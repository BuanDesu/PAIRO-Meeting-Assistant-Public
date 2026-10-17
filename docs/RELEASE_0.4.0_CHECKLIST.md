# 0.4.0 发布与交付

2026-10-17，维护者授权完成后续工作，明确仓库继续私有，功能测试由维护者自行完成。

- [x] 版本 0.4.0 / Android 4001；README 更新正式下载链接和新操作说明。
- [x] 复用固定 Android 签名；保持应用 ID、配置路径和既有正式包的覆盖升级兼容性。
- [x] Windows/Linux/Android CI 与 Windows EXE、目录 ZIP、正式签名 APK 构建通过。
- [x] 核对三份包的版本、APK 证书与 SHA-256，检查 Windows 包包含输入组件且不含本机配置或签名文件。
- [x] 发布私有仓库 v0.4.0，上传三份安装包及 SHA256SUMS，核对下载文件。
- [x] 将同一正式 APK 覆盖安装到已授权 USB 手机，核对系统安装版本；不卸载、不读取 Key、不代做业务验收。
- [x] 保留本机完整安装包和解压后的 Windows 程序，交给维护者自行测试。

本清单只记录发布和交付，不将安装成功当作真机功能验收。Windows 仍未签名，不改变仓库可见性。

## 发布证据

- PR [#6](https://github.com/BuanDesu/PAIRO-Meeting-Assistant/pull/6) 合并提交 `15154cf113db89b12f2c622a6b4fe288c50f3359`，标签 `v0.4.0` 指向同一提交。
- 源码 CI [39016608433](https://github.com/BuanDesu/PAIRO-Meeting-Assistant/actions/runs/39016608433)：Windows、Linux、Android 通过。100 项本地单元检查通过；不重复原有长时间会议或真实 AI 验收。
- 正式打包 [39017027829](https://github.com/BuanDesu/PAIRO-Meeting-Assistant/actions/runs/39017027829)：`windows-portable`、`android-apk`、`github-release` 全部成功。
- [v0.4.0 发布页](https://github.com/BuanDesu/PAIRO-Meeting-Assistant/releases/tag/v0.4.0) 为正式发布，三份安装包及 `SHA256SUMS.txt` 均为已上传状态；交付时再次通过 API 确认仓库 `private: true`。

## 文件与安装核对

- 本地三份文件的 SHA-256 均与正式发布摘要和 `SHA256SUMS.txt` 一致；Windows EXE、目录程序的版本均为 0.4.0。
- Windows 便携包与目录包中的 96 份应用文件逐一比对一致，包含选区读取、回答键入及快捷键组件。两份归档路径未包含 `PAIRO-data`、本机签名目录或私钥容器；APK 同样没有这些运行数据或签名私钥路径。
- 对目录包应用文件执行 Gitleaks 脱敏扫描，未检出凭据。本条只描述本次扫描范围，不替代 [完整隐私检查记录](PRIVACY_REVIEW_2026-10-16.md)。
- APK 的应用 ID 保持 `com.pairo.meetingcopilot`，版本 0.4.0 / 4001，最低 Android API 26；v2 签名校验通过，证书 SHA-256 与原固定正式证书一致。
- 第一次系统安装确认因手机息屏被取消；维护者说明情况后重新发起覆盖更新，ADB 返回 `Success`。系统版本核对为 0.4.0 / 4001，原始安装时间保持不变；全程未卸载或清除数据，未读取 Key、设置内容或对话。
- 手机业务流程与真实服务调用留给维护者自行测试，没有据此标记新功能真机验收完成。

## 本地交付位置

- 完整 EXE、ZIP、APK 和校验文件：`release/v0.4.0/downloads/`。
- 已完整解压的 Windows 程序：`release/v0.4.0/windows/Pairo Meeting Copilot.exe`。
- 另保留便携程序 `release/Pairo-Meeting-Copilot-0.4.0-win-x64.exe`，与已有 `release/PAIRO-data` 相邻；未修改旧配置或自动启动程序。使用前先从托盘退出旧版本。
- 核对结果保存在忽略的 `release/v0.4.0/qa/`，不提交本机运行缓存。手机重新启动后需在应用内填写 Key；不在聊天或仓库提供 Key。
