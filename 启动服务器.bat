@echo off
cd /d %~dp0

REM 1. 系统 PATH 中的 node
where node >nul 2>nul
if not errorlevel 1 goto start

REM 2. WorkBuddy 托管 node
for /d %%p in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do set "PATH=%PATH%;%%p"
where node >nul 2>nul
if not errorlevel 1 goto start

REM 3. 没有 node，尝试自动安装
echo 未检测到 Node.js，正在尝试自动安装...
call :autoinstall
set "PATH=%PATH%;C:\Program Files\nodejs;%LOCALAPPDATA%\Programs\nodejs"
where node >nul 2>nul
if not errorlevel 1 goto start

REM 4. 自动安装失败，提示用户
echo.
echo [错误] 未能自动安装 Node.js。请安装 Node.js (https://nodejs.org) 后重新运行本脚本。
echo.
pause
goto end

:autoinstall
where winget >nul 2>nul
if not errorlevel 1 (
  echo 正在通过 winget 安装 Node.js LTS...
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
  goto :eof
)
echo 正在下载并安装 Node.js 官方安装包...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $ProgressPreference='SilentlyContinue'; $v=(Invoke-RestMethod -UseBasicParsing https://nodejs.org/dist/index.json | Where-Object { $_.lts -ne $false } | Select-Object -First 1).version; $u='https://nodejs.org/dist/'+$v+'/node-'+$v+'-x64.msi'; $t=$env:TEMP+'\node-install.msi'; Write-Host ('下载 '+ $u); Invoke-WebRequest -UseBasicParsing $u -OutFile $t; Start-Process msiexec -Verb RunAs -ArgumentList '/i',$t,'/quiet','/norestart' -Wait; Remove-Item $t -Force -ErrorAction SilentlyContinue } catch { Write-Host ('自动安装失败: '+$_); exit 1 }"
goto :eof

:start
node server.js
:end
pause