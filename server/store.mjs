import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateSnapshot } from '../src/model.js';

export const MAX_BYTES = 5 * 1024 * 1024;
export class StoreError extends Error {
  constructor(message, status = 500) { super(message); this.status = status; }
}
export function defaultDataDir(platform = process.platform, projectDir = process.cwd()) {
  return platform === 'win32' ? 'D:\\datejob' : path.resolve(projectDir, '..', 'datejob');
}
const revisionOf = (raw) => createHash('sha256').update(raw).digest('hex');

export async function createStore(directory) {
  const dataDir = path.resolve(directory);
  await fs.mkdir(dataDir, { recursive: true });
  const filename = path.join(dataDir, 'data.json');
  const backupPath = path.join(dataDir, 'data.previous.json');
  const lockPath = path.join(dataDir, '.write.lock');
  let queue = Promise.resolve();
  async function read() {
    let raw;
    try { raw = await fs.readFile(filename, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { state: null, revision: 'missing', storagePath: filename };
      throw new StoreError(`无法读取 ${filename}，请检查目录权限。原文件未被修改。`);
    }
    try {
      if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('文件超过 5 MB');
      return { state: validateSnapshot(JSON.parse(raw)), revision: revisionOf(raw), storagePath: filename };
    } catch {
      throw new StoreError(`数据文件 ${filename} 无法解析，已停止写入。请先保留该文件，再用 data.previous.json 或已导出的备份恢复。`);
    }
  }
  async function atomicWrite(target, content) {
    const temporary = path.join(dataDir, `.data-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close(); handle = null;
      await fs.rename(temporary, target);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async function lock() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await fs.open(lockPath, 'wx', 0o600);
        try { await handle.writeFile(String(process.pid)); }
        finally { await handle.close(); }
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const pid = Number(await fs.readFile(lockPath, 'utf8'));
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new StoreError('写入锁异常，请停止所有序日服务后移除 datejob/.write.lock。', 409);
          try { process.kill(pid, 0); }
          catch (probe) {
            if (probe.code === 'ESRCH') { await fs.unlink(lockPath); continue; }
          }
        } catch (probe) { if (probe.code === 'ENOENT') continue; throw probe; }
        throw new StoreError('另一个服务正在写入同一数据文件，请稍后重试。', 409);
      }
    }
    throw new StoreError('未取得数据文件写入锁，请重试。', 409);
  }
  function write(input, expectedRevision) {
    const operation = queue.then(async () => {
      let state;
      try { state = validateSnapshot(input); }
      catch (error) { throw new StoreError(error.message, 400); }
      const raw = JSON.stringify(state, null, 2) + '\n';
      if (Buffer.byteLength(raw) > MAX_BYTES) throw new StoreError('数据超过 5 MB，未保存。请减少较长的备注后重试。', 413);
      try { await lock(); }
      catch (error) {
        if (error instanceof StoreError) throw error;
        throw new StoreError(`无法写入 ${filename}，本次修改未保存。请检查磁盘空间和目录权限。`);
      }
      try {
        const current = await read();
        if (typeof expectedRevision !== 'string' || current.revision !== expectedRevision) {
          const error = new StoreError('数据已被其他页面更新，当前修改未保存。请重新打开编辑。', 409);
          error.current = current;
          throw error;
        }
        if (current.state !== null) {
          const previous = await fs.readFile(filename, 'utf8');
          if (revisionOf(previous) !== current.revision) throw new StoreError('数据文件刚刚被修改，请重新载入后保存。', 409);
          await atomicWrite(backupPath, previous);
        }
        await atomicWrite(filename, raw);
        return { state, revision: revisionOf(raw), storagePath: filename };
      } catch (error) {
        if (error instanceof StoreError) throw error;
        throw new StoreError(`无法写入 ${filename}，本次修改未保存。请检查磁盘空间和目录权限。`);
      } finally { await fs.unlink(lockPath); }
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return { read, write, filename, backupPath };
}
