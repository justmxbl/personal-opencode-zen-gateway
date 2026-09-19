# HTTP health probe for the OpenCode Zen Gateway (Windows).
#
# Unlike a TCP port check, this asks the gateway's /health endpoint, which in
# turn probes the opencode backend. If the gateway is unreachable or reports a
# degraded backend, the gateway task is restarted.
#
# Runs every few minutes from the "opencode-zen-gateway-health" scheduled task.

param(
  [int]$Port = 8899,
  [switch]$CheckReady,
  [int]$LogMaxBytes = 2097152,   # 2 MB
  [int]$LogKeep = 2
)

$taskName = "opencode-zen-gateway"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$logFile = Join-Path $dir "health-check.log"

function Rotate-Log {
  if ($LogMaxBytes -le 0) { return }
  if (-not (Test-Path $logFile)) { return }
  if ((Get-Item $logFile).Length -lt $LogMaxBytes) { return }
  try {
    $oldest = "$logFile.$LogKeep"
    if (Test-Path $oldest) { Remove-Item $oldest -Force -ErrorAction SilentlyContinue }
    for ($i = $LogKeep - 1; $i -ge 1; $i--) {
      $src = "$logFile.$i"
      if (Test-Path $src) { Move-Item $src "$logFile.$($i + 1)" -Force -ErrorAction SilentlyContinue }
    }
    Move-Item $logFile "$logFile.1" -Force -ErrorAction SilentlyContinue
  } catch {
    # never let rotation break the check
  }
}

function Write-Log([string]$msg) {
  Rotate-Log
  "$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) $msg" | Add-Content $logFile
}

function Restart-Gateway {
  Write-Log "restarting gateway task '$taskName'..."
  schtasks /end /tn $taskName 2>$null | Out-Null
  Start-Sleep -Seconds 2
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*gateway.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" |
    Where-Object { $_.CommandLine -like "*serve*" -and $_.CommandLine -like "*4096*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  schtasks /run /tn $taskName | Out-Null
}

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 20
  if ($health.status -ne "ok") {
    Write-Log "DEGRADED: backend reachable=$($health.backend.reachable) restarts=$($health.backend.restarts)"
    Restart-Gateway
    Start-Sleep -Seconds 20
    $again = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 20
    Write-Log "post-restart: status=$($again.status) backend=$($again.backend.reachable)"
    exit 0
  }
  Write-Log "OK: backend pid=$($health.backend.pid) restarts=$($health.backend.restarts) models=$($health.models_cached)"

  if ($CheckReady) {
    try {
      $ready = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/ready?force=1" -TimeoutSec 90
      Write-Log "ready: ok=$($ready.ok) model=$($ready.model) latency=$($ready.latency_ms)ms"
    } catch {
      Write-Log "ready FAILED: $($_.Exception.Message)"
    }
  }
} catch {
  Write-Log "UNREACHABLE: $($_.Exception.Message)"
  Restart-Gateway
  Start-Sleep -Seconds 20
  try {
    $again = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 20
    Write-Log "post-restart: status=$($again.status) backend=$($again.backend.reachable)"
  } catch {
    Write-Log "post-restart STILL UNREACHABLE: $($_.Exception.Message)"
  }
}
