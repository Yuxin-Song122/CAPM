const indexURL = new URL('../index.html', import.meta.url);
const workerURL = new URL('../sw.js', import.meta.url);
const mobileMenuQuery = '(max-width: 680px), (max-width: 1024px) and (pointer: coarse)';
const diskStorage = document.querySelector('meta[name="xuri-storage"]')?.content === 'disk';
const status = {
  supported: Boolean(!diskStorage && globalThis.isSecureContext && 'serviceWorker' in navigator),
  ready: false,
  offline: !navigator.onLine,
  updateAvailable: false,
  standalone: Boolean(navigator.standalone || matchMedia('(display-mode: standalone)').matches),
  error: '',
};
let registration;
let initialization;
let requestedUpdate = false;

function emit() { document.dispatchEvent(new CustomEvent('xuri:pwa-status', { detail: pwaStatus() })); }
export function pwaStatus() { return { ...status }; }
async function inspect() {
  status.offline = !navigator.onLine;
  status.updateAvailable = Boolean(registration?.waiting);
  status.ready = Boolean(registration?.active && await caches.match(indexURL.href));
  emit();
}
export function initPwa() {
  if (initialization) return initialization;
  initialization = (async () => {
    if (diskStorage && 'serviceWorker' in navigator) {
      // The desktop file edition needs its running local API and live assets.
      // Remove a worker left by an earlier version without touching user data.
      try {
        const previous = await navigator.serviceWorker.getRegistration(new URL('../', import.meta.url).href);
        if ([previous?.active, previous?.waiting, previous?.installing].some((worker) => worker?.scriptURL === workerURL.href)) await previous.unregister();
      } catch { /* A worker is optional for the local file edition. */ }
    }
    if (!status.supported) { if (!diskStorage) status.error = '当前环境不支持离线安装，请用 Safari 打开 HTTPS 网址。'; emit(); return pwaStatus(); }
    try {
      registration = await navigator.serviceWorker.register(workerURL.href, { scope: new URL('../', import.meta.url).href, updateViaCache: 'none' });
      const watchInstallation = (installing) => {
        if (!installing) return;
        const changed = () => {
          if (installing.state === 'redundant' && !registration.active) {
            status.error = '离线资源准备失败，请联网刷新重试。';
          } else if (['installed', 'activated'].includes(installing.state)) status.error = '';
          if (['installed', 'activated', 'redundant'].includes(installing.state)) inspect().catch(() => {});
        };
        installing.addEventListener('statechange', changed);
        changed();
      };
      registration.addEventListener('updatefound', () => watchInstallation(registration.installing));
      // Registration may resolve after updatefound; watch an in-flight first install too.
      watchInstallation(registration.installing);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (requestedUpdate) location.reload();
        else inspect().catch(() => {});
      });
      navigator.serviceWorker.ready.then(() => inspect()).catch(() => {});
      await inspect();
    } catch {
      status.error = '离线资源准备失败，请保持联网并重新打开应用。';
      status.ready = false;
      emit();
    }
    return pwaStatus();
  })();
  return initialization;
}
export async function requestPwaUpdate() {
  await initPwa();
  if (!registration?.waiting) return false;
  requestedUpdate = true;
  registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  return true;
}
window.addEventListener('online', () => {
  inspect().catch(() => {});
  registration?.update().catch(() => {});
});
window.addEventListener('offline', () => inspect().catch(() => {}));

// The app rerenders its navigation. Keep the drawer's accessibility in sync
// without coupling its focus handling to project/calendar business state.
function initDrawer() {
  const media = matchMedia(mobileMenuQuery);
  let wasOpen = false;
  const focusable = (root) => [...root.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
    .filter((el) => el.getClientRects().length && !el.closest('[inert]'));
  function synchronize() {
    const sidebar = document.querySelector('.sidebar');
    const shell = document.querySelector('.main-shell');
    const toggle = document.querySelector('[data-action="toggle-sidebar"]');
    if (!sidebar) return;
    sidebar.id = 'project-sidebar';
    sidebar.tabIndex = -1;
    const open = media.matches && sidebar.classList.contains('is-open');
    if (toggle) {
      toggle.setAttribute('aria-controls', sidebar.id);
      toggle.setAttribute('aria-expanded', String(open));
    }
    sidebar.inert = media.matches && !open;
    if (media.matches) sidebar.setAttribute('aria-hidden', String(!open));
    else sidebar.removeAttribute('aria-hidden');
    if (shell) shell.inert = open;
    document.body.classList.toggle('project-menu-open', open);
    if (open && !wasOpen && !document.querySelector('dialog[open]')) (sidebar.querySelector('[data-action="close-sidebar"]') || focusable(sidebar)[0] || sidebar).focus({ preventScroll: true });
    if (!open && wasOpen && (document.activeElement === document.body || document.activeElement === sidebar)) toggle?.focus({ preventScroll: true });
    wasOpen = open;
  }
  const app = document.querySelector('#app');
  new MutationObserver(synchronize).observe(app, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  media.addEventListener('change', synchronize);
  document.addEventListener('keydown', (event) => {
    const sidebar = document.querySelector('.sidebar.is-open');
    if (!media.matches || !sidebar || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      document.querySelector('[data-action="close-sidebar"]')?.click();
      return;
    }
    if (event.key !== 'Tab') return;
    const options = focusable(sidebar);
    const first = options[0]; const last = options.at(-1);
    if (!first) { event.preventDefault(); sidebar.focus(); }
    else if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  });
  synchronize();
}

initDrawer();
initPwa();
