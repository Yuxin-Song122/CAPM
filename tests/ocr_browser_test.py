"""Real Chinese OCR and offline-resource checks in an isolated Chromium profile.

The fixture is generated locally with Canvas. This test does not mock Tesseract,
send an image to a server, or represent a physical iPhone/Safari verification.
Run after integrating the same-origin OCR files into the static build and SW.
"""
import base64
import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

from pwa_upgrade_test import READ_ALL


ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "test-results"


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".gz": "application/gzip",
    }

    def log_message(self, *_):
        pass

    def do_GET(self):
        self.server.request_paths.append(self.path)
        return super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        return super().end_headers()


MAKE_FIXTURE = """async () => {
  await document.fonts.load('48px "Noto Sans CJK SC"');
  const canvas = document.createElement('canvas');
  canvas.width = 1700; canvas.height = 530;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111111';
  ctx.font = '48px "Noto Sans CJK SC", "Noto Sans CJK", sans-serif';
  ctx.textBaseline = 'alphabetic';
  const lines = [
    '项目提交通知',
    '请按时提交研究报告。',
    '截止：2026年11月20日18:00',
    '地点：图书馆三楼'
  ];
  lines.forEach((line, index) => ctx.fillText(line, 65, 100 + index * 105));
  window._ocrFixture = new File(
    [await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))],
    'synthetic-notice.png', { type: 'image/png' }
  );
  return canvas.toDataURL('image/png').split(',')[1];
}"""

RECOGNIZE = """async () => {
  const { recognizeNotificationImage } = await import('./src/ocr.js');
  window._ocrProgress = [];
  let timer;
  try {
    return await Promise.race([
      recognizeNotificationImage(window._ocrFixture, {
        onProgress: value => window._ocrProgress.push(value)
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('真实OCR测试超过90秒')), 90000);
      })
    ]);
  } finally { clearTimeout(timer); }
}"""


def check_text(text):
    assert isinstance(text, str) and text.strip(), "OCR没有返回文字"
    compact = re.sub(r"\s+", "", text).replace("：", ":")
    assert "项目提交通知" in compact, f"项目标题识别不正确: {text}"
    assert "2026年11月20日18:00" in compact, f"截止日期或时间识别不正确: {text}"
    assert "图书馆三楼" in compact, f"地点识别不正确: {text}"


def check_progress(page):
    events = page.evaluate("window._ocrProgress")
    assert events, "没有提供OCR进度"
    assert all(
        isinstance(item, dict)
        and isinstance(item.get("progress"), (float, int))
        and 0 <= item["progress"] <= 1
        and isinstance(item.get("status"), str)
        and item["status"]
        for item in events
    ), events


