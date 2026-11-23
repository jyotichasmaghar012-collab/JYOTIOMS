@echo off
title Optical Shop OMS
cd /d "%~dp0"
echo ================================
echo   Optical Shop OMS - Starting
echo ================================
echo.

where node >nul 2>nul
if not %errorlevel%==0 (
    echo [ERROR] Node.js computer par install nahi mila.
    echo.
    echo https://nodejs.org se Node.js 22 LTS ya usse naya version install karein,
    echo phir is file ko dobara double-click karein.
    echo.
    pause
    exit /b
)

if not exist node_modules (
    echo Dependencies install ho rahi hain, thoda time lagega ^(sirf pehli baar^)...
    call npm install --omit=dev
)

echo.
echo ================================
echo Server chalu ho raha hai...
echo Browser mein ye link kholein:  http://localhost:5000
echo.
echo Is window ko band mat karein jab tak OMS use karna hai.
echo Band karne ke liye is window mein CTRL+C dabayein.
echo ================================
echo.

node app.js

pause
