@echo off
title AV2 Transcoder - Setup ^& Launch
setlocal enabledelayedexpansion

echo ==========================================================
echo            AV2 TRANSCODER GUI LAUNCHER
echo        Zero-Dependency Auto-Setup ^& Launcher
echo ==========================================================
echo.

:: Store the directory where this script lives (with trailing backslash)
set "ROOT=%~dp0"

:: =====================================================
::  STEP 1: CHECK / INSTALL NODE.JS
:: =====================================================
echo [1/4] Checking for Node.js...

:: First check system PATH
where node >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('node --version') do echo        Found Node.js %%v on system PATH.
    goto :node_ready
)

:: Then check portable installation
if exist "%ROOT%tools\node\node.exe" (
    set "PATH=%ROOT%tools\node;%PATH%"
    echo        Found portable Node.js in tools\node\
    goto :node_ready
)

:: Download portable Node.js
echo        Node.js not found. Downloading portable Node.js v22.11.0...
echo        (This is a one-time download, ~30 MB)
echo.

if not exist "%ROOT%tools" mkdir "%ROOT%tools"

powershell -NoProfile -Command ^
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " ^
    "$ProgressPreference = 'SilentlyContinue'; " ^
    "try { " ^
    "  Write-Host '        Downloading from nodejs.org...'; " ^
    "  Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.11.0/node-v22.11.0-win-x64.zip' -OutFile '%ROOT%tools\node_download.zip' -UseBasicParsing; " ^
    "  Write-Host '        Extracting...'; " ^
    "  Expand-Archive -Path '%ROOT%tools\node_download.zip' -DestinationPath '%ROOT%tools\node_temp' -Force; " ^
    "  $src = Get-ChildItem -Path '%ROOT%tools\node_temp' -Directory | Select-Object -First 1; " ^
    "  if (-not (Test-Path '%ROOT%tools\node')) { New-Item -ItemType Directory -Path '%ROOT%tools\node' | Out-Null }; " ^
    "  Copy-Item -Path (Join-Path $src.FullName '*') -Destination '%ROOT%tools\node' -Recurse -Force; " ^
    "  Remove-Item '%ROOT%tools\node_temp' -Recurse -Force; " ^
    "  Remove-Item '%ROOT%tools\node_download.zip' -Force; " ^
    "  Write-Host '        Node.js installed successfully.'; " ^
    "} catch { " ^
    "  Write-Host ('        [ERROR] Failed to download Node.js: ' + $_.Exception.Message); " ^
    "  exit 1; " ^
    "}"

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Automatic Node.js download failed.
    echo         Please install Node.js manually from https://nodejs.org
    echo         Then run this launcher again.
    pause
    exit /b 1
)

if not exist "%ROOT%tools\node\node.exe" (
    echo [ERROR] Node.js extraction failed. Please install manually from https://nodejs.org
    pause
    exit /b 1
)

set "PATH=%ROOT%tools\node;%PATH%"
echo.

:node_ready

:: =====================================================
::  STEP 2: CHECK / INSTALL FFMPEG
:: =====================================================
echo [2/4] Checking for FFmpeg...

:: Check system PATH
where ffmpeg >nul 2>&1
if %errorlevel% equ 0 (
    echo        Found FFmpeg on system PATH.
    goto :ffmpeg_ready
)

:: Check portable installation
if exist "%ROOT%tools\ffmpeg\ffmpeg.exe" (
    set "PATH=%ROOT%tools\ffmpeg;%PATH%"
    echo        Found portable FFmpeg in tools\ffmpeg\
    goto :ffmpeg_ready
)

:: Download portable FFmpeg
echo        FFmpeg not found. Downloading portable FFmpeg...
echo        (This is a one-time download, ~90 MB)
echo.

if not exist "%ROOT%tools" mkdir "%ROOT%tools"

powershell -NoProfile -Command ^
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " ^
    "$ProgressPreference = 'SilentlyContinue'; " ^
    "try { " ^
    "  Write-Host '        Downloading from gyan.dev...'; " ^
    "  Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile '%ROOT%tools\ffmpeg_download.zip' -UseBasicParsing; " ^
    "  Write-Host '        Extracting...'; " ^
    "  Expand-Archive -Path '%ROOT%tools\ffmpeg_download.zip' -DestinationPath '%ROOT%tools\ffmpeg_temp' -Force; " ^
    "  $binDir = Get-ChildItem -Path '%ROOT%tools\ffmpeg_temp' -Recurse -Directory | Where-Object { $_.Name -eq 'bin' } | Select-Object -First 1; " ^
    "  if (-not (Test-Path '%ROOT%tools\ffmpeg')) { New-Item -ItemType Directory -Path '%ROOT%tools\ffmpeg' | Out-Null }; " ^
    "  Copy-Item -Path (Join-Path $binDir.FullName '*') -Destination '%ROOT%tools\ffmpeg' -Recurse -Force; " ^
    "  Remove-Item '%ROOT%tools\ffmpeg_temp' -Recurse -Force; " ^
    "  Remove-Item '%ROOT%tools\ffmpeg_download.zip' -Force; " ^
    "  Write-Host '        FFmpeg installed successfully.'; " ^
    "} catch { " ^
    "  Write-Host ('        [ERROR] Failed to download FFmpeg: ' + $_.Exception.Message); " ^
    "  exit 1; " ^
    "}"

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Automatic FFmpeg download failed.
    echo         Please install FFmpeg manually from https://ffmpeg.org/download.html
    echo         Add ffmpeg.exe to your system PATH, then run this launcher again.
    pause
    exit /b 1
)

