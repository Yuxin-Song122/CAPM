import { mkdir, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Publish only the PWA shell. Never include the local Node service, data files,
// browser test backups, Git metadata, or credentials in an Internet deployment.
const root = new URL('../', import.meta.url);
const output = new URL('../dist/', import.meta.url);
const assets = [
  'index.html', 'styles.css', 'favicon.svg', 'manifest.webmanifest', 'sw.js',
  'src/app.js', 'src/model.js', 'src/storage.js', 'src/device-store.js', 'src/pwa.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

const source = new Map();
for (const name of assets) {
  const info = await lstat(new URL(name, root));
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`静态发布文件不是普通文件：${name}`);
  source.set(name, await readFile(new URL(name, root)));
}
const html = source.get('index.html').toString('utf8');
if (!/<meta\s+name="xuri-storage"\s+content="device"\s*\/?\s*>/.test(html)) {
  throw new Error('静态发布入口必须显式使用 device 本地存储模式。');
}
if (/(?:src|href)=["']\/(?!\/)/.test(html)) {
  throw new Error('静态入口的资源路径须为相对路径，以便从 /CAPM/ 安装。');
}

// Fingerprint the exact bytes that will be published. A shell change always gets
// a separate cache; sw.js is excluded so replacing its cache constant is stable.
const hash = createHash('sha256');
for (const name of assets.filter((name) => name !== 'sw.js')) {
  hash.update(name).update('\0').update(source.get(name)).update('\0');
}
const fingerprint = hash.digest('hex');
const worker = source.get('sw.js').toString('utf8');
const cacheDeclaration = /^const CACHE_NAME = .*;$/m;
if (!cacheDeclaration.test(worker)) throw new Error('Service Worker 缺少可生成的缓存版本。');
source.set('sw.js', Buffer.from(worker.replace(cacheDeclaration, () => 'const CACHE_NAME = `${CACHE_PREFIX}build-' + fingerprint + '`;')));

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of assets) {
  const target = new URL(name, output);
  await mkdir(new URL('./', target), { recursive: true });
  await writeFile(target, source.get(name));
}
await writeFile(new URL('.nojekyll', output), '');

// An explicit allowlist is also checked after copying: data must never appear.
const published = [];
async function walk(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await walk(new URL(entry.name + '/', directory), name + '/');
    else published.push(name);
  }
}
await walk(output);
if (published.length !== assets.length + 1 || published.some((name) => name !== '.nojekyll' && !assets.includes(name))) {
  throw new Error('发布目录包含未批准的文件。');
}
console.log(`PWA 静态发布目录：${fileURLToPath(output)}\n共 ${published.length} 个文件；不包含 API 服务或个人数据。\n离线资源版本：${fingerprint.slice(0, 12)}`);
