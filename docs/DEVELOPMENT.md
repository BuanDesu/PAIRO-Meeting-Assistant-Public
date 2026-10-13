# 源码运行与构建

普通使用者请先阅读仓库首页的下载和配对说明。这里面向需要修改代码或自行构建的人。

## 运行网页版

需要 Node.js 22.12+ 与 npm，CI 使用 Node.js 24。在仓库目录运行：

```bash
npm ci
npm run signal
```

另开一个终端，在同一目录运行：

```bash
npm run dev -- --host 0.0.0.0
```

电脑浏览器打开 `http://localhost:5173`。手机浏览器访问 `http://电脑局域网IP:5173`，信令地址填写 `http://电脑局域网IP:8787`。部分移动浏览器会限制局域网 HTTP 下的能力；正式部署请使用 HTTPS/WSS，详见 [部署说明](DEPLOYMENT.md)。

## 运行 Electron 桌面端

首次安装依赖后，先下载 Electron 运行时：

```bash
node node_modules/electron/install.js
npm run desktop
```

Windows 程序内置 UI 服务及 LAN 信令服务，不需要另外运行开发服务器。默认信令端口为 8787，冲突时自动选择空闲端口；UI 只监听本机，使用随机端口。

## 构建安装包

Windows x64 需要 NSIS 3.x，运行：

```bash
npm run desktop:portable
```

输出：`release/Pairo-Meeting-Copilot-<package.json 版本>-win-x64.exe`。

Android 需要 JDK 21、Android SDK platform 36 和 build-tools 36.0.0，设置 `JAVA_HOME`、`ANDROID_HOME` / `ANDROID_SDK_ROOT` 后运行：

```bash
npm run android:apk
```

输出：`android/app/build/outputs/apk/debug/app-debug.apk`，发布时使用包含产品名和版本的文件名。更多环境要求及签名说明见 [打包说明](PACKAGING.md)。

## 检查

```bash
npm test
npm run build
npm audit
```

安装 Electron 运行时后，还可运行 `npm run test:desktop` 验证屏幕权限入口，或 `npm run test:webrtc` 验证真实配对、截图和断开清理。测试使用空采集来源和模拟截图，不捕获真实屏幕或麦克风；WebRTC 测试需要本机允许 ICE 连通。

`npm run test:webrtc` 还会断开信令并重建媒体连接，确认数据通道恢复。`npm run test:ui` 使用生产构建验证网卡选择、二维码显示、角色切换时停止模拟采集与手机布局，截图保存在 `release/ui-qa/`。这些检查不代替 [实际设备验收](DEVICE_VALIDATION.md)。

当前功能分支新增扫码配对、电脑允许手机连接、断线恢复及 AI 配置测试/取消/重试；新协议版本为 2，与已发布的 v0.1.0 不兼容，两端必须一起升级。Android 开发版需要 Android 8 或更高版本。未发布前，README 下载区仍指向已经发布的 v0.1.0；下一次发布时统一更新使用指南和下载链接。

回答支持逐步显示：浏览器使用 fetch 流，Android 使用 `native/android/ModelStreamPlugin.java` 的原生 HTTP，避免浏览器 CORS 限制。两者共用 `src/completion-stream.js`；`[DONE]` 或明确的完成状态才提交历史与同步答案，中断内容不能当作完整回答。服务若直接返回 JSON，显示其完整答案；不会因流式不兼容自动重复发送请求。

`scripts/prepare-android.mjs` 在每次同步时复制并注册 `native/android/` 中的插件，因此不要只修改被 Git 忽略的生成工程。取消、超时和页面销毁会清理对应连接；插件禁止自动跳转和远程明文 API。Capacitor 日志关闭，避免调试记录残留模型内容；诊断时只输出必要状态。插件注册方式见 [Capacitor 官方说明](https://capacitorjs.com/docs/android/custom-code)。

分支推送和 PR 会在 Windows/Linux 运行测试与网页构建。版本标签和手动触发的原生打包流程见 [维护者发布步骤](RELEASING.md)。
