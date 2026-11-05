# 序日后台提醒服务（Cloudflare Workers + D1）

这是独立的后端。GitHub Pages 本身不能在网页关闭后执行定时推送。
此目录提供可部署实现；仅把前端发布到 GitHub Pages **不会启用后台提醒**。
必须先完成下面的 Cloudflare 配置，再在序日的提醒设置中连接服务。
当前个人服务地址：`https://xuri-push.2832667234.workers.dev`。D1 已绑定、每分钟 Cron 已配置；设备仍需在主屏幕应用中配对并允许通知。仓库不含账户令牌、私钥或配对码。

## 提醒范围

- 服务器按一分钟周期检查任务，在开始前 120、30、5 分钟请求 Web Push 服务发送提醒。
- 首次连接时，已经错过的提醒时间会跳过，不会补发三条提醒。
- iPhone 需要 iOS 16.4 或以上，用 Safari 将序日添加到主屏幕，再从主屏幕打开并允许通知。
- 网页关闭或手机锁屏时，由 Apple 推送服务交给系统显示。勿强行终止系统进程；具体到达时间仍受网络、专注模式、系统通知设置和系统调度影响。
- 电脑与 iPhone 的完整项目、任务和日程不会互相同步。每台设备仅上传自己的待提醒安排。
- 完成、删除、改期会在下一次成功联网同步后替换服务器安排。**离线期间做出的修改，服务器要等设备再次联网并完成同步后才能获知。**
- 已交给 Apple 等推送服务的通知无法撤回；在发送瞬间进行编辑或完成操作，仍有可能收到原提醒。

## 准备工作

