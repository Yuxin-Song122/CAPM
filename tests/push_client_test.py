"""Client contract checks with mocked notification/push provider (no real delivery)."""
from http.server import ThreadingHTTPServer
import functools,json,shutil,subprocess,tempfile,threading
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
from pwa_upgrade_test import Handler
from pwa_browser_test import menu
ROOT=Path(__file__).resolve().parents[1]
def run():
 subprocess.run(['node','scripts/build-static.mjs'],cwd=ROOT,check=True)
 key=subprocess.check_output(['node','--input-type=module','-e',"import {createECDH} from 'node:crypto'; console.log(createECDH('prime256v1').generateKeys('base64url'))"],text=True).strip()
 with tempfile.TemporaryDirectory(prefix='xuri-push-client-') as td:
  public=Path(td)/'CAPM';shutil.copytree(ROOT/'dist',public)
  server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=td));thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
  base=f'http://127.0.0.1:{server.server_port}/CAPM/';origin=base.split('/CAPM/')[0]
  requests=[]
  try:
   with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=shutil.which('chromium') or '/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':390,'height':844},timezone_id='Asia/Shanghai')
    context.add_init_script("""window._permissionCalls=0;let current=null;
     Object.defineProperty(window,'Notification',{configurable:true,value:class {static permission='granted';static requestPermission(){window._permissionCalls++;return Promise.resolve('granted')}}});
     Object.defineProperty(ServiceWorkerRegistration.prototype,'pushManager',{configurable:true,get:()=>({
      getSubscription:async()=>current,
      subscribe:async options=>(current={options,toJSON:()=>({endpoint:'https://web.push.apple.com/test',keys:{p256dh:'test-public',auth:'test-auth'}}),unsubscribe:async()=>{current=null;return true}})
     })});""")
    def route(req_route):
     req=req_route.request;path=req.url.removeprefix('https://push.example.test')
     headers={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization','Content-Type':'application/json'}
     if req.method=='OPTIONS':req_route.fulfill(status=204,headers=headers);return
     body=req.post_data_json if req.post_data else None;requests.append({'path':path,'method':req.method,'body':body})
     if path=='/config':value={'vapidPublicKey':key,'offsetsMinutes':[120,30,5]}
     elif path=='/devices' and req.method=='POST':
      assert body['pairingSecret']=='synthetic-pairing-secret'
      value={'deviceId':'synthetic-device','deviceToken':'synthetic-token'}
     elif path=='/devices' and req.method=='DELETE':req_route.fulfill(status=204,headers=headers);return
     elif path=='/schedule':value={'scheduledJobs':3*len(body['items']),'items':len(body['items'])}
     elif path=='/test':value={'accepted':True}
     else:raise AssertionError('unexpected path '+path)
     req_route.fulfill(status=200,headers=headers,body=json.dumps(value))
    context.route('https://push.example.test/**',route)
    page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(base);expect(page.get_by_role('heading',level=1)).to_have_text('日历计划')
    page.wait_for_function("async()=>(await import('./src/pwa.js')).pwaStatus().ready")
    assert page.evaluate('window._permissionCalls')==0,'permission must not be requested on startup'
    assert not requests,'unconfigured app must not upload schedules'
    page.get_by_role('button',name='新建日程',exact=True).click();modal=page.locator('#modal')
    modal.locator('[name=title]').fill('后台提醒测试')
    modal.locator('[name=date]').fill('2040-01-19');modal.locator('[name=start]').fill('09:00');modal.locator('[name=end]').fill('10:00')
    modal.locator('[name=location]').fill('本地地点不应上传')
    modal.get_by_role('button',name='添加日程',exact=True).click();expect(modal).not_to_be_visible()
    menu(page).locator('[data-action=push-settings]').click()
    expect(modal).to_contain_text('系统提醒未启用')
    expect(modal.locator('[name=backendUrl]')).to_have_value('https://xuri-push-capm.pages.dev')
    modal.locator('[name=backendUrl]').fill('https://push.example.test')
    modal.locator('[name=pairingSecret]').fill('  synthetic-pairing-secret  ')
    modal.get_by_role('button',name='连接后台并启用通知',exact=True).click()
    expect(modal).to_contain_text('设备已连接推送后台')
    expect(modal).to_contain_text('待提醒数量：3')
    assert page.evaluate('window._permissionCalls')==1
    scheduled=[r for r in requests if r['path']=='/schedule']
    assert scheduled and len(scheduled[-1]['body']['items'])==1
    item=scheduled[-1]['body']['items'][0]
    assert item['startAt']=='2040-01-19T01:00:00.000Z'
    assert set(item)=={'id','title','startAt'}
    assert '本地地点不应上传' not in json.dumps(scheduled,ensure_ascii=False)
    assert isinstance(scheduled[-1]['body']['generation'],int)
    modal.get_by_role('button',name='发送测试通知',exact=True).click()
    expect(page.locator('#toast')).to_contain_text('测试通知已提交')
    modal.get_by_role('button',name='关闭弹窗',exact=True).click();page.keyboard.press('Escape')
    page.get_by_role('checkbox',name='完成：后台提醒测试',exact=True).check()
    page.evaluate("async()=>{window._pushModule=await import('./src/push-client.js');}")
    page.wait_for_function("()=>{const x=window._pushModule.pushStatus(); return x.connected && !x.syncing && x.scheduledJobs===0;}")
    assert [r for r in requests if r['path']=='/schedule'][-1]['body']['items']==[],'completion must cancel future jobs'
    generations=[r['body']['generation'] for r in requests if r['path']=='/schedule']
    assert generations==sorted(set(generations))
    menu(page).locator('[data-action=push-settings]').click()
    modal.get_by_role('button',name='停用并撤销后台安排',exact=True).click()
    expect(modal).to_contain_text('系统提醒未启用')
    assert any(r['path']=='/devices' and r['method']=='DELETE' for r in requests)
    assert not errors,errors
    context.close();browser.close()
    print('PASS 未配置时不申请权限、不上传；显式授权后连接，UTC时间与递增版本正确，仅上传必要字段')
    print('PASS 测试通知请求、完成后取消安排、停用撤销设备；无脚本错误')
    print('NOT RUN 真实Cloudflare/Apple送达：本测试使用隔离的通知和HTTPS后台替身，不代表真机推送成功。')
  finally:server.shutdown();server.server_close();thread.join(timeout=3)
if __name__=='__main__':run()
