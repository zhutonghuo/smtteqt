@echo off
rem hides the P/S wave fronts of the estimated epicenter (IsHidePSWaveOfEstimatedEpicenter=true)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_pswave.ps1" wave
echo.
pause
