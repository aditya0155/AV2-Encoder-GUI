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

:: 1. Download and install portable compiler toolchain (WinLibs GCC + MinGW-w64 + NASM + CMake)
if not exist "%ROOT%tools\mingw64\bin\gcc.exe" (
    echo Downloading portable compiler toolchain [GCC, MinGW-w64, NASM, CMake]...
    echo This is a one-time download, ~270 MB
    if not exist "%ROOT%tools" mkdir "%ROOT%tools"
    powershell -NoProfile -Command ^
        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " ^
        "$ProgressPreference = 'SilentlyContinue'; " ^
        "try { " ^
        "  Write-Host '        Downloading from GitHub...'; " ^
        "  Invoke-WebRequest -Uri 'https://github.com/brechtsanders/winlibs_mingw/releases/download/14.2.0posix-19.1.1-12.0.0-ucrt-r2/winlibs-x86_64-posix-seh-gcc-14.2.0-mingw-w64ucrt-12.0.0-r2.zip' -OutFile '%ROOT%tools\winlibs.zip' -UseBasicParsing; " ^
        "  Write-Host '        Extracting...'; " ^
        "  Expand-Archive -Path '%ROOT%tools\winlibs.zip' -DestinationPath '%ROOT%tools' -Force; " ^
        "  Remove-Item '%ROOT%tools\winlibs.zip' -Force; " ^
        "  Write-Host '        Compiler toolchain installed successfully.'; " ^
        "} catch { " ^
        "  Write-Host ('        [ERROR] Failed to download/extract toolchain: ' + $_.Exception.Message); " ^
        "  exit 1; " ^
        "}"
    if !errorlevel! neq 0 ( pause & exit /b 1 )
) else (
    echo Portable compiler toolchain is already installed.
)
set "PATH=%ROOT%tools\mingw64\bin;%PATH%"


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
if exist "%ROOT%avm\build" rd /s /q "%ROOT%avm\build"
mkdir "%ROOT%avm\build"
pushd "%ROOT%avm\build"

:: Run CMake with MinGW Makefiles generator, disabling TFLite-dependent features to prevent compiler conflicts
cmake -G "MinGW Makefiles" -DCMAKE_BUILD_TYPE=Release -DENABLE_DOCS=OFF -DENABLE_TESTS=OFF -DCONFIG_ML_PART_SPLIT=0 -DCONFIG_DIP_EXT_PRUNING=0 -DCONFIG_TENSORFLOW_LITE=0 ..
if !errorlevel! neq 0 (
    echo [ERROR] CMake configuration failed.
    popd
    pause
    exit /b 1
)

echo.
echo Compiling avmenc - this will take several minutes...
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
echo local_build > "%ROOT%build\avmenc.version"

echo.
echo ==========================================================
echo  AV2 reference encoder compiled successfully.
echo  Binary is located at: build\avmenc.exe
echo ==========================================================
echo.
