@echo off
rem Trip Dashboard - first-time setup. Double-click me.
cd /d "%~dp0"
chcp 65001 >nul
echo.
echo  ==============================================
echo   Trip Dashboard - first-time setup
echo  ==============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
    echo  Node.js is not installed on this computer yet.
    echo.
    echo  1. Go to  https://nodejs.org
    echo  2. Download the LTS version and install it - all defaults are fine.
    echo  3. Close this window and double-click Setup.bat again.
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node --version') do set NODEVER=%%v
echo  Found Node.js %NODEVER%
echo.
echo  Installing the dashboard's packages - this can take a minute or two...
echo.
call npm install
if errorlevel 1 (
    echo.
    echo  Something went wrong during the install. Read the message above.
    echo  If it mentions your Node version, install Node 24 LTS from
    echo  https://nodejs.org and then double-click Setup.bat again.
    echo.
    pause
    exit /b 1
)
echo.
echo  Setup complete! Next: double-click Start-Dashboard.bat
echo.
pause
