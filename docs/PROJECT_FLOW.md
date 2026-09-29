# 项目流程树

## 端到端工作流

```mermaid
flowchart LR
  PC[桌面浏览器] -->|主动授权| CAP[屏幕 / 可选系统音频与麦克风]
  PC -->|SDP / ICE| SIG[短暂信令服务]
  PHONE[手机浏览器] -->|加入一次性房间| SIG
  SIG -->|仅转发 SDP / ICE| PC
  PC <-->|加密 WebRTC 媒体| PHONE
  PC <-->|RTCDataChannel 截图 / 转写 / 答复| PHONE
  PHONE -->|Key 仅在手机页面内存| LLM[OpenAI-compatible LLM]
  LLM -->|答案| PHONE
  PHONE -->|答复同步| PC
```

## 设备操作

```mermaid
flowchart TD
  A[桌面点击开始分享] --> B[浏览器屏幕权限与可选音频权限]
  B --> C[生成随机房间码并连接信令]
  C --> D[手机输入服务地址与房间码]
  D --> E[SDP Offer / Answer 与 ICE 候选交换]
  E --> F{WebRTC P2P 连通?}
  F -->|是| G[手机显示画面与播放音频]
  F -->|否| H[部署 TURN 并配置 ICE_SERVERS_JSON]
  H --> E
  G --> I{桌面快捷键}
  I -->|Alt+Shift+S| J[压缩 JPEG 截图]
  I -->|Alt+Shift+M| K[语音识别为文本]
  I -->|Alt+Shift+A| Q[切换手机自动回答]
  Q --> M
  J --> L[RTCDataChannel 发送到手机]
  K --> L
  L --> M{手机自动回答已开启?}
  M -->|是| N[调用手机配置的 LLM API]
  M -->|否| O[用户手动点击发送]
  O --> N
  N --> P[手机展示答复并通过 P2P 同步桌面]
```

## 仓库结构

```text
p2p-meeting-copilot/
├─ docs/ (部署、计划、进度、流程)
├─ server/signaling.js      # 临时信令，仅转发 SDP/ICE
├─ src/main.js              # 双端 UI、采集快捷键、请求编排
├─ src/peer-session.js      # WebRTC / RTCDataChannel
├─ src/llm.js               # 手机直连 OpenAI-compatible API
├─ src/styles.css           # 响应式主题
├─ test/                    # 信令集成测试
├─ index.html
├─ package.json
└─ vite.config.js
```

## 信任边界

- 信令服务可以看到房间码与连接协商元数据，但不接收屏幕帧、语音内容、对话或模型 Key。
- WebRTC 媒体与数据通道由浏览器加密；公网环境仍需要 TLS 信令并配置可靠 ICE/TURN。
- 手机客户端持有模型 Key 并直接发给其 API endpoint；endpoint 提供方能够读取请求中的文本/图像。
