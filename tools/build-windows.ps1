[CmdletBinding()]
param(
    [string]$LazarusRoot = 'D:\LazarusDX\lazarus',
    [string]$ComponentsRoot = 'D:\LazComponents',
    [string]$PrimaryConfigPath = 'D:\LazarusDX\config_lazarus',
    [string]$ProjectPath = ''
)

$ErrorActionPreference = 'Stop'

if (-not $ProjectPath) {
    $ProjectPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'dxwebsrv.lpi'
}

function Resolve-Lazbuild {
    param([string]$Root)

    $candidate = Join-Path $Root 'lazbuild.exe'
    if (Test-Path -LiteralPath $candidate) {
        return (Resolve-Path -LiteralPath $candidate).Path
    }

    $command = Get-Command lazbuild -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    throw @"
lazbuild.exe was not found.
Install fpcupdeluxe-i386-win32 into D:\LazarusDX:
  FPC: fixes-3.2
  Lazarus: 4.6
Run this command again after the installer reports success.
"@
}

function Invoke-Lazbuild {
    param(
        [string]$Executable,
        [string[]]$Arguments
    )

    Write-Host ('> lazbuild ' + ($Arguments -join ' '))
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "lazbuild failed with exit code $LASTEXITCODE"
    }
}

$lazbuild = Resolve-Lazbuild -Root $LazarusRoot
$project = (Resolve-Path -LiteralPath $ProjectPath).Path

$packages = @(
    (Join-Path $ComponentsRoot 'PascalScript\Source\pascalscript.lpk'),
    (Join-Path $ComponentsRoot 'PascalScript\Source\PascalScriptFCL.lpk'),
    (Join-Path $ComponentsRoot 'bgra\bgrabitmap\bgrabitmappack4nogui.lpk')
)

foreach ($package in $packages) {
    if (-not (Test-Path -LiteralPath $package)) {
        throw "Package not found: $package. Clone https://github.com/dxbit/dataexpress-depend into $ComponentsRoot"
    }
}

$commonArguments = @()
if ($PrimaryConfigPath) {
    if (-not (Test-Path -LiteralPath $PrimaryConfigPath)) {
        New-Item -ItemType Directory -Path $PrimaryConfigPath | Out-Null
    }
    $commonArguments += "--pcp=$PrimaryConfigPath"
}

Write-Host "lazbuild: $lazbuild"
Write-Host "project:  $project"

foreach ($package in $packages) {
    Invoke-Lazbuild -Executable $lazbuild -Arguments ($commonArguments + '--add-package-link' + $package)
}

Invoke-Lazbuild -Executable $lazbuild -Arguments ($commonArguments + '--build-mode=Win32' + $project)

$binary = Join-Path (Split-Path -Parent $project) '_test\dxwebsrv.exe'
if (-not (Test-Path -LiteralPath $binary)) {
    throw "Build completed without the expected file: $binary"
}

Write-Host "Ready: $binary"