1. 一个可使用 Workers、D1 和 Cron Triggers 的 Cloudflare 账户。
2. 电脑安装 Node.js 22 或更新版本。在此目录打开终端：

   ```sh
   npm ci
   npx wrangler login
   ```

   使用浏览器登录 Cloudflare。若在自动部署环境中使用 API Token，请通过平台的秘密配置提供 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`。Token 只授予目标账户的 Workers Scripts 编辑与 D1 编辑权限。不要把这些值发到聊天、提交 Git 或写进前端。

3. 新建数据库：

   ```sh
   npx wrangler d1 create xuri-push
   ```

   把输出的 `database_id` 填入 [wrangler.toml](wrangler.toml)，替换全零占位符。保留 `binding = "DB"`。
4. 确认 `ALLOWED_ORIGIN` 是前端网址的**来源**，不能带路径；`APP_URL` 是完整前端网址。目前配置为：

   ```toml
   ALLOWED_ORIGIN = "https://yuxin-song122.github.io"
   APP_URL = "https://yuxin-song122.github.io/CAPM/"
   ```

   更换域名时要同时更新这两项。后端只接受此来源的跨域浏览器请求，通知点击地址也只允许在此来源内。

## 生成密钥并部署

以下命令在 `push-backend` 目录运行。把示例邮箱换成你能接收邮件的真实邮箱；它是推送服务要求的联系地址。

```sh
npm run generate-secrets -- mailto:你的真实邮箱
npm run db:remote
npx wrangler secret bulk .secrets.json
npm run deploy
```

- 脚本仅在电脑上创建 `.secrets.json` 和 `.dev.vars`，不在终端打印密钥。两个文件已加入本目录 `.gitignore`。
- `PAIRING_SECRET` 是个人设备连接此后端的配对口令。连接前端时，自己打开本地 `.secrets.json`，仅把 `PAIRING_SECRET` 对应值复制到“配对口令”；不要复制整份文件。
- `VAPID_PRIVATE_KEY` 是后端签名私钥，不能填进网页。`VAPID_PUBLIC_KEY` 是可公开的订阅公钥。
- 妥善保存一份私密备份。不要重复生成或随意更换 VAPID 密钥；换钥后所有设备需要重新订阅。脚本会拒绝覆盖已有文件。
- `wrangler deploy` 成功后才会给出你自己的 HTTPS Worker 地址。在前端填写这个实际地址。本文没有提供虚构的在线地址。
- 在 Cloudflare 控制台确认该 Worker 的 Cron Triggers 中存在 `* * * * *`。Cron 配置更改可能需要几分钟才生效。
- 若当前套餐 CPU 限额、请求数或 D1 用量不够，请在 Cloudflare 控制台查看日志和用量；本服务按个人小量任务设计，不承诺免费套餐能处理任意数量的同时提醒。

## 连接后的人工检查

1. 在浏览器访问 Worker 的 `/health`：应返回 `{"ok":true,"configured":true}`。缺少密钥、数据库绑定或表结构时返回 503。
2. iPhone：Safari 打开前端 → 分享 → 添加到主屏幕。从主屏幕启动，打开提醒设置，填写实际 Worker 地址和配对口令，允许通知。
3. 点击“发送测试提醒”。接口的 `accepted: true` 只代表推送服务接受了请求。必须亲自确认 iPhone 上出现通知。
4. 添加十分钟后的安排，完成联网同步，锁屏等待开始前五分钟的通知。另用较长时间安排验证提前三十分钟和两小时的通知。
5. 在另一条未到提醒时间的安排上分别测试完成、删除和改期，再确认同步成功且旧提醒不再出现。
6. 关闭网页、锁屏以及临时断网后恢复网络分别验证。设备专注模式等会改变通知表现；模拟浏览器不能代替 iPhone 真机检查。
7. 单独验证电脑与手机：此功能没有实现两台设备业务数据同步。

## API 约定

所有 JSON 接口返回 `Cache-Control: no-store`。错误结构是 `{ "error": "中文错误说明" }`。

| 接口 | 说明 |
| --- | --- |
| `GET /health` | 配置和数据库表可用性；不返回任何密钥。未就绪时 503。 |
| `GET /config` | `{ vapidPublicKey, offsetsMinutes: [120,30,5], timeZone: "UTC" }` |
| `POST /devices` | `{ pairingSecret, subscription: { endpoint, keys: { p256dh, auth } } }` → 201 `{ deviceId, deviceToken }`。同一订阅重新配对会撤销旧设备令牌和提醒。 |
| `PUT /schedule` | Bearer 令牌；`{ generation, items: [{ id, title, startAt }] }`。`startAt` 必须是带 `Z` 的 UTC ISO 时间。一次发送该设备全部未来未完成的定时安排。最多 500 项、请求最多 150 KB。 |
| `POST /test` | Bearer 令牌；每台设备每分钟最多一次；`{ accepted: true }` 仅表示推送服务已接受。 |
| `DELETE /devices` | Bearer 令牌；204，撤销令牌并删除此设备全部提醒。 |

`generation` 是同一设备跨浏览器标签页共享、通过 IndexedDB 事务递增的正安全整数。服务端在同一个 D1 原子批次内比较版本和替换全部安排。旧版本返回 409 `{ error: "提醒安排已被较新操作更新", stale: true }`，相同版本重试为幂等操作，避免旧请求恢复已经完成或删除的提醒。

同步成功返回 `{ scheduledJobs, items, serverTime }`。过去的开始时间和 `completed: true` 项不会创建提醒；没有日期或时间的任务应由前端省略。通知数据只含安排标题、开始时间、条目编号、提前分钟数和固定的应用地址。

## 保存的数据与发送机制

- D1 仅保存设备订阅、令牌的 SHA-256 哈希、任务编号/标题/UTC 开始时间和提醒投递状态。配对口令不入库；完整项目、目标、备注和备份不会上传。
- 支持精确的 Apple `web.push.apple.com`、Apple `pushapi…push.apple.com`、Google `fcm.googleapis.com` 与 Mozilla `updates.push.services.mozilla.com` HTTPS 订阅地址；拒绝其他主机、用户名密码、非默认端口和重定向，避免接口被用于任意网络请求。
- 标准加密由固定版本 `@block65/webcrypto-web-push@2.0.0` 实现：RFC 8291 `aes128gcm`，RFC 8292 VAPID。私钥仅保存在 Worker Secret。
- Cron 通过原子数据库领取避免多个执行实例同时发送同一提醒；失败仅在两分钟有效期内最多尝试三次。过期提醒不会在恢复服务后集中补发。404/410 订阅会自动删除，设备需重新连接。
- 为控制 Worker 子请求数和处理时间，每次 Cron 最多领取十条提醒。个人少量任务通常足够；同一分钟有大量提醒时，部分提醒可能等到下一分钟处理或过期，应调整容量和套餐后再增加上限。
- 推送系统无法保证端到端“恰好一次”：推送已被服务商接受但 Worker 尚未写入成功状态时崩溃，重试仍可能产生重复提醒。应用使用固定提醒标识减少重复展示。
- 已结束的提醒记录一天后清理；无未来安排且九十天未同步的设备会清理。配对尝试的 IP 哈希仅保留约五分钟。
- 关闭配对设备会删除其提醒。若口令泄露，请更换 Worker 的 `PAIRING_SECRET` 并检查 D1 设备记录；更换口令本身不会撤销已发放的设备令牌。

## 本地验证

```sh
npm ci
npm test
npm run db:local
npm run dev
```

测试使用临时内存 SQLite、临时生成的加密密钥和模拟推送提供商，不调用真实设备、不修改用户已有日程。独立验证了 RFC 8291 解密、VAPID 签名、安排替换、完成/删除/改期取消、并发领取、重试、过期和订阅失效等行为。`npm run dev` 会读取本地 `.dev.vars`；由于 CORS 与实际订阅限制，本地开发不能替代部署后 iPhone 锁屏和后台接收测试。

仅检查构建而不发布：

```sh
npx wrangler deploy --dry-run --outdir ../test-results/worker-build
```

此命令不会让服务上线。只有真实部署、配置 Cron 并连接设备后，才能把后台提醒标记为已启用。
