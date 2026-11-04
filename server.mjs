import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const port = Number(option('--port', process.env.PORT || 3000));
const host = option('--host', process.env.HOST || '127.0.0.1');
if (!Number.isInteger(port) || port < 1 || port > 65535 || !host) {
  console.error('端口须为 1–65535 的整数。用法：npm start -- --port 3000 --host 127.0.0.1');
  process.exit(1);
}

const root = new URL('./', import.meta.url);
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/src/app.js', ['src/app.js', 'text/javascript; charset=utf-8']],
  ['/src/model.js', ['src/model.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }
  const path = new URL(req.url, 'http://localhost').pathname;
  const file = files.get(path);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('页面不存在');
    return;
  }
  try {
    const body = await readFile(new URL(file[0], root));
    res.writeHead(200, { 'Content-Type': file[1] });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    console.error('读取静态文件失败：', error.message);
    res.writeHead(500).end('文件读取失败，请检查项目文件是否完整。');
  }
});
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `端口 ${port} 已被占用。请试试：npm start -- --port ${port + 1}`
    : `启动失败：${error.message}`);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(`\n  序日 · 日常与计划\n  请在浏览器打开 http://${host === '0.0.0.0' ? 'localhost' : host}:${port}\n  按 Ctrl+C 停止服务。修改网页文件后刷新即可。\n  项目目录：${fileURLToPath(root)}\n`);
});
