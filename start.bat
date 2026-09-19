@echo off
REM OpenCode Zen Gateway launcher (Windows).
REM Runs the gateway in the foreground. It spawns and supervises `opencode serve`.
setlocal
cd /d "%~dp0"
node "%~dp0gateway.js" %*
