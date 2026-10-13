param(
    [Parameter(Mandatory = $true)][string]$SourceDirectory,
    [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
$taskSource = (Resolve-Path -LiteralPath $SourceDirectory).Path
$taskDestination = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath (Join-Path $taskSource 'PAIRO-data')) { throw 'Refusing to package user preferences' }
$taskFiles = @(Get-ChildItem -LiteralPath $taskSource -Force | Select-Object -ExpandProperty FullName)
if ($taskFiles.Count -eq 0) { throw 'Application directory is empty' }
Compress-Archive -LiteralPath $taskFiles -DestinationPath $taskDestination -CompressionLevel Optimal -Force
Write-Output 'Directory ZIP created. Extract it once, then launch the application EXE inside.'
