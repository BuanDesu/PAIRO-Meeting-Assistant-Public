param([switch]$CompileOnly)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$assemblies = @('System.Windows.Forms', 'System.Drawing', 'System.Web.Extensions', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase')
foreach ($assembly in $assemblies) { Add-Type -AssemblyName $assembly }
Add-Type -Path (Join-Path $PSScriptRoot 'text-worker.cs') -ReferencedAssemblies $assemblies
if ($CompileOnly) { Write-Output '{"compiled":true}'; exit 0 }
[PairoTextWorker]::Run()
