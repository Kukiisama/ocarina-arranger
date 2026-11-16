@echo off
setlocal
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
cd /d "%~dp0"

echo [1/2] build
call npm run build
if errorlevel 1 goto fail

echo [2/2] package
call npx electron-builder --win --x64
if errorlevel 1 goto fail

echo.
echo DONE - output in release\
pause
exit /b 0

:fail
echo.
echo FAILED - check the log above
pause
exit /b 1
