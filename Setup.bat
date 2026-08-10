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
if errorlevel 1 goto no_node
goto have_node

:no_node
echo  Node.js is not installed on this computer yet.
echo.
where winget >nul 2>nul
if errorlevel 1 goto manual_node
echo  Trying to install it for you with Windows' built-in app installer
echo  (winget). If Windows asks for permission, say Yes. This can take a
echo  few minutes...
echo.
winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto manual_node
echo.
echo  Node.js is installed! One more step:
echo  CLOSE this window, then double-click Setup.bat again.
echo  (Newly installed programs only become visible to new windows.)
echo.
pause
exit /b 0

:manual_node
echo  The automatic install didn't work, but doing it yourself is quick:
echo.
echo  1. Go to  https://nodejs.org
echo  2. Download the LTS version and install it - all defaults are fine.
echo  3. Close this window and double-click Setup.bat again.
echo.
pause
exit /b 1

:have_node
for /f "delims=" %%v in ('node --version') do set NODEVER=%%v
echo  Found Node.js %NODEVER%
echo.
echo  Installing the dashboard's packages - this can take a minute or two...
echo.
if not exist package-lock.json goto flex_install
call npm ci
if not errorlevel 1 goto done
echo.
echo  The exact-version install didn't work on this computer.
echo  Trying the flexible install instead...
echo.

:flex_install
call npm install
if errorlevel 1 (
    echo.
    echo  Something went wrong during the install. Read the message above.
    echo  If it mentions your Node version, install Node 24 LTS from
    echo  https://nodejs.org and then double-click Setup.bat again.
    echo  Still stuck? See "If the launchers don't work" in KICKSTART.md
    echo.
    pause
    exit /b 1
)

:done
echo.
echo  Setup complete! Next: double-click Start-Dashboard.bat
echo.
pause
