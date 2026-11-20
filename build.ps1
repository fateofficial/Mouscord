$ErrorActionPreference = "Stop"

# Pack modular src/js/*.js into C++ raw-string headers automatically
& "$PSScriptRoot\scripts\pack_payloads.ps1"

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) {
    throw "Visual Studio C++ Build Tools not found."
}

$vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) {
    throw "vcvars64.bat not found at $vcvars"
}

New-Item -ItemType Directory -Force -Path "build" | Out-Null
Get-Process -Name "Mouscord" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 150

$cmd = "`"$vcvars`" && rc /nologo /fo build\app.res src\app.rc && cl /nologo /utf-8 /std:c++20 /EHsc /W4 /O2 /MT /DNOMINMAX /Fe:build\Mouscord.exe src\main.cpp build\app.res /link /SUBSYSTEM:WINDOWS"
cmd /c $cmd
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host "Built build\Mouscord.exe successfully."
