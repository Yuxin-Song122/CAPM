"""Notice/project scheduling flows in an isolated mobile-size Chromium profile.

All fixtures are synthetic. No user data, external AI, real notification service,
Cloudflare request, or physical iPhone is involved.
"""
from datetime import date
from http.server import ThreadingHTTPServer
import functools
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading

from playwright.sync_api import expect, sync_playwright

from pwa_browser_test import menu
from pwa_upgrade_test import Handler, READ_ALL


ROOT = Path(__file__).resolve().parents[1]
NOTICE = "【毕业设计材料提交】\n请完成毕业设计报告并提交电子版。\n截止时间：2040年1月25日18:00。\n地点：教学楼A座301室。"
IMPLEMENTATION = "每个工作日安排两个小时学习，周末三点到五点做真题"
LEGACY_NOTE = "这是升级前的原备注，必须保留。"
LEGACY = {
    "version": 1,
    "projects": [{"id": "legacy-project", "name": "原来的项目", "goal": "原项目目标", "deadline": "2040-02-01", "color": "sage", "archived": False, "isDemo": False}],
    "items": [{"id": "legacy-item", "title": "原来的日程", "notes": LEGACY_NOTE, "projectId": "legacy-project", "date": "2040-01-19", "start": "19:30", "end": "20:30", "completed": False, "isDemo": False}],
}


def state(page):
    return page.evaluate("async () => (await (await import('./src/storage.js')).readDisk()).state")


def close_planning(page):
    page.keyboard.press("Escape")
    expect(page.locator("#planning-modal")).not_to_be_visible()


def open_project(page, project_id):
    menu(page).locator(f'[data-action="open-project"][data-id="{project_id}"]').click()


def notice_preview(page, modal):
    tools = modal.locator("#notice-tools")
    if not tools.evaluate("el => el.open"):
        tools.locator("summary").click()
    tools.locator('[name="noticeInput"]').fill(NOTICE)
    tools.locator('[data-action="notice-analyze"]').click()
    planning = page.locator("#planning-modal")
    expect(planning).to_be_visible()
    return planning, planning.locator('[data-plan-form="notice"]')


def preview_rules(planning):
    form = planning.locator('[data-plan-form="implementation"]')
    form.locator('[name="startDate"]').fill("2040-01-19")
    form.locator('[name="endDate"]').fill("2040-01-25")
    form.locator('[name="defaultStart"]').fill("19:00")
    form.get_by_role("button", name="解析实施计划", exact=True).click()
    expect(planning.locator("#plan-rules .plan-rule")).to_have_count(2)
    form.get_by_role("button", name="预览日程", exact=True).click()
    expect(planning.locator("#plan-preview")).to_be_visible()


