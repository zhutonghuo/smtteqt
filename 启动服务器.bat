@echo off
cd /d %~dp0
where node >nul 2>nul
if errorlevel 1 goto alt
node server.js
goto end
:alt
set PATH=%PATH%;C:\Users\LiuYuming\.workbuddy\binaries\node\versions\22.22.2-3
node server.js
:end
pause