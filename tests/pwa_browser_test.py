"""Static PWA checks in Chromium iPhone-size emulation; not a physical iPhone test.

Serve a copied public bundle under /CAPM/ on a random localhost port. All browser
profiles, caches and IndexedDB records are temporary. No actual user data changes.
"""
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
from urllib.request import urlopen

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "test-results"


def check(condition, message):
    if not condition:
        raise AssertionError(message)


class StaticHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()


def menu(page):
    toggle = page.get_by_role("button", name="打开项目栏", exact=True)
    if toggle.is_visible() and not page.locator(".sidebar").evaluate("el => el.classList.contains('is-open')"):
        toggle.click()
    return page.locator(".sidebar")


def project(page):
    menu(page).locator(".project-nav-item").filter(has_text="手机项目").click()
    expect(page.get_by_role("heading", level=1)).to_contain_text("手机项目")


def close_modal(modal):
    modal.page.screenshot(path=str(RESULTS / "pwa-backup-dialog.png"))
    check(modal.evaluate("el => {const r=el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1}"), "备份弹窗溢出手机视口")
    modal.get_by_role("button", name="关闭弹窗", exact=True).click()
    expect(modal).not_to_be_visible()
    if modal.page.locator('.sidebar.is-open').count():
        modal.page.keyboard.press('Escape')


def export_backup(page, modal, name):
    menu(page).locator('[data-action="backup"]').click()
    with page.expect_download() as event:
        modal.get_by_role("button", name="下载完整备份", exact=True).click()
    target = RESULTS / name
    event.value.save_as(target)
    value = json.loads(target.read_text(encoding="utf-8"))
    close_modal(modal)
    return value, target


def failed_first_install(playwright, options, public, base):
    """A failed precache must show failure rather than endless preparation."""
    icon = public / "icons" / "icon-maskable-512.png"
    missing_icon = icon.with_suffix(".temporarily-missing")
    icon.rename(missing_icon)
    try:
        with tempfile.TemporaryDirectory(prefix="xuri-pwa-failed-install-") as profile:
            context = playwright.chromium.launch_persistent_context(profile, **options)
            try:
                page = context.pages[0]
                page.goto(base)
                expect(page.get_by_role("heading", level=1)).to_have_text("日历计划")
                page.evaluate("async () => { window._pwaModule = await import('./src/pwa.js'); }")
                page.wait_for_function("() => { const s = window._pwaModule.pwaStatus(); return Boolean(s.error) && !s.ready; }", timeout=15000)
                status = page.evaluate("async () => (await import('./src/pwa.js')).pwaStatus()")
                check(status["error"] and not status["ready"], "离线资源首次下载失败仍显示为准备中")
                check(not page.evaluate("async () => Boolean(await caches.match(new URL('./index.html', location.href).href))"), "失败的首次安装留下了不完整离线缓存")
                expect(page.locator(".pwa-banner")).to_contain_text(status["error"])
                print("PASS 首次离线资源安装遇到 404，清理不完整缓存并显示明确错误，不再无限准备")
            finally:
                context.close()
    finally:
        missing_icon.rename(icon)