def run():
    subprocess.run(["node", "scripts/build-static.mjs"], cwd=ROOT, check=True)
    with tempfile.TemporaryDirectory(prefix="xuri-planning-browser-") as temporary:
        temp = Path(temporary)
        web = temp / "web"
        web.mkdir()
        shutil.copytree(ROOT / "dist", web / "CAPM")
        server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(web)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}/CAPM/"
        try:
            with sync_playwright() as playwright:
                context = playwright.chromium.launch_persistent_context(
                    str(temp / "profile"), executable_path=shutil.which("chromium") or "/usr/bin/chromium",
                    headless=True, args=["--no-sandbox"], viewport={"width": 390, "height": 844},
                    is_mobile=True, has_touch=True, timezone_id="Asia/Shanghai",
                )
                context.add_init_script("""window._permissionCalls=0;
                  Object.defineProperty(window,'Notification',{configurable:true,value:class {
                    static permission='default';
                    static requestPermission(){window._permissionCalls++;return Promise.resolve('denied')}
                  }});""")
                external_requests = []

                def block_external(route):
                    external_requests.append(route.request.url)
                    route.abort("blockedbyclient")

                context.route("https://**/*", block_external)
                page = context.pages[0]
                page.set_default_timeout(15000)
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(base)
                expect(page.get_by_role("heading", level=1)).to_have_text("日历计划")
                page.wait_for_function("async () => (await import('./src/pwa.js')).pwaStatus().ready")
                page.evaluate("""async fixture => {
                  const storage = await import('./src/storage.js');
                  const current = await storage.readDisk();
                  await storage.writeDisk(fixture,current.revision);
                }""", LEGACY)
                page.reload()
                expect(page.get_by_role("heading", level=1)).to_have_text("日历计划")
                before_notice = page.evaluate(READ_ALL)

                # Review and cancellation leave the original schedule draft intact.
                page.get_by_role("button", name="新建日程", exact=True).click()
                modal = page.locator("#modal")
                modal.locator('[name="title"]').fill("尚未保存的日程草稿")
                modal.locator('[name="date"]').fill("2040-02-02")
                modal.locator('[name="start"]').fill("12:30")
                modal.locator('[name="end"]').fill("13:30")
                modal.locator('[name="location"]').fill("原草稿地点")
                planning, notice = notice_preview(page, modal)
                expect(notice.locator('[name="name"]')).to_have_value("毕业设计材料提交")
                expect(notice.locator('[name="goal"]')).to_contain_text("毕业设计报告")
                expect(notice.locator('[name="deadline"]')).to_have_value("2040-01-25")
                expect(notice.locator('[name="deadlineTime"]')).to_have_value("18:00")
                expect(notice.locator('[name="location"]')).to_have_value("教学楼A座301室")
                assert page.evaluate(READ_ALL) == before_notice, "通知预览写入了未确认的数据"
                close_planning(page)
                expect(modal).to_be_visible()
                for name, value in {"title": "尚未保存的日程草稿", "date": "2040-02-02", "start": "12:30", "end": "13:30", "location": "原草稿地点"}.items():
                    expect(modal.locator(f'[name="{name}"]')).to_have_value(value)
                assert page.evaluate(READ_ALL) == before_notice

                # Confirm only the project; the original schedule remains a draft.
                planning, notice = notice_preview(page, modal)
                notice.get_by_role("button", name="确认建立项目", exact=True).click()
                expect(planning).not_to_be_visible()
                expect(modal).to_be_visible()
                current = state(page)
                notice_project = next(project for project in current["projects"] if project["name"] == "毕业设计材料提交")
                assert notice_project["noticeText"] == NOTICE
                assert notice_project["deadlineTime"] == "18:00"
                assert notice_project["location"] == "教学楼A座301室"
                assert current["items"] == LEGACY["items"], "建立通知项目不应偷偷新建日程"
                expect(modal.locator('[name="projectId"]')).to_have_value(notice_project["id"])
                expect(modal.locator('[name="title"]')).to_have_value("尚未保存的日程草稿")
                expect(modal.locator('[name="location"]')).to_have_value("原草稿地点")
                modal.get_by_role("button", name="关闭弹窗", exact=True).click()
                expect(modal).not_to_be_visible()

                # A manual implementation plan opens a separate editable builder.
                menu(page).get_by_role("button", name="新增项目", exact=True).click()
                modal.locator('[name="name"]').fill("六级实施计划测试")
                modal.locator('[name="goal"]').fill("坚持学习并练习真题")
                modal.locator('[name="deadline"]').fill("2040-01-25")
                modal.locator('[name="implementationPlan"]').fill(IMPLEMENTATION)
                modal.get_by_role("button", name="创建项目", exact=True).click()
                expect(modal).not_to_be_visible()
                planning = page.locator("#planning-modal")
                expect(planning).to_be_visible()
                preview_rules(planning)
                rules = planning.locator("#plan-rules .plan-rule")
                expect(rules.nth(0).locator('[name="rule-start"]')).to_have_value("19:00")
                expect(rules.nth(0).locator('[name="rule-end"]')).to_have_value("21:00")
                expect(rules.nth(1).locator('[name="rule-start"]')).to_have_value("15:00")
                expect(rules.nth(1).locator('[name="rule-end"]')).to_have_value("17:00")
                assert rules.nth(0).locator('[name="rule-days"]:checked').evaluate_all("els => els.map(el => Number(el.value))") == [1, 2, 3, 4, 5]
                assert rules.nth(1).locator('[name="rule-days"]:checked').evaluate_all("els => els.map(el => Number(el.value))") == [6, 7]
                occurrences = planning.locator("#plan-preview .plan-occurrence")
                expect(occurrences).to_have_count(7)
                conflict = planning.locator('input[name="occurrence"][value*="2040-01-19"]')
                expect(conflict).not_to_be_checked()
                expect(planning.locator('input[name="occurrence"]:checked')).to_have_count(6)
                before_confirm = page.evaluate(READ_ALL)
                assert len(state(page)["items"]) == 1, "日程预览不应提前保存"
                planning.locator("#plan-confirm").click()
                expect(planning).not_to_be_visible()
                expect(page.get_by_role("heading", level=1)).to_have_text("六级实施计划测试")
                current = state(page)
                project = next(project for project in current["projects"] if project["name"] == "六级实施计划测试")
                assert project["implementationPlan"] == IMPLEMENTATION
                generated = [item for item in current["items"] if item["projectId"] == project["id"]]
                assert len(generated) == 6
                assert page.evaluate(READ_ALL) != before_confirm
                for item in generated:
                    weekend = date.fromisoformat(item["date"]).isoweekday() in (6, 7)
                    assert (item["title"], item["start"], item["end"]) == (("做真题", "15:00", "17:00") if weekend else ("学习", "19:00", "21:00"))
                    assert item.get("planKey")
                assert next(item for item in current["items"] if item["id"] == "legacy-item") == LEGACY["items"][0]

                # Repeating generation has no checked duplicates or new writes.
                repeat_before = page.evaluate(READ_ALL)
                page.locator('[data-action="project-plan"]').click()
                expect(planning).to_be_visible()
                preview_rules(planning)
                expect(planning.locator("#plan-preview .plan-occurrence")).to_have_count(1)
                expect(planning.locator('input[name="occurrence"]:checked')).to_have_count(0)
                assert page.evaluate(READ_ALL) == repeat_before
                close_planning(page)

                # New location editing preserves the old notes field exactly.
                open_project(page, "legacy-project")
                legacy_row = page.locator('[data-item-id="legacy-item"]')
                legacy_row.get_by_role("button", name="编辑：原来的日程", exact=True).click()
                expect(modal.locator('[name="location"]')).to_have_value("")
                modal.locator('[name="location"]').fill("图书馆二楼")
                modal.get_by_role("button", name="保存修改", exact=True).click()
                expect(modal).not_to_be_visible()
                legacy = next(item for item in state(page)["items"] if item["id"] == "legacy-item")
                assert legacy["notes"] == LEGACY_NOTE
                assert legacy["location"] == "图书馆二楼"
                legacy_row.locator('[data-action="go-item-date"]').click()
                expect(page.locator('[data-item-id="legacy-item"]')).to_contain_text("图书馆二楼")

                # Date, completion and project views keep using the same item.
                open_project(page, project["id"])
                moved = next(item for item in generated if item["date"] == "2040-01-20")
                task = page.locator(f'[data-item-id="{moved["id"]}"]')
                task.get_by_role("button", name="编辑：学习", exact=True).click()
                modal.locator('[name="date"]').fill("2040-01-26")
                modal.locator('[name="location"]').fill("自习室203")
                modal.get_by_role("button", name="保存修改", exact=True).click()
                expect(modal).not_to_be_visible()
                task.locator('[data-action="go-item-date"]').click()
                schedule = page.locator(f'[data-item-id="{moved["id"]}"]')
                expect(schedule).to_contain_text("自习室203")
                schedule.get_by_role("checkbox", name="完成：学习", exact=True).check()
                page.wait_for_function("""async id => {
                  const value = (await (await import('./src/storage.js')).readDisk()).state;
                  return value.items.find(item => item.id === id)?.completed === true;
                }""", arg=moved["id"])
                open_project(page, project["id"])
                expect(page.locator(f'[data-item-id="{moved["id"]}"]').get_by_role("checkbox", name="完成：学习", exact=True)).to_be_checked()
                changed = next(item for item in state(page)["items"] if item["id"] == moved["id"])
                assert changed["planKey"] == moved["planKey"]
                assert changed["date"] == "2040-01-26"
                assert changed["location"] == "自习室203"

                # Regeneration must not reintroduce the manually moved occurrence.
                page.locator('[data-action="project-plan"]').click()
                expect(planning).to_be_visible()
                preview_rules(planning)
                expect(planning.locator("#plan-preview .plan-occurrence")).to_have_count(1)
                expect(planning.locator('input[name="occurrence"]:checked')).to_have_count(0)
                close_planning(page)
                # Saving a manually edited rule without selecting new events
                # keeps that preference and range when the builder is reopened.
                count_before_rule_edit = len(state(page)["items"])
                page.locator('[data-action="project-plan"]').click()
                expect(planning).to_be_visible()
                expect(planning.locator('[name="startDate"]')).to_have_value("2040-01-19")
                expect(planning.locator('[name="endDate"]')).to_have_value("2040-01-25")
                first_rule = planning.locator(".plan-rule").first
                first_rule.locator('[name="rule-title"]').fill("手调学习")
                first_rule.locator('[name="rule-start"]').fill("18:00")
                first_rule.locator('[name="rule-end"]').fill("20:00")
                planning.get_by_role("button", name="预览日程", exact=True).click()
                for checkbox in planning.locator('input[name="occurrence"]:checked').all():
                    checkbox.uncheck()
                planning.locator("#plan-confirm").click()
                expect(planning).not_to_be_visible()
                assert len(state(page)["items"]) == count_before_rule_edit
                page.locator('[data-action="project-plan"]').click()
                expect(planning).to_be_visible()
                restored = planning.locator(".plan-rule").first
                expect(restored.locator('[name="rule-title"]')).to_have_value("手调学习")
                expect(restored.locator('[name="rule-start"]')).to_have_value("18:00")
                expect(restored.locator('[name="rule-end"]')).to_have_value("20:00")
                expect(planning.locator('[name="startDate"]')).to_have_value("2040-01-19")
                close_planning(page)
                final = state(page)
                assert next(p for p in final["projects"] if p["id"] == "legacy-project") == LEGACY["projects"][0]
                assert next(item for item in final["items"] if item["id"] == "legacy-item")["notes"] == LEGACY_NOTE
                assert len(final["items"]) == 7
                assert page.evaluate("window._permissionCalls") == 0
                assert not external_requests, "本地通知和计划解析不应自动连接外部服务"
                assert not errors, errors
                (ROOT / "test-results").mkdir(exist_ok=True)
                page.screenshot(path=str(ROOT / "test-results" / "planning-mobile.png"), full_page=True)
                context.set_offline(True)
                page.reload()
                expect(page.get_by_role("heading", level=1)).to_have_text("六级实施计划测试")
                assert state(page) == final, "离线重开后项目、地点、计划或旧备注丢失"
                context.close()
                print("PASS 文字通知提取项目、截止时刻与地点；确认前零写入、取消保留日程草稿")
                print("PASS 项目实施计划预览工作日/周末时段；冲突默认不选、重复及已编辑条目不重复生成")
                print("PASS 地点编辑、旧备注保留、日期/完成联动，离线重新打开保留全部数据")
                print("NOT RUN 真实iPhone、图片OCR和推送送达：本测试仅使用临时本机Chromium资料")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


if __name__ == "__main__":
    run()
