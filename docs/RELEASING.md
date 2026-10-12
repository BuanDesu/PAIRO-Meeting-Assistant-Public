# 维护者发布步骤

普通使用者请从仓库首页或 Releases 下载 EXE 与 APK，不需要执行这里的步骤。

## 发布前

1. 将待发布代码更新到主分支，确认 Windows/Linux CI 通过。
2. 保持 package.json 与 package-lock.json 的版本一致，并同步 README 下载链接中的版本、文件名和说明。
3. 确认桌面端和手机端使用同一版本；协议改动时明确要求两端同时升级。

## 自动打包发布

推送指向已验证提交的 `v<版本>` 标签，例如 `v0.1.0`，会触发 `.github/workflows/package-release.yml`。工作流分别构建 Windows EXE 和 Android debug APK，测试通过、两个产物都生成后才创建或补全 Release。

发布文件名：

- `Pairo-Meeting-Copilot-<版本>-win-x64.exe`
- `Pairo-Meeting-Copilot-<版本>-android.apk`

手动运行此工作流会生成 Actions artifacts，供检查下载；手动运行本身不创建 Release。

发布说明应包含下载入口、最低设备要求、README 使用指南和本次变更。发布前确认两个 Assets 均可下载，不把自动生成的源码 ZIP 当作安装包。

## 上传已经构建的安装包

也可以使用 GitHub 网页或 GitHub CLI，基于与产物一致的已验证提交创建草稿 Release，上传 EXE、APK，核对文件名、字节大小及 SHA-256 后再发布。v0.1.0 使用已在本机完成测试与构建的安装包。

自动发布不会覆盖同名的现有附件，避免后续重复构建替换已下载的安装包。需要更新程序时请使用新版本和新标签。

## 当前测试包的签名

Windows EXE 尚未进行 Authenticode 签名。Android APK 使用 debug 签名，不是应用商店发布包；本机构建和 CI 构建的签名可能不同，更新时可能需要先卸载旧版。面向长期分发时，应配置由维护者保管的固定签名密钥；不把密钥提交到仓库。
