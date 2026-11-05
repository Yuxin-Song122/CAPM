import { validateSnapshot } from './model.js';

const DATABASE = 'xuri-device-v1';
// Keep the database and records in place. The internal version prevents an old
// client from reopening v1 and dropping fields that it does not understand.
const DATABASE_VERSION = 2;
const TABLE = 'snapshots';
const PATH = '此设备 · 本地存储（IndexedDB）';
let connection;
function open() {
  if (connection) return connection;
  let pending;
  pending = new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(DATABASE, DATABASE_VERSION);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.onupgradeneeded = () => {
      // A blocked request cannot be cancelled immediately. If it eventually
      // resumes after rejection, abort its upgrade instead of writing anything.
      if (settled) { request.transaction.abort(); return; }
      if (!request.result.objectStoreNames.contains(TABLE)) request.result.createObjectStore(TABLE);
    };
    request.onerror = () => fail(request.error);
    request.onblocked = () => fail(new Error('本地存储被其他页面占用，请关闭其他序日页面后重试，原有数据保留。'));
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      settled = true;
      db.onversionchange = () => { db.close(); if (connection === pending) connection = null; };
      resolve(db);
    };
  }).catch((error) => { if (connection === pending) connection = null; throw error; });
  connection = pending;
  return connection;
}
function wrap(record) {
  return { state: record ? validateSnapshot(record.state) : null, revision: record?.revision || 'missing', storagePath: PATH, mode: 'device' };
}
function explain(error) {
  if (error?.status) return error;
  if (error?.name === 'VersionError') return new Error('此页面版本较旧，请更新应用后再编辑，原有数据保留。');
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
