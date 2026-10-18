@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do (
  echo [stop] 停止进程 %%a ...
  taskkill /F /PID %%a >nul 2>&1
  set FOUND=1
)
if !FOUND!==1 (
  echo [stop] 已停止。
) else (
  echo [stop] 服务未在运行。
)
