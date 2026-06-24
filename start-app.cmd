@echo off
REM ============================================================
REM  NSE Results Screener - one-click launcher
REM  Double-click this file to start the app (API + web UI).
REM  Keep this window open while using the app.
REM  Close the window (or press Ctrl+C) to stop the app.
REM ============================================================

title NSE Results Screener
cd /d "%~dp0"

REM Install dependencies on first run if needed.
if not exist "node_modules" (
  echo [setup] Installing dependencies, please wait...
  call npm run install:all
)

REM Open the dashboard in the default browser after a short delay,
REM so the servers have time to start.
start "" /b cmd /c "timeout /t 6 /nobreak >nul & start """" http://localhost:5173"

echo.
echo  Starting NSE Results Screener...
echo  Dashboard will open at http://localhost:5173
echo  (Keep this window open. Close it to stop the app.)
echo.

REM Start backend API + frontend together.
call npm run app

pause
