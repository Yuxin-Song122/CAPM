export class StorageError extends Error {
  constructor(message, status, current) { super(message); this.status = status; this.current = current; }
}
async function request(options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('/api/state', { cache: 'no-store', ...options, signal: controller.signal });
    const result = await response.json();
    if (!response.ok) throw new StorageError(result.error || '读取或保存数据失败。', response.status, result.current);
    return result;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('无法连接本机服务。请保持启动窗口打开，再重试；本次操作未确认写入文件。', 0);
  } finally { clearTimeout(timeout); }
}
export const readDisk = () => isDeviceStorage ? readDevice() : request();
export const writeDisk = (state, revision) => isDeviceStorage ? writeDevice(state, revision) : request({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, revision }) });
import { readDevice, writeDevice } from './device-store.js';
export const isDeviceStorage = document.querySelector('meta[name="xuri-storage"]')?.content !== 'disk';
