param([switch]$Upload, [string]$Repository = 'BuanDesu/p2p-meeting-copilot')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskSigningDir = Join-Path $taskRoot '.local-signing'
New-Item -ItemType Directory -Path $taskSigningDir -Force | Out-Null
$taskIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls $taskSigningDir /inheritance:r /grant:r "*$($taskIdentity):(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict signing directory permissions' }
$taskConfigFile = Join-Path $taskSigningDir 'android-signing.json'
$taskKeyFile = Join-Path $taskSigningDir 'pairo-release.keystore'
if (-not (Test-Path -LiteralPath $taskConfigFile)) {
    if (Test-Path -LiteralPath $taskKeyFile) { throw 'Existing keystore has no local credential metadata; do not overwrite it' }
    $taskBytes = New-Object byte[] 48
    $taskRandom = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $taskRandom.GetBytes($taskBytes) } finally { $taskRandom.Dispose() }
    $taskPassword = [Convert]::ToBase64String($taskBytes)
    $env:PAIRO_ANDROID_STORE_PASSWORD = $taskPassword
    $env:PAIRO_ANDROID_KEY_PASSWORD = $taskPassword
    & keytool -genkeypair -keystore $taskKeyFile -storetype PKCS12 -alias pairo-release -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=PAIRO' -storepass:env PAIRO_ANDROID_STORE_PASSWORD -keypass:env PAIRO_ANDROID_KEY_PASSWORD
    if ($LASTEXITCODE -ne 0) { throw 'Keystore generation failed' }
    $taskProtected = ConvertTo-SecureString $taskPassword -AsPlainText -Force | ConvertFrom-SecureString
    @{ keyAlias = 'pairo-release'; protectedPassword = $taskProtected } | ConvertTo-Json | Set-Content -LiteralPath $taskConfigFile -Encoding UTF8
}
if (-not (Test-Path -LiteralPath $taskKeyFile)) { throw 'Signing metadata exists but the keystore is missing' }
if ($Upload) {
    $taskConfig = Get-Content -LiteralPath $taskConfigFile -Raw | ConvertFrom-Json
    $taskSecret = ConvertTo-SecureString $taskConfig.protectedPassword
    $taskPassword = [System.Net.NetworkCredential]::new('', $taskSecret).Password
    # Reuse the user's existing GitHub authorization only inside this process.
    $taskCredentialText = "protocol=https`nhost=github.com`n`n" | git credential fill
    if ($LASTEXITCODE -ne 0) { throw 'GitHub credential unavailable' }
    $taskPasswordLine = $taskCredentialText | Where-Object { $_.StartsWith('password=') } | Select-Object -First 1
    if (-not $taskPasswordLine) { throw 'GitHub credential missing' }
    $env:GH_TOKEN = $taskPasswordLine.Substring(9)
    $taskSecrets = @{
        PAIRO_ANDROID_KEYSTORE_BASE64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($taskKeyFile))
        PAIRO_ANDROID_STORE_PASSWORD = $taskPassword
        PAIRO_ANDROID_KEY_ALIAS = $taskConfig.keyAlias
        PAIRO_ANDROID_KEY_PASSWORD = $taskPassword
    }
    foreach ($taskName in $taskSecrets.Keys) {
        $taskSecrets[$taskName] | & gh secret set $taskName --repo $Repository
        if ($LASTEXITCODE -ne 0) { throw "Cannot upload repository secret: $taskName" }
    }
    Write-Output 'Fixed Android signing secrets configured in GitHub Actions.'
}
Remove-Item Env:PAIRO_ANDROID_STORE_PASSWORD,Env:PAIRO_ANDROID_KEY_PASSWORD,Env:GH_TOKEN -ErrorAction SilentlyContinue
Write-Output 'Signing key retained in the private, Git-ignored .local-signing directory.'
