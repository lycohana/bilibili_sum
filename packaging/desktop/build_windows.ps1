[CmdletBinding()]
param(
    [switch]$SkipPrebuild
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$desktopDir = Join-Path $repoRoot "apps\desktop"
$rceditPatchScript = Join-Path $repoRoot "scripts\patch_electron_builder_rcedit.js"
$winCodeSignVersion = "2.6.0"
$winCodeSignArchiveName = "winCodeSign-$winCodeSignVersion.7z"
$winCodeSignUrl = "https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-$winCodeSignVersion/$winCodeSignArchiveName"
$winCodeSignCacheDir = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
$localRceditDir = Join-Path $winCodeSignCacheDir "briefvid-rcedit"

function Ensure-PythonPip {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PythonExe
    )

    & $PythonExe -m pip --version *> $null
    if ($LASTEXITCODE -eq 0) {
        return
    }

    Write-Host "pip is missing in the selected Python environment; bootstrapping with ensurepip..."
    & $PythonExe -m ensurepip --upgrade
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to bootstrap pip for $PythonExe"
    }

    & $PythonExe -m pip --version *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "pip is still unavailable after ensurepip for $PythonExe"
    }
}

function Ensure-LocalRcedit {
    $rceditX64 = Join-Path $localRceditDir "rcedit-x64.exe"
    $rceditIa32 = Join-Path $localRceditDir "rcedit-ia32.exe"
    if ((Test-Path $rceditX64) -and (Test-Path $rceditIa32)) {
        return $rceditX64
    }

    New-Item -ItemType Directory -Force -Path $localRceditDir | Out-Null

    $archivePath = Join-Path $winCodeSignCacheDir $winCodeSignArchiveName
    if (-not (Test-Path $archivePath)) {
        Write-Host "Downloading winCodeSign archive for local rcedit extraction..."
        & curl.exe -L --fail --retry 3 --retry-delay 2 --output $archivePath $winCodeSignUrl
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to download $winCodeSignUrl"
        }
    }

    $sevenZip = Join-Path $desktopDir "node_modules\7zip-bin\win\x64\7za.exe"
    if (-not (Test-Path $sevenZip)) {
        throw "7za.exe was not found: $sevenZip"
    }

    Write-Host "Extracting local rcedit binaries from winCodeSign archive..."
    & $sevenZip e -y $archivePath "-o$localRceditDir" "rcedit-x64.exe" "rcedit-ia32.exe" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to extract local rcedit binaries from $archivePath"
    }

    if (-not (Test-Path $rceditX64)) {
        throw "Extracted rcedit-x64.exe was not found: $rceditX64"
    }

    return $rceditX64
}

$python312 = (uv python find 3.12).Trim()
if (-not $python312) {
    throw "No Python 3.12 interpreter was found via uv."
}

Write-Host "Using Python 3.12:" $python312
Ensure-PythonPip -PythonExe $python312

# Clean entire electron-builder cache to avoid symlink issues on Windows
$cacheDir = "$env:LOCALAPPDATA\electron-builder\Cache"
if (Test-Path $cacheDir) {
    Write-Host "Cleaning electron-builder cache directory: $cacheDir"
    Remove-Item -Recurse -Force $cacheDir
}

# Create a dummy winCodeSign directory with a fake version file to prevent electron-builder from downloading
# This avoids the symlink creation issue on Windows
Write-Host "Creating dummy winCodeSign cache directory: $winCodeSignCacheDir"
New-Item -ItemType Directory -Force -Path $winCodeSignCacheDir | Out-Null
# Create a version file that electron-builder checks
"2.6.0" | Out-File -FilePath "$winCodeSignCacheDir\.version" -Encoding utf8
# Create darwin directory structure to satisfy electron-builder
$darwinLibDir = "$winCodeSignCacheDir\darwin\10.12\lib"
New-Item -ItemType Directory -Force -Path $darwinLibDir | Out-Null
# Create dummy dylib files (empty) to prevent symlink creation attempts
New-Item -ItemType File -Force -Path "$darwinLibDir\libcrypto.dylib" | Out-Null
New-Item -ItemType File -Force -Path "$darwinLibDir\libssl.dylib" | Out-Null

Push-Location $desktopDir
try {
    # Generate icon before building
    $iconScript = Join-Path $repoRoot "apps\desktop\build\generate_icon.py"
    if (-not (Test-Path $iconScript)) {
        throw "Icon generator script was not found: $iconScript"
    }
    Write-Host "Ensuring Pillow is available for icon generation..."
    $probeErrorPath = [System.IO.Path]::GetTempFileName()
    try {
        $probeProcess = Start-Process `
            -FilePath $python312 `
            -ArgumentList '-c "from PIL import Image"' `
            -NoNewWindow `
            -Wait `
            -PassThru `
            -RedirectStandardError $probeErrorPath
        $pillowAvailable = ($probeProcess.ExitCode -eq 0)
    }
    finally {
        Remove-Item $probeErrorPath -Force -ErrorAction SilentlyContinue
    }
    if (-not $pillowAvailable) {
        Write-Host "Pillow is missing; installing Pillow into the selected Python 3.12 environment..."
        & $python312 -m pip install --disable-pip-version-check Pillow
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install Pillow for icon generation."
        }
    }
    Write-Host "Generating application icon..."
    & $python312 $iconScript
    if ($LASTEXITCODE -ne 0) {
        throw "Application icon generation failed."
    }

    if (-not $SkipPrebuild) {
        npm run build:renderer
        & $python312 (Join-Path $repoRoot "packaging\pyinstaller\build_onedir.py")

        $backendExe = Join-Path $repoRoot "dist\BriefVid\BriefVid.exe"
        if (-not (Test-Path $backendExe)) {
            throw "Packaged backend was not produced: $backendExe"
        }
    }
    else {
        Write-Host "SkipPrebuild enabled: reusing existing renderer and backend artifacts."
    }

    npm run build:electron
    
    if (-not (Test-Path $rceditPatchScript)) {
        throw "electron-builder patch script was not found: $rceditPatchScript"
    }

    Write-Host "Patching electron-builder to use local rcedit when available..."
    node $rceditPatchScript
    if ($LASTEXITCODE -ne 0) {
        throw "electron-builder rcedit patch failed."
    }

    $localRcedit = Ensure-LocalRcedit
    Write-Host "Using local rcedit:" $localRcedit
    $env:BRIEFVID_RCEDIT_PATH = $localRcedit

    # Disable code signing on Windows to avoid symlink issues with darwin libraries
    Write-Host "Building with code signing disabled..."
    
    $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
    $env:CSC_PLATFORM = "windows"
    
    npx electron-builder --config electron-builder.config.js --win nsis --x64 --publish=never
    if ($LASTEXITCODE -ne 0) {
        throw "electron-builder packaging failed."
    }
}
finally {
    Pop-Location
}
