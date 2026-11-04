import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createStore, defaultDataDir, StoreError, MAX_BYTES } from './server/store.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const port = Number(option('--port', process.env.PORT || 3000));
const host = option('--host', process.env.HOST || '127.0.0.1');
const root = new URL('./', import.meta.url);
const dataDir = option('--data-dir', process.env.DATEJOB_DATA_DIR || defaultDataDir(process.platform, fileURLToPath(root)));
if (!Number.isInteger(port) || port < 1 || port > 65535 || !['127.0.0.1', 'localhost', '::1'].includes(host) || !dataDir) {
  console.error('启动参数无效。示例：npm start -- --port 3000 --data-dir "D:\\datejob"');
  process.exit(1);
}
let store;
try { store = await createStore(dataDir); }
catch (error) {
  console.error(`无法使用数据目录 ${dataDir}：${error.message}\n请确认 D 盘存在且目录可写，或用 --data-dir 指定目录。不会改为浏览器保存。`);
  process.exit(1);
}
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/src/app.js', ['src/app.js', 'text/javascript; charset=utf-8']],
  ['/src/model.js', ['src/model.js', 'text/javascript; charset=utf-8']],
  ['/src/storage.js', ['src/storage.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
async function api(req, res) {
  const authority = new URL(`http://${req.headers.host || 'invalid'}`);
  const origin = req.headers.origin;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(authority.hostname)
    || (origin && origin !== authority.origin)
    || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) {
    throw new StoreError('请通过本机地址打开序日。', 403);
  }
  if (req.method === 'GET') { json(res, 200, await store.read()); return; }
  if (req.method !== 'PUT') { res.setHeader('Allow', 'GET, PUT'); json(res, 405, { error: '不支持的请求方法。' }); return; }
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new StoreError('请求须为 JSON 格式。', 415);
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BYTES + 1024) throw new StoreError('数据超过 5 MB，未保存。', 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new StoreError('数据不是有效的 JSON。', 400); }
  if (!body || typeof body !== 'object') throw new StoreError('请求缺少数据。', 400);
  json(res, 200, await store.write(body.state, body.revision));
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try {
    const requestPath = new URL(req.url, 'http://localhost').pathname;
    if (requestPath === '/api/state') { await api(req, res); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    const file = files.get(requestPath);
    if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('页面不存在'); return; }
    const body = await readFile(new URL(file[0], root));
    res.writeHead(200, { 'Content-Type': file[1] });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (!res.headersSent) json(res, error.status || 500, { error: error instanceof StoreError ? error.message : '请求失败，请检查本机服务窗口。', ...(error.current ? { current: error.current } : {}) });
    else res.end();
  }
});
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `端口 ${port} 已被占用。更新程序后请先停止旧服务，再重新启动。也可使用 npm start -- --port ${port + 1}。`
    : `启动失败：${error.message}`);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  const address = `http://127.0.0.1:${port}`;
  console.log(`\n  序日 · 日常与计划\n  地址：${address}\n  数据文件：${store.filename}\n  上一版本备份：${store.backupPath}\n  每次操作成功后写入文件。按 Ctrl+C 停止服务。\n`);
  if (process.platform === 'win32' && args.includes('--open')) {
    const child = spawn('cmd.exe', ['/c', 'start', '', address], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => console.log(`请手动打开 ${address}`));
    child.unref();
  }
});
