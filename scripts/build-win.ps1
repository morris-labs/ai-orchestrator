<#
.SYNOPSIS
Builds the Windows installers of AI Orchestrator into dist\win\.

.DESCRIPTION
Run it on Windows x64 (or arm64) with the architecture you ship for: the
server's native SQLite module is built for the machine that runs
`pnpm install`. The script builds every package, packs the engine into
image\dist\ with scripts\build-image.sh under Git for Windows' bash,
stages the runtime (Node.js, a windowless copy of it, the server, the
CLI, the image build context, and the web bundles) with
scripts\stage-runtime.mjs, and runs electron-builder for both apps. The
AI Orchestrator installer carries the runtime in resources\runtime.

Signing: with CSC_LINK (or WIN_CSC_LINK) set, electron-builder signs the
installers and executables. Without it they are unsigned, and SmartScreen
warns when you run them. Signing is a TODO; see docs\platforms.md.

It needs Node.js 22, pnpm (through corepack), and Git for Windows.

.PARAMETER Arch
The architecture, x64 or arm64. Default: this machine's.

.PARAMETER NoInstall
Skip `pnpm install --frozen-lockfile`.

.PARAMETER Print
Print the steps instead of running them.
#>
[CmdletBinding()]
param(
    [ValidateSet('x64', 'arm64')]
    [string]$Arch = $(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }),
    [switch]$NoInstall,
    [switch]$Print
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$OutDir = Join-Path $Root 'dist\win'
$RequiredNodeMajor = '22'

function Find-GitBash {
    $candidates = @(
        $env:AIO_BASH,
        (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe')
    ) | Where-Object { $_ }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw 'Git for Windows is not installed. Install it from https://git-scm.com/download/win, or set AIO_BASH to a bash.exe.'
}

# Runs a program and stops when it fails; native programs don't throw.
function Invoke-Step {
    param([string]$Description, [string]$File, [string[]]$Arguments, [string]$WorkingDirectory = $Root)
    Write-Host "==> $Description"
    if ($Print) {
        Write-Host "    $File $($Arguments -join ' ')  (in $WorkingDirectory)"
        return
    }
    Push-Location $WorkingDirectory
    try {
        & $File @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$File exited with $LASTEXITCODE." }
    } finally {
        Pop-Location
    }
}

if (-not $Print) {
    # $IsWindows doesn't exist in Windows PowerShell 5.1, so ask .NET.
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        throw 'Build Windows installers on Windows. Use -Print to see the steps.'
    }
    # Keep double quotes out of this expression: Windows PowerShell 5.1 and pwsh
    # before 7.3 don't escape them for native programs, so node never sees them.
    $nodeMajor = (& node -p 'parseInt(process.versions.node)')
    if ($LASTEXITCODE -ne 0) { throw "node exited with $LASTEXITCODE while the script read its version." }
    if ($nodeMajor -ne $RequiredNodeMajor) {
        throw "Node.js $nodeMajor is active, but the build needs Node.js $RequiredNodeMajor, the version the bundled runtime and its native module use."
    }
    if (-not $env:CSC_LINK -and -not $env:WIN_CSC_LINK) {
        Write-Host '==> No signing certificate (CSC_LINK or WIN_CSC_LINK); building unsigned installers'
    }
}
$bash = if ($Print) { 'bash.exe' } else { Find-GitBash }

if (-not $NoInstall) {
    Invoke-Step 'Installing dependencies' 'corepack' @('pnpm', 'install', '--frozen-lockfile')
}
Invoke-Step 'Checking that every package and image\versions.env agree' $bash @('scripts/set-version.sh', '--check')
Invoke-Step 'Building every package' 'corepack' @('pnpm', '-r', 'build')
Invoke-Step 'Packing the engine' $bash @('scripts/build-image.sh', '--pack-only')
Invoke-Step 'Staging the runtime' 'node' @('scripts/stage-runtime.mjs', '--os', 'win', '--arch', $Arch)
foreach ($app in @('boxes', 'review')) {
    Invoke-Step "Building the $app app with electron-builder" 'corepack' @(
        'pnpm', 'exec', 'electron-builder', '--win', "--$Arch", '--publish', 'never',
        "-c.directories.output=$(Join-Path $OutDir $app)"
    ) (Join-Path $Root "apps\$app")
}
Write-Host "==> Built the Windows installers in $OutDir"
