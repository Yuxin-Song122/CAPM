// A public HTTPS entry for the existing reminder Worker. The service binding is
// the only destination; incoming URLs can never choose another upstream host.
const APP_ORIGIN = 'https://yuxin-song122.github.io';

function unavailable(request) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
  });
  // Keep failures readable from the existing app without reflecting arbitrary
  // origins, credentials, provider errors, or configuration details.
  if (request.headers.get('Origin') === APP_ORIGIN) {
    headers.set('Access-Control-Allow-Origin', APP_ORIGIN);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  }
  return new Response(JSON.stringify({ error: '提醒服务暂时不可用，请稍后重试。' }), {
    status: 503,
    headers,
  });
}

export async function handleGatewayRequest(request, env) {
  const backend = env?.REMINDER_BACKEND;
  if (!backend || typeof backend.fetch !== 'function') return unavailable(request);
  try {
    // Forward the original request, including method, path, headers and stream.
    // The existing Worker owns authentication, CORS and all reminder processing.
    return await backend.fetch(request);
  } catch {
    return unavailable(request);
  }
}

export default { fetch: handleGatewayRequest };
