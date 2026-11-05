"""Connection diagnostics with fake HTTPS responses in a temporary browser profile.

These checks never use a real backend, pairing secret or push subscription. They
exercise the Safari-style UI and diagnostic contracts, not iPhone/APNs delivery.
"""
from datetime import datetime
from http.server import ThreadingHTTPServer
import functools
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

from pwa_browser_test import menu
from pwa_upgrade_test import Handler, READ_ALL


ROOT = Path(__file__).resolve().parents[1]
BACKEND = "https://push.example.test"
OTHER_BACKEND = "https://other-push.example.test"
PAIRING_SENTINEL = "synthetic-pairing-value-must-stay-in-the-form"
LOCAL_LOCATION = "仅保存在本地的诊断测试地点"
LOCAL_GOAL = "诊断不能修改的项目目标"

INITIALIZE = """() => {
 window._permissionCalls = 0;
 window._idbWrites = 0;
 Object.defineProperty(window, 'Notification', { configurable: true, value: class {
   static permission = 'default';
   static requestPermission() {
     window._permissionCalls++;
     return Promise.resolve('granted');
   }
 }});
 for (const name of ['put', 'add', 'delete', 'clear']) {
   const original = IDBObjectStore.prototype[name];
   IDBObjectStore.prototype[name] = function (...args) {
     window._idbWrites++;
     return original.apply(this, args);
   };
 }
}"""


def open_settings(page):
    menu(page).locator('[data-action="push-settings"]').click()
    modal = page.locator("#modal")
    expect(modal).to_be_visible()
    return modal


def report(page, backend=BACKEND):
    return page.evaluate(
        "async url => (await import('./src/push-client.js')).checkPushBackend(url)",
        backend,
    )


def assert_read_only(page, before, writes, requests):
    assert page.evaluate(READ_ALL) == before, "诊断改动了项目、日程或快照版本"
    assert page.evaluate("window._idbWrites") == writes, "诊断执行了 IndexedDB 写操作"
    assert page.evaluate("window._permissionCalls") == 0, "诊断不应申请通知权限"
    for request in requests:
        assert request["method"] == "GET", request
        assert request["path"] in ("/health", "/config"), request
        assert request["body"] is None, "诊断不应上传请求正文"
        assert not request["authorization"], "诊断不应发送设备令牌"
    serialized = json.dumps(requests, ensure_ascii=False)
    for value in (PAIRING_SENTINEL, LOCAL_LOCATION, LOCAL_GOAL):
        assert value not in serialized, "诊断上传了本地输入或业务数据"


def delay_backend(page):
    """Keep fake-backend fetch pending until the test releases it explicitly."""
    page.evaluate(
        """base => {
          window._diagnosticNativeFetch = window.fetch;
          window._delayedStarted = 0;
          window._delayedCompleted = 0;
          const gate = new Promise(resolve => { window._releaseDiagnostic = resolve; });
          window.fetch = async function (...args) {
            const url = String(args[0]?.url || args[0]);
            if (!url.startsWith(base + '/')) return window._diagnosticNativeFetch(...args);
            window._delayedStarted++;
            try {
              await gate;
              return await window._diagnosticNativeFetch(...args);
            } finally { window._delayedCompleted++; }
          };
        }""",
        BACKEND,
    )


def finish_delayed(page):
    page.evaluate("window._releaseDiagnostic()")
    page.wait_for_function(
        "() => window._delayedStarted > 0 && window._delayedStarted === window._delayedCompleted"
    )
    # Drain the result's async rendering without a fixed wall-clock sleep.
    page.evaluate(
        "async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); }"
    )
    page.evaluate("window.fetch = window._diagnosticNativeFetch")


