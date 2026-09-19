# Removes the OpenCode Zen Gateway scheduled tasks and stops running processes.

$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$taskName = "opencode-zen-gateway"
$healthTaskName = "opencode-zen-gateway-health"

schtasks /end /tn $taskName 2>$null | Out-Null
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $healthTaskName -Confirm:$false -ErrorAction SilentlyContinue

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*gateway.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" |
  Where-Object { $_.CommandLine -like "*serve*" -and $_.CommandLine -like "*4096*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host "Removed scheduled tasks and stopped the gateway."
