import { buildPushPayload } from '@block65/webcrypto-web-push';

export const OFFSETS = Object.freeze([120, 30, 5]);
const MAX_ITEMS = 500;
const MAX_BODY_BYTES = 150_000;
const MAX_ATTEMPTS = 3;
const CLAIM_MS = 90_000;
const LATE_GRACE_MS = 120_000;
const encoder = new TextEncoder();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const bytesToBase64 = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export async function hashToken(value) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function keyBytes(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new HttpError(400, '订阅密钥格式无效');
  let bytes;
  try { bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0)); }
  catch { throw new HttpError(400, '订阅密钥格式无效'); }
  if (bytes.length !== length) throw new HttpError(400, '订阅密钥长度无效');
  return bytes;
}

function configuration(env) {
  let origin, app;
  try {
    origin = new URL(env.ALLOWED_ORIGIN);
    app = new URL(env.APP_URL || `${origin.origin}/CAPM/`);
  } catch { throw new HttpError(503, '提醒服务尚未配置'); }
  if (origin.protocol !== 'https:' || origin.origin !== env.ALLOWED_ORIGIN || app.origin !== origin.origin || app.username || app.password) {
    throw new HttpError(503, '提醒服务网址配置无效');
  }
  if (!env.DB || typeof env.PAIRING_SECRET !== 'string' || env.PAIRING_SECRET.length < 32 ||
      !/^[A-Za-z0-9_-]{87}$/.test(env.VAPID_PUBLIC_KEY || '') || !/^[A-Za-z0-9_-]{43}$/.test(env.VAPID_PRIVATE_KEY || '') ||
      !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(env.VAPID_SUBJECT || '')) {
    throw new HttpError(503, '提醒服务尚未配置');
  }
  return { origin: origin.origin, appUrl: app.href };
}

export function validateEndpoint(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new HttpError(400, '推送地址无效');
  let endpoint;
  try { endpoint = new URL(value); } catch { throw new HttpError(400, '推送地址无效'); }
  const host = endpoint.hostname.toLowerCase();
  const apple = host === 'web.push.apple.com' || /^pushapi[a-z0-9-]*(?:\.[a-z0-9-]+)?\.push\.apple\.com$/.test(host);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port || endpoint.hash || endpoint.pathname === '/' ||
      !(apple || host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com')) {
    throw new HttpError(400, '仅支持 Apple、Google、Mozilla 的 HTTPS 推送地址');
  }
  return endpoint.href;
}

export async function validateSubscription(value) {
  if (!value || typeof value !== 'object') throw new HttpError(400, '缺少设备推送订阅');
  const endpoint = validateEndpoint(value.endpoint);
  const publicKey = keyBytes(value.keys?.p256dh, 65);
  keyBytes(value.keys?.auth, 16);
  if (publicKey[0] !== 4) throw new HttpError(400, '订阅公钥无效');
  try { await crypto.subtle.importKey('raw', publicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []); }
  catch { throw new HttpError(400, '订阅公钥无效'); }
  return { endpoint, expirationTime: null, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}

async function readJson(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, '请使用 JSON 请求');
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) throw new HttpError(413, '请求过大');
  if (!request.body) throw new HttpError(400, '缺少请求内容');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new HttpError(413, '请求过大'); }
    chunks.push(value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(data)); }
  catch { throw new HttpError(400, 'JSON 格式无效'); }
}

export function normalizeItems(value, now) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new HttpError(400, '每台设备最多同步 500 项安排');
  const ids = new Set();
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id.length < 1 || item.id.length > 128 || /[\x00-\x1f\x7f]/.test(item.id)) {
      throw new HttpError(400, '安排编号无效');
    }
    if (ids.has(item.id)) throw new HttpError(400, '安排编号重复');
    ids.add(item.id);
    if (item.completed === true) return [];
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 200 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(item.title)) throw new HttpError(400, '安排名称无效');
    if (typeof item.startAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(item.startAt)) throw new HttpError(400, '开始时间必须是 UTC ISO 时间');
    const startAt = Date.parse(item.startAt);
    if (!Number.isFinite(startAt) || new Date(startAt).toISOString().slice(0, 19) !== item.startAt.slice(0, 19)) throw new HttpError(400, '开始时间无效');
    if (startAt <= now) return [];
    // Keep only the three fields required to schedule a reminder. Project goals,
    // notes, completed tasks and other planner data are never stored here.
    return [{ id: item.id, title: item.title.trim(), startAt }];
  });
}

