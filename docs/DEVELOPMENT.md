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

当前源码为 0.5.0，协议版本 5；两端必须同时升级，包括较早的 0.5.0 构建。Android 需要 8 或更新版本，手机固定竖屏，只负责配对与提词阅读。旧版客户端会在信令阶段收到不兼容提示。

PC 的 `MeetingEngine` 串行管理问题、上下文和最新完整回答，浏览器预览可直接 fetch（服务需支持 CORS）；生产 Electron 使用 `model-service.cjs` 的主进程 fetch，经可信主页面 IPC 传入受限参数并返回流式片段。保留 contextIsolation、sandbox 和 webSecurity，禁止带 Key 重定向；连接/整次请求 60 秒超时，取消会中止连接。Key 只留本次内存。Android 的旧模型插件与 JS 传输已删除，原生工程同步时清理遗留 Java 文件。`[DONE]` 或明确完成状态才提交历史，截断/失败/取消不会成为完整回答；JSON 服务仅请求一次。

`prompter-sync.js` 用接收端每次连接生成的随机标识、递增版本和完整状态快照隔离旧消息；每个快照最多 8 个问题，每问题最多 12000、回答最多 24000 UTF-16 单元。快照约每 70 ms 合并，最多一个发送中和一个待发送状态；现有 DataChannelTransport 继续提供分块、大小上限和背压。手机按请求 ID 更新文本，不拼接乱序增量。已批准手机重连后请求当前快照；批准新手机、PC 清空或结束会话才重置会话。断线时手机标明内容已过时，PC 取消键入并停止语音采集，保留本次回答供恢复。

`stopCapture()` 只停止采集：释放所有现有和待接受音轨、取消截图和未提交转写，保留房间及已提交模型任务。初次协商预留一个视频和两个音频 sendonly transceiver；串行 `replaceTrack(track|null)` 支持无轨暂停及不同音轨数量恢复，修订号阻止旧异步操作恢复采集。数据通道上的 `media-state` 使用 MID 告知手机当前有效媒体，手机清除旧帧和音频。暂停时重连仍使用空轨。`endSession()` 另行发出 `leave`，服务端删除桌面房间或撤销手机令牌，客户端清理历史与信任。

知识库由 `knowledge-files.cjs` 提取、`knowledge-service.cjs` 增量持久化、`knowledge-index.js` 本地检索、`knowledge-ui.js` 管理界面。只接受系统选择器添加的目录，不接受网页传入任意扫描路径；限制大小、格式、目录范围，跳过链接、依赖、构建及凭据，不执行任何内容。DOCX/ODT 只在内存解压正文，限制条目、压缩比和展开大小，不落地压缩路径。索引持有原文、摘要、相对来源、块 ID 与内容 hash；Key 和 API endpoint 不持久化到索引，模型配置只保存 hash。串行理解、全库 1500 个片段/24 MB 上限，取消后保留已完成文件，失败文件可重试。

检索对英文标识符和中文二/三字片段建立内存倒排表，按语料频率加权，至少覆盖 18% 查询词且匹配两个词或一个至少四字符的英文标识符，最多取六个片段与 14000 字上下文。只有带指代词的短追问才尝试上一问题。匹配依据可由 `knowledgeSearch` 的 matches/reason 读取，PC 页面显示路由说明。无关问题不做远程分类、不发 embeddings 请求、不逐文件扫描；未命中/索引不可用时明确按通用知识回答。它是词语检索，无法保证同义词/跨语言语义匹配。知识内容作为不可信参考数据注入，来源随答案同步手机。

分支推送和 PR 会在 Windows/Linux 运行测试与网页构建。版本标签和手动触发的原生打包流程见 [维护者发布步骤](RELEASING.md)。

## XP 工作台与针对性检查

`index.html` 复用原有 XP 面板、配色、按钮与间距。PC 底部增加会议助手设置和知识库，手机底部保留配对和阅读；导航不重建 PeerSession。截图在 PC 直接进入同一问题队列，不向手机发图片请求；普通文字提问不会夹带旧截图。

`src/shortcuts.js` 共用按键规则；`electron/shortcuts.cjs` 负责全局注册和冲突回滚。后台注册、前台 DOM 处理让输入框能正常使用方向键。窗口关闭收起到托盘，后台禁用节流、桌面 WebContents 静音。

Num3 显式读取前台选区并以纯文字自动提问；旧版五键配置会补入 Shift+Num3。`electron/text-automation.cjs` 通过固定 PowerShell/C# 工作进程的 UTF-8 stdin/stdout 操作 Windows UI Automation 和 `SendInput`，不把内容拼入命令，也不写入日志。系统 PowerShell 5.1 编译随包 C# 源码，所需 UIAutomation/.NET Framework 是 Windows 10/11 桌面组件；受限语言策略可能阻止此功能，其他会议功能仍可使用。