def run():
    RESULTS.mkdir(exist_ok=True)
    public_files = ["index.html", "styles.css", "favicon.svg", "manifest.webmanifest", "sw.js"]
    with tempfile.TemporaryDirectory(prefix="xuri-static-") as temporary, tempfile.TemporaryDirectory(prefix="xuri-pwa-profile-") as profile:
        public = Path(temporary) / "CAPM"
        public.mkdir()
        for name in public_files:
            check((ROOT / name).is_file(), f"缺少 PWA 文件：{name}")
            shutil.copy2(ROOT / name, public / name)
        for directory in ["src", "icons", "vendor"]:
            shutil.copytree(ROOT / directory, public / directory)
        check('name="xuri-storage" content="device"' in (public / "index.html").read_text(), "静态网页必须使用设备本地存储")
        server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(StaticHandler, directory=temporary))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}/CAPM/"
        try:
            manifest = json.loads(urlopen(base + "manifest.webmanifest").read())
            check(manifest.get("name") and manifest.get("short_name"), "Manifest 缺少应用名称")
            check(manifest.get("display") == "standalone", "Manifest 必须声明独立窗口")
            check(not manifest.get("start_url", "/").startswith("/"), "start_url 必须兼容子目录")
            check(not manifest.get("scope", "/").startswith("/"), "scope 必须兼容子目录")
            sizes = {icon["sizes"] for icon in manifest["icons"]}
            check({"192x192", "512x512"}.issubset(sizes), "缺少安装图标尺寸")
            for icon in manifest["icons"]:
                raw = urlopen(base + icon["src"].removeprefix("./")).read()
                check(raw.startswith(b"\x89PNG\r\n\x1a\n"), "图标须为有效 PNG")
            print("PASS 子目录 Manifest、应用名称、独立窗口和完整 PNG 安装图标")

            with sync_playwright() as p:
                chromium = os.environ.get("CHROMIUM_PATH") or shutil.which("chromium") or shutil.which("google-chrome")
                options = {"headless": True, "args": ["--no-sandbox"], "viewport": {"width": 390, "height": 844}, "device_scale_factor": 1, "is_mobile": True, "has_touch": True, "locale": "zh-CN", "timezone_id": "Asia/Shanghai", "accept_downloads": True}
                if chromium:
                    options["executable_path"] = chromium
                failed_first_install(p, options, public, base)
                context = p.chromium.launch_persistent_context(profile, **options)
                context.set_default_timeout(10000)
                page = context.pages[0]
                errors, console_errors, api_requests = [], [], []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
                page.on("request", lambda request: api_requests.append(request.url) if "/api/" in request.url else None)
                page.goto(base)
                expect(page.get_by_role("heading", level=1)).to_have_text("日历计划")
                page.evaluate("async () => { window._pwaModule = await import('./src/pwa.js'); }")
                page.wait_for_function("() => window._pwaModule.pwaStatus().ready", timeout=20000)
                check(page.evaluate("Boolean(navigator.serviceWorker.controller)"), "Service Worker 没有控制页面")
                check(page.locator('meta[name="apple-mobile-web-app-capable"]').get_attribute("content") == "yes", "缺少 iOS 主屏幕独立窗口声明")
                check(page.locator('link[rel="apple-touch-icon"]').count() == 1, "缺少 iPhone 主屏幕图标")
                expect(page.locator("#calendar-content")).to_be_hidden()
                expect(page.locator(".overview-metrics .metric")).to_have_count(2)
                page.get_by_role("button", name="展开月历", exact=True).click()
                expect(page.locator("#calendar-content")).to_be_visible()
                modal = page.locator("#modal")

                # Touch drawer, keyboard dismissal and focus containment.
                toggle = page.get_by_role("button", name="打开项目栏", exact=True)
                toggle.click()
                expect(toggle).to_have_attribute("aria-expanded", "true")
                page.wait_for_function("document.activeElement.closest('.sidebar') !== null")
                page.keyboard.press("Shift+Tab")
                check(page.evaluate("Boolean(document.activeElement.closest('.sidebar'))"), "菜单焦点未保留在抽屉中")
                page.keyboard.press("Escape")
                expect(toggle).to_have_attribute("aria-expanded", "false")
                print("PASS iPhone 尺寸项目抽屉、焦点限制、Esc 关闭与 iOS 安装元数据")

                menu(page).get_by_role("button", name="新增项目", exact=True).click()
                modal.locator('[name="name"]').fill("手机项目")
                modal.locator('[name="goal"]').fill("验证 iPhone 尺寸项目和日历联动")
                modal.locator('[name="deadline"]').fill("2027-02-28")
                check(modal.locator('[name="name"]').evaluate("el => parseFloat(getComputedStyle(el).fontSize)") >= 16, "手机输入框字号应避免 Safari 自动缩放")
                modal.get_by_role("button", name="创建项目", exact=True).click()
                expect(page.get_by_role("heading", level=1)).to_have_text("手机项目")
                page.get_by_role("button", name="添加任务", exact=True).click()
                modal.locator('[name="title"]').fill("手机项目任务")
                modal.get_by_role("button", name="添加任务", exact=True).click()
                page.get_by_role("button", name="安排时间", exact=True).click()
                modal.locator('[name="date"]').fill("2027-01-19")
                modal.locator('[name="start"]').fill("09:00")
                modal.locator('[name="end"]').fill("10:00")
                modal.get_by_role("button", name="保存修改", exact=True).click()
                page.locator(".task-date").click()
                expect(page.locator(".schedule-row")).to_contain_text("手机项目任务")
                page.locator('[data-date="2027-01-18"]').click()
                expect(page.locator(".schedule-row")).to_have_count(0)
                page.locator('[data-date="2027-01-19"]').click()
                page.get_by_role("checkbox", name="完成：手机项目任务", exact=True).check()
                project(page)
                expect(page.get_by_role("checkbox", name="完成：手机项目任务", exact=True)).to_be_checked()
                expect(page.locator(".progress-ring")).to_contain_text("100")
                page.locator(".task-date").click()
                print("PASS 手机项目创建、任务安排、日期切换与双向完成状态")

                context.set_offline(True)
                page.reload()
                expect(page.get_by_role("heading", level=1)).to_have_text("日历计划")
                expect(page.get_by_role("checkbox", name="完成：手机项目任务", exact=True)).to_be_checked()
                check(not page.evaluate("navigator.onLine"), "浏览器尚未离线")
                page.get_by_role("button", name="新建日程", exact=True).click()
                modal.locator('[name="title"]').fill("离线日程")
                modal.locator('[name="start"]').fill("17:00")
                modal.locator('[name="end"]').fill("18:00")
                modal.get_by_role("button", name="添加日程", exact=True).click()
                expect(page.locator(".schedule-row")).to_have_count(2)
                page.get_by_role("button", name="编辑：离线日程", exact=True).click()
                modal.locator('[name="title"]').fill("离线编辑日程")
                modal.locator('[name="end"]').fill("18:30")
                modal.get_by_role("button", name="保存修改", exact=True).click()
                page.get_by_role("checkbox", name="完成：离线编辑日程", exact=True).check()
                backup, backup_path = export_backup(page, modal, "pwa-offline-backup.json")
                check(len(backup["projects"]) == 1 and len(backup["items"]) == 2, "离线导出的备份记录数量错误")
                check(all(item["completed"] for item in backup["items"]), "离线备份遗漏完成状态")
                page.get_by_role("button", name="删除：离线编辑日程", exact=True).click()
                modal.get_by_role("button", name="确认删除", exact=True).click()
                expect(page.locator(".schedule-row")).to_have_count(1)
                menu(page).locator('[data-action="backup"]').click()
                modal.locator('#import-file').set_input_files({"name": "invalid.json", "mimeType": "application/json", "buffer": b'{"version":999}'})
                expect(modal.locator('#form-error')).to_be_visible()
                modal.locator('#import-file').set_input_files(str(backup_path))
                modal.locator('[name="import-mode"][value="replace"]').check()
                modal.get_by_role("button", name="确认导入", exact=True).click()
                expect(modal).not_to_be_visible()
                expect(page.locator(".schedule-row")).to_have_count(2)
                page.reload()
                expect(page.locator(".schedule-row")).to_have_count(2)
                expect(page.get_by_role("checkbox", name="完成：离线编辑日程", exact=True)).to_be_checked()
                print("PASS 真实断网后启动、增改删日程、勾选、无效导入保护和 JSON 备份还原")

                cached_urls = page.evaluate("async () => (await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(r => r.url)))).flat()")
                check(cached_urls and all('/CAPM/' in url for url in cached_urls), "离线缓存范围越过部署目录")
                check(not any('/api/' in url or 'data.json' in url for url in cached_urls), "Service Worker 不应缓存数据 API")
                check(not api_requests, f"设备模式仍依赖本机 API：{api_requests}")
                page.screenshot(path=str(RESULTS / "pwa-iphone-size-offline.png"), full_page=True)
                context.close()
                context = p.chromium.launch_persistent_context(profile, **options)
                context.set_default_timeout(10000)
                context.set_offline(True)
                page = context.pages[0]
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
                page.goto(base)
                expect(page.get_by_role("heading", level=1)).to_have_text("日历计划")
                # Session selection can reset after a complete browser restart.
                if not page.locator("#calendar-content").is_visible(): page.get_by_role("button", name="展开月历", exact=True).click()
                page.get_by_role("combobox", name="年份", exact=True).select_option("2027")
                page.get_by_role("combobox", name="月份", exact=True).select_option("0")
                page.locator('[data-date="2027-01-19"]').click()
                expect(page.locator(".schedule-row")).to_have_count(2)
                expect(page.get_by_role("checkbox", name="完成：手机项目任务", exact=True)).to_be_checked()
                expect(page.get_by_role("checkbox", name="完成：离线编辑日程", exact=True)).to_be_checked()
                print("PASS 完全关闭并重开浏览器，保持断网，缓存应用及 IndexedDB 记录仍可读取")

                for width, height in [(320, 690), (390, 844), (430, 932), (844, 390), (1366, 768)]:
                    page.set_viewport_size({"width": width, "height": height})
                    check(not page.evaluate("document.documentElement.scrollWidth > innerWidth"), f"{width}×{height} 页面横向溢出")
                    button = page.get_by_role("button", name="新建日程", exact=True)
                    if width <= 1024:
                        check(button.bounding_box()['height'] >= 44, f"{width}px 新建日程触控高度不足")
                page.set_viewport_size({"width": 390, "height": 844})
                page.screenshot(path=str(RESULTS / "pwa-iphone-size-reopened.png"), full_page=True)
                check(not errors, f"浏览器脚本错误：{errors}")
                check(not console_errors, f"浏览器控制台错误：{console_errors}")
                print("PASS 320/390/430 宽度、横屏和桌面布局，无横向溢出，手机主要触控目标 ≥44px，无脚本与控制台错误")
                context.close()
                webkit_path = Path(p.webkit.executable_path)
                print("NOT RUN：真实 iPhone/Safari 主屏幕安装与硬件行为；当前没有连接的 iPhone。")
                print("WebKit executable available:", webkit_path.exists())
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
    print("\nPWA 静态部署与真实离线流程检查通过（Chromium iPhone 尺寸模拟）。")


if __name__ == "__main__":
    run()
