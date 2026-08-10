@echo off
rem Trip Dashboard - start the app. Double-click me. Close this window to stop it.
rem (Called with --wait-and-open it only waits for the server, opens the
rem  browser, and exits - that's the minimized helper window.)
if "%~1"=="--wait-and-open" goto waitopen
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

rem The admin page (install your trip, reset PINs) needs a key. If you set an
rem ADMIN_KEY environment variable yourself it is used as-is; otherwise a fresh
rem key is generated for this session and shown below.
set "ADMIN_NOTE=(your own ADMIN_KEY environment variable)"
if defined ADMIN_KEY goto have_key
set "ADMIN_NOTE=(fresh key for this session - valid until you close this window)"
for /f "delims=" %%g in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N').Substring(0,12)"') do set "ADMIN_KEY=%%g"
if not defined ADMIN_KEY set "ADMIN_KEY=key%RANDOM%%RANDOM%%RANDOM%"
:have_key

set "LANIP="
for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-NetIPConfiguration | Where-Object {$_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up'} | Select-Object -First 1).IPv4Address.IPAddress" 2^>nul') do set "LANIP=%%i"

echo.
echo  ==============================================
echo   Trip Dashboard is starting...
echo.
echo   Your browser opens the dashboard by itself
echo   once it's ready (usually a few seconds).
echo.
echo   Addresses:
echo     On this computer:      http://localhost:3000
if defined LANIP echo     Phones on your Wi-Fi:  http://%LANIP%:3000
echo.
echo   Admin page (install your trip, reset PINs):
echo     http://localhost:3000/admin.html
echo     Admin key: %ADMIN_KEY%
echo     %ADMIN_NOTE%
echo.
echo   CLOSE THIS WINDOW TO STOP THE DASHBOARD.
echo  ==============================================
echo.
start "" /min cmd /c ""%~f0" --wait-and-open"
node server.js
echo.
echo  The dashboard has stopped. If you didn't stop it yourself, read the
echo  message above for the reason. You can close this window.
pause
exit /b 0

:waitopen
rem Poll the health endpoint (up to ~45s), then open the browser. If the server
rem never comes up, open anyway so the user sees *something* instead of nothing.
for /l %%i in (1,1,45) do (
  curl -s -o nul --max-time 2 http://localhost:3000/api/health 2>nul && goto openit
  timeout /t 1 /nobreak >nul
)
:openit
start "" http://localhost:3000
exit
