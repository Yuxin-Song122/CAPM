import { validateSnapshot } from './model.js';

const DATABASE = 'xuri-device-v1';
const TABLE = 'snapshots';
const PATH = '此设备 · 本地存储（IndexedDB）';
let connection;
function open() {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(TABLE);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('本地存储被其他页面占用，请关闭其他序日页面后重试。'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); connection = null; };
      resolve(db);
    };
  }).catch((error) => { connection = null; throw error; });
  return connection;
}
function wrap(record) {
  return { state: record ? validateSnapshot(record.state) : null, revision: record?.revision || 'missing', storagePath: PATH, mode: 'device' };
}
function explain(error) {
  if (error?.status) return error;
  const message = error?.name === 'QuotaExceededError'
    ? '设备存储空间不足，本次修改未保存。请先导出备份，再清理存储空间。'
    : `无法读写此设备的本地存储：${error?.message || '浏览器不支持 IndexedDB'}。请保留备份并检查浏览器设置。`;
  return new Error(message);
}
export async function readDevice() {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(TABLE, 'readonly');
      const request = transaction.objectStore(TABLE).get('current');
      transaction.oncomplete = () => {
        try { resolve(wrap(request.result)); } catch (error) { reject(error); }
      };
      transaction.onabort = () => reject(transaction.error);
    });
  } catch (error) { throw explain(error); }
}
export async function writeDevice(input, expectedRevision) {
  try {
    const state = validateSnapshot(input);
    if (new Blob([JSON.stringify(state)]).size > 5 * 1024 * 1024) throw new Error('数据超过 5 MB，请减少备注内容后重试');
    const db = await open();
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(TABLE, 'readwrite');
      const table = transaction.objectStore(TABLE);
      const request = table.get('current');
      let result;
      let failure;
      request.onsuccess = () => {
        try {
          const current = wrap(request.result);
          if (current.revision !== expectedRevision) {
            failure = new Error('其他页面已更新数据，本次修改未保存。请重新打开编辑。');
            failure.status = 409; failure.current = current;
            transaction.abort(); return;
          }
          const record = { state, revision: crypto.randomUUID() };
          if (request.result) table.put(request.result, 'previous');
          table.put(record, 'current');
          result = wrap(record);
        } catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failure || transaction.error);
    });
  } catch (error) { throw explain(error); }
}
