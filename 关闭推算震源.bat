@echo off
rem disables epicenter estimation and the detection grid, so no wave front is drawn at all
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_pswave.ps1" full
echo.
pause
