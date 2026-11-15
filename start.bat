@echo off
chcp 65001 >nul
title MailHub 临时邮箱聚合台
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo [!] 未找到 Python，请先安装 Python 3.10+ 并加入 PATH。
  pause
  exit /b 1
)

python -c "import fastapi, uvicorn, curl_cffi" >nul 2>nul
if errorlevel 1 (
  echo [*] 首次运行，正在安装依赖...
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo [!] 依赖安装失败，请手动执行: python -m pip install -r requirements.txt
    pause
    exit /b 1
  )
)

echo.
echo   MailHub 已启动: http://127.0.0.1:8000
echo   按 Ctrl+C 停止服务
echo.

start "" http://127.0.0.1:8000
python -m uvicorn server.main:app --host 127.0.0.1 --port 8000
pause
