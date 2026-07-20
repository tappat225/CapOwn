<#
.SYNOPSIS
    CapOwn Worker Next local source installation (Windows).
.DESCRIPTION
    Installs the Worker from the local repository into ~/.capown/worker/.
    Does not create Windows services. Does not auto-register with a Master.
#>

# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = "Stop"

# --- Configuration and arguments ---
$Prefix = Join-Path $HOME ".capown"
$WorkerSrc = (Resolve-Path (Join-Path $PSScriptRoot "..\worker")).Path

for ($i = 0; $i -lt $args.Count; $i++) {
    switch ($args[$i]) {
        "--prefix" {
            if ($i + 1 -ge $args.Count) {
                throw "--prefix requires a directory"
            }
            $Prefix = $args[++$i]
        }
        "--help" { Get-Content $PSCommandPath | Select-Object -First 9; exit 0 }
        "-h" { Get-Content $PSCommandPath | Select-Object -First 9; exit 0 }
        default { throw "Unknown option: $($args[$i])" }
    }
}

$AppDir = Join-Path $Prefix "worker\app"
$BinDir = Join-Path $Prefix "bin"
$ConfigDir = Join-Path $Prefix "worker"
$ConfigFile = Join-Path $ConfigDir "config.toml"
$IdentityFile = Join-Path $ConfigDir "identity.toml"
$Launcher = Join-Path $BinDir "capown-worker.cmd"

Write-Output "CapOwn Worker Next Installer"
Write-Output "============================"
Write-Output ""
Write-Output "Prefix:  $Prefix"
Write-Output "Source:  $WorkerSrc"
Write-Output ""

# --- Check prerequisites ---
$nodeExe = Get-Command "node" -ErrorAction SilentlyContinue
if (-not $nodeExe) {
    Write-Error "Node.js is not installed. Install Node.js >=20.18.0 from https://nodejs.org/"
    exit 1
}

$nodeVersion = & node --version
$nodeVersion = $nodeVersion -replace "^v", ""
Write-Output "Node.js version: $nodeVersion"

$versionParts = $nodeVersion -split "\."
$major = [int]$versionParts[0]
$minor = [int]$versionParts[1]

if ($major -lt 20 -or ($major -eq 20 -and $minor -lt 18)) {
    Write-Error "Node.js >=20.18.0 is required, found $nodeVersion"
    exit 1
}

$npmExe = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
if (-not $npmExe) {
    Write-Error "npm is not installed."
    exit 1
}

$npmVersion = & $npmExe.Source --version
Write-Output "npm version:     $npmVersion"

# --- Create directories ---
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null

# --- Copy and build in a fresh staging directory ---
Write-Output ""
Write-Output "Copying Worker source..."
$StageDir = Join-Path $ConfigDir (".app-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $StageDir | Out-Null

try {
    Get-ChildItem -Path $WorkerSrc -Exclude "node_modules", "dist", ".env" | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination $StageDir -Recurse -Force
    }

    Write-Output ""
    Write-Output "Installing npm dependencies..."
    Push-Location $StageDir
    try {
        & $npmExe.Source ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

        Write-Output ""
        Write-Output "Building TypeScript..."
        & $npmExe.Source run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    } finally {
        Pop-Location
    }

    if (Test-Path $AppDir) {
        Remove-Item -LiteralPath $AppDir -Recurse -Force
    }
    Move-Item -LiteralPath $StageDir -Destination $AppDir
} finally {
    if (Test-Path $StageDir) {
        Remove-Item -LiteralPath $StageDir -Recurse -Force
    }
}

# --- Create launcher ---
Write-Output ""
Write-Output "Creating launcher: $Launcher"
@"
@echo off
REM CapOwn Worker Next launcher
set "CAPOWN_WORKER_DIR=%~dp0..\worker"
node "%CAPOWN_WORKER_DIR%\app\dist\src\cli.js" --config "%CAPOWN_WORKER_DIR%\config.toml" --identity "%CAPOWN_WORKER_DIR%\identity.toml" %*
"@ | Out-File -FilePath $Launcher -Encoding ascii

# --- Copy default config if not present ---
if (-not (Test-Path $ConfigFile)) {
    Write-Output ""
    Write-Output "Creating default config: $ConfigFile"
    $exampleConfig = Join-Path $AppDir "config.toml.example"
    if (Test-Path $exampleConfig) {
        Copy-Item -Path $exampleConfig -Destination $ConfigFile
        Write-Output "  (copied from config.toml.example)"
    } else {
        @"
# CapOwn Worker configuration
role = "worker"

[worker]
reconnect_interval = 5
"@ | Out-File -FilePath $ConfigFile -Encoding utf8
        Write-Output "  (generated default)"
    }
} else {
    Write-Output ""
    Write-Output "Config already exists: $ConfigFile"
    Write-Output "  (not overwritten)"
}

# --- Done ---
Write-Output ""
Write-Output "Installation complete!"
Write-Output ""
Write-Output "Installed files:"
Write-Output "  Worker:  $AppDir"
Write-Output "  Binary:  $Launcher"
Write-Output "  Config:  $ConfigFile"
Write-Output "  Identity: $IdentityFile"
Write-Output ""
Write-Output "Make sure $BinDir is in your PATH:"
Write-Output "  `$env:Path = `"$BinDir;`$env:Path`""
Write-Output ""
$HasRegistration = $false
if (Test-Path $IdentityFile) {
    $HasRegistration = [bool](Select-String -Path $IdentityFile -Pattern '^\s*worker_id\s*=\s*["''][^"'']+["'']\s*(?:#.*)?$' -Quiet)
}

if ($HasRegistration) {
    Write-Output "Existing Worker registration preserved."
    Write-Output "Start the Worker in the background:"
    Write-Output "  capown-worker start"
    Write-Output "  capown-worker status"
    Write-Output "  capown-worker logs"
    Write-Output "  capown-worker stop"
    Write-Output ""
    Write-Output "To replace the registration, run:"
    Write-Output "  capown-worker register https://<master>/v1/worker-registrations/<token>"
} else {
    Write-Output "Next steps:"
    Write-Output "  1. Register with a Master:"
    Write-Output "     capown-worker register https://<master>/v1/worker-registrations/<token>"
    Write-Output ""
    Write-Output "  2. Start the Worker:"
    Write-Output "     capown-worker start"
    Write-Output "     capown-worker status"
    Write-Output "     capown-worker logs"
    Write-Output "     capown-worker stop"
}
