@echo off
rem restores the default P/S wave display
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_pswave.ps1" show
echo.
pause
