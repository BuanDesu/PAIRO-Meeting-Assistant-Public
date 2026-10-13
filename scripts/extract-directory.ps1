param(
    [Parameter(Mandatory = $true)][string]$SourceZip,
    [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Destination) { throw 'Use a new measurement directory' }
Expand-Archive -LiteralPath $SourceZip -DestinationPath $Destination
