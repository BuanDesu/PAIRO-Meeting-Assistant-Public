param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$DestinationRoot = (Join-Path $env:LOCALAPPDATA 'PairoMeetingCopilot\Cache')
)

$ErrorActionPreference = 'Stop'
$hashes = @{ '44.4.5' = '11c395820a5aaa8ebcc0686b476d0ac98a730274ebfbdc8cf5538a7c2815cb5d' }
if (-not $hashes.ContainsKey($Version)) { throw "No verified Windows Electron SHA256 is recorded for version $Version" }
$expected = $hashes[$Version]
$file = 'electron-v' + $Version + '-win32-x64.zip'
New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
$destination = Join-Path $DestinationRoot $file
if (Test-Path $destination) {
  $existing = (Get-FileHash -Path $destination -Algorithm SHA256).Hash.ToLower()
  if ($existing -eq $expected) { Write-Output ('Using verified cached Electron archive: ' + $destination); exit 0 }
  Remove-Item -Force $destination
}
$tempFile = Join-Path $DestinationRoot ($file + '.' + [guid]::NewGuid().ToString('N') + '.part')
$officialUrl = 'https://github.com/electron/electron/releases/download/v' + $Version + '/' + $file
try {
  Invoke-WebRequest -Uri $officialUrl -OutFile $tempFile -UseBasicParsing -TimeoutSec 900
} catch {
  Write-Output 'Official Electron download unavailable; trying mirror with the same official checksum.'
  $mirrorUrl = 'https://cdn.npmmirror.com/binaries/electron/v' + $Version + '/' + $file
  Invoke-WebRequest -Uri $mirrorUrl -OutFile $tempFile -UseBasicParsing -TimeoutSec 900
}
$actual = (Get-FileHash -Path $tempFile -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) {
  Remove-Item -Force $tempFile -ErrorAction SilentlyContinue
  throw ('Electron archive failed official SHA256 verification: ' + $actual)
}
Move-Item -Force $tempFile $destination
Write-Output ('Downloaded Electron archive verified against official release SHA256: ' + $destination)