async function authenticate(request, env) {
  const bearer = request.headers.get('Authorization')?.match(/^Bearer (xuri_[A-Za-z0-9_-]{43})$/);
  if (!bearer) throw new HttpError(401, '设备尚未配对或令牌无效');
  const device = await env.DB.prepare('SELECT * FROM devices WHERE token_hash = ?').bind(await hashToken(bearer[1])).first();
  if (!device) throw new HttpError(401, '设备配对已失效，请重新连接提醒服务');
  return device;
}

async function pairDevice(request, env, now) {
  // D1, rather than a Worker-local map, makes the limit shared between isolates.
  const ipHash = await hashToken(`${env.PAIRING_SECRET}:${request.headers.get('CF-Connecting-IP') || 'unknown'}`);
  const rate = await env.DB.prepare(`INSERT INTO pairing_attempts(ip_hash, bucket, attempts) VALUES (?, ?, 1)
    ON CONFLICT(ip_hash, bucket) DO UPDATE SET attempts = attempts + 1 RETURNING attempts`).bind(ipHash, Math.floor(now / 60_000)).first();
  if (rate.attempts > 10) throw new HttpError(429, '配对尝试过于频繁，请稍后再试');
  const input = await readJson(request);
  const candidate = typeof input?.pairingSecret === 'string' && input.pairingSecret.length <= 512 ? input.pairingSecret : '';
  const expected = await hashToken(env.PAIRING_SECRET);
  const actual = await hashToken(candidate);
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  if (difference) throw new HttpError(401, '配对口令无效');
  const subscription = await validateSubscription(input.subscription);
  const token = `xuri_${bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))}`;
  const deviceId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM devices WHERE endpoint = ?').bind(subscription.endpoint),
    env.DB.prepare(`INSERT INTO devices(id, token_hash, endpoint, subscription_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(deviceId, await hashToken(token), subscription.endpoint, JSON.stringify(subscription), now, now),
  ]);
  return json({ deviceId, deviceToken: token }, 201);
}

export async function replaceSchedule(env, device, items, now, generation) {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new HttpError(400, '提醒同步版本无效');
  const payload = JSON.stringify(items);
  const revision = crypto.randomUUID();
  // A D1 batch is an atomic SQLite transaction. Retain retry/delivery state for
  // unchanged reminders; remove all reminders for deleted/changed/completed items.
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE devices SET generation = ?, schedule_revision = ?, last_sync_at = ?, updated_at = ?
      WHERE id = ? AND generation < ?`).bind(generation, revision, now, now, device.id, generation),
    env.DB.prepare(`UPDATE jobs SET revision = ?, title = (
      SELECT json_extract(value, '$.title') FROM json_each(?)
      WHERE json_extract(value, '$.id') = jobs.item_id AND json_extract(value, '$.startAt') = jobs.start_at
    ) WHERE device_id = ? AND EXISTS (SELECT 1 FROM devices WHERE id = ? AND schedule_revision = ?) AND EXISTS (
      SELECT 1 FROM json_each(?) WHERE json_extract(value, '$.id') = jobs.item_id AND json_extract(value, '$.startAt') = jobs.start_at
    )`).bind(revision, payload, device.id, device.id, revision, payload),
    env.DB.prepare(`INSERT INTO jobs(id, device_id, item_id, title, start_at, offset_minutes, due_at, expires_at, revision, next_attempt_at)
      SELECT ? || ':' || json_extract(i.value, '$.id') || ':' || json_extract(i.value, '$.startAt') || ':' || o.value,
        ?, json_extract(i.value, '$.id'), json_extract(i.value, '$.title'), json_extract(i.value, '$.startAt'), o.value,
        json_extract(i.value, '$.startAt') - o.value * 60000,
        MIN(json_extract(i.value, '$.startAt') - o.value * 60000 + ?, json_extract(i.value, '$.startAt')),
        ?, json_extract(i.value, '$.startAt') - o.value * 60000
      FROM json_each(?) AS i CROSS JOIN json_each('[120,30,5]') AS o
      WHERE json_extract(i.value, '$.startAt') - o.value * 60000 > ?
        AND EXISTS (SELECT 1 FROM devices WHERE id = ? AND schedule_revision = ?)
      ON CONFLICT(device_id, item_id, start_at, offset_minutes) DO UPDATE SET title = excluded.title, revision = excluded.revision
    `).bind(device.id, device.id, LATE_GRACE_MS, revision, payload, now, device.id, revision),
    env.DB.prepare(`DELETE FROM jobs WHERE device_id = ? AND revision != ?
      AND EXISTS (SELECT 1 FROM devices WHERE id = ? AND schedule_revision = ?)`).bind(device.id, revision, device.id, revision),
    env.DB.prepare("SELECT COUNT(*) AS total FROM jobs WHERE device_id = ? AND status IN ('pending', 'sending') AND expires_at > ?").bind(device.id, now),
    env.DB.prepare('SELECT generation FROM devices WHERE id = ?').bind(device.id),
  ]);
  const current = results[5].results[0];
  if (!current) throw new HttpError(401, '设备配对已失效，请重新连接提醒服务');
  if (current.generation > generation) {
    const error = new HttpError(409, '提醒安排已被较新操作更新');
    error.stale = true;
    throw error;
  }
  return { scheduledJobs: results[4].results[0].total, items: items.length, serverTime: new Date(now).toISOString() };
}

