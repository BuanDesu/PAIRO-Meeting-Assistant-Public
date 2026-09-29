# 原生打包说明

## Windows portable EXE

- 运行 npm run desktop:portable；electron-builder 用 --dir 生成 Windows x64 运行目录，NSIS 3.12 将其封装成单文件自解压 portable EXE，输出在 release/。无需下载 electron-builder 的 NSIS bundle。
- Electron 主进程为每次启动生成本机 UI HTTP 服务与一个 LAN 信令端口；UI 服务只绑定 127.0.0.1，信令端口绑定 0.0.0.0 以接受同网手机。
- 屏幕/窗口由 Electron desktopCapturer 枚举，Windows 上使用应用内来源选择对话框，不会自动选择首个屏幕。Electron 的 useSystemPicker 选项目前仅 macOS 15+ 实验支持，故 Windows 不依赖它。[Electron 屏幕捕获文档](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- 系统音频请求 Electron Windows loopback；麦克风由应用弹出每次会话权限确认。三组 Alt+Shift 快捷键通过 Electron globalShortcut 注册，可在窗口未聚焦时触发。[Electron 全局快捷键文档](https://www.electronjs.org/docs/latest/api/global-shortcut)
- EXE 未做 Authenticode 签名，Windows SmartScreen 可能提示未知发布者。自解压包由本机 NSIS 3.12 生成；构建脚本自动探测 Program Files 下的 NSIS，非默认目录可通过 NSIS_HOME 指定。[electron-builder Windows 目标文档](https://www.electron.build/win)

## Android APK

- Capacitor 8.5.2 将 dist/ 打包到 Android WebView；Android 原生 shell 默认直接显示手机角色，使用 WebRTC 接收画面/音频，并通过 CapacitorHttp 原生网络插件发起 LLM API 请求（不受 WebView CORS 限制）。
- 最低 Android API 24（Android 7）；需要 JDK 21、Android SDK platform 36、build-tools 36.0.0 与 platform-tools。[Capacitor Android 文档](https://capacitorjs.com/docs/android)
- 安装 SDK 后设置 ANDROID_HOME / ANDROID_SDK_ROOT（默认 Android Studio 路径 LocalAppData/Android/Sdk）；如使用非默认 JDK，请设置 JAVA_HOME。Gradle 本地配置文件不会提交到仓库。
- 运行 npm run android:sync 会先构建网页，并在 android/ 不存在时执行 cap add android，之后同步资源。运行 npm run android:apk 构建 debug APK。
- Debug APK 由本机 Android debug keystore 自动签名，适合侧载和验收；未创建生产发布 keystore，因此不应直接上传 Play Store。

## P2P 与 Android cleartext 边界

Android 包使用 androidScheme=http 与 Capacitor cleartext 设置，让 HTTPS/localhost WebView 可在同一可信局域网通过 ws:// 连接 Windows EXE 的本地信令端口；不然不同 scheme/cleartext 策略会阻止局域网配对。该设置不适合公网或不可信网络。明文信令可能被局域网攻击者观察或篡改 SDP/ICE；公网正式部署需 HTTPS/WSS、来源限制、可控 TURN 和签名发布构建。

信令进程只转发房间协商消息，不处理数据通道内容。但这并不防止信令层的主动中间人；请只在可信局域网使用本地 HTTP/WS 配对模式。

## GitHub Actions

- workflow_dispatch：构建两个工件并保存为 GitHub Actions artifacts。
- 推送符合 v* 的 tag：构建并创建 GitHub Release，附加便携 EXE 与 debug APK。
- GitHub Release APK 仍为 debug 签名；生产签名密钥不在仓库、工作流或此 MVP 中创建。
