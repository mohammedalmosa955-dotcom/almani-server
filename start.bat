@echo off
title سوبر ماركت ألماني - السيرفر
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   سوبر ماركت ألماني - تشغيل السيرفر
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.
cd /d "C:\Users\user\Desktop\almani-server"
echo جاري تشغيل السيرفر...
start http://localhost:3000
node server.js
pause
