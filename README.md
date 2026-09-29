# PAIRO — P2P Meeting Copilot

桌面浏览器负责分享画面、系统音频/麦克风与语音转写；手机浏览器接收 WebRTC 直连流，必要时把转写文字或截图发送给你配置的 OpenAI-compatible LLM API，并将答案同步回桌面。

## MVP 能力

- **桌面节点**：浏览器授权后共享屏幕；可选共享系统音频与麦克风音轨。
- **快捷操作**：Alt + Shift + S 截图；Alt + Shift + M 开始/停止中文语音识别；Alt + Shift + A 远程切换手机自动回答。快捷键仅在此网页获得焦点且未编辑输入框时生效。
- **手机节点**：输入信令地址与一次性房间码，查看桌面视频/播放接收音频；显示问题、手动提问或打开自动回答。
- **LLM**：手机浏览器直接请求 OpenAI-compatible Chat Completions 接口，支持文本与 JPEG/PNG/WebP 截图上下文；答复同步回桌面。
- **P2P**：信令服务只中转 SDP/ICE；媒体、截图、转写与答复走 WebRTC。WebRTC 使用 DTLS-SRTP / DTLS 加密链路。

## 本地启动

需要 Node.js 20+ 与 npm。分别打开两个终端：

```bash
npm install
npm run signal
```

另一个终端运行：

```bash
npm run dev -- --host 0.0.0.0
```

桌面端在本机浏览器打开 http://localhost:5173，点击开始屏幕分享并允许捕获。手机与电脑在同一局域网时，用手机访问 http://电脑局域网 IP:5173；信令地址填写 http://电脑局域网 IP:8787，并输入桌面显示的房间码。在手机端填写 API endpoint、model 与 API Key；打开“收到问题后自动请求模型”后，截图/语音转写会自动请求模型。

本地局域网 HTTP 在部分移动浏览器中可能因安全上下文限制而不可用。生产或跨网使用请部署 HTTPS/WSS；公网 NAT 穿透失败时需配置 TURN。

## 设置与部署

- 信令监听端口：PORT，默认 8787。
- 浏览器来源白名单：ALLOWED_ORIGINS，逗号分隔；公网部署必须显式设置。
- ICE 服务配置：ICE_SERVERS_JSON，JSON 数组。未设置时使用公开 STUN。跨 NAT 网络需 TURN；生产环境应使用短时效 TURN 凭据，注意 /ice-config 会将 ICE 配置提供给客户端。
- Web 端生产构建：npm run build。将 dist/ 部署至 HTTPS 静态站点；Node 信令服务部署到支持 WebSocket Upgrade 的主机或反向代理。
- 前端信令地址填写信令主机 origin，不含 /signaling。

## 隐私与安全

- 共享屏幕、麦克风和音频需要桌面端用户明确授权；停止分享会关闭轨道与信令连接。
- 浏览器 Web Speech Recognition 的实现可能把语音发送至浏览器供应商服务，具体取决于浏览器。会议/问卷场景启用前应取得必要同意。
- API Key 只留在手机页面运行时内存，并随页面关闭/刷新清除。模型 endpoint 与 model 等非秘密偏好保存在本地浏览器。
- 模型请求从手机浏览器直接发到配置的提供商；截图/文本会被该服务处理。只向可信服务发送，并确认 endpoint 允许 CORS。
- 房间码是临时能力凭证。不要公开分享；关闭设备连接会释放房间。信令服务不保存会话和内容。
- 公开部署必须使用 HTTPS/WSS、设置来源白名单与 TURN 服务；本项目是个人工具 MVP，尚未加入账号、持久化、房间 PIN 或生产级滥用防护。

## 检查

- npm test：WebSocket 信令房间与消息转发集成测试。
- npm run build：Vite 生产构建。

查看 docs/PROJECT_PROGRESS.md、docs/PROJECT_FLOW.md、docs/DEPLOYMENT.md 与 docs/PLAN.md。
