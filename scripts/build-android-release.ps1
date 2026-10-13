$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskSigningDir = Join-Path $taskRoot '.local-signing'
$taskConfig = Get-Content -LiteralPath (Join-Path $taskSigningDir 'android-signing.json') -Raw | ConvertFrom-Json
$taskSecret = ConvertTo-SecureString $taskConfig.protectedPassword
$taskPassword = [System.Net.NetworkCredential]::new('', $taskSecret).Password
$env:PAIRO_ANDROID_KEYSTORE = Join-Path $taskSigningDir 'pairo-release.keystore'
$env:PAIRO_ANDROID_STORE_PASSWORD = $taskPassword
$env:PAIRO_ANDROID_KEY_PASSWORD = $taskPassword
$env:PAIRO_ANDROID_KEY_ALIAS = $taskConfig.keyAlias
try {
    Push-Location $taskRoot
    & npm run android:release
    if ($LASTEXITCODE -ne 0) { throw 'Signed APK build failed' }
} finally {
    Pop-Location
    Remove-Item Env:PAIRO_ANDROID_KEYSTORE,Env:PAIRO_ANDROID_STORE_PASSWORD,Env:PAIRO_ANDROID_KEY_PASSWORD,Env:PAIRO_ANDROID_KEY_ALIAS -ErrorAction SilentlyContinue
}
