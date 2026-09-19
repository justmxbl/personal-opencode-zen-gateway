# Hidden launcher used by the Windows scheduled task.
# Runs the gateway in the foreground of this process so the task's restart
# policy applies if the gateway exits. The console window stays hidden.

$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $root
& node "$root\gateway.js"
exit $LASTEXITCODE
