# 通知图片本地识别资源

本目录固定分发 Tesseract.js 6.0.1 的浏览器 Worker、Tesseract.js-core 6.0.0 的两种 LSTM 核心，以及 `@tesseract.js-data/chi_sim` 和 `@tesseract.js-data/eng` 1.0.0 的 `4.0.0_best_int` 模型。`*.wasm.js` 内嵌 WebAssembly，无需再下载独立 `.wasm` 文件；浏览器只选择适合当前设备的一种核心。

`src/ocr.js` 直接创建本目录的同源 Worker，并指定同源核心和语言目录。图片只在页面与该 Worker 的内存间传递，不上传到网站或任何 OCR 服务；识别后关闭 Worker。原通知图片不进入项目备份。识别出的文字由用户核对后另行确认保存。

首次识别需要联网，典型设备需加载约 8.8 MB 原始资源（实际网络压缩传输可能更小）。Service Worker 按需缓存资源后可再次离线识别。两个核心与模型全部分发约 12.7 MB，避免在第一次安装 PWA 时强制下载。

## 完整性与重建

`manifest.json` 列出了分发文件的 SHA-256、字节数、运行时标记、原归档成员，以及固定 NPM 归档的 SHA-512。核心、Worker 和模型均按原归档字节分发，没有修改第三方实现。

若需要补齐丢失的资源，保留已提交的清单，在项目根目录运行：

```sh
node scripts/vendor-ocr.mjs
```

维护脚本通过系统 `curl` 下载，沿用系统代理与 CA 配置，并在复制前核对固定归档和文件校验值；不使用凭据。不需要在日常启动应用时执行，也不需要安装 NPM 运行依赖。

## 许可证

- Tesseract.js 和 Tesseract.js-core 为 Apache-2.0，完整许可证及 Worker 中打包依赖的许可证见 `licenses/`。
- 两个语言 NPM 包的元数据声明 MIT，包来自 `naptha/tessdata`；该上游语言数据仓库分发的完整 Apache-2.0 许可证也保存在 `licenses/tessdata-LICENSE.txt`。NPM 包的版本、来源和归档完整性在清单中保留。

本地规则解析与图片 OCR 都不能保证通知中的时间、地点识别准确；尤其是模糊照片、手写文字或复杂表格，应在项目预览中核对原文后再保存。
