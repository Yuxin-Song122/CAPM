# 提醒后台的 Pages 备用入口

此目录提供 Cloudflare Pages Advanced Mode 的免费备用 HTTPS 入口。**代码已准备好不代表入口已部署成功。** 必须完成权限配置、实际部署和手机联网检查后，才能把部署输出的网址用于「系统提醒」。`pages.dev` 在用户当前网络是否可访问需要实测，不能保证换入口后一定恢复连接。

备用入口只通过 `REMINDER_BACKEND` 服务绑定，把原请求交给同一账户中现有的 `xuri-push` Worker。路径、方法、请求头和请求正文保持原样；不接受任意上游网址，不发起其他网络请求，不记录或缓存配对码、令牌、请求正文。绑定缺失或服务调用失败时返回固定 JSON 503，仅向现有 GitHub Pages 来源提供跨域响应头，不回显内部异常。

## 保持现有数据和提醒服务

- 前端继续使用 `https://yuxin-song122.github.io/CAPM/`，iPhone 保留原主屏幕应用和本地项目、日程数据。
- 不修改原 Worker 的 `ALLOWED_ORIGIN`、`APP_URL`、D1 数据库、Cron、VAPID 密钥或配对码。这里不创建新的提醒数据库和定时任务。
- Pages 项目只需要服务绑定和公开来源配置，不需要复制 VAPID 私钥、配对码或 Cloudflare API Token 到网页代码。
- 当前尚未连接提醒后台的设备，可在备用入口实测可访问后，把「HTTPS 后台地址」改为新的根网址，仍使用原配对码连接。不要在根网址后添加 `/health`。
- 备用入口本身不新增电脑和手机的数据同步，也不代表已验证真实通知送达。测试通知和锁屏后的定时提醒仍需在 iPhone 上亲自验证。

## 为现有 Token 添加 Pages 权限

部署需要目标账户的 **Account → Cloudflare Pages → Edit（编辑）** 权限；现有的 Workers、D1 权限继续保留。

1. 在自己的 Cloudflare 控制台打开「个人资料 → API Tokens」。
2. 找到当前云环境使用的那个 Token，打开其「编辑」。
3. 保留已有权限，新增「Account → Cloudflare Pages → Edit」。账户资源范围继续只选自己的目标账户，保存修改。
4. 若当前 Token 无法编辑，先在 Cloudflare 界面确认可用的授权方式；不要把 Token、账户密码或包含凭据的截图发到聊天、提交 Git 或写入前端。

编辑现有 Token 的权限通常不需要更换 Token 值，也不需要把它再发给其他人。如果在云环境中部署，沿用环境秘密配置提供的 `CLOUDFLARE_API_TOKEN` 和普通环境变量 `CLOUDFLARE_ACCOUNT_ID`；不要在命令行粘贴或打印它们。

## 创建并部署备用入口

在项目根目录的终端中执行。Node.js 和 Wrangler 依赖使用原 `push-backend` 配置：

```sh
cd push-backend
npm ci
cd pages-gateway
npx wrangler pages project create xuri-push-capm --production-branch main
npx wrangler pages deploy public --project-name xuri-push-capm --branch main
```

如果项目已经创建，跳过 `project create`，直接部署。若项目名被占用，选一个自己的可用名称，并同步修改此目录 `wrangler.toml` 的 `name` 和命令中的 `--project-name`。这不会重命名现有的 `xuri-push` Worker。

`wrangler.toml` 中的 `REMINDER_BACKEND` 必须指向当前账户中已部署的 `xuri-push`。部署后在 Pages 项目「设置 → 绑定」中核对该服务绑定，不要给这里另建一套 D1 或 Cron。

**以部署命令实际输出的生产 HTTPS 根网址为准**，不要把示例或计划中的域名视为已经上线的地址。检查发布结果，再在发生问题的同一部 iPhone 上用应用的「检查后台连接」验证 `/health` 与 `/config`；通过后才连接设备、允许通知并发送测试通知。

当前云环境的网络白名单是独立限制。若执行环境需要访问新生成的域名，仍须通过环境配置的审核、保存和发布流程放行该确切域名；仅保存配置草稿不会生效。不得关闭代理、改路由或用备用入口绕过环境网络限制。
