@echo off
title EQuake 白屏修复工具
echo.
echo  正在修复 EQuake 白屏 / 界面飞走 问题
echo  将修改: %APPDATA%\EQuake\config\Settings.ini
echo  修改前自动备份为 Settings.ini.bak
echo  请先完全退出 EQuake（右键托盘图标退出）再运行。
echo.
if not exist "%~dp0_fix_eq.ps1" goto nops
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_fix_eq.ps1"
if errorlevel 1 goto err
echo.
echo  修复完成。现在可以重新启动 EQuake 了。
echo  若想还原原设置，请运行「还原设置.bat」。
goto end
:nops
echo  错误: 找不到 _fix_eq.ps1
echo  请把本 bat 和 _fix_eq.ps1 放在同一个文件夹里。
goto end
:err
echo.
echo  修复失败，可把上面的英文输出发给排查者。
:end
pause