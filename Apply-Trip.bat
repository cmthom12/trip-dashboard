@echo off
rem Trip Dashboard - install your trip JSON into the app. Double-click me.
cd /d "%~dp0"
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
    echo  Node.js is not installed yet. Double-click Setup.bat first.
    pause
    exit /b 1
)
echo.
echo  ==============================================
echo   Install your trip into the dashboard
echo  ==============================================
echo.
echo  First, save the JSON your AI gave you as a file in this folder
echo  (see BUILD_WITH_AI.md). The usual name is my-trip.json
echo.
echo  Note: this is the FRESH-START installer. If you've already used the
echo  dashboard and want to keep its PINs/votes, import your JSON on the
echo  admin page instead (see ADMIN.md) - the tool below explains both.
echo.
set "TRIPFILE=my-trip.json"
set /p "TRIPFILE=Trip file name [press Enter for my-trip.json]: "
if not exist "%TRIPFILE%" (
    echo.
    echo  Can't find "%TRIPFILE%" in this folder. Save your AI's JSON here
    echo  with that name and double-click Apply-Trip.bat again.
    echo.
    pause
    exit /b 1
)
node tools\apply-trip-data.js "%TRIPFILE%"
echo.
pause
