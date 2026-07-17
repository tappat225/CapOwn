<#
.SYNOPSIS
    CapOwn Master local source installation (Windows).
.DESCRIPTION
    Installs the Master binary, configuration, and database directory below
    $HOME\.capown\master. It does not create a Windows service.
#>

# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = "Stop"

$ScriptDir = $PSScriptRoot
$MasterSrc = (Resolve-Path (Join-Path $ScriptDir "..\master")).Path
$CapownRoot = Join-Path $HOME ".capown"

for ($i = 0; $i -lt $args.Count; $i++) {
    switch ($args[$i]) {
        "--prefix" {
            if ($i + 1 -ge $args.Count) {
                throw "--prefix requires a directory"
            }
            $CapownRoot = $args[++$i]
        }
        "--help" { Get-Content $PSCommandPath | Select-Object -First 12; exit 0 }
        "-h" { Get-Content $PSCommandPath | Select-Object -First 12; exit 0 }
        default { throw "Unknown option: $($args[$i])" }
    }
}

$MasterDir = Join-Path $CapownRoot "master"
$BinDir = Join-Path $CapownRoot "bin"
$ConfigFile = Join-Path $MasterDir "config.toml"
$BinaryFile = Join-Path $MasterDir "capown-master.exe"
$Launcher = Join-Path $BinDir "capown-master.cmd"

Write-Output "CapOwn Master Installer"
Write-Output "======================="
Write-Output ""
Write-Output "Source: $MasterSrc"
Write-Output "Data:   $MasterDir"
Write-Output ""

$goCommand = Get-Command "go" -ErrorAction SilentlyContinue
if (-not $goCommand) {
    throw "Go 1.23 or newer is required."
}

$goVersionText = & go version
if ($goVersionText -notmatch "go(?<major>\d+)\.(?<minor>\d+)") {
    throw "Unable to determine Go version: $goVersionText"
}
$goMajor = [int]$Matches.major
$goMinor = [int]$Matches.minor
if ($goMajor -lt 1 -or ($goMajor -eq 1 -and $goMinor -lt 23)) {
    throw "Go 1.23 or newer is required, found: $goVersionText"
}

Write-Output "Go:     $goVersionText"
Write-Output ""

New-Item -ItemType Directory -Path (Join-Path $MasterDir "data") -Force | Out-Null
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

Write-Output "Building Master..."
Push-Location $MasterSrc
try {
    & go build -o $BinaryFile ./cmd/capown-master
    if ($LASTEXITCODE -ne 0) { throw "go build failed" }
} finally {
    Pop-Location
}

if (-not (Test-Path $ConfigFile)) {
    Copy-Item (Join-Path $MasterSrc "config.toml.example") $ConfigFile
    Write-Output "Created config: $ConfigFile"
} else {
    Write-Output "Config exists:  $ConfigFile (not overwritten)"
}

@"
@echo off
REM CapOwn Master launcher
set "CAPOWN_MASTER_DIR=%~dp0..\master"
set "CAPOWN_MASTER_CONFIG=%CAPOWN_MASTER_DIR%\config.toml"
cd /d "%CAPOWN_MASTER_DIR%"
"%CAPOWN_MASTER_DIR%\capown-master.exe" %*
"@ | Set-Content -Path $Launcher -Encoding ascii

Write-Output ""
Write-Output "Installation complete."
Write-Output "  Launcher: $Launcher"
Write-Output "  Config:   $ConfigFile"
Write-Output "  Database: $(Join-Path $MasterDir "data\master.db")"
Write-Output ""
Write-Output "Run the Master with:"
Write-Output "  $Launcher"
