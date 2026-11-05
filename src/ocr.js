// Image bytes stay in this page and its same-origin OCR worker. This adapter
// deliberately uses the pinned Tesseract.js 6.0.1 worker protocol directly so
// every initialization error and timeout can terminate the owned native Worker.
const ASSET_ROOT = new URL('../vendor/ocr/', import.meta.url);
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;
const MAX_SIDE = 2000;
let busy = false;

const userError = (message) => Object.assign(new Error(message), { userMessage: true });
function progress(callback, value, status) {
  try { callback({ progress: Math.max(0, Math.min(1, value)), status }); }
  catch { /* Progress rendering cannot interrupt worker cleanup. */ }
}
function readDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(userError('无法读取这张图片，请重新选择。'));
    reader.readAsDataURL(file);
  });
}
async function imageBytes(file) {
  const source = await readDataURL(file);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(userError('这张图片无法解码，请改用 PNG、JPEG 或 WebP 截图。'));
      image.src = source;
    });
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > MAX_PIXELS) {
      throw userError('图片尺寸过大，请裁剪到通知正文后再识别（最多 2400 万像素）。');
    }
    const scale = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    try {
      const context = canvas.getContext('2d');
      if (!context) throw userError('当前浏览器无法处理图片，请使用 Safari 并重新打开应用。');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw userError('图片处理未完成，请选择较小的清晰截图。');
      return new Uint8Array(await blob.arrayBuffer());
    } finally { canvas.width = 0; canvas.height = 0; }
  } finally { image.src = ''; }
}

export async function recognizeNotificationImage(file, { onProgress = () => {} } = {}) {
  if (!(file instanceof Blob) || !file.size) throw userError('请先选择一张通知图片。');
  if (/heic|heif/i.test(file.type || '') || /\.(?:heic|heif)$/i.test(file.name || '')) {
    throw userError('暂不支持 HEIC／HEIF 照片，请在 iPhone 上截屏，选择 PNG 或 JPEG 图片。');
  }
  if (!/^image\/(?:png|jpe?g|webp)$/i.test(file.type || '') && !(!file.type && /\.(?:png|jpe?g|webp)$/i.test(file.name || ''))) {
    throw userError('请选择 PNG、JPEG 或 WebP 图片。');
  }
  if (file.size > MAX_FILE_BYTES) throw userError('图片超过 15 MB，请裁剪到通知正文后再识别。');
  if (!('Worker' in globalThis) || !('WebAssembly' in globalThis)) throw userError('当前浏览器不支持本地图片识别，请使用新版 Safari。');
  if (busy) throw userError('正在识别另一张图片，请等待完成后再试。');
  busy = true;
  let worker;
  let sequence = 0;
  const jobs = new Map();
  const rejectAll = (error) => {
    for (const job of jobs.values()) { clearTimeout(job.timer); job.reject(error); }
    jobs.clear();
  };
  const request = (action, payload, begin, span, label) => new Promise((resolve, reject) => {
    const jobId = `ocr-${++sequence}`;
    const timer = setTimeout(() => {
      jobs.delete(jobId);
      reject(userError('图片识别等待超时，请保持联网并使用清晰、较小的通知截图重试。'));
    }, 120000);
    jobs.set(jobId, { resolve, reject, timer, begin, span, label });
    worker.postMessage({ workerId: 'xuri-notice-ocr', jobId, action, payload });
  });
  try {
    progress(onProgress, 0, '正在读取图片');
    const image = await imageBytes(file);
    // An explicit same-origin URL avoids the library's Blob-worker and CDN
    // defaults. The owned worker is always terminated in finally below.
    worker = new Worker(new URL('worker.min.js', ASSET_ROOT).href);
    worker.onerror = (event) => {
      event.preventDefault();
      rejectAll(userError('图片识别资源未能加载。首次使用需要联网，请保持联网后重试。'));
    };
    worker.onmessageerror = () => rejectAll(userError('图片识别通信失败，请重新选择图片后再试。'));
    worker.onmessage = ({ data }) => {
      const job = jobs.get(data?.jobId);
      if (!job) return;
      if (data.status === 'progress') {
        progress(onProgress, job.begin + job.span * (Number(data.data?.progress) || 0), job.label);
      } else {
        clearTimeout(job.timer);
        jobs.delete(data.jobId);
        if (data.status === 'resolve') job.resolve(data.data);
        else job.reject(userError('本地图片识别未完成。请保持联网，首次下载资源后再试；也可直接粘贴通知文字。'));
      }
    };
    progress(onProgress, 0.02, '正在准备本地识别引擎');
    await request('load', { options: { lstmOnly: true, corePath: new URL('core/', ASSET_ROOT).href, logging: false } }, 0.02, 0.18, '正在准备本地识别引擎');
    await request('loadLanguage', { langs: ['chi_sim', 'eng'], options: { langPath: new URL('lang/', ASSET_ROOT).href, cacheMethod: 'none', gzip: true, lstmOnly: true } }, 0.2, 0.25, '正在准备中文识别资源，首次使用需下载');
    await request('initialize', { langs: ['chi_sim', 'eng'], oem: 1, config: {} }, 0.45, 0.1, '正在初始化图片识别');
    const result = await request('recognize', { image, options: {}, output: { text: true } }, 0.55, 0.45, '正在识别图片文字');
    const text = String(result?.text || '').replace(/([\u3400-\u9fff0-9])[ \t]+(?=[\u3400-\u9fff0-9])/g, '$1').trim();
    if (!text) throw userError('未识别出文字，请裁剪通知正文、提高截图清晰度，或直接粘贴文字。');
    progress(onProgress, 1, '图片识别完成，请核对文字');
    return text;
  } catch (error) {
    if (error?.userMessage) throw error;
    throw userError('图片识别未完成，请保持联网并选择清晰截图重试。');
  } finally {
    rejectAll(userError('图片识别已结束。'));
    worker?.terminate();
    busy = false;
  }
}
