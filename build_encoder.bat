@echo off
setlocal enabledelayedexpansion
set "ROOT=%~dp0"

echo ==========================================================
echo        AVM (AV2) AUTOMATED LOCAL BUILDER
echo        Zero-Dependency Compiler Toolchain Setup
echo ==========================================================
echo.

:: Check for Git
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Git is required to clone the AVM repository.
    echo         Please install Git or add it to your PATH.
    pause
    exit /b 1
)

:: Locate Git's Perl
set "PERL_PATH=C:\Program Files\Git\usr\bin"
if not exist "%PERL_PATH%\perl.exe" (
    :: Fallback search
    for /f "tokens=*" %%i in ('where.exe perl 2^>nul') do set "PERL_PATH=%%~dpi"
)
if not exist "!PERL_PATH!\perl.exe" (
    echo [ERROR] Perl not found. AVM requires Perl for code generation.
    echo         Git for Windows usually bundles Perl in C:\Program Files\Git\usr\bin.
    echo         Please install Perl or ensure Git is fully installed.
    pause
    exit /b 1
)
set "PATH=!PERL_PATH!;%PATH%"

:: 1. Download portable CMake
if not exist "%ROOT%tools\cmake\bin\cmake.exe" (
    echo [1/3] Downloading portable CMake...
    echo       (This is a one-time download, ~30 MB)
    if not exist "%ROOT%tools" mkdir "%ROOT%tools"
    powershell -NoProfile -Command ^
        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " ^
        "$ProgressPreference = 'SilentlyContinue'; " ^
        "try { " ^
        "  Write-Host '        Downloading from Kitware...'; " ^
        "  Invoke-WebRequest -Uri 'https://github.com/Kitware/CMake/releases/download/v3.29.3/cmake-3.29.3-windows-x86_64.zip' -OutFile '%ROOT%tools\cmake.zip' -UseBasicParsing; " ^
        "  Write-Host '        Extracting...'; " ^
        "  Expand-Archive -Path '%ROOT%tools\cmake.zip' -DestinationPath '%ROOT%tools\cmake_temp' -Force; " ^
        "  $src = Get-ChildItem -Path '%ROOT%tools\cmake_temp' -Directory | Select-Object -First 1; " ^
        "  if (-not (Test-Path '%ROOT%tools\cmake')) { New-Item -ItemType Directory -Path '%ROOT%tools\cmake' | Out-Null }; " ^
        "  Copy-Item -Path (Join-Path $src.FullName '*') -Destination '%ROOT%tools\cmake' -Recurse -Force; " ^
        "  Remove-Item '%ROOT%tools\cmake_temp' -Recurse -Force; " ^
        "  Remove-Item '%ROOT%tools\cmake.zip' -Force; " ^
        "  Write-Host '        CMake installed successfully.'; " ^
        "} catch { " ^
        "  Write-Host ('        [ERROR] Failed to download CMake: ' + $_.Exception.Message); " ^
        "  exit 1; " ^
        "}"
    if !errorlevel! neq 0 ( pause & exit /b 1 )
) else (
    echo [1/3] Portable CMake is already installed.
)
set "PATH=%ROOT%tools\cmake\bin;%PATH%"

:: 2. Download portable GCC (w64devkit)
if not exist "%ROOT%tools\mingw\bin\gcc.exe" (
    echo [2/3] Downloading portable GCC compiler (w64devkit)...
    echo       (This is a one-time download, ~85 MB)
    if not exist "%ROOT%tools" mkdir "%ROOT%tools"
    powershell -NoProfile -Command ^
        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " ^
        "$ProgressPreference = 'SilentlyContinue'; " ^
        "try { " ^
        "  Write-Host '        Downloading from GitHub...'; " ^
        "  Invoke-WebRequest -Uri 'https://github.com/skeeto/w64devkit/releases/download/v2.0.0/w64devkit-2.0.0.zip' -OutFile '%ROOT%tools\w64devkit.zip' -UseBasicParsing; " ^
        "  Write-Host '        Extracting...'; " ^
        "  Expand-Archive -Path '%ROOT%tools\w64devkit.zip' -DestinationPath '%ROOT%tools\mingw_temp' -Force; " ^
        "  $src = Get-ChildItem -Path '%ROOT%tools\mingw_temp' -Directory | Select-Object -First 1; " ^
        "  if (-not (Test-Path '%ROOT%tools\mingw')) { New-Item -ItemType Directory -Path '%ROOT%tools\mingw' | Out-Null }; " ^
        "  Copy-Item -Path (Join-Path $src.FullName '*') -Destination '%ROOT%tools\mingw' -Recurse -Force; " ^
        "  Remove-Item '%ROOT%tools\mingw_temp' -Recurse -Force; " ^
        "  Remove-Item '%ROOT%tools\w64devkit.zip' -Force; " ^
        "  Write-Host '        MinGW-w64 compiler installed successfully.'; " ^
        "} catch { " ^
        "  Write-Host ('        [ERROR] Failed to download w64devkit: ' + $_.Exception.Message); " ^
        "  exit 1; " ^
        "}"
    if !errorlevel! neq 0 ( pause & exit /b 1 )
) else (
    echo [2/3] Portable GCC compiler is already installed.
)
set "PATH=%ROOT%tools\mingw\bin;%PATH%"

