#!/usr/bin/env pwsh
# Simple wrapper for running the TypeScript yo CLI via bun on Windows.
# Usage: .\yo-cli.ps1 <command> [args...]

$ErrorActionPreference = "Stop"

# Resolve the directory this script lives in and run from there.
$ScriptDir = Split-Path -Parent -Path $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

# Allow overriding `bun` executable via the BUN environment variable.
$BunExe = if ($env:BUN) { $env:BUN } else { "bun" }

# Check if bun is available
if (-not (Get-Command $BunExe -ErrorAction SilentlyContinue)) {
    Write-Error "Error: 'bun' not found in PATH. Install bun or set the BUN environment variable to its path."
    exit 127
}

# Check if any arguments were provided
if ($args.Count -eq 0) {
    Write-Host "Usage: .\yo-cli.ps1 <command> [args...]"
    Write-Host "Forwards to: $BunExe run src/yo-cli.ts <command> [args...]"
    exit 2
}

# Run bun with all arguments
& $BunExe run src/yo-cli.ts @args
exit $LASTEXITCODE
