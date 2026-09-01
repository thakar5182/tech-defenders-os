@echo off
setlocal
title Tech Defenders OS - Brevo Email OTP
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Get it from https://nodejs.org
  if /I not "%~1"=="/setup" pause
  exit /b 1
)

where powershell >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Windows PowerShell is required for hidden secret input.
  if /I not "%~1"=="/setup" pause
  exit /b 1
)

if /I "%~1"=="/setup" (
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\configure-brevo.ps1"
) else (
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\configure-brevo.ps1" -Force
)
set "BREVO_RESULT=%ERRORLEVEL%"

if not "%BREVO_RESULT%"=="0" echo [ERROR] Brevo configuration was not saved.
if /I not "%~1"=="/setup" pause
exit /b %BREVO_RESULT%
