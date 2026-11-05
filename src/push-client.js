// Notification settings are separate from project/calendar data and its backups.
export const DEFAULT_PUSH_BACKEND_URL = 'https://xuri-push.2832667234.workers.dev';
const DB_NAME = 'xuri-push-settings-v1';
let settings = null;
let getItems = () => [];
let working = false;
let pending = false;
let lastFingerprint = '';
let status = { connected: false, syncing: false, error: '', lastSyncedAt: null, scheduledJobs: 0 };
const emit = () => document.dispatchEvent(new CustomEvent('xuri:push-status'));
export const pushStatus = () => ({ ...status, backendUrl: settings?.backendUrl || '' });
async function preferences(write, value) {
  return await new Promise((resolve, reject) => {
    const opening = indexedDB.open(DB_NAME, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('settings');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction('settings', write ? 'readwrite' : 'readonly');
      const table = tx.objectStore('settings');
      const request = write ? table.put(value, 'current') : table.get('current');
      tx.oncomplete = () => { const result = request.result; db.close(); resolve(result); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
async function reserveGeneration() {
  return await new Promise((resolve, reject) => {
    const opening = indexedDB.open(DB_NAME, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('settings');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction('settings', 'readwrite');
      const table = tx.objectStore('settings');
      const request = table.get('generation');
      let next;
      request.onsuccess = () => { next = (Number(request.result) || 0) + 1; table.put(next, 'generation'); };
      tx.oncomplete = () => { db.close(); resolve(next); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
async function updateConnection(expectedToken, updates, remove = false) {
  return await new Promise((resolve, reject) => {
    const opening = indexedDB.open(DB_NAME, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('settings');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction('settings', 'readwrite');
      const table = tx.objectStore('settings');
      const request = table.get('current');
      let next;
      request.onsuccess = () => {
        const current = request.result;
        if ((current?.deviceToken || null) !== expectedToken) return;
        next = remove ? null : { ...current, ...updates };
        table.put(next, 'current');
      };
      tx.oncomplete = () => { db.close(); resolve(next); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
async function connectionLock(action) {
  if (navigator.locks) return await navigator.locks.request('xuri-push-connection', { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('另一个页面正在修改提醒连接，请稍后重试。');
    return await action();
  });
  return await action();
}
export function pushSupport() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && !(navigator.standalone || matchMedia('(display-mode: standalone)').matches)) return { supported: false, reason: 'iPhone 请先用 Safari 添加到主屏幕，再从主屏幕应用中启用提醒（需要 iOS 16.4 或以上）。' };
  if (!isSecureContext || !('Notification' in globalThis) || !('PushManager' in globalThis) || !('serviceWorker' in navigator)) return { supported: false, reason: '当前浏览器不支持系统推送。iPhone 需要 iOS 16.4 或以上，并从主屏幕打开 HTTPS 应用。' };
  return { supported: true, reason: '' };
}
function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请填写有效的 HTTPS 推送后台网址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) throw new Error('后台地址须为 HTTPS，且不包含账号、查询参数或其他端口。');
  return url.href.replace(/\/$/, '');
}
async function api(base, route, { token, method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(base + route, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal, cache: 'no-store' });
    const value = response.status === 204 ? null : await response.json();
    if (!response.ok) { const error = new Error(value?.error || (response.status === 401 ? '后台认证失效，请重新连接。' : `推送后台返回错误 ${response.status}`)); error.stale = value?.stale === true; error.status = response.status; throw error; }
    return value;
  } catch (error) {
    if (error instanceof TypeError || error.name === 'AbortError') throw new Error('无法连接推送后台，请检查网络、HTTPS 地址和后台允许的网站来源。');
    throw error;
  } finally { clearTimeout(timeout); }
}
function keyBytes(value) {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
async function payload() {
  return (await getItems()).filter((item) => item.date && !item.completed).map((item) => ({ id: item.id, title: item.title, startAt: new Date(`${item.date}T${item.start}:00`).toISOString() })).filter((item) => Date.parse(item.startAt) > Date.now()).sort((a, b) => a.id.localeCompare(b.id));
}
export async function syncPush(force = false) {
  pending = true;
  if (working) return;
  working = true;
  try {
    settings = await preferences(false);
    status.connected = Boolean(settings?.deviceToken);
    while (pending && settings?.deviceToken) {
      pending = false;
      if (!navigator.onLine) throw new Error('当前离线：日程已保存在此设备，提醒变更尚未同步，后台仍可能按上次安排发送。联网后会重试。');
      const generation = await reserveGeneration();
      const items = await payload();
      const fingerprint = JSON.stringify(items);
      if (!force && fingerprint === lastFingerprint) continue;
      status.syncing = true; emit();
      const active = settings;
      const result = await api(active.backendUrl, '/schedule', { token: active.deviceToken, method: 'PUT', body: { items, generation } });
      lastFingerprint = fingerprint;
      const next = await updateConnection(active.deviceToken, { lastSyncedAt: new Date().toISOString(), scheduledJobs: result.scheduledJobs });
      if (next === undefined) { settings = await preferences(false); status.connected = Boolean(settings?.deviceToken); lastFingerprint = ''; continue; }
      settings = next;
      status = { ...status, connected: true, syncing: false, error: '', lastSyncedAt: settings.lastSyncedAt, scheduledJobs: settings.scheduledJobs };
      force = false;
    }
  } catch (error) { if (!error.stale) status.error = error.message; }
  finally { working = false; status.syncing = false; emit(); }
}
export async function initPush(itemsProvider) {
  getItems = itemsProvider;
  try {
    settings = await preferences(false);
    status = { ...status, connected: Boolean(settings?.deviceToken), lastSyncedAt: settings?.lastSyncedAt || null, scheduledJobs: settings?.scheduledJobs || 0 };
  } catch { status.error = '无法读取提醒设置；项目和日程数据不受影响。'; }
  emit();
  window.addEventListener('online', () => syncPush(true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncPush(true); });
  await syncPush(true);
}
export async function connectPush(url, pairingSecret) {
  const support = pushSupport();
  if (!support.supported) throw new Error(support.reason);
  if (settings?.deviceToken) throw new Error('当前已有推送后台连接，请先停用后再连接新的后台。');
  const backendUrl = endpoint(url);
  if (!pairingSecret.trim()) throw new Error('请填写后台部署时设置的配对码。');
  // Call permission synchronously in the button's gesture, before any awaits (iOS).
  const permission = Notification.requestPermission();
  return await connectionLock(async () => {
  settings = await preferences(false);
  if (settings?.deviceToken) throw new Error('其他页面已连接后台，请先停用原连接。');
  const configRequest = api(backendUrl, '/config');
  const [allowed, config] = await Promise.all([permission, configRequest]);
  if (allowed !== 'granted') throw new Error('未获得系统通知权限。请在 iPhone 设置中允许「序日」发送通知后重试。');
  if (!config?.vapidPublicKey) throw new Error('后台尚未配置推送密钥，不能启用提醒。');
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration?.active) throw new Error('离线资源尚未准备完成，请等待「离线已就绪」后再启用系统提醒。');
  let subscription = await registration.pushManager.getSubscription();
  let existed = Boolean(subscription);
  const expectedKey = keyBytes(config.vapidPublicKey);
  const existingKey = subscription?.options?.applicationServerKey;
  if (subscription && existingKey && (new Uint8Array(existingKey).length !== expectedKey.length || new Uint8Array(existingKey).some((value, i) => value !== expectedKey[i]))) {
    await subscription.unsubscribe(); subscription = null; existed = false;
  }
  if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: expectedKey });
  let registered;
  try {
    registered = await api(backendUrl, '/devices', { method: 'POST', body: { pairingSecret: pairingSecret.trim(), subscription: subscription.toJSON() } });
    if (!registered?.deviceToken) throw new Error('后台没有返回设备凭证，连接失败。');
    const next = { backendUrl, deviceToken: registered.deviceToken, deviceId: registered.deviceId, lastSyncedAt: null, scheduledJobs: 0 };
    const saved = await updateConnection(null, next);
    if (saved === undefined) throw new Error('提醒连接已被其他页面更新，请重新打开设置。');
    settings = saved; status.connected = true; status.error = '';
  } catch (error) {
    if (registered?.deviceToken) await api(backendUrl, '/devices', { method: 'DELETE', token: registered.deviceToken }).catch(() => {});
    if (!existed) await subscription.unsubscribe().catch(() => {});
    throw error;
  }
  lastFingerprint = '';
  await syncPush(true);
  if (status.error) throw new Error(`设备已登记，但提醒安排尚未同步：${status.error}`);
  });
}
export async function disconnectPush() {
  return await connectionLock(async () => {
    const active = await preferences(false);
    if (!active?.deviceToken) { settings = null; status.connected = false; emit(); return; }
    try { await api(active.backendUrl, '/devices', { method: 'DELETE', token: active.deviceToken }); }
    catch (error) { if (error.status !== 401) throw error; }
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe().catch(() => {});
    await updateConnection(active.deviceToken, null, true);
    settings = await preferences(false);
    lastFingerprint = '';
    status = { connected: Boolean(settings?.deviceToken), syncing: false, error: '', lastSyncedAt: settings?.lastSyncedAt || null, scheduledJobs: settings?.scheduledJobs || 0 };
    emit();
  });
}
export async function testPush() {
  if (!settings?.deviceToken) throw new Error('请先连接推送后台。');
  await api(settings.backendUrl, '/test', { method: 'POST', token: settings.deviceToken });
}
