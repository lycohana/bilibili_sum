$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$desktopDir = Join-Path $repoRoot "apps\desktop"

$python312 = (uv python find 3.12).Trim()
if (-not $python312) {
    throw "No Python 3.12 interpreter was found via uv."
}

Write-Host "Using Python 3.12:" $python312

# Preserve electron-builder caches such as nsis/nsis-resources so packaging
# does not depend on a fresh network download every run.
$cacheDir = "$env:LOCALAPPDATA\electron-builder\Cache"
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

# Create a dummy winCodeSign directory with a fake version file to prevent electron-builder from downloading
# This avoids the symlink creation issue on Windows
$winCodeSignCacheDir = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
if (Test-Path $winCodeSignCacheDir) {
    Remove-Item -Recurse -Force $winCodeSignCacheDir
}
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
    Write-Host "Generating application icon..."
    & $python312 $iconScript

    npm run build:renderer
    & $python312 (Join-Path $repoRoot "packaging\pyinstaller\build_onedir.py")

    $backendExe = Join-Path $repoRoot "dist\BriefVid\BriefVid.exe"
    if (-not (Test-Path $backendExe)) {
        throw "Packaged backend was not produced: $backendExe"
    }

    npm run build:electron
    
    # Disable code signing on Windows to avoid symlink issues with darwin libraries
    Write-Host "Building with code signing disabled..."
    
    $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
    $env:CSC_PLATFORM = "windows"
    
    npx electron-builder --config electron-builder.config.js --win nsis --x64 --publish=never
}
finally {
    Pop-Location
}
