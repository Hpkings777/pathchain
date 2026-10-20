@echo off
REM PATHchain node launcher (Windows)
REM Double-click me on every exhibition computer. That's it.
title PATHchain node
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
  python run.py %*
  goto :end
)
where py >nul 2>nul
if %errorlevel%==0 (
  py run.py %*
  goto :end
)
echo.
echo  Python was not found on this computer.
echo  Install it from https://www.python.org/downloads/
echo  (tick "Add Python to PATH" during install) and run this file again.
echo.
pause

:end
pause