def run():
    subprocess.run(["node", "scripts/build-static.mjs"], cwd=ROOT, check=True)
    assert (ROOT / "dist/src/ocr.js").is_file(), "静态构建缺少OCR入口"
    assert (ROOT / "dist/vendor/ocr/manifest.json").is_file(), "静态构建缺少同源OCR资源清单"
    RESULTS.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="xuri-real-ocr-") as temporary:
        temp = Path(temporary)
        public = temp / "web" / "CAPM"
        public.parent.mkdir()
        shutil.copytree(ROOT / "dist", public)
        server = ThreadingHTTPServer(
            ("127.0.0.1", 0), functools.partial(Handler, directory=str(public.parent))
        )
        server.request_paths = []
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}/CAPM/"
        origin = urlsplit(base).netloc
        blocked = []
        requests = []
        errors = []
        try:
            with sync_playwright() as playwright:
                context = playwright.chromium.launch_persistent_context(
                    str(temp / "profile"),
                    executable_path=shutil.which("chromium") or "/usr/bin/chromium",
                    headless=True,
                    args=["--no-sandbox"],
                    viewport={"width": 390, "height": 844},
                    is_mobile=True,
                    has_touch=True,
                    locale="zh-CN",
                    timezone_id="Asia/Shanghai",
                    user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
                )
                context.set_default_timeout(15000)

                def guard(route):
                    request = route.request
                    parsed = urlsplit(request.url)
                    if parsed.scheme in ("http", "https") and parsed.netloc != origin:
                        blocked.append(request.url)
                        route.abort("blockedbyclient")
                    else:
                        route.continue_()

                context.route("**/*", guard)
                context.on("request", lambda request: requests.append({
                    "url": request.url,
                    "method": request.method,
                    "body": request.post_data,
                }))
                page = context.pages[0]
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(base)
                expect(page.get_by_role("heading", level=1)).to_have_text("日历计划")
                page.wait_for_function("async () => (await import('./src/pwa.js')).pwaStatus().ready")
                page.wait_for_function("() => Boolean(navigator.serviceWorker.controller)")

                # A real temporary project protects non-empty business data during OCR.
                page.evaluate("""async () => {
                  const { readDisk, writeDisk } = await import('./src/storage.js');
                  const current = await readDisk();
                  await writeDisk({version:1, projects:[{
                    id:'ocr-kept-project', name:'图片识别不能覆盖的项目', goal:'保留这个目标',
                    deadline:'2026-12-31', color:'sage', archived:false, isDemo:false
                  }], items:[{
                    id:'ocr-kept-item', title:'图片识别不能覆盖的日程', notes:'原始备注仍保留',
                    projectId:'ocr-kept-project', date:'2026-11-20', start:'09:00', end:'10:00',
                    completed:true, isDemo:false
                  }]}, current.revision);
                }""")
                before = page.evaluate(READ_ALL)
                # writeDisk above simulates another page. Let the normal polling
                # update the app's in-memory revision before opening an editor;
                # otherwise its intentional conflict handling closes that draft.
                expect(page.locator('.project-nav')).to_contain_text('图片识别不能覆盖的项目')

                heic = page.evaluate("""async () => {
                  try {
                    await (await import('./src/ocr.js')).recognizeNotificationImage(
                      new File(['synthetic-unsupported-format'], 'notice.heic', {type:'image/heic'})
                    );
                    return '';
                  } catch (error) { return error.message; }
                }""")
                assert heic and re.search(r"[\u4e00-\u9fff]", heic), heic
                assert re.search(r"HEIC|HEIF|PNG|JPEG|转换", heic, re.IGNORECASE), heic

                fixture = page.evaluate(MAKE_FIXTURE)
                (RESULTS / "ocr-fixture.png").write_bytes(base64.b64decode(fixture))
                online = page.evaluate(RECOGNIZE)
                check_text(online)
                check_progress(page)
                assert page.evaluate(READ_ALL) == before, "图片识别改变了原始项目、日程或revision"
                assert any("/vendor/ocr/" in item["url"] for item in requests), "没有加载本地OCR引擎资源"

                # Exercise the actual image picker and notice preview, while
                # keeping an ordinary unsaved schedule draft underneath it.
                page.get_by_role("button", name="新建日程", exact=True).click()
                modal = page.locator("#modal")
                expect(modal).to_be_visible()
                modal.locator("[name=title]").fill("图片解析时保留的日程草稿")
                modal.locator("[name=location]").fill("尚未保存的地点草稿")
                modal.locator("#notice-tools > summary").click()
                modal.locator("#notice-image").set_input_files({
                    "name": "synthetic-notice.png",
                    "mimeType": "image/png",
                    "buffer": base64.b64decode(fixture),
                })
                expect(modal.locator("#notice-status")).to_contain_text("文字已识别", timeout=90000)
                check_text(modal.locator("[name=noticeInput]").input_value())
                try:
                    modal.locator('[data-action="notice-analyze"]').click()
                except Exception:
                    diagnostics = page.evaluate("""() => {
                      const modal = document.querySelector('#modal');
                      const details = document.querySelector('#notice-tools');
                      const button = document.querySelector('[data-action="notice-analyze"]');
                      const elements = [];
                      for (let current = button; current; current = current.parentElement) {
                        const style = getComputedStyle(current);
                        const rect = current.getBoundingClientRect();
                        elements.push({tag:current.tagName,id:current.id,hidden:current.hidden,
                          display:style.display,visibility:style.visibility,overflow:style.overflow,
                          rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}});
                      }
                      return {modalOpen:modal?.open,detailsOpen:details?.open,
                        active:document.activeElement?.outerHTML,
                        scrollTop:modal?.scrollTop,status:document.querySelector('#notice-status')?.textContent,
                        elements};
                    }""")
                    print('OCR_UI_FAILURE', json.dumps(diagnostics, ensure_ascii=False))
                    page.screenshot(path=str(RESULTS / 'ocr-ui-failure.png'), full_page=True)
                    raise
                planning = page.locator("#planning-modal")
                expect(planning).to_be_visible()
                expect(planning.locator("[name=deadline]")).to_have_value("2026-11-20")
                expect(planning.locator("[name=deadlineTime]")).to_have_value("18:00")
                expect(planning.locator("[name=location]")).to_have_value("图书馆三楼")
                planning.get_by_role("button", name="取消", exact=True).click()
                expect(planning).not_to_be_visible()
                expect(modal).to_be_visible()
                expect(modal.locator("[name=title]")).to_have_value("图片解析时保留的日程草稿")
                expect(modal.locator("[name=location]")).to_have_value("尚未保存的地点草稿")
                modal.get_by_role("button", name="关闭弹窗", exact=True).click()
                expect(modal).not_to_be_visible()
                assert page.evaluate(READ_ALL) == before, "取消图片解析预览或日程草稿后仍改动了业务数据"

                # Chromium may perform SW update checks outside the page's
                # emulated offline network session. Stop the real HTTP server
                # as well: the second recognition must use cached resources.
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)
                server_requests = len(server.request_paths)
                context.set_offline(True)
                page.reload()
                expect(page.get_by_role("heading", level=1)).to_be_visible()
                page.wait_for_function("() => Boolean(navigator.serviceWorker.controller)")
                page.evaluate(MAKE_FIXTURE)
                offline = page.evaluate(RECOGNIZE)
                check_text(offline)
                check_progress(page)
                assert len(server.request_paths) == server_requests, (
                    "离线重新打开OCR仍访问了服务器: "
                    + repr(server.request_paths[server_requests:])
                    + '; OCR cache: '
                    + repr(page.evaluate("async () => await Promise.all((await caches.keys()).filter(name => name.startsWith('xuri-ocr-')).map(async name => ({name, urls:(await (await caches.open(name)).keys()).map(request => request.url)})))"))
                )
                assert page.evaluate(READ_ALL) == before, "离线OCR改变了原始项目、日程或revision"

                assert not blocked, f"OCR试图访问第三方网址: {blocked}"
                assert all(
                    urlsplit(request["url"]).scheme not in ("http", "https")
                    or (urlsplit(request["url"]).netloc == origin and request["method"] in ("GET", "HEAD") and request["body"] is None)
                    for request in requests
                ), "存在外部请求或上传图片/业务数据的HTTP请求"
                assert not errors, errors
                (RESULTS / "ocr-recognized.txt").write_text(online, encoding="utf-8")
                context.close()
                print("PASS 真实中文OCR识别标题、截止日期和时间、地点；HEIC返回中文转换提示")
                print("PASS 实际图片选择→识别文字→项目预览；取消后保留原日程标题及地点草稿，未确认时不写数据")
                print("PASS OCR引擎和语言模型全部同源；没有上传图片、配对码或项目数据")
                print("PASS 首次识别后离线重开仍可识别；原项目、日程、备注和revision完全保留")
                print("NOT RUN 物理iPhone/Safari：本测试使用Chromium手机尺寸模拟。")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


if __name__ == "__main__":
    run()
