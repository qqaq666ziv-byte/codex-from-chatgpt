@echo off
setlocal DisableDelayedExpansion
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\start-daily.ps1"
set "AutoDevDailyExit=%ERRORLEVEL%"
if /I "%~1"=="--no-pause" goto done
pause
:done
exit /b %AutoDevDailyExit%
