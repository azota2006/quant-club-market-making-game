@echo off
setlocal
cd /d "%~dp0"

rem Batch file, not PowerShell - sidesteps the execution-policy block on npm.ps1.
set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found.
  echo   Expected it at: %LOCALAPPDATA%\Programs\nodejs
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo   Installing dependencies, one moment...
  call npm.cmd install --no-audit --no-fund
  if errorlevel 1 (
    echo   Install failed.
    pause
    exit /b 1
  )
)

node server\index.js

echo.
echo   Server stopped.
pause