def run():
    subprocess.run(["node", "scripts/build-static.mjs"], cwd=ROOT, check=True)
    public_key = subprocess.check_output(
        [
            "node", "--input-type=module", "-e",
            "import {createECDH} from 'node:crypto'; console.log(createECDH('prime256v1').generateKeys('base64url'))",
        ], text=True,
    ).strip()
    with tempfile.TemporaryDirectory(prefix="xuri-push-diagnostics-") as temporary:
        temp = Path(temporary)
        web = temp / "web"
        web.mkdir()
        shutil.copytree(ROOT / "dist", web / "CAPM")
        server = ThreadingHTTPServer(
            ("127.0.0.1", 0), functools.partial(Handler, directory=str(web))
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}/CAPM/"
        origin = base.removesuffix("/CAPM/")
        requests = []
        behavior = {"mode": "success"}
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
                    timezone_id="Asia/Shanghai",
                    user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
                )
                context.add_init_script("(" + INITIALIZE + ")()")

                def route(interception):
                    request = interception.request
                    path = urlsplit(request.url).path
                    requests.append({
                        "url": request.url,
                        "path": path,
                        "method": request.method,
                        "body": request.post_data,
                        "authorization": request.headers.get("authorization"),
                    })
                    headers = {
                        "Access-Control-Allow-Origin": origin,
                        "Content-Type": "application/json",
                        "Cache-Control": "no-store",
                    }
                    if behavior["mode"] == "abort" and path == "/config":
                        interception.abort("failed")
                    elif behavior["mode"] == "html" and path == "/health":
                        interception.fulfill(
                            status=503,
                            headers={**headers, "Content-Type": "text/html"},
                            body="<html><body>synthetic gateway failure</body></html>",
                        )
                    elif path == "/health":
                        interception.fulfill(
                            status=200, headers=headers,
                            body=json.dumps({"ok": True, "configured": True}),
                        )
                    elif path == "/config":
                        interception.fulfill(
                            status=200, headers=headers,
                            body=json.dumps({"vapidPublicKey": public_key, "offsetsMinutes": [120, 30, 5]}),
                        )
                    else:
                        raise AssertionError("诊断请求了未授权接口: " + path)

                context.route(BACKEND + "/**", route)
                context.route(OTHER_BACKEND + "/**", route)
                page = context.pages[0]
                page.set_default_timeout(12000)
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(base)
                expect(page.get_by_role("heading", level=1)).to_have_text("日历计划")
                page.wait_for_function("async () => (await import('./src/pwa.js')).pwaStatus().ready")
                assert not requests, "未连接设备不应自动请求推送后台"

                # Create actual temporary planner data to protect throughout all checks.
                menu(page).get_by_role("button", name="新增项目", exact=True).click()
                modal = page.locator("#modal")
                modal.locator("[name=name]").fill("诊断时保留的项目")
                modal.locator("[name=goal]").fill(LOCAL_GOAL)
                modal.get_by_role("button", name="创建项目", exact=True).click()
                expect(modal).not_to_be_visible()
                expect(page.get_by_role("heading", level=1)).to_have_text("诊断时保留的项目")
                menu(page).locator('button[data-action="calendar"]').click()
                expect(page.get_by_role("heading", level=1)).to_have_text("日历计划")
                page.get_by_role("button", name="新建日程", exact=True).click()
                modal.locator("[name=title]").fill("仅本地的诊断测试日程")
                modal.locator("[name=date]").fill("2040-01-19")
                modal.locator("[name=start]").fill("09:00")
                modal.locator("[name=end]").fill("10:00")
                modal.locator("[name=location]").fill(LOCAL_LOCATION)
                modal.get_by_role("button", name="添加日程", exact=True).click()
                expect(modal).not_to_be_visible()
                before = page.evaluate(READ_ALL)
                writes = page.evaluate("window._idbWrites")

                healthy = report(page)
                assert healthy["ok"] is True, healthy
                assert healthy["backendUrl"] == BACKEND
                assert healthy["origin"] == origin
                assert healthy["standalone"] is False
                assert healthy["notificationPermission"] == "default"
                datetime.fromisoformat(healthy["checkedAt"].replace("Z", "+00:00"))
                assert {check["name"] for check in healthy["checks"]} == {"health", "config"}
                assert all(check["ok"] and check["message"] for check in healthy["checks"])
                assert public_key not in json.dumps(healthy), "诊断报告不需要展示推送公钥"

                behavior["mode"] = "abort"
                failed = report(page)
                assert failed["ok"] is False, failed
                assert any(check["name"] == "health" and check["ok"] for check in failed["checks"])
                assert any(check["name"] == "config" and not check["ok"] for check in failed["checks"])

                behavior["mode"] = "html"
                html = report(page)
                assert html["ok"] is False, html
                assert any("503" in check["message"] for check in html["checks"]), html
                assert "synthetic gateway failure" not in json.dumps(html), "不应回显原始服务器正文"

                # Exercise the timeout path immediately, without a real 15-second wait.
                behavior["mode"] = "success"
                timeout = page.evaluate(
                    """async base => {
                      const original = window.fetch;
                      window.fetch = (...args) => String(args[0]?.url || args[0]).startsWith(base + '/')
                        ? Promise.reject(new DOMException('synthetic timeout', 'AbortError'))
                        : original(...args);
                      try { return await (await import('./src/push-client.js')).checkPushBackend(base); }
                      finally { window.fetch = original; }
                    }""",
                    BACKEND,
                )
                assert timeout["ok"] is False, timeout
                assert any("超时" in check["message"] for check in timeout["checks"]), timeout
                assert_read_only(page, before, writes, requests)

                # This is deliberately iPhone Safari-style, not standalone. Checking
                # connectivity must remain available when actual subscription is disabled.
                modal = open_settings(page)
                check_button = modal.locator('[data-action="push-check"]')
                expect(check_button).to_be_enabled()
                assert check_button.get_attribute("type") == "button"
                modal.locator("[name=backendUrl]").fill(BACKEND)
                expect(modal.locator("[name=pairingSecret]")).to_have_value("")
                check_button.click()
                results = modal.locator("#push-diagnostics")
                expect(results).to_be_visible()
                expect(results).to_have_attribute("role", "status")
                expect(results).to_contain_text(origin)
                expect(results).to_contain_text(re.compile("Safari|浏览器|普通网页"))
                expect(check_button).to_be_enabled()
                expect(modal.locator("#form-error")).to_be_hidden()
                modal.locator("[name=pairingSecret]").fill(PAIRING_SENTINEL)
                check_button.click()
                expect(check_button).to_be_enabled()
                expect(modal.locator("[name=backendUrl]")).to_have_value(BACKEND)
                expect(modal.locator("[name=pairingSecret]")).to_have_value(PAIRING_SENTINEL)
                assert_read_only(page, before, writes, requests)
                assert not page.evaluate('document.documentElement.scrollWidth > innerWidth'), '手机诊断页面横向溢出'
                (ROOT / 'test-results').mkdir(exist_ok=True)
                page.screenshot(path=str(ROOT / 'test-results' / 'push-connection-diagnostics.png'), full_page=True)

                # Close then reopen a fresh settings dialog while an older check waits.
                delay_backend(page)
                check_button.click()
                page.wait_for_function("() => window._delayedStarted > 0")
                modal.get_by_role("button", name="关闭弹窗", exact=True).click()
                expect(modal).not_to_be_visible()
                modal = open_settings(page)
                expect(modal.locator("#push-diagnostics")).to_be_hidden()
                finish_delayed(page)
                expect(modal.locator("#push-diagnostics")).to_be_hidden()
                expect(modal.locator("#form-error")).to_be_hidden()

                # Changing the requested URL must invalidate the old in-flight report.
                modal.locator("[name=backendUrl]").fill(BACKEND)
                delay_backend(page)
                modal.locator('[data-action="push-check"]').click()
                page.wait_for_function("() => window._delayedStarted > 0")
                modal.locator("[name=backendUrl]").fill(OTHER_BACKEND)
                expect(modal.locator("#push-diagnostics")).to_be_hidden()
                finish_delayed(page)
                expect(modal.locator("#push-diagnostics")).to_be_hidden()
                expect(modal.locator("[name=backendUrl]")).to_have_value(OTHER_BACKEND)
                assert_read_only(page, before, writes, requests)
                assert not errors, errors
                context.close()
                print("PASS 后台检查：正常响应、网络失败、超时和HTML 503分别报告；不回显服务器正文")
                print("PASS 普通Safari模式、空配对码也可检查；不申请通知，不上传数据或令牌，不写IndexedDB")
                print("PASS 项目与日程全部快照保留；输入保留，关闭弹窗及改网址后忽略旧请求结果")
                print("NOT RUN 真实Cloudflare/Apple送达：此测试仅使用本机隔离浏览器与模拟HTTPS响应。")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


if __name__ == "__main__":
    run()
