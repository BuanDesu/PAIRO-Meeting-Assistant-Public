# 部署说明

## 前端与信令服务

1. 安装 Node.js 20+，运行 npm ci。
2. 构建前端：npm run build，将 dist/ 发布至 HTTPS 静态托管。
3. 部署 Node 信令服务：npm run signal。托管平台需支持 WebSocket Upgrade，并设置 PORT。
4. 配置 ALLOWED_ORIGINS 为前端完整 origin，例如 https://copilot.example.com。
5. 为跨公网/NAT 环境设置 ICE_SERVERS_JSON，例如服务商提供的 STUN/TURN 配置。使用 TURN 时推荐动态短期凭据，不要把长期凭据写入前端构建变量。
6. 将界面中的信令服务地址设为信令服务 origin；客户端会自动使用 wss:// 与 /signaling 路径，并从 /ice-config 读取 ICE 配置。

本仓库没有提供云厂商账号、域名、TURN 服务或 API Key。上线前需自行配置并在两台设备间验收。

## 同一局域网开发

电脑运行 npm run signal 与 npm run dev -- --host 0.0.0.0。桌面浏览器从 http://localhost:5173 打开应用；手机访问电脑局域网 IP:5173，并将信令服务地址设置为 http://电脑局域网 IP:8787。若手机浏览器拒绝 WebRTC/语音能力，请改用可信 HTTPS 开发隧道或部署环境。

## LLM

手机端填写兼容 Chat Completions 的 HTTPS endpoint、模型名和个人 API Key。需确认服务支持 Chat Completions 消息格式、视觉输入格式（截图问答）与浏览器 CORS。Key 不保存；刷新或关闭页面后需重新输入。
