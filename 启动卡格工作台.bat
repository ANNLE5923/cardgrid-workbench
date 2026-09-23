@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Please install Node.js 22 or later. & pause & exit /b 1)
where npm >nul 2>nul || (echo npm is required. & pause & exit /b 1)
if not exist node_modules\vite\bin\vite.js (echo Installing project dependencies... & call npm ci || (pause & exit /b 1))
start "CardGrid local server" /D "%~dp0" cmd /k "npm run dev"
timeout /t 3 /nobreak >nul
start "" http://127.0.0.1:4173/