Windows 会把 Shift+Num3 转为导航键，C# 独立消息线程仅匹配设置中启用的 Shift+小键盘组合，以物理扫描码区分主键区导航键，忽略系统生成的假 Shift 松开事件；不将其他按键转换为文字、记录或发送。Electron 保留按键占用检测；窗口前台和快捷键关闭时不拦截组合。

Shift+Num3 首先读取 PC 最新完整回答，确认没有待处理问题，然后锁定前台窗口及可编辑 UIA 焦点，使用一次性令牌键入。新问题、失败、清空、取消和连接中断撤销可键入状态；不再发送 answer-request/answer-result。桌面后台保持静默。

中文默认 60 字/分钟；英文默认 90 词/分钟，按五字符一词。使用单调时钟安排各字符，UIA 及目标处理成本可能降低实际速度；换行/制表符为空格，拒绝其余控制字符，不发送回车键。每个字符前核对焦点与可编辑状态，Esc、再次按快捷键、失去连接或关闭快捷键通过独立读取线程的取消代次中止本次操作，保留小键盘识别线程供下次使用；组件超时或退出时终止进程。已经进入 Windows 输入队列的单个字符无法撤销。不得提升权限来绕过目标限制。相关 Windows API：[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)、[低级键盘事件](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-kbdllhookstruct)。

定向检查：`node --test test/main-session.test.js test/shortcuts.test.js test/text-automation.test.js`。`powershell.exe -NoProfile -Sta -File scripts/test-text-worker.ps1` 会短暂打开专用生成输入框并在结束后关闭，验证真实 UIA 选区、Unicode 输入、默认/自定义速度、焦点中止、密码/只读框、令牌过期及实体小键盘扫描码。不在用户其他应用中注入测试文字。界面与两端消息使用隔离 WebRTC/模拟 AI 检查，不重复长时真机流程。

`src/voice-input.js` 给每个音轨各建高通与独立 worklet，保留来源与 AudioContext 时间戳，使用零增益输出维持采集。`voice-worklet.js` 每路独立保留前后缓冲，输出有上限的 16 kHz PCM。`voice-queue.js` 串行运行本机识别，处理与等待合计最多三段，两路均有等待时轮流取段、同路 FIFO。超容量明确拒收触发片段并断开收听节点，已接受段处理完后停止并提示重试。只对同时、文本相同且麦克风波形几乎为较弱系统音副本的结果合并；普通声学回声依赖浏览器 AEC，不能保证全去重，合法后续重复不会全局删除。

`electron/offline-speech.cjs` 每段先调用本机 Silero VAD，再把含完整停顿的语音范围交给固定版本 Whisper；无声、弱解码证据及异常重复不会自动提问。`speech-language.cjs` 只在自动模式下，参考同源最近 90 秒内两段已接受且至少两秒的明确中/英文长句，对不超过 1.2 秒的短答选择语言；长句仍自动检测，停止或设置变化清空提示。没有词语替换或模型纠错。语言与模型档在电脑本地保存，旧 tiny 模型仍可用。引擎、VAD 和模型从固定官方版本下载并校验 SHA-256；转写不调用外部 API，临时 WAV/JSON 在完成、失败或取消后清理。

```bash
npm test                 # 轻量单元测试
npm run test:ui          # 隔离的角色导航与知识库 UI、竖屏和截图自动提问检查，并保存截图
npm run test:native-workspace  # Windows：真实注册、托盘静默、文本／滚动、双音源离线转写
```

原生短验收用 Windows SAPI 合成英文测试音频，可通过 `PAIRO_QA_CHINESE_WAV` 提供专用的 16 kHz 单声道普通话测试夹具；测试不播放声音，也不读取真实麦克风或屏幕。默认离线组件下载至隔离的 `release/xp-qa/runtime/PAIRO-data`，之后复用。用 `PAIRO_QA_OUTPUT` 指向新目录可保留旧证据。模拟手机运行于隐藏 Electron 窗口，AI 响应在主进程用模拟服务拦截，不使用真实 Key 或付费服务。预期的 Num2 占用异常用于检查回滚。区域裁剪等 UI 检查可运行 `npm run test:ui:media`。

`npm test` 显式运行当前 `test/`，不会递归执行忽略目录中的旧仓库迁移副本。`scripts/measure-knowledge.mjs` 使用 1000 个合成片段和本机模拟 SSE，结果保存于 `release/architecture-qa/latency.json`；没有真实服务性能结论。`npm run test:native-workspace` 另覆盖真实 IPC 目录选择边界（选择器返回固定测试目录）、知识库导入/缓存/路由、手机重连及清空。
