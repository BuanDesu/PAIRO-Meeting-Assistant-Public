# 项目进度

最后更新：2026-09-29

## 当前状态：Android debug APK 已构建；Windows portable EXE 打包中

### 已完成

- [x] 安装 Electron 44 / Capacitor 8 包装依赖与 Android SDK command-line tools、platform 36、build-tools 36.0.0。
- [x] 增加 Electron Windows portable 配置、用户可选屏幕捕获、Windows loopback 音频、麦克风确认、全局快捷键与本地 LAN 信令入口。
- [x] 增加 Capacitor Android 配置，APK 默认手机角色；增加 Android APK 打包脚本与 GitHub Actions 发布工作流。
- [x] Android APK 构建成功并通过 apksigner v2 验证；包名 com.pairo.meetingcopilot，min API 24 / target API 36，文件 4,152,353 bytes（debug 签名）。

- [x] 创建 Vite 前端与 Node.js WebSocket 信令服务。
- [x] 桌面/手机双角色界面与房间码配对。
- [x] 信令服务仅转发 SDP/ICE，限制每个房间一台桌面与一台手机，不接受应用内容消息。
- [x] WebRTC 媒体轨道与 RTCDataChannel；桌面屏幕分享、可选系统音频和麦克风。
- [x] 桌面快捷键截图、语音识别与文字请求；Alt+Shift+A 可通过 P2P 切换手机自动回答；手机端显示请求并播放远端音频。
- [x] 手机端可配置 OpenAI-compatible endpoint、model 和 API Key；截图/文本问答、可选自动作答、答案回传桌面。
- [x] API Key 只保留在页面运行时；截图压缩；输入输出使用 textContent；服务端房间不持久化。
- [x] 自动化测试：10 项通过（包含信令集成、API 请求、URL 安全与 UI 选择器契约）；Vite 生产构建成功。

### 未完成 / 后续

- [ ] 完成并校验 Windows portable EXE；自解压打包使用本机 NSIS 3.12。
- [ ] 使用一台真实电脑与一台真实手机，按公网/局域网分别验证权限、音频自动播放策略与完整协商流程。
- [ ] 选择并部署公开 HTTPS/WSS 信令地址；配置有访问控制与短时效凭据的 TURN 服务以支持复杂 NAT。
- [ ] 在真实 LLM 提供商上验证模型名称、视觉输入能力与 CORS 配置。
- [ ] 视实际测试结果增加 QR 配对、断线恢复、房间过期和服务端速率限制。

### 已知限制

- 屏幕分享、快捷键和语音识别受浏览器能力与权限影响；快捷键要求网页获得焦点。
- 语音识别可能调用浏览器供应商在线服务，不等同于本地离线转写。
- 默认 STUN 不能保证所有网络之间直连；需要 TURN 时应配置 ICE_SERVERS_JSON。
- 浏览器直连模型要求提供商允许跨域请求；不要在共享设备或不可信网页输入 API Key。
- 当前没有账号、持久化对话、项目级认证、TURN 凭据签发或生产级滥用防护。

## 验收记录

| 检查 | 结果 |
|---|---|
| npm test | 10 passed |
| npm run build | passed |
| Android APK | Build SUCCESS; apksigner v2 verified; debug signed |
| Windows portable EXE | 正在构建 |
| 真机安装 / P2P + LLM | 尚未执行 |
