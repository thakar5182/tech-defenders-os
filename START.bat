@echo off
title Tech Defenders OS v3.2.1
cd /d "%~dp0"

echo ==================================================
echo   TECH DEFENDERS OS v3.2.1 - starting...
echo ==================================================

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not in PATH.
  echo Download it from https://nodejs.org  and run this file again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [setup] Installing dependencies ^(first run only^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check your internet connection and retry.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  node scripts\create-env.js
  if errorlevel 1 ( echo [ERROR] Could not create secure configuration. & pause & exit /b 1 )
)

findstr /B /R /C:"BREVO_API_KEY=." ".env" >nul 2>nul
if errorlevel 1 (
  echo [setup] Brevo API key is missing; email OTP needs one-time configuration.
  call CONFIGURE-BREVO.bat /setup
)

echo.
echo Starting server on http://localhost:4173
echo Super Admin: superadmin@techdefenders.in / Super@123
echo Press Ctrl+C to stop the server.
echo.

start "" http://localhost:4173
node server.js
pause
