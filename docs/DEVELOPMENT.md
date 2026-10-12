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

输出：`release/Pairo-Meeting-Copilot-0.1.0-win-x64.exe`。

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

分支推送和 PR 会在 Windows/Linux 运行测试与网页构建。版本标签和手动触发的原生打包流程见 [维护者发布步骤](RELEASING.md)。
