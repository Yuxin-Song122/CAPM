import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createECDH, randomBytes, hkdfSync, createDecipheriv, createPublicKey, verify } from 'node:crypto';
import { handleRequest, runCron, normalizeItems, validateEndpoint, hashToken } from '../push-backend/src/worker.js';

// Real SQLite exercises the same JSON1, foreign-key, transaction and RETURNING
// queries that D1 executes. Only the D1 transport and push provider are fake.
class D1 {
  constructor({ schema = true } = {}) {
    this.db = new DatabaseSync(':memory:');
    if (schema) this.db.exec(readFileSync(new URL('../push-backend/schema.sql', import.meta.url), 'utf8'));
    this.beforeFirst = null;
  }
  prepare(sql) {
    const db = this;
    return {
      values: [], sql,
      bind(...values) { this.values = values; return this; },
      execute() { return { results: db.db.prepare(sql).all(...this.values), success: true }; },
      async first() { if (db.beforeFirst) await db.beforeFirst(sql); return this.execute().results[0] || null; },
      async all() { return this.execute(); },
      async run() { return this.execute(); },
    };
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try { const result = statements.map((statement) => statement.execute()); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  rows(sql = 'SELECT * FROM jobs', ...args) { return this.db.prepare(sql).all(...args); }
}

const NOW = Date.UTC(2030, 0, 1, 0, 0, 0);
const ORIGIN = 'https://yuxin-song122.github.io';
function fixture(options, vapidPrivateKey) {
  const vapid = createECDH('prime256v1');
  if (vapidPrivateKey) vapid.setPrivateKey(vapidPrivateKey);
  else vapid.generateKeys();
  const client = createECDH('prime256v1'); client.generateKeys();
  const auth = randomBytes(16);
  const subscription = { endpoint: `https://web.push.apple.com/${randomBytes(12).toString('hex')}`, keys: {
    p256dh: client.getPublicKey().toString('base64url'), auth: auth.toString('base64url'),
  } };
  return {
    env: { DB: new D1(options), ALLOWED_ORIGIN: ORIGIN, APP_URL: `${ORIGIN}/CAPM/`, PAIRING_SECRET: randomBytes(32).toString('base64url'),
      VAPID_PUBLIC_KEY: vapid.getPublicKey().toString('base64url'), VAPID_PRIVATE_KEY: Buffer.concat([Buffer.alloc(32), vapid.getPrivateKey()]).subarray(-32).toString('base64url'), VAPID_SUBJECT: 'mailto:test@example.com' },
    client, auth, subscription,
  };
}
async function request(env, path, { method = 'GET', body, token, origin = ORIGIN, now = NOW, fetcher, raw } = {}) {
  const headers = { ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
  return handleRequest(new Request(`https://worker.example${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : raw !== undefined ? { body: raw } : {}) }), env, { now, fetcher });
}
async function pair(f) {
  const response = await request(f.env, '/devices', { method: 'POST', body: { pairingSecret: f.env.PAIRING_SECRET, subscription: f.subscription } });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}
const item = (id = 'task-a', minutes = 180) => ({ id, title: `安排 ${id}`, startAt: new Date(NOW + minutes * 60_000).toISOString() });
const sync = (f, token, items, generation = 1, now = NOW) => request(f.env, '/schedule', { method: 'PUT', token, now, body: { items, generation } });
const cron = (f, now, fetcher = async () => new Response(null, { status: 201 }), extras = {}) => runCron(f.env, { now, clock: () => now, fetcher, ...extras });

// Independently decrypt RFC8291 with node:crypto. This deliberately does not use
// the sending library's encryption or KDF implementation.
function decrypt(requestOptions, f) {
  const data = Buffer.from(requestOptions.body);
  const salt = data.subarray(0, 16);
  assert.equal(data.readUInt32BE(16), 4096);
  const keyLength = data[20]; assert.equal(keyLength, 65);
  const serverKey = data.subarray(21, 21 + keyLength);
  const secret = f.client.computeSecret(serverKey);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), f.client.getPublicKey(), serverKey]);
  const ikm = hkdfSync('sha256', secret, f.auth, info, 32);
  const cek = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const ciphertext = data.subarray(21 + keyLength);
  const cipher = createDecipheriv('aes-128-gcm', cek, nonce);
  cipher.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([cipher.update(ciphertext.subarray(0, -16)), cipher.final()]);
  let end = plain.length - 1;
  while (plain[end] === 0) end--;
  assert.equal(plain[end], 2, 'last-record RFC8188 delimiter');
  return JSON.parse(plain.subarray(0, end).toString('utf8'));
}

test('configuration, real schema health and exact CORS fail closed', async () => {
  const f = fixture();
  const healthy = await request(f.env, '/health');
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), { ok: true, configured: true });
  assert.equal((await request({ ...f.env, DB: new D1({ schema: false }) }, '/health')).status, 503);
  assert.equal((await request({ ...f.env, VAPID_PRIVATE_KEY: '' }, '/config')).status, 503);
  assert.equal((await request(f.env, '/config', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await request(f.env, '/config', { origin: 'null' })).status, 403);
  const config = await request(f.env, '/config');
  assert.equal(config.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(config.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await config.json(), { vapidPublicKey: f.env.VAPID_PUBLIC_KEY, offsetsMinutes: [120, 30, 5], timeZone: 'UTC' });
  const preflight = await request(f.env, '/schedule', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});

test('leading-zero VAPID private scalars are encoded as exactly 32 bytes and can sign a push', async () => {
  // Scalar 1 makes getPrivateKey() return one byte, deterministically exercising
  // the rare leading-zero condition that random keys expose intermittently.
  const f = fixture(undefined, Buffer.from([1]));
  const privateKey = Buffer.from(f.env.VAPID_PRIVATE_KEY, 'base64url');
  assert.equal(privateKey.length, 32);
  assert.equal(privateKey.subarray(0, 31).every((byte) => byte === 0), true);
  assert.equal((await request(f.env, '/health')).status, 200);
  const { deviceToken } = await pair(f);
  const response = await request(f.env, '/test', { method: 'POST', token: deviceToken,
    fetcher: async (_url, options) => { assert.equal(decrypt(options, f).test, true); return new Response(null, { status: 201 }); } });
  assert.equal(response.status, 200, await response.clone().text());
});

test('endpoint validation prevents SSRF, credential URLs and redirects', async () => {
  for (const value of ['http://web.push.apple.com/token', 'https://127.0.0.1/token', 'https://localhost/token', 'https://fcm.googleapis.com.evil.example/token',
    'https://evil.example@web.push.apple.com/token', 'https://fcm.googleapis.com:8443/token', 'https://web.push.apple.com/token#x',
    'https://notpush.push.apple.com/token', 'https://web.push.apple.com/']) assert.throws(() => validateEndpoint(value), { status: 400 });
  for (const value of ['https://web.push.apple.com/token', 'https://pushapi.useast1.push.apple.com/token', 'https://pushapi2.push.apple.com/token',
    'https://fcm.googleapis.com/fcm/send/token', 'https://updates.push.services.mozilla.com/wpush/v2/token']) assert.equal(validateEndpoint(value), value);
  const f = fixture();
  const bad = await request(f.env, '/devices', { method: 'POST', body: { pairingSecret: f.env.PAIRING_SECRET, subscription: { ...f.subscription, keys: { p256dh: 'invalid', auth: 'invalid' } } } });
  assert.equal(bad.status, 400);
});

test('pairing authenticates, stores token hashes, limits attempts and rotates same subscription', async () => {
  const f = fixture();
  assert.equal((await request(f.env, '/devices', { method: 'POST', body: { pairingSecret: 'wrong', subscription: f.subscription } })).status, 401);
  const first = await pair(f);
  const device = f.env.DB.rows('SELECT * FROM devices')[0];
  assert.equal(device.token_hash, await hashToken(first.deviceToken));
  assert.ok(!JSON.stringify(device).includes(first.deviceToken));
  assert.ok(!JSON.stringify(device).includes(f.env.PAIRING_SECRET));
  await sync(f, first.deviceToken, [item()]);
  const second = await pair(f);
  assert.notEqual(first.deviceToken, second.deviceToken);
  assert.equal(f.env.DB.rows().length, 0);
  assert.equal((await sync(f, first.deviceToken, [item()])).status, 401);
  assert.equal((await sync(f, second.deviceToken, [item()])).status, 200);
  for (let n = 0; n < 8; n++) await request(f.env, '/devices', { method: 'POST', body: { pairingSecret: 'wrong' } });
  assert.equal((await request(f.env, '/devices', { method: 'POST', body: { pairingSecret: 'wrong' } })).status, 429);
});

test('schedule creates all three offsets, stores minimal fields and preserves delivery on repeat sync', async () => {
  const f = fixture(); const { deviceToken } = await pair(f);
  const response = await sync(f, deviceToken, [{ ...item(), notes: 'private notes never upload', goal: 'private goal' }, { ...item('done'), completed: true }]);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).scheduledJobs, 3);
  const jobs = f.env.DB.rows('SELECT * FROM jobs ORDER BY offset_minutes');
  assert.deepEqual(jobs.map((job) => job.offset_minutes), [5, 30, 120]);
  assert.ok(!JSON.stringify(jobs).includes('private'));
  assert.equal(jobs[2].due_at, NOW + 60 * 60_000);
  f.env.DB.db.prepare("UPDATE jobs SET status='delivered', attempts=1, delivered_at=? WHERE offset_minutes=120").run(NOW);
  await sync(f, deviceToken, [item()], 2);
  assert.equal(f.env.DB.rows("SELECT * FROM jobs WHERE offset_minutes=120")[0].status, 'delivered');
  assert.equal(f.env.DB.rows().length, 3);
});

test('completion, deletion and changed start cancel old jobs, isolated per device', async () => {
  const f = fixture(); const { deviceToken } = await pair(f);
  await sync(f, deviceToken, [item('a'), item('b')]);
  assert.equal(f.env.DB.rows().length, 6);
  await sync(f, deviceToken, [{ ...item('a'), completed: true }, item('b', 200)], 2);
  assert.equal(f.env.DB.rows().length, 3);
  assert.ok(f.env.DB.rows().every((job) => job.item_id === 'b' && job.start_at === NOW + 200 * 60_000));
  await sync(f, deviceToken, [], 3);
  assert.equal(f.env.DB.rows().length, 0);
  f.subscription.endpoint += '-second';
  const second = await pair(f);
  await sync(f, second.deviceToken, [item('separate')]);
  await sync(f, deviceToken, [item('first')], 4);
  await request(f.env, '/devices', { method: 'DELETE', token: deviceToken });
  assert.equal(f.env.DB.rows().length, 3);
  assert.ok(f.env.DB.rows().every((job) => job.item_id === 'separate'));
});

test('atomic generations reject stale requests and same generation is idempotent', async () => {
  const f = fixture(); const { deviceToken } = await pair(f);
  await sync(f, deviceToken, [item()], 8);
  await sync(f, deviceToken, [], 10);
  const stale = await sync(f, deviceToken, [item()], 9);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).stale, true);
  assert.equal(f.env.DB.rows().length, 0);
  assert.equal((await sync(f, deviceToken, [item()], 10)).status, 200);
  assert.equal(f.env.DB.rows().length, 0, 'same-generation retry cannot replace newer payload');
  assert.equal((await sync(f, deviceToken, [item()], 0)).status, 400);
  assert.equal((await sync(f, deviceToken, [item()], Number.MAX_SAFE_INTEGER + 1)).status, 400);
});

test('reject malformed schedules atomically and skip missed reminders instead of catch-up bursts', async () => {
  const f = fixture(); const { deviceToken } = await pair(f);
  await sync(f, deviceToken, [item()]);
  assert.equal((await sync(f, deviceToken, [item(), item()], 2)).status, 400);
  assert.equal(f.env.DB.rows().length, 3);
  assert.throws(() => normalizeItems([{ ...item(), startAt: '2030-02-30T10:00:00Z' }], NOW), { status: 400 });
  assert.throws(() => normalizeItems([{ ...item(), startAt: '2030-01-01T08:00:00+08:00' }], NOW), { status: 400 });
  await sync(f, deviceToken, [item('near', 10), item('past', -1)], 3);
  assert.deepEqual(f.env.DB.rows().map((job) => job.offset_minutes), [5]);
  let calls = 0;
  const result = await cron(f, NOW, async () => { calls++; return new Response(null, { status: 201 }); });
  assert.equal(result.claimed, 0); assert.equal(calls, 0);
  const tooBig = await request(f.env, '/schedule', { method: 'PUT', token: deviceToken, raw: ' '.repeat(150_001) });
  assert.equal(tooBig.status, 413);
  assert.equal(f.env.DB.rows().length, 1);
});

test('cron sends RFC8291 payload and verifiable RFC8292 VAPID signature exactly once on overlapping executions', async () => {
  const f = fixture(); const { deviceToken } = await pair(f);
  await sync(f, deviceToken, [item()]);
  const sent = [];
  const fetcher = async (endpoint, options) => { sent.push({ endpoint, options }); return new Response(null, { status: 201 }); };
  await Promise.all([cron(f, NOW + 60 * 60_000 + 10_000, fetcher), cron(f, NOW + 60 * 60_000 + 10_000, fetcher)]);
  assert.equal(sent.length, 1);
  const { endpoint, options } = sent[0];
  assert.equal(endpoint, f.subscription.endpoint);
  assert.equal(options.method.toUpperCase(), 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.get('Content-Encoding'), 'aes128gcm');
  assert.equal(options.headers.get('Urgency'), 'high');
  assert.equal(Number(options.headers.get('TTL')), 110);
  const message = decrypt(options, f);
  assert.equal(message.itemId, 'task-a'); assert.equal(message.offsetMinutes, 120);
  assert.equal(message.url, `${ORIGIN}/CAPM/`);
  assert.equal(message.startAt, item().startAt);
  const authorization = options.headers.get('Authorization');
  const jwt = authorization.match(/t=([^,\s]+)/)[1];
  const [header, payload, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).aud, 'https://web.push.apple.com');
  const publicBytes = Buffer.from(f.env.VAPID_PUBLIC_KEY, 'base64url');
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: publicBytes.subarray(1, 33).toString('base64url'), y: publicBytes.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  assert.equal(f.env.DB.rows("SELECT * FROM jobs WHERE offset_minutes=120")[0].status, 'delivered');
  await cron(f, NOW + 60 * 60_000 + 30_000, fetcher);
  assert.equal(sent.length, 1);
});

test('transient errors retry inside TTL, permanent errors do not, expired jobs never send', async () => {
  const f = fixture(); const { deviceToken } = await pair(f);
  await sync(f, deviceToken, [item()]);
  const due = NOW + 60 * 60_000;
  let calls = 0;
  await cron(f, due + 1000, async () => { calls++; return new Response(null, { status: 503 }); });
  assert.equal(f.env.DB.rows('SELECT * FROM jobs WHERE offset_minutes=120')[0].status, 'pending');
  await cron(f, due + 62_000, async () => { calls++; return new Response(null, { status: 201 }); });
  assert.equal(calls, 2);
  assert.equal(f.env.DB.rows('SELECT * FROM jobs WHERE offset_minutes=120')[0].attempts, 2);
  await cron(f, NOW + 150 * 60_000 + 1000, async () => { calls++; return new Response(null, { status: 403 }); });
  assert.equal(f.env.DB.rows('SELECT * FROM jobs WHERE offset_minutes=30')[0].status, 'failed');
  await cron(f, NOW + 150 * 60_000 + 62_000, async () => { calls++; return new Response(null, { status: 201 }); });
  assert.equal(calls, 3);
  await cron(f, NOW + 175 * 60_000 + 121_000, async () => { calls++; return new Response(null, { status: 201 }); });
  assert.equal(calls, 3);
});

test('invalid push subscriptions revoke device and cascade queued reminders', async () => {
  for (const status of [404, 410]) {
    const f = fixture(); const { deviceToken } = await pair(f);
    await sync(f, deviceToken, [item()]);
    await cron(f, NOW + 60 * 60_000, async () => new Response(null, { status }));
    assert.equal(f.env.DB.rows('SELECT * FROM devices').length, 0);
    assert.equal(f.env.DB.rows().length, 0);
    assert.equal((await sync(f, deviceToken, [item()], 2)).status, 401);
  }
});

test('a schedule cancelled after claim is rechecked before send; late/expired claims do not send', async () => {
  const f = fixture(); const { deviceToken } = await pair(f);
  await sync(f, deviceToken, [item()]);
  let cancelled = false, calls = 0;
  f.env.DB.beforeFirst = async (sql) => {
    if (!cancelled && sql.includes('JOIN devices')) {
      cancelled = true;
      await sync(f, deviceToken, [], 2);
    }
  };
  const result = await cron(f, NOW + 60 * 60_000, async () => { calls++; return new Response(null, { status: 201 }); });
  assert.equal(result.cancelled, 1); assert.equal(calls, 0);
  f.env.DB.beforeFirst = null;
  await sync(f, deviceToken, [item()], 3);
  const delayed = await cron(f, NOW + 60 * 60_000, async () => { calls++; return new Response(null, { status: 201 }); }, { clock: () => NOW + 60 * 60_000 + 121_000 });
  assert.equal(delayed.cancelled, 1); assert.equal(calls, 0);
});

test('test notification requires auth, is throttled and reports provider acceptance only', async () => {
  const f = fixture(); const { deviceToken } = await pair(f);
  assert.equal((await request(f.env, '/test', { method: 'POST' })).status, 401);
  let payload;
  const fetcher = async (_endpoint, options) => { payload = decrypt(options, f); return new Response(null, { status: 201 }); };
  const response = await request(f.env, '/test', { method: 'POST', token: deviceToken, fetcher });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.equal(payload.test, true);
  assert.equal((await request(f.env, '/test', { method: 'POST', token: deviceToken, fetcher })).status, 429);
  const invalid = await request(f.env, '/test', { method: 'POST', token: deviceToken, now: NOW + 60_001, fetcher: async () => new Response(null, { status: 410 }) });
  assert.equal(invalid.status, 410);
  assert.equal(f.env.DB.rows('SELECT * FROM devices').length, 0);
});
