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

当前源码为 0.3.0 XP 工作台改版，协议版本 3，与已发布的 0.2.0 不兼容，两端必须一起升级。Android 需要 8 或更新版本，手机界面固定竖屏。README 明确区分未发布改版与最新已发布的 0.2.0，发布前不修改旧附件。

回答支持逐步显示：浏览器使用 fetch 流，Android 使用 `native/android/ModelStreamPlugin.java` 的原生 HTTP，避免浏览器 CORS 限制。两者共用 `src/completion-stream.js`；`[DONE]` 或明确的完成状态才提交历史，中断内容不能当作完整回答。回答仅留在手机；服务若直接返回 JSON，显示其完整答案，不会因流式不兼容自动重复请求。

`scripts/prepare-android.mjs` 在每次同步时复制并注册 `native/android/` 中的插件，因此不要只修改被 Git 忽略的生成工程。取消、超时和页面销毁会清理对应连接；插件禁止自动跳转和远程明文 API。Capacitor 日志关闭，避免调试记录残留模型内容；诊断时只输出必要状态。插件注册方式见 [Capacitor 官方说明](https://capacitorjs.com/docs/android/custom-code)。

分支推送和 PR 会在 Windows/Linux 运行测试与网页构建。版本标签和手动触发的原生打包流程见 [维护者发布步骤](RELEASING.md)。

## XP 工作台与针对性检查

`index.html` 保留配对／模型／截图元素，各角色底部三页通过 `navigatePage` 切换可见性，不重建 PeerSession。截图消息携带有界 `question` 字段，手机解码确认后携带该图自动提交；文字请求携带 `autoAsk`，不附加旧截图。滚动控制通过已配对数据通道传输，上翻后暂缓自动跟随。旧版本不能理解这些行为，因此协议升为 3。

`src/shortcuts.js` 共用按键规则；`electron/shortcuts.cjs` 负责全局注册和冲突回滚。后台注册、前台 DOM 处理让输入框能正常使用方向键。窗口关闭收起到托盘，后台禁用节流、桌面 WebContents 静音。Num3 只切换已有主窗口中的输入栏，无新窗口或后台键盘采集。

`src/voice-input.js` 将独立音轨分别接入 Web Audio 再混合；`voice-worklet.js` 做静音筛选、分段和 16 kHz PCM 输出，输出通过零增益节点维持处理，不播放采集内容。`electron/offline-speech.cjs` 校验输入大小，调用固定本机 CLI，串行处理、超时／取消清理。模型与引擎从固定官方版本下载并核验 SHA-256，不引入外部语音 API。

```bash
npm test                 # 轻量单元测试
npm run test:ui          # 隔离的三页 UI、竖屏和截图自动提问检查，并保存截图
npm run test:native-workspace  # Windows：真实注册、托盘静默、文本／滚动、双音源离线转写
```

原生短验收用 Windows SAPI 合成测试音频到文件，禁止播放，不读取真实麦克风或屏幕；首次自动下载约 80 MB 到隔离的 `release/xp-qa/runtime/PAIRO-data`，之后复用。模拟手机运行于隐藏 Electron 窗口，AI 响应在该页面拦截，不使用真实 Key 或付费服务。预期的 Num2 占用异常用于检查回滚。结果和截图在忽略的 `release/xp-qa/`。区域裁剪等原有 UI 检查仍可手动运行 `npm run test:ui:media`，不必每次重复全部设备和一小时场景。
