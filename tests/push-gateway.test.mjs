import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { handleGatewayRequest } from '../push-backend/pages-gateway/public/_worker.js';
import { handleRequest } from '../push-backend/src/worker.js';

const ORIGIN = 'https://yuxin-song122.github.io';
const ENTRY = 'https://synthetic-reminder-entry.pages.dev';
function backend() {
  const key = createECDH('prime256v1'); key.generateKeys();
  return {
    ALLOWED_ORIGIN: ORIGIN, APP_URL: `${ORIGIN}/CAPM/`,
    PAIRING_SECRET: randomBytes(32).toString('base64url'),
    VAPID_PUBLIC_KEY: key.getPublicKey().toString('base64url'),
    VAPID_PRIVATE_KEY: Buffer.concat([Buffer.alloc(32), key.getPrivateKey()]).subarray(-32).toString('base64url'),
    VAPID_SUBJECT: 'https://synthetic-contact.example',
    DB: { prepare: () => ({ first: async () => null }) },
  };
}

test('Pages entry forwards methods, path, query, authentication and body only to its service binding', async () => {
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const body = ['POST', 'PUT'].includes(method) ? JSON.stringify({ synthetic: 'request-body' }) : undefined;
    const request = new Request(`${ENTRY}/schedule?synthetic=query`, {
      method, headers: { Origin: ORIGIN, Authorization: 'Bearer synthetic-device-token', 'Content-Type': 'application/json' }, body,
    });
    let calls = 0;
    const result = new Response('synthetic-backend-response', { status: 202 });
    const response = await handleGatewayRequest(request, {
      ALLOWED_ORIGIN: ORIGIN,
      REMINDER_BACKEND: { fetch: async (forwarded) => {
        calls++;
        assert.equal(forwarded.url, request.url);
        assert.equal(forwarded.method, method);
        assert.equal(forwarded.headers.get('Origin'), ORIGIN);
        assert.equal(forwarded.headers.get('Authorization'), 'Bearer synthetic-device-token');
        assert.equal(await forwarded.text(), body || '');
        return result;
      } },
    });
    assert.equal(response.status, 202);
    assert.equal(await response.text(), 'synthetic-backend-response');
    assert.equal(calls, 1);
  }
});

test('The real reminder handler keeps health, config and exact CORS at the Pages entry', async () => {
  const original = backend();
  const env = { ALLOWED_ORIGIN: ORIGIN, REMINDER_BACKEND: { fetch: (request) => handleRequest(request, original) } };
  const health = await handleGatewayRequest(new Request(`${ENTRY}/health`, { headers: { Origin: ORIGIN } }), env);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, configured: true });
  assert.equal(health.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(health.headers.get('Cache-Control'), 'no-store');
  const config = await handleGatewayRequest(new Request(`${ENTRY}/config`, { headers: { Origin: ORIGIN } }), env);
  assert.equal(config.status, 200);
  assert.deepEqual(await config.json(), { vapidPublicKey: original.VAPID_PUBLIC_KEY, offsetsMinutes: [120, 30, 5], timeZone: 'UTC' });
  const options = await handleGatewayRequest(new Request(`${ENTRY}/schedule`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'Authorization, Content-Type' } }), env);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(options.headers.get('Access-Control-Allow-Methods'), /PUT/);
  assert.match(options.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  const unauthorized = await handleGatewayRequest(new Request(`${ENTRY}/schedule`, { method: 'PUT', headers: { Origin: ORIGIN } }), env);
  assert.equal(unauthorized.status, 401);
  const foreign = await handleGatewayRequest(new Request(`${ENTRY}/config`, { headers: { Origin: 'https://foreign.example' } }), env);
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);
});

test('Missing binding or upstream failure returns a private JSON 503 without a public-network fallback', async () => {
  const sentinel = 'synthetic-private-upstream-detail';
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('external fetch is forbidden in this test'); };
  try {
    for (const extra of [{}, { REMINDER_BACKEND: { fetch: async () => { throw new Error(sentinel); } } }]) {
      for (const origin of [ORIGIN, 'https://foreign.example']) {
        const response = await handleGatewayRequest(new Request(`${ENTRY}/health`, { headers: { Origin: origin } }), { ALLOWED_ORIGIN: ORIGIN, ...extra });
        assert.equal(response.status, 503);
        assert.match(response.headers.get('Content-Type'), /application\/json/);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin === ORIGIN ? ORIGIN : null);
        assert.equal(response.headers.get('Vary'), 'Origin');
        const text = await response.text();
        assert.doesNotMatch(text, new RegExp(sentinel));
        assert.ok(JSON.parse(text).error);
      }
    }
  } finally { globalThis.fetch = previousFetch; }
});