:: 3. Download portable NASM
if not exist "%ROOT%tools\nasm\nasm.exe" (
    echo [3/3] Downloading portable NASM assembler...
    echo       (This is a one-time download, ~2 MB)
    if not exist "%ROOT%tools" mkdir "%ROOT%tools"
    powershell -NoProfile -Command ^
        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " ^
        "$ProgressPreference = 'SilentlyContinue'; " ^
        "try { " ^
        "  Write-Host '        Downloading from nasm.us...'; " ^
        "  Invoke-WebRequest -Uri 'https://www.nasm.us/pub/nasm/releasebuilds/2.16.03/win64/nasm-2.16.03-win64.zip' -OutFile '%ROOT%tools\nasm.zip' -UseBasicParsing; " ^
        "  Write-Host '        Extracting...'; " ^
        "  Expand-Archive -Path '%ROOT%tools\nasm.zip' -DestinationPath '%ROOT%tools\nasm_temp' -Force; " ^
        "  $src = Get-ChildItem -Path '%ROOT%tools\nasm_temp' -Directory | Select-Object -First 1; " ^
        "  if (-not (Test-Path '%ROOT%tools\nasm')) { New-Item -ItemType Directory -Path '%ROOT%tools\nasm' | Out-Null }; " ^
        "  Copy-Item -Path (Join-Path $src.FullName 'nasm.exe'), (Join-Path $src.FullName 'ndisasm.exe') -Destination '%ROOT%tools\nasm' -Force; " ^
        "  Remove-Item '%ROOT%tools\nasm_temp' -Recurse -Force; " ^
        "  Remove-Item '%ROOT%tools\nasm.zip' -Force; " ^
        "  Write-Host '        NASM installed successfully.'; " ^
        "} catch { " ^
        "  Write-Host ('        [ERROR] Failed to download NASM: ' + $_.Exception.Message); " ^
        "  exit 1; " ^
        "}"
    if !errorlevel! neq 0 ( pause & exit /b 1 )
) else (
    echo [3/3] Portable NASM is already installed.
)
set "PATH=%ROOT%tools\nasm;%PATH%"

:: Clone AVM repository if missing
if not exist "%ROOT%avm\CMakeLists.txt" (
    echo Cloning AVM repository...
    git clone --depth 1 https://github.com/AOMediaCodec/avm.git "%ROOT%avm"
    if !errorlevel! neq 0 (
        echo [ERROR] Failed to clone AVM repository.
        pause
        exit /b 1
    )
)

:: Configure and Build AVM
echo.
echo Configuring AVM build system...
if not exist "%ROOT%avm\build" mkdir "%ROOT%avm\build"
pushd "%ROOT%avm\build"

:: Run CMake with MinGW Makefiles generator
cmake -G "MinGW Makefiles" -DCMAKE_BUILD_TYPE=Release -DENABLE_DOCS=OFF -DENABLE_TESTS=OFF ..
if !errorlevel! neq 0 (
    echo [ERROR] CMake configuration failed.
    popd
    pause
    exit /b 1
)

echo.
echo Compiling avmenc (this will take several minutes)...
cmake --build . --target avmenc -j%NUMBER_OF_PROCESSORS%
if !errorlevel! neq 0 (
    echo [ERROR] Compilation failed.
    popd
    pause
    exit /b 1
)

popd

:: Copy binary to build folder
if not exist "%ROOT%build" mkdir "%ROOT%build"
copy /y "%ROOT%avm\build\avmenc.exe" "%ROOT%build\avmenc.exe"

echo.
echo ==========================================================
echo  AV2 reference encoder compiled successfully!
echo  Binary is located at: build\avmenc.exe
echo ==========================================================
echo.
