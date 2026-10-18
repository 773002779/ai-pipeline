@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ---- 前端产物检查 ----
if not exist dist\index.html (
  echo [start] 未找到 dist 产物，正在构建前端...
  call npm run build
  if errorlevel 1 (
    echo [start] 构建失败，请检查 npm 环境。
    pause
    exit /b 1
  )
)

rem ---- 端口占用检查（幂等启动） ----
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":3001 " ^| findstr LISTENING') do (
  echo [start] 端口 3001 已被进程 %%a 占用，服务可能已在运行。
  echo [start] 如需重启请运行 restart.bat
  pause
  exit /b 0
)

echo [start] 启动 ai-pipeline: http://localhost:3001
start "ai-pipeline" cmd /c "set NODE_ENV=production&& npx tsx server/index.ts & pause"

rem 等待端口就绪后打开浏览器（最多等 15 秒）
set /a tries=0
:waitloop
timeout /t 1 >nul
set /a tries+=1
netstat -ano | findstr /C:":3001 " | findstr LISTENING >nul
if errorlevel 1 (
  if %tries% lss 15 goto waitloop
  echo [start] 等待超时，请查看服务窗口的报错信息。
  pause
  exit /b 1
)
start "" http://localhost:3001
echo [start] 服务已就绪。
