@echo off
rem Trip Dashboard - start the app. Double-click me. Close this window to stop it.
cd /d "%~dp0"
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
    echo  Node.js is not installed yet. Double-click Setup.bat first.
    pause
    exit /b 1
)
if not exist node_modules (
    echo  Setup hasn't been run yet. Double-click Setup.bat first.
    pause
    exit /b 1
)
echo.
echo  ==============================================
echo   Trip Dashboard is starting...
echo.
echo   Your browser will open http://localhost:3000
echo   in a few seconds. If it doesn't, open that
echo   address yourself.
echo.
echo   CLOSE THIS WINDOW TO STOP THE DASHBOARD.
echo  ==============================================
echo.
start "" /min cmd /c "ping -n 4 127.0.0.1 >nul & start http://localhost:3000"
node server.js
echo.
echo  The dashboard has stopped. If you didn't stop it yourself, read the
echo  message above for the reason. You can close this window.
pause
