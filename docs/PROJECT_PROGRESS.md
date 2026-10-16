# 项目进度

最后更新：2026-10-16。

2026-10-16：仓库改名为 PAIRO-Meeting-Assistant，保持私有，本地 origin 与源码链接同步。完成源码／Git 历史、正式附件和可读取 GitHub 内容的隐私检查，未发现真实凭据泄漏；补充运行数据与私钥容器的忽略规则，README 改为逐步使用指南。检查范围与限制见 [隐私检查记录](PRIVACY_REVIEW_2026-10-16.md)。v0.3.0 历史安装包内容与摘要保持不变。

0.3.0 XP 工作台已完成，Android 升级编号 3001、协议 3；三页导航、手机竖屏聊天室、可配置 Num1/Num2/Num3/↑/↓、静默托盘、本机双音源离线转写与一对一系统音频模式均已实现。新 APK 覆盖升级保留设置，实际触控、键盘与五项快捷键短流程通过；中文转写统一为简体，一对一实际系统音频转写与手机自动回答通过，麦克风请求为 0。最终代码 d3d4bda 的 Windows/Linux/Android CI 全部通过，用户已授权合并 [PR #3](https://github.com/BuanDesu/PAIRO-Meeting-Assistant/pull/3) 并发布。EXE、ZIP、正式签名 APK 和校验文件由版本标签工作流发布，结果见 [v0.3.0](https://github.com/BuanDesu/PAIRO-Meeting-Assistant/releases/tag/v0.3.0)。旧版附件保持原样。见 [本轮 TODO](XP_WORKSPACE_TODO.md) 与 [检查证据](XP_WORKSPACE_VALIDATION.md)。

以下保留 0.2.0 已发布版本的真实设备记录。

0.2.0 的 Android 升级编号为 2001、协议版本 2，最低 Android 8，两端需同时更新。历史下载见 [v0.2.0](https://github.com/BuanDesu/PAIRO-Meeting-Assistant/releases/tag/v0.2.0)；提供 Windows EXE、目录 ZIP、固定正式签名 APK 与三份文件的 SHA-256。

[PR #2](https://github.com/BuanDesu/PAIRO-Meeting-Assistant/pull/2) 包含这批改进。最终 EXE、目录 ZIP 和正式 APK 已构建，APK v2 签名与版本校验通过；固定签名迁移和 2000 → 2001 覆盖升级通过。README 提供普通用户的下载、安装、扫码、模型设置与更新指南。

## 已完成的能力

- Windows 屏幕或窗口分享、缩略图选择器、可选系统音频与麦克风、全局快捷键、局域网信令服务。
- Android 默认进入手机端；二维码配对、地址选择、连接检测、电脑允许手机加入后才传输媒体。
- WebRTC 加密媒体与分块消息；有限重连、协商超时、旧会话清理、服务心跳与资源限制。
- 截图框选、传输进度、手机解码后的接收确认；取消后释放本地预览与等待任务。
- 手机文本与截图提问、配置检测、队列、取消、重试、逐段显示回答；Android 原生 HTTP 流式请求，API Key 仅在当前会话内存中。
- 版本与标签一致性检查、APK 升级编号、发布附件校验、脱敏连接诊断；Windows/Linux 检查和从零生成 Android 工程的构建检查。

## 验证与待完成工作

0.2.0 发布时自动化测试 81 项通过；生产界面与真实 Electron WebRTC 检查通过。Windows 成品和 Android 16 真机已验证扫码权限拒绝与恢复、加入审批、屏幕/单窗口/麦克风/系统音频、截图边界与手机回执、锁屏和后台、同房间更换来源、信令中断与服务重启、完整 60 分钟会话，以及电脑 Wi-Fi 暂断后 30 秒内自动恢复。真实 DeepSeek 配置、图片问答、逐段显示、取消、修正配置后重试、清空与主动离开均通过，未出现迟到回答或自动重新加入。正式包还验证了编辑后未失焦就关闭的设置保存。更新入口支持私有仓库提示；初始取消采集不生成房间并显示中文指导。ZIP 实际解压后的两次启动为 0.489 / 0.264 秒，测量范围见启动记录。

2026-10-14 最终正式 APK 覆盖安装 Success，冷启动后 API 地址与模型保留、Key 为空；实际手机“版本与更新”显示 0.2.0，查询私有仓库返回中文登录指导，弹窗正常关闭。PR #2 已获用户明确授权并合并到 main，版本发布继续由标签工作流生成安装包。

2026-10-14，[v0.2.0 已发布](https://github.com/BuanDesu/PAIRO-Meeting-Assistant/releases/tag/v0.2.0)，latest 已指向该正式版本。标签源提交 6eddb59；发布工作流的 Windows、Android 和 Release 作业均成功，EXE / ZIP / APK 与 SHA256SUMS.txt 四份附件已上传。校验文件的三份摘要与 GitHub 服务器附件摘要一致。官方 APK 已完整下载并核对 SHA-256、固定证书、v2 签名、0.2.0 / 2001 / min API 26、非调试属性；手机再次覆盖安装 Success，启动正常、地址和模型保留、Key 为空。已发布附件不替换。

未完成范围保持明确：切换到另一网络/地址变化及多种活动网卡组合缺完整真机记录；维护者暂无 Windows 代码签名证书。当前结果不作为跨公网连接、复杂会议负载或所有 Android 设备的保证。

完整的优先级与结果分别见 [TODO](TODO.md) 和 [实际设备验收](DEVICE_VALIDATION.md)。公网 HTTPS/TURN 部署按实际需求另行配置，当前主要面向同一可信局域网使用。