if not exist "%ROOT%tools\ffmpeg\ffmpeg.exe" (
    echo [ERROR] FFmpeg extraction failed. Please install manually.
    pause
    exit /b 1
)

set "PATH=%ROOT%tools\ffmpeg;%PATH%"
echo.

:ffmpeg_ready

:: =====================================================
::  STEP 3: CHECK / INSTALL NPM PACKAGES
:: =====================================================
echo [3/4] Checking npm dependencies...

if not exist "%ROOT%av2_gui\backend\node_modules\" (
    echo        Installing backend dependencies...
    pushd "%ROOT%av2_gui\backend"
    call npm install
    popd
) else (
    echo        Backend packages OK.
)

if not exist "%ROOT%av2_gui\frontend\node_modules\" (
    echo        Installing frontend dependencies...
    pushd "%ROOT%av2_gui\frontend"
    call npm install
    popd
) else (
    echo        Frontend packages OK.
)

:: =====================================================
::  STEP 4: CHECK ENCODER BINARY
:: =====================================================
echo [4/4] Checking AV2 encoder binary...

if not exist "%ROOT%build\avmenc.exe" (
    echo        avmenc.exe not found in build\ folder.
    echo        Attempting to download precompiled avmenc.exe from GitHub...
    echo        (This is a one-time download from the latest project release, ~10 MB)
    echo.
    
    if not exist "%ROOT%build" mkdir "%ROOT%build"
    
    powershell -NoProfile -Command ^
        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " ^
        "$ProgressPreference = 'SilentlyContinue'; " ^
        "try { " ^
        "  Write-Host '        Downloading from github.com/aditya0155/AV2-Encoder-GUI...'; " ^
        "  Invoke-WebRequest -Uri 'https://github.com/aditya0155/AV2-Encoder-GUI/releases/latest/download/avmenc.exe' -OutFile '%ROOT%build\avmenc.exe' -UseBasicParsing; " ^
        "  Write-Host '        avmenc.exe downloaded and installed successfully.'; " ^
        "} catch { " ^
        "  Write-Host '        [WARNING] Failed to download pre-compiled avmenc.exe.'; " ^
        "  Write-Host ('        Error detail: ' + $_.Exception.Message); " ^
        "  exit 1; " ^
        "}"
        
    if !errorlevel! neq 0 (
        echo.
        echo [WARNING] Automatic avmenc.exe download failed or no release is available yet.
        echo           You can compile it manually from source: https://gitlab.com/AOMediaCodec/avm
        echo           And place the compiled avmenc.exe in the build\ folder.
        echo.
        echo           The GUI will launch now, but encoding will fail until avmenc.exe is present.
        echo.
        pause
    )
) else (
    echo        avmenc.exe found in build\ folder.
)

echo.
echo ==========================================================
echo  All checks passed! Starting servers...
echo ==========================================================
echo.

:: Build the PATH for child processes so they also see portable tools
set "PATH=%ROOT%tools\node;%ROOT%tools\ffmpeg;%PATH%"

:: Start backend server minimized
start "AV2 Transcoder Backend" /min cmd /k "set PATH=%ROOT%tools\node;%ROOT%tools\ffmpeg;%PATH% && cd /d %ROOT%av2_gui\backend && node server.js"

:: Start frontend development server minimized
start "AV2 Transcoder Frontend" /min cmd /k "set PATH=%ROOT%tools\node;%ROOT%tools\ffmpeg;%PATH% && cd /d %ROOT%av2_gui\frontend && npx vite --host"

:: Wait for servers to warm up, then open browser
echo Waiting for servers to initialize...
timeout /t 4 /nobreak > nul

echo Opening browser...
start http://localhost:5173

echo.
echo ==========================================================
echo  AV2 Transcoder GUI is now active!
echo.
echo  Web Interface:  http://localhost:5173
echo  Backend API:    http://localhost:5000
echo.
echo  To shut down, close this window and the two
echo  minimized terminal windows in your taskbar.
echo ==========================================================
echo.
pause
