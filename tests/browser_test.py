"""真实浏览器端到端检查。独立测试资料与随机端口，不触碰日常使用的数据。"""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.request import urlopen

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "test-results"
KEY = "xuri.planner.v1"


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def run():
    RESULTS.mkdir(exist_ok=True)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = subprocess.Popen(["node", "server.mjs", "--port", str(port)], cwd=ROOT, stdout=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(60):
            try:
                with urlopen(base, timeout=1) as response:
                    check(response.status == 200, "服务器响应")
                break
            except OSError:
                if server.poll() is not None:
                    raise RuntimeError("应用服务器未能启动")
                time.sleep(.1)
        else:
            raise RuntimeError("应用服务器启动超时")

        with tempfile.TemporaryDirectory(prefix="xuri-browser-") as profile, sync_playwright() as p:
            chromium = os.environ.get("CHROMIUM_PATH") or shutil.which("chromium") or shutil.which("google-chrome")
            options = {"headless": True, "args": ["--no-sandbox"], "viewport": {"width": 1440, "height": 1000}, "timezone_id": "Asia/Shanghai", "locale": "zh-CN", "accept_downloads": True}
            if chromium:
                options["executable_path"] = chromium
            context = p.chromium.launch_persistent_context(profile, **options)
            context.set_default_timeout(8000)
            errors = []
            page = context.pages[0]
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(base)
            expect(page.get_by_role("heading", level=1)).to_contain_text("给每一天")
            page.screenshot(path=str(RESULTS / "01-calendar.png"), full_page=True)
            modal = page.locator("#modal")
            stored = lambda: page.evaluate("key => JSON.parse(localStorage.getItem(key))", KEY)

            # 1. 创建和编辑项目；清除示例不会影响自己创建的项目。
            page.get_by_role("button", name="新增项目", exact=True).click()
            modal.locator('[name="name"]').fill("个人网站计划")
            modal.locator('[name="goal"]').fill("学会开发自己的作品集，每天进步一点。")
            modal.locator('[name="deadline"]').fill("2027-02-28")
            modal.get_by_role("radio", name="雾蓝", exact=True).check()
            modal.get_by_role("button", name="创建项目", exact=True).click()
            expect(page.get_by_role("heading", level=1)).to_contain_text("个人网站计划")
            page.get_by_role("button", name="编辑项目", exact=True).click()
            modal.locator('[name="name"]').fill("我的作品集项目")
            modal.get_by_role("button", name="保存修改", exact=True).click()
            expect(page.locator(".project-goal")).to_contain_text("每天进步一点")
            page.locator('.primary-nav [data-action="calendar"]').click()
            page.get_by_role("button", name="清除示例", exact=True).click()
            modal.get_by_role("button", name="清除示例", exact=True).click()
            check(len(stored()["projects"]) == 1, "清除示例需保留自己的项目")
            page.locator(".project-nav-item").filter(has_text="我的作品集项目").click()
            print("PASS 创建、编辑项目与安全清除示例")

            # 2. 新增未安排任务，再安排到下一年的具体时间。
            page.get_by_role("button", name="添加任务", exact=True).click()
            modal.locator('[name="title"]').fill("完成首页设计")
            expect(modal.locator("#schedule-fields")).to_be_hidden()
            modal.get_by_role("button", name="添加任务", exact=True).click()
            page.get_by_role("button", name="安排时间", exact=True).click()
            modal.locator('[name="date"]').fill("2027-01-15")
            modal.locator('[name="start"]').fill("09:00")
            modal.locator('[name="end"]').fill("10:30")
            modal.get_by_role("button", name="保存修改", exact=True).click()
            task_id = stored()["items"][0]["id"]
            page.locator(".task-date").click()
            expect(page.locator("#calendar-year")).to_have_value("2027")
            expect(page.locator("#calendar-month")).to_have_value("0")
            expect(page.locator(".schedule-section")).to_contain_text("1 月 15 日")
            expect(page.locator(".schedule-row")).to_contain_text("完成首页设计")
            expect(page.locator(".time-label")).to_contain_text("10:30")
            print("PASS 项目任务安排到日历、跨年切换与日期选择")

            # 3. 双向完成同步；从日历改名称、日期与时间，旧日期不留副本。
            page.get_by_role("checkbox", name="完成：完成首页设计", exact=True).check()
            page.locator(".project-nav-item").filter(has_text="我的作品集项目").click()
            expect(page.get_by_role("checkbox", name="完成：完成首页设计", exact=True)).to_be_checked()
            expect(page.locator(".progress-ring")).to_contain_text("100")
            page.locator('.task-tab[data-filter="done"]').click()
            expect(page.locator(".task-row")).to_have_count(1)
            # A click removes this row from the completed-only filter immediately.
            page.get_by_role("checkbox", name="完成：完成首页设计", exact=True).click()
            expect(page.locator(".task-row")).to_have_count(0)
            page.locator('.task-tab[data-filter="all"]').click()
            page.locator(".task-date").click()
            expect(page.get_by_role("checkbox", name="完成：完成首页设计", exact=True)).not_to_be_checked()
            page.get_by_role("button", name="编辑：完成首页设计", exact=True).click()
            modal.locator('[name="title"]').fill("首页设计与排版")
            modal.locator('[name="date"]').fill("2027-01-16")
            modal.locator('[name="start"]').fill("13:00")
            modal.locator('[name="end"]').fill("14:30")
            modal.get_by_role("button", name="保存修改", exact=True).click()
            page.locator('[data-date="2027-01-15"]').click()
            expect(page.locator(".schedule-row")).to_have_count(0)
            page.locator('[data-date="2027-01-16"]').click()
            expect(page.locator(".schedule-row")).to_have_count(1)
            page.get_by_role("checkbox", name="完成：首页设计与排版", exact=True).check()
            page.locator(".project-nav-item").filter(has_text="我的作品集项目").click()
            expect(page.locator(".task-row")).to_contain_text("首页设计与排版")
            expect(page.locator(".task-row")).to_contain_text("13:00–14:30")
            page.screenshot(path=str(RESULTS / "02-project.png"), full_page=True)
            page.locator(".task-date").click()
            print("PASS 完成状态双向同步、编辑日期时间与项目进度")

            # 4. 独立日程、时间校验、冲突提示、编辑和删除。
            page.get_by_role("button", name="新建日程", exact=True).click()
            modal.locator('[name="title"]').fill("跑步与散步")
            modal.locator('[name="start"]').fill("18:00")
            modal.locator('[name="end"]').fill("17:00")
            modal.get_by_role("button", name="添加日程", exact=True).click()
            expect(modal.locator("#form-error")).to_contain_text("结束时间")
            check(len(stored()["items"]) == 1, "不合法的时间不应写入存储")
            modal.locator('[name="end"]').fill("18:30")
            modal.get_by_role("button", name="添加日程", exact=True).click()
            expect(page.locator(".schedule-row")).to_have_count(2)
            check(next(i for i in stored()["items"] if i["title"] == "跑步与散步")["projectId"] is None, "独立日程不能关联项目")
            page.get_by_role("button", name="编辑：跑步与散步", exact=True).click()
            modal.locator('[name="title"]').fill("傍晚散步")
            modal.get_by_role("button", name="保存修改", exact=True).click()
            page.get_by_role("button", name="新建日程", exact=True).click()
            modal.locator('[name="title"]').fill("临时安排")
            modal.locator('[name="start"]').fill("18:15")
            modal.locator('[name="end"]').fill("18:45")
            modal.get_by_role("button", name="添加日程", exact=True).click()
            expect(page.locator(".conflict-tag")).to_have_count(2)
            page.get_by_role("button", name="删除：临时安排", exact=True).click()
            modal.get_by_role("button", name="取消", exact=True).click()
            expect(page.locator(".schedule-row")).to_have_count(3)
            page.get_by_role("button", name="删除：临时安排", exact=True).click()
            modal.get_by_role("button", name="确认删除", exact=True).click()
            expect(page.locator(".schedule-row")).to_have_count(2)
            expect(page.locator(".conflict-tag")).to_have_count(0)
            print("PASS 独立日程增改删、非法时间保护与重叠提示")

            # 5. 刷新与彻底关闭浏览器后，用户数据仍保留。
            before_reload = stored()
            page.reload()
            expect(page.get_by_role("checkbox", name="完成：首页设计与排版", exact=True)).to_be_checked()
            check(stored() == before_reload, "刷新后数据变化")
            context.close()
            context = p.chromium.launch_persistent_context(profile, **options)
            context.set_default_timeout(8000)
            page = context.pages[0]
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(base)
            modal = page.locator("#modal")
            check(stored() == before_reload, "浏览器重开后数据变化")
            page.locator('[data-action="next-month"]').click()
            page.locator('[data-action="prev-month"]').click()
            page.get_by_role("combobox", name="年份", exact=True).select_option("2027")
            page.get_by_role("combobox", name="月份", exact=True).select_option("0")
            page.locator('[data-date="2027-01-16"]').click()
            expect(page.get_by_role("checkbox", name="完成：首页设计与排版", exact=True)).to_be_checked()
            expect(page.locator(".schedule-row")).to_contain_text(["首页设计与排版", "傍晚散步"])
            print("PASS 刷新及彻底关闭、重新打开浏览器后数据保留")

            # 6. 归档与恢复，日历保留任务；导出、无效导入、替换和幂等合并。
            page.locator(".project-nav-item").filter(has_text="我的作品集项目").click()
            page.get_by_role("button", name="归档项目", exact=True).click()
            modal.get_by_role("button", name="归档项目", exact=True).click()
            expect(page.locator(".archive-card")).to_contain_text("我的作品集项目")
            page.locator('.primary-nav [data-action="calendar"]').click()
            expect(page.locator(".schedule-row").filter(has_text="首页设计与排版")).to_contain_text("已归档")
            page.locator('[data-action="archive-view"]').click()
            page.get_by_role("button", name="恢复", exact=True).click()
            expect(page.get_by_role("heading", level=1)).to_contain_text("我的作品集项目")
            page.locator('[data-action="backup"]').click()
            with page.expect_download() as download_event:
                modal.get_by_role("button", name="下载完整备份", exact=True).click()
            backup_path = RESULTS / "roundtrip-backup.json"
            download_event.value.save_as(backup_path)
            backup = json.loads(backup_path.read_text(encoding="utf-8"))
            check(backup["items"] == stored()["items"], "导出遗漏任务数据")
            before_import = stored()
            modal.locator('#import-file').set_input_files({"name": "invalid.json", "mimeType": "application/json", "buffer": b'{"not":"a backup"}'})
            expect(modal.locator("#form-error")).to_contain_text("备份文件")
            check(stored() == before_import, "无效导入不应覆盖数据")
            modal.locator('#import-file').set_input_files({"name": "empty.json", "mimeType": "application/json", "buffer": b'{"version":1,"projects":[],"items":[]}'})
            expect(modal.locator('#import-preview')).to_be_visible()
            modal.locator('[name="import-mode"][value="replace"]').check()
            modal.get_by_role("button", name="确认导入", exact=True).click()
            check(stored()["items"] == [], "替换导入未清空旧数据")
            page.locator('[data-action="backup"]').click()
            modal.locator('#import-file').set_input_files(str(backup_path))
            modal.get_by_role("button", name="确认导入", exact=True).click()
            check(stored() == before_import, "备份还原后内容或完成状态不一致")
            page.locator('[data-action="backup"]').click()
            modal.locator('#import-file').set_input_files(str(backup_path))
            modal.get_by_role("button", name="确认导入", exact=True).click()
            check(stored() == before_import, "重复合并导入产生了重复任务")
            print("PASS 归档恢复与完整备份导出、校验、替换、合并还原")

            # 7. 在日历删除项目任务，项目清单也同步移除。
            page.locator('.primary-nav [data-action="calendar"]').click()
            page.get_by_role("combobox", name="年份", exact=True).select_option("2027")
            page.get_by_role("combobox", name="月份", exact=True).select_option("0")
            page.locator('[data-date="2027-01-16"]').click()
            page.get_by_role("button", name="删除：首页设计与排版", exact=True).click()
            modal.get_by_role("button", name="确认删除", exact=True).click()
            check(all(i["id"] != task_id for i in stored()["items"]), "删除未同步底层任务")
            page.locator(".project-nav-item").filter(has_text="我的作品集项目").click()
            expect(page.locator(".task-row")).to_have_count(0)
            print("PASS 删除项目日程与任务清单同步")

            # 8. 另一标签页实时同步，手机布局和键盘关闭弹窗。
            other = context.new_page()
            other.goto(base)
            other.get_by_role("button", name="新增项目", exact=True).click()
            other.locator('#modal [name="name"]').fill("另一个页面的目标")
            other.locator('#modal').get_by_role("button", name="创建项目", exact=True).click()
            expect(page.locator(".project-nav-item").filter(has_text="另一个页面的目标")).to_have_count(1)
            other.close()
            page.set_viewport_size({"width": 390, "height": 844})
            page.get_by_role("button", name="打开项目栏", exact=True).click()
            page.locator('.primary-nav [data-action="calendar"]').click()
            page.get_by_role("button", name="今天", exact=True).click()
            check(not page.evaluate("document.documentElement.scrollWidth > innerWidth"), "手机页面存在横向溢出")
            page.screenshot(path=str(RESULTS / "03-mobile.png"), full_page=True)
            page.get_by_role("button", name="新建日程", exact=True).click()
            expect(modal).to_be_visible()
            page.keyboard.press("Escape")
            expect(modal).not_to_be_visible()
            page.get_by_role("button", name="打开项目栏", exact=True).click()
            page.locator(".project-nav-item").filter(has_text="我的作品集项目").click()
            check(not page.evaluate("document.documentElement.scrollWidth > innerWidth"), "手机项目页存在横向溢出")
            check(not errors, f"浏览器脚本错误：{errors}")
            print("PASS 多标签同步、390px 手机布局与键盘操作；无浏览器脚本错误")
            context.close()
    finally:
        server.terminate()
        server.wait(timeout=10)


if __name__ == "__main__":
    run()
    print("\n全部真实浏览器流程检查通过。截图与备份位于 test-results/（已忽略，不入库）。")
