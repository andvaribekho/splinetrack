@echo off
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
) else (
  where python >nul 2>nul
  if %errorlevel%==0 (
    start "" http://localhost:5173
    python -m http.server 5173 --bind 127.0.0.1
  ) else (
    echo Necesitas Node.js o Python instalado. https://nodejs.org
    pause
  )
)
