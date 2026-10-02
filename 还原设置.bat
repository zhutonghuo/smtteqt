@echo off
title EQuake 设置还原
echo.
echo  正在把 EQuake 设置还原为修复前的状态
echo  源文件: Settings.ini.bak
echo  同样请先完全退出 EQuake。
echo.
if not exist "%~dp0_fix_eq.ps1" goto nops
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_fix_eq.ps1" restore
if errorlevel 1 goto err
echo.
echo  已还原。重新启动 EQuake 即可。
goto end
:nops
echo  错误: 找不到 _fix_eq.ps1
goto end
:err
echo.
echo  还原失败。
:end
pause