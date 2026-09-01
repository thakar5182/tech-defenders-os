@echo off
title Tech Defenders OS v4.2.0 - Setup
cd /d "%~dp0"

echo ==================================================
echo   TECH DEFENDERS OS v4.2.0 - Mobile Connected - full setup
echo ==================================================

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Get it from https://nodejs.org
  pause
  exit /b 1
)

node -e "const v=process.versions.node.split('.').map(Number);process.exit(Math.max(0,22003-(v[0]*1000+v[1])))"
if errorlevel 1 (
  echo [ERROR] Node.js 22.3 or newer is required. Current version:
  node --version
  pause
  exit /b 1
)

echo [1/7] Installing dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 ( echo [ERROR] npm install failed & pause & exit /b 1 )

echo.
echo [2/7] Creating secure local configuration...
node scripts\create-env.js
if errorlevel 1 ( echo [ERROR] Could not create .env & pause & exit /b 1 )

echo.
echo [3/7] Configuring Brevo email OTP...
call CONFIGURE-BREVO.bat /setup
if errorlevel 1 echo [WARNING] Brevo configuration failed; password login will still work.

echo.
echo [4/7] Detecting and configuring local Ollama AI...
node scripts\configure-ollama.js
if errorlevel 1 echo [WARNING] Ollama configuration was skipped; the rest of setup will continue.

echo.
echo [5/7] Running isolated core regression tests ^(your real data is not changed^)...
node smoke-test.js
if errorlevel 1 ( echo [ERROR] Smoke checks failed - see output above. & pause & exit /b 1 )
node v3-test.js
if errorlevel 1 ( echo [ERROR] V3 checks failed - see output above. & pause & exit /b 1 )
node operations-test.js
if errorlevel 1 ( echo [ERROR] V4 operations checks failed - see output above. & pause & exit /b 1 )

echo.
echo [6/7] Running local provider contract tests ^(no paid message or GST submission^)...
node integration-test.js
if errorlevel 1 ( echo [ERROR] Provider contract checks failed - see output above. & pause & exit /b 1 )

echo.
echo [7/7] Setup complete.
echo   Start the app anytime with START.bat
echo   Reset to clean start:  npm run seed
echo   Re-run all tests:      npm test
echo   Reconfigure Ollama:    node scripts\configure-ollama.js
echo   Replace Brevo key:     CONFIGURE-BREVO.bat
echo.
pause
