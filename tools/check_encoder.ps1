$ErrorActionPreference = 'Stop'
$root = $env:ROOT
if (-not $root) {
    $root = Split-Path -Parent $MyInvocation.MyCommand.Path
    $root = Split-Path -Parent $root
}

$binPath = Join-Path $root "build\avmenc.exe"
$verPath = Join-Path $root "build\avmenc.version"
$repo = "aditya0155/AV2-Encoder-GUI"

# Read local version if exists
$localVer = ""
if (Test-Path $verPath) {
    $localVer = (Get-Content $verPath -Raw).Trim()
}

# Fetch latest release tag from GitHub with 1.5s timeout
$onlineVer = $null
try {
    $url = "https://github.com/$repo/releases/latest"
    $req = [System.Net.WebRequest]::Create($url)
    $req.Timeout = 1500
    $req.Method = "HEAD"
    $req.AllowAutoRedirect = $false
    $res = $req.GetResponse()
    $loc = $res.Headers["Location"]
    $res.Close()
    if ($loc -and $loc -match "/releases/tag/([^/]+)") {
        $onlineVer = $Matches[1]
    }
} catch {
    # Silence network/timeout errors, we will fallback to local binary if present
}

if ($onlineVer) {
    if ((Test-Path $binPath) -and ($localVer -eq $onlineVer)) {
        Write-Host "        avmenc.exe is up to date ($localVer)."
        exit 0
    }
    
    # Download update
    if (Test-Path $binPath) {
        Write-Host "        New version $onlineVer is available (local is $localVer)."
        Write-Host "        Downloading update..."
    } else {
        Write-Host "        Downloading precompiled avmenc.exe ($onlineVer) from GitHub..."
    }
    
    $tmpBin = Join-Path $root "build\avmenc.exe.tmp"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    try {
        Invoke-WebRequest -Uri "https://github.com/$repo/releases/download/$onlineVer/avmenc.exe" -OutFile $tmpBin -UseBasicParsing
        if (Test-Path $binPath) { Remove-Item $binPath -Force }
        Rename-Item $tmpBin "avmenc.exe" -Force
        Set-Content -Path $verPath -Value $onlineVer -Force
        Write-Host "        avmenc.exe installed successfully."
        exit 0
    } catch {
        Write-Host "        [WARNING] Failed to download precompiled binary: $_"
        if (Test-Path $tmpBin) { Remove-Item $tmpBin -Force }
        if (Test-Path $binPath) {
            Write-Host "        Using existing local avmenc.exe."
            exit 0
        }
        exit 1
    }
} else {
    # Offline or no release published yet
    if (Test-Path $binPath) {
        Write-Host "        Offline or no updates found. Using local avmenc.exe."
        exit 0
    } else {
        Write-Host "        No pre-compiled binary available and no internet connection."
        exit 1
    }
}
