import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const root = new URL('../vendor/ocr/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const digest = (algorithm, data, encoding = 'hex') => createHash(algorithm).update(data).digest(encoding);
function download(url) {
  // curl inherits the normal system/session proxy and CA trust. No credentials
  // are requested or supplied for these public, version-pinned source files.
  return execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--max-time', '120', url], { maxBuffer: 64 * 1024 * 1024 });
}
function member(archive, wanted) {
  const data = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const string = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '');
    const prefix = string(345, 155);
    const name = (prefix ? `${prefix}/` : '') + string(0, 100);
    const bytes = Number.parseInt(string(124, 12).trim(), 8) || 0;
    const start = offset + 512;
    if (name === wanted && [0, 48].includes(header[156])) return data.subarray(start, start + bytes);
    offset = start + Math.ceil(bytes / 512) * 512;
  }
  throw new Error(`固定归档中缺少文件：${wanted}`);
}
for (const source of manifest.sources) {
  const entries = manifest.files.filter((file) => file.package === source.name);
  if (!entries.length) continue;
  let needed = false;
  for (const file of entries) {
    try {
      if (digest('sha256', await readFile(new URL(file.path, root))) !== file.sha256) needed = true;
    } catch { needed = true; }
  }
  if (!needed) continue;
  const downloaded = download(source.url);
  let archive = downloaded;
  if (source.kind === 'github-blob') {
    archive = Buffer.from(JSON.parse(downloaded.toString()).content, 'base64');
  } else if (`sha512-${digest('sha512', archive, 'base64')}` !== source.integrity) {
    throw new Error(`归档完整性校验失败：${source.name}`);
  }
  for (const file of entries) {
    if (!/^[a-zA-Z0-9_.\/-]+$/.test(file.path) || file.path.startsWith('/') || file.path.split('/').includes('..')) throw new Error('清单包含无效路径');
    const data = source.kind === 'github-blob' ? archive : member(archive, file.archiveMember);
    if (data.length !== file.bytes || digest('sha256', data) !== file.sha256) throw new Error(`文件完整性校验失败：${file.path}`);
    const destination = new URL(file.path, root);
    await mkdir(new URL('./', destination), { recursive: true });
    await writeFile(destination, data);
  }
}
for (const file of manifest.files) {
  const data = await readFile(new URL(file.path, root));
  if (data.length !== file.bytes || digest('sha256', data) !== file.sha256) throw new Error(`文件完整性校验失败：${file.path}`);
}
console.log(`OCR 同源资源校验通过：${manifest.files.length} 个文件。`);