async function sendPush(env, subscription, message, ttl, fetcher) {
  const request = await buildPushPayload({ data: JSON.stringify(message), options: { ttl } }, subscription, {
    subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY,
  });
  // Never follow a push provider's redirect to another host.
  const headers = new Headers(request.headers);
  headers.set('Urgency', 'high');
  return fetcher(subscription.endpoint, { ...request, headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
}

async function sendTest(env, device, now, appUrl, fetcher) {
  const changed = await env.DB.prepare('UPDATE devices SET last_test_at = ? WHERE id = ? AND (last_test_at IS NULL OR last_test_at <= ?) RETURNING id')
    .bind(now, device.id, now - 60_000).first();
  if (!changed) throw new HttpError(429, '每分钟只能发送一次测试提醒');
  let response;
  try {
    response = await sendPush(env, JSON.parse(device.subscription_json), {
      title: '序日测试提醒', body: '提醒服务已连接。请检查锁屏和后台接收情况。', url: appUrl, test: true,
    }, 60, fetcher);
  } catch { throw new HttpError(502, '暂时无法连接推送服务，请稍后再试'); }
  if (response.status === 404 || response.status === 410) {
    await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(device.id).run();
    throw new HttpError(410, '设备推送订阅已失效，请重新连接');
  }
  if (!response.ok) throw new HttpError(502, '推送服务未接受测试提醒');
  return json({ accepted: true });
}

export async function runCron(env, { now = Date.now(), fetcher = fetch, clock = Date.now } = {}) {
  const { appUrl } = configuration(env);
  const claim = crypto.randomUUID();
  const selected = await env.DB.prepare(`UPDATE jobs SET status = 'sending', attempts = attempts + 1, claim_token = ?, claim_until = ?
    WHERE id IN (SELECT id FROM jobs WHERE due_at <= ? AND expires_at > ? AND attempts < ?
      AND ((status = 'pending' AND next_attempt_at <= ?) OR (status = 'sending' AND claim_until <= ?))
      ORDER BY due_at LIMIT 10) RETURNING *`).bind(claim, now + CLAIM_MS, now, now, MAX_ATTEMPTS, now, now).all();
  const summary = { claimed: selected.results.length, accepted: 0, failed: 0, cancelled: 0 };
  // Bound encryption/fetch concurrency and subrequests for a personal Worker.
  for (let offset = 0; offset < selected.results.length; offset += 5) {
    await Promise.all(selected.results.slice(offset, offset + 5).map(async (job) => {
      // A schedule replacement or device deletion may have cancelled a claimed
      // reminder. Re-read immediately before sending to avoid sending stale jobs.
      const current = await env.DB.prepare(`SELECT j.*, d.subscription_json FROM jobs AS j
        JOIN devices AS d ON d.id = j.device_id WHERE j.id = ? AND j.claim_token = ? AND j.status = 'sending'`).bind(job.id, claim).first();
      if (!current) { summary.cancelled++; return; }
      const sendAt = Math.max(now, clock());
      if (current.expires_at <= sendAt || current.claim_until <= sendAt) {
        await env.DB.prepare("UPDATE jobs SET status = 'failed', claim_token = NULL, claim_until = NULL WHERE id = ? AND claim_token = ?")
          .bind(current.id, claim).run();
        summary.cancelled++;
        return;
      }
      let status = 0;
      try {
        const subscription = await validateSubscription(JSON.parse(current.subscription_json));
        const ttl = Math.max(1, Math.min(120, Math.floor((current.expires_at - sendAt) / 1000)));
        const response = await sendPush(env, subscription, {
          title: '序日提醒', body: `${current.title} · 距开始 ${current.offset_minutes} 分钟`,
          itemId: current.item_id, startAt: new Date(current.start_at).toISOString(), offsetMinutes: current.offset_minutes,
          date: new Date(current.start_at).toISOString(), url: appUrl,
        }, ttl, fetcher);
        status = response.status;
        if (response.ok) {
          await env.DB.prepare("UPDATE jobs SET status = 'delivered', delivered_at = ?, claim_token = NULL, claim_until = NULL WHERE id = ? AND claim_token = ?")
            .bind(Math.max(now, clock()), current.id, claim).run();
          summary.accepted++;
          return;
        }
      } catch { /* Network errors are retried only inside this reminder's short TTL. */ }
      if (status === 404 || status === 410) {
        await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(current.device_id).run();
      } else {
        const retryable = status === 0 || status === 429 || status >= 500;
        const retryAt = Math.max(now, clock()) + 60_000;
        const retry = retryable && current.attempts < MAX_ATTEMPTS && retryAt < current.expires_at;
        await env.DB.prepare(`UPDATE jobs SET status = ?, next_attempt_at = ?, error_code = ?, claim_token = NULL, claim_until = NULL
          WHERE id = ? AND claim_token = ?`).bind(retry ? 'pending' : 'failed', retryAt, status, current.id, claim).run();
      }
      summary.failed++;
    }));
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM jobs WHERE expires_at < ? OR (status = 'delivered' AND delivered_at < ?)").bind(now - 86_400_000, now - 86_400_000),
    env.DB.prepare('DELETE FROM pairing_attempts WHERE bucket < ?').bind(Math.floor(now / 60_000) - 5),
    // Stop retaining inactive devices and minimal scheduling data indefinitely.
    env.DB.prepare(`DELETE FROM devices WHERE updated_at < ? AND NOT EXISTS (
      SELECT 1 FROM jobs WHERE jobs.device_id = devices.id AND jobs.start_at > ?
    )`).bind(now - 90 * 86_400_000, now),
  ]);
  return summary;
}

export async function handleRequest(request, env, { now = Date.now(), fetcher = fetch } = {}) {
  const path = new URL(request.url).pathname.replace(/\/$/, '') || '/';
  const origin = request.headers.get('Origin');
  let response;
  try {
    if (origin && origin !== env.ALLOWED_ORIGIN) throw new HttpError(403, '请求来源未获允许');
    if (request.method === 'OPTIONS') {
      if (!origin) throw new HttpError(403, '缺少请求来源');
      response = new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600',
      } });
    } else if (request.method === 'GET' && path === '/health') {
      let configured = true;
      try {
        configuration(env);
        await env.DB.prepare(`SELECT d.generation, j.status, p.attempts FROM devices AS d
          LEFT JOIN jobs AS j ON j.device_id = d.id LEFT JOIN pairing_attempts AS p ON 1 = 0 LIMIT 1`).first();
      } catch { configured = false; }
      response = json({ ok: configured, configured }, configured ? 200 : 503);
    } else {
      const { appUrl } = configuration(env);
      if (request.method === 'GET' && path === '/config') response = json({ vapidPublicKey: env.VAPID_PUBLIC_KEY, offsetsMinutes: OFFSETS, timeZone: 'UTC' });
      else if (request.method === 'POST' && path === '/devices') response = await pairDevice(request, env, now);
      else if (request.method === 'PUT' && path === '/schedule') {
        const device = await authenticate(request, env);
        const input = await readJson(request);
        response = json(await replaceSchedule(env, device, normalizeItems(input?.items, now), now, input?.generation));
      } else if (request.method === 'POST' && path === '/test') response = await sendTest(env, await authenticate(request, env), now, appUrl, fetcher);
      else if (request.method === 'DELETE' && path === '/devices') {
        const device = await authenticate(request, env);
        await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(device.id).run();
        response = new Response(null, { status: 204 });
      } else throw new HttpError(404, '接口不存在');
    }
  } catch (error) {
    // Never echo requests, subscriptions, tokens, secrets or provider responses.
    response = json({ error: error instanceof HttpError ? error.message : '提醒服务暂时不可用', ...(error.stale ? { stale: true } : {}) }, error instanceof HttpError ? error.status : 500);
  }
  const headers = new Headers(response.headers);
  headers.set('Vary', 'Origin');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (origin && origin === env.ALLOWED_ORIGIN) headers.set('Access-Control-Allow-Origin', origin);
  return new Response(response.body, { status: response.status, headers });
}

export default {
  fetch: (request, env) => handleRequest(request, env),
  scheduled(_event, env, context) { context.waitUntil(runCron(env)); },
};
