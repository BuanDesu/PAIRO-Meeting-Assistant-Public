# 维护者发布步骤

普通使用者请从仓库首页或 Releases 下载 EXE 与 APK，不需要执行这里的步骤。

## 发布前

1. 将待发布代码更新到主分支，确认 Windows/Linux CI 通过。
2. 保持 package.json 与 package-lock.json 的版本一致，并同步 README 下载链接中的版本、文件名和说明。
3. 确认桌面端和手机端使用同一版本；协议改动时明确要求两端同时升级。

## 自动打包发布

推送指向已验证提交的 `v<版本>` 标签会触发 `.github/workflows/package-release.yml`。工作流分别构建 Windows EXE / 目录 ZIP 和 Android 正式签名 APK，测试通过、三份文件都生成并验证后才创建或补全 Release。`npm run release:check` 检查标签、package.json 与锁文件版本，Android 内部版本也由同一版本生成。

发布文件名：

- `Pairo-Meeting-Copilot-<版本>-win-x64.exe`
- `Pairo-Meeting-Copilot-<版本>-win-x64-folder.zip`（解压一次后直接打开目录内 EXE）
- `Pairo-Meeting-Copilot-<版本>-android.apk`
- `SHA256SUMS.txt`

手动运行此工作流会生成 Actions artifacts，供检查下载；手动运行本身不创建 Release。

发布说明应包含下载入口、最低设备要求、README 使用指南和本次变更。发布前确认 EXE、APK、目录 ZIP 都可下载并包含在校验文件中；目录 ZIP 是可运行的 Windows 程序，页面底部的 Source code ZIP 是源码。

## 上传已经构建的安装包

也可以使用 GitHub 网页或 GitHub CLI，基于与产物一致的已验证提交创建草稿 Release，上传 EXE、APK，核对文件名、字节大小及 SHA-256 后再发布。v0.1.0 使用已在本机完成测试与构建的安装包。

自动发布不会覆盖同名的现有附件，避免后续重复构建替换已下载的安装包。需要更新程序时请使用新版本和新标签。

## 当前测试包的签名

Windows EXE 尚未进行 Authenticode 签名。已发布的 v0.1.0 APK 使用 debug 签名；迁移到正式签名时可能需要先卸载一次。以后的正式包使用相同签名，升级编号按 `major × 1000000 + minor × 1000 + patch + 1` 递增；minor/patch 须小于 1000，总编号不能超过 Android 限制。不得降低版本或在同一版本下更换二进制附件。

## 固定 Android 签名

在维护者明确授权后，Windows 上运行：

```powershell
powershell -NoProfile -File scripts/provision-android-signing.ps1 -Upload
```

脚本只在首次执行时生成密钥，重复执行不会更换密钥；`.local-signing/` 不进入 Git，目录权限仅给当前 Windows 用户，密码由 Windows DPAPI 加密保存。`-Upload` 将签名配置写入仓库 GitHub Actions 加密 Secrets：`PAIRO_ANDROID_KEYSTORE_BASE64`、`PAIRO_ANDROID_STORE_PASSWORD`、`PAIRO_ANDROID_KEY_ALIAS`、`PAIRO_ANDROID_KEY_PASSWORD`。

已有密钥可以直接配置这些 Secrets；本地构建设置对应的 `PAIRO_ANDROID_KEYSTORE`（文件绝对路径）及三个密码/别名环境变量，然后运行 `npm run android:release`。Secrets 必须由维护者保管与备份，不能提交源码。DPAPI 密码备份与原 Windows 账号绑定，复制本地目录到另一台电脑并不能自动解密；应另在个人密码管理器和离线备份中保存可恢复的签名信息。

使用本机生成的签名构建：

```powershell
powershell -NoProfile -File scripts/build-android-release.ps1
```

未获得授权或未配置密钥时只执行 `npm run android:apk` 开发验收；发布工作流会明确失败，不发布未签名或调试签名替代品。

2026-10-13 维护者已明确授权并完成首次固定签名配置：本机目录受限保存、四项 Actions Secrets 上传及正式 APK 签名检查通过。今后应复用现有密钥；私钥不在源码中。当前正式证书 SHA-256 指纹为 `b9ccb30df1c5cfec3e0f2eb6baffe57fe01ee13d045dfea8612c66b328eed400`，可用 `apksigner verify --print-certs` 核对后续 APK。
