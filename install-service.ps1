# Installs the OpenCode Zen Gateway as a Windows scheduled task.
#
#   - starts at logon
#   - hidden console window
#   - no execution time limit
#   - restarts up to 3 times if the gateway exits
#   - keeps running while the machine is idle (StopOnIdleEnd = false)
#
# A companion task runs an HTTP health probe every 5 minutes and restarts the
# gateway if it is unreachable.

param(
  [int]$Port = 8899,
  [int]$HealthIntervalMinutes = 5,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$taskName = "opencode-zen-gateway"
$healthTaskName = "opencode-zen-gateway-health"
$serviceScript = Join-Path $dir "service.ps1"
$healthScript = Join-Path $dir "health-check.ps1"

# Stop anything already running from a previous install.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*gateway.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" |
  Where-Object { $_.CommandLine -like "*serve*" -and $_.CommandLine -like "*4096*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $healthTaskName -Confirm:$false -ErrorAction SilentlyContinue

# --- main gateway task -----------------------------------------------------
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$serviceScript`"" `
  -WorkingDirectory $dir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -DisallowHardTerminate `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal | Out-Null

# --- health probe task -----------------------------------------------------
$healthAction = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$healthScript`" -Port $Port" `
  -WorkingDirectory $dir

$healthTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes $HealthIntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$healthSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable `
  -MultipleInstances IgnoreNew

try {
  Register-ScheduledTask `
    -TaskName $healthTaskName -Action $healthAction -Trigger $healthTrigger `
    -Settings $healthSettings -Principal $principal | Out-Null
} catch {
  Write-Warning "Could not register the health probe task: $($_.Exception.Message)"
}

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $taskName
}

Write-Host ""
Write-Host "Installed scheduled tasks:"
Write-Host "  $taskName        - gateway, at logon, hidden, auto-restart"
Write-Host "  $healthTaskName - HTTP /health probe every $HealthIntervalMinutes min"
Write-Host ""
Write-Host "Gateway: http://127.0.0.1:$Port/v1"
Write-Host "Health:  curl http://127.0.0.1:$Port/health"
Write-Host "Ready:   curl http://127.0.0.1:$Port/ready"
