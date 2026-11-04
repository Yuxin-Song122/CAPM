# HTTPS 发布与 iPhone 安装

## 发布的是什么

`node scripts/build-static.mjs` 生成 `dist/`，只包含网页、样式、JavaScript、清单、Service Worker 和图标。电脑的 `D:\datejob`、Node 数据 API、Git 历史和测试备份均不进入发布目录。

发布版使用设备本地存储。iPhone 和电脑各自保存各自的数据，**不会自动同步到 D 盘或其他设备**；可以手动导出、导入 JSON 转移。不要把静态网页部署当成跨设备同步。

## 首次启用 GitHub Pages

仓库：`Yuxin-Song122/CAPM`。代码带有 `.github/workflows/deploy-pages.yml`：推送到 `main` 或手动运行工作流都会尝试启用并部署 GitHub Pages。工作流使用 `actions/configure-pages` 的 `enablement: true` 和受限的 `pages: write` 权限；不会改变仓库的公开/私有状态。账号套餐或仓库权限不足时，启用可能失败，须由有管理权限的账号处理。

1. 使用有仓库管理权限的 GitHub 账号打开仓库。
2. 查看工作流自动启用是否成功；如 GitHub 要求手动配置，进入 **Settings → Pages → Build and deployment**，Source 选择 **GitHub Actions**。
3. 进入 **Actions → Publish Xuri PWA to GitHub Pages → Run workflow**，选择 `main`。
4. 等待 `build` 和 `deploy` 均完成，打开工作流输出或 Settings → Pages 中的实际地址。

GitHub Pages 是否支持私有仓库取决于账号和套餐。请按 GitHub 设置页面提示处理；不需要为了使用此项目而自动把源码仓库改为公开。若账号当前不支持，可把生成的 `dist/` 部署到你已有的 HTTPS 静态网站托管服务。

该仓库通常对应的候选地址是 `https://yuxin-song122.github.io/CAPM/`，**最终以部署输出为准，候选地址不代表已经发布或验证成功**。HTTPS 地址必须实际能在手机打开，才能继续安装。GitHub 仓库页面和 ZIP 下载链接均不是应用网址。

## Safari 添加到主屏幕

1. 在 iPhone 的 **Safari** 打开已部署的 HTTPS 应用网址，保持联网，等待页面的离线准备状态完成。
2. 点击 Safari 的**分享**按钮；若工具栏隐藏，轻点页面或先回到工具栏。
3. 在分享菜单中选择**添加到主屏幕**；若提供「作为 Web App 打开」，保持开启。
4. 确认名称为「序日」，点击**添加**。
5. 从主屏幕的「序日」图标打开，确认项目、月历与当天时间表可用。
6. 创建一条测试任务，关闭后重开，再在飞行模式下打开，检查记录和离线操作。离线资源首次下载完成前不能保证离线启动。

首次从浏览器添加主屏幕后，请核对已有记录；不同 iOS 版本或浏览器资料可能使用独立存储空间。如有需要，先从 Safari 导出，再在主屏幕应用导入。

## 备份、通知与同步边界

- 本地持久化并不等同于不会被删除；移除 Web App、清除网站数据、设备恢复或系统存储回收都可能影响记录。请定期导出到「文件」或 iCloud Drive。
- 本版不实现系统提醒通知、后台定时提醒或 Web Push；关闭 App 后不会自动通知你。
- 本版不实现电脑与手机自动同步。手动导入导出是备份和转移，不是同步。
- 模拟 iPhone 尺寸和 WebKit 检查不能代替 iPhone 真机 Safari 的主屏幕、文件选择器与离线启动检查；测试报告应区分两者。

## 维护与验证

发布构建根据网页、样式、脚本、清单和图标的实际内容自动生成 Service Worker 缓存版本，不需要手动记忆修改版本号。资源更新产生独立缓存，避免旧页面混用新版脚本。应用有更新时按页面提示刷新；操作前先完成并保存正在编辑的内容。

静态站点应能从子路径安装；资源、清单、图标和 Service Worker 均采用相对地址。不要把 `dist/` 中的路径改成网站根目录路径。

托管设置、账号权限或网络访问未就绪时，应明确报告阻塞项。只有实际访问并验证过的 HTTPS 地址才能标记为已上线。
