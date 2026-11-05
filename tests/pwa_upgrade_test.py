"""Upgrade the previous published PWA in a real browser; use temporary data only."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import functools
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import threading
from playwright.sync_api import sync_playwright, expect
from pwa_browser_test import menu

ROOT = Path(__file__).resolve().parents[1]
READ_ALL = """async () => await new Promise((resolve,reject) => {
 const opening=indexedDB.open('xuri-device-v1');
 opening.onerror=()=>reject(opening.error.message);
 opening.onsuccess=()=>{ const db=opening.result; const tx=db.transaction('snapshots','readonly');
 const table=tx.objectStore('snapshots'); const keys=table.getAllKeys(); const values=table.getAll();
 tx.oncomplete=()=>{ const result=Object.fromEntries(keys.result.map((k,i)=>[k,values.result[i]]));db.close();resolve(result);};
 tx.onabort=()=>{db.close();reject(tx.error.message);}; };
})"""
class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_): pass
    def end_headers(self):
        self.send_header('Cache-Control','no-store')
        super().end_headers()

def run():
    expected_version=json.loads((ROOT/'package.json').read_text())['version']
    subprocess.run(['node','scripts/build-static.mjs'],cwd=ROOT,check=True)
    with tempfile.TemporaryDirectory(prefix='xuri-upgrade-') as temporary:
        temp=Path(temporary); old=temp/'old'; old.mkdir()
        # The known release used by the user's existing installation.
        archive=subprocess.check_output(['git','archive','90bbabc'],cwd=ROOT)
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar: tar.extractall(old, filter='data')
        subprocess.run(['node','scripts/build-static.mjs'],cwd=old,check=True,stdout=subprocess.DEVNULL)
        serve=temp/'web';serve.mkdir();public=serve/'CAPM';shutil.copytree(old/'dist',public)
        server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(serve)))
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base=f'http://127.0.0.1:{server.server_port}/CAPM/'
        profile=temp/'profile'
        try:
            with sync_playwright() as p:
                options=dict(headless=True,executable_path=shutil.which('chromium') or '/usr/bin/chromium',args=['--no-sandbox'],viewport={'width':390,'height':844},is_mobile=True,has_touch=True,timezone_id='Asia/Shanghai')
                context=p.chromium.launch_persistent_context(str(profile),**options)
                page=context.pages[0];page.set_default_timeout(12000)
                errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
                page.goto(base);expect(page.get_by_role('heading',level=1)).to_have_text('日历计划')
                page.wait_for_function("async()=> (await import('./src/pwa.js')).pwaStatus().ready")
                menu(page).get_by_role('button',name='新增项目',exact=True).click()
                modal=page.locator('#modal')
                modal.locator('[name=name]').fill('保留的项目')
                modal.locator('[name=goal]').fill('原有项目目标，不应因升级改变')
                modal.locator('[name=deadline]').fill('2027-02-28')
                modal.get_by_role('button',name='创建项目',exact=True).click()
                page.get_by_role('button',name='添加任务',exact=True).click()
                modal.locator('[name=title]').fill('保留的任务')
                modal.locator('#item-scheduled').check()
                modal.locator('[name=date]').fill('2027-01-19')
                modal.locator('[name=start]').fill('09:00')
                modal.locator('[name=end]').fill('10:30')
                modal.locator('[name=notes]').fill('任务原始备注')
                modal.locator('[name=completed]').check()
                modal.get_by_role('button',name='添加任务',exact=True).click()
                expect(page.locator('.task-row')).to_have_count(1)
                page.locator('.task-date').click()
                expect(page.locator('.schedule-row')).to_have_count(1)
                page.get_by_role('button',name='新建日程',exact=True).click()
                modal.locator('[name=title]').fill('保留的独立日程')
                modal.locator('[name=start]').fill('15:00')
                modal.locator('[name=end]').fill('16:00')
                modal.locator('[name=notes]').fill('独立日程原始备注')
                modal.get_by_role('button',name='添加日程',exact=True).click()
                expect(page.locator('.schedule-row')).to_have_count(2)
                before=page.evaluate(READ_ALL)
                assert len(before['current']['state']['projects'])==1
                assert len(before['current']['state']['items'])==2
                old_caches=page.evaluate('caches.keys()')
                assert old_caches
                # Serve the new version at exactly the same origin, path and profile.
                next_public=serve/'next';shutil.copytree(ROOT/'dist',next_public)
                public.rename(serve/'retired');next_public.rename(public)
                # Hold a deliberately uncooperative old connection. Exercise the
                # new store directly at a separate test-only URL, outside the old
                # worker's asset list, before the real app update.
                probe=(ROOT/'src/device-store.js').read_text().replace("from './model.js'", "from './src/model.js'")
                (public/'storage-upgrade-probe.js').write_text(probe)
                page.evaluate("""async()=>await new Promise((resolve,reject)=>{
                  const request=indexedDB.open('xuri-device-v1',1);
                  request.onerror=()=>reject(request.error.message);
                  request.onsuccess=()=>{window._heldOldDatabase=request.result;resolve();};
                })""")
                blocked=page.evaluate("""async()=>{
                  const probe=await import('./storage-upgrade-probe.js');
                  try {await probe.readDevice();return 'unexpected-success';}
                  catch(error){return error.message;}
                }""")
                assert '关闭其他序日页面' in blocked,blocked
                page.evaluate('window._heldOldDatabase.close()')
                assert page.evaluate(READ_ALL)==before,'被阻塞的迟到请求改写了原始记录'
                # Let the aborted late upgrade finish before inspecting its version.
                unchanged_version=page.evaluate("""async()=>await new Promise((resolve,reject)=>{
                  const request=indexedDB.open('xuri-device-v1');
                  request.onerror=()=>reject(request.error.message);
                  request.onsuccess=()=>{const db=request.result;const version=db.version;db.close();resolve(version);};
                })""")
                assert unchanged_version==1,'已拒绝的阻塞请求不应继续升级数据库'
                page.evaluate("async()=>{ const r=await navigator.serviceWorker.getRegistration();await r.update(); }")
                expect(page.get_by_role('button',name='更新应用',exact=True)).to_be_visible(timeout=20000)
                page.get_by_role('button',name='更新应用',exact=True).click()
                page.wait_for_function("version => document.querySelector('meta[name=\"xuri-release\"]')?.content === version", arg=expected_version, timeout=20000)
                expect(page.locator('#calendar-content')).to_be_hidden()
                expect(page.locator('.overview-metrics .metric')).to_have_count(2)
                expect(page.get_by_text('进行中的项目',exact=True)).to_have_count(0)
                expect(page.get_by_role('checkbox',name='完成：保留的任务',exact=True)).to_be_checked()
                expect(page.locator('.schedule-row')).to_have_count(2)
                assert page.evaluate(READ_ALL)==before,'升级改写了原有数据或版本号'
                database_version=page.evaluate("""async()=>await new Promise((resolve,reject)=>{
                  const request=indexedDB.open('xuri-device-v1');
                  request.onerror=()=>reject(request.error.message);
                  request.onsuccess=()=>{const db=request.result;const version=db.version;db.close();resolve(version);};
                })""")
                assert database_version==2,'应仅将同名 IndexedDB 内部版本升级为2'
                stale_open=page.evaluate("""async()=>await new Promise(resolve=>{
                  const request=indexedDB.open('xuri-device-v1',1);
                  request.onerror=(event)=>{event.preventDefault();resolve(request.error.name);};
                  request.onsuccess=()=>{request.result.close();resolve('unexpected-success');};
                })""")
                assert stale_open=='VersionError','旧版客户端不应继续打开数据库写回缺失新字段的记录'
                assert page.evaluate(READ_ALL)==before,'旧版打开失败后原始快照应保持相同'
                assert page.get_by_role('button',name='打开项目栏',exact=True).bounding_box()['y']>=14
                page.get_by_role('button',name='展开月历',exact=True).click()
                expect(page.locator('#calendar-content')).to_be_visible()
                page.locator('[data-date="2027-01-18"]').click()
                expect(page.locator('.schedule-row')).to_have_count(0)
                page.locator('[data-date="2027-01-19"]').click()
                expect(page.locator('.schedule-row')).to_have_count(2)
                page.get_by_role('button',name='收起月历',exact=True).click()
                expect(page.locator('#calendar-content')).to_be_hidden()
                assert page.evaluate(READ_ALL)==before,'折叠/选日期不应修改业务数据'
                for w,h in [(320,690),(390,844),(430,932),(844,390),(1366,768)]:
                    page.set_viewport_size({'width':w,'height':h})
                    assert not page.evaluate('document.documentElement.scrollWidth>innerWidth'),f'{w} 横向溢出'
                page.set_viewport_size({'width':390,'height':844})
                context.set_offline(True);page.reload()
                expect(page.locator('#calendar-content')).to_be_hidden()
                expect(page.locator('.schedule-row')).to_have_count(2)
                assert page.evaluate(READ_ALL)==before,'新版离线重开后原始数据变化'
                assert page.evaluate('caches.keys()')!=old_caches,'未切换到新版缓存'
                (ROOT/'test-results').mkdir(exist_ok=True)
                page.screenshot(path=str(ROOT/'test-results'/f'v{expected_version}-upgrade-preserved.png'),full_page=True)
                assert not errors,errors
                context.close()
                print('PASS 旧版实际 Service Worker 更新→新版，IndexedDB 全部记录和 revision 逐项相同')
                print('PASS 折叠/展开、日期切换、原任务完成状态和日程备注保留，五种屏幕无横向溢出')
                print('PASS 顶部点击区留白、新版离线重新打开保留全部原始数据；没有清除或重建业务数据库')
                print('PASS 旧连接阻塞时提示关闭其他页面，迟到升级不写入；数据库内部v2阻止旧v1客户端重新打开')
        finally:
            server.shutdown();server.server_close();thread.join(timeout=3)
if __name__=='__main__':run()
