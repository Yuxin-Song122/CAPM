@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Please install Node.js LTS from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
node server.mjs --open
pause
