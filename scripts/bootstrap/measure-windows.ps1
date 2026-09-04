<#
.SYNOPSIS
  Measure wall-clock and PEAK memory of a command on Windows.

.DESCRIPTION
  The Windows analogue of `/usr/bin/time -v` (Linux) and `/usr/bin/time -l`
  (macOS). Until this script, the repo had NO peak-memory measurement of any
  kind on a Windows runner: the sampler's Windows arm in test.yml is empty
  (`Windows) : ;;`) and sits inside a step gated `if: runner.os == 'Linux'`, so
  it never ran either way. Every allocator A/B to date has therefore been
  macOS-only, which is exactly why windows-x64 still ships mimalloc "because the
  switch was measured on macOS only".

  THE GOTCHA THIS SCRIPT EXISTS TO ENCODE: .NET can only report
  PeakWorkingSet64 after a process exits if its native handle was cached WHILE
  IT WAS ALIVE. Touching `$p.Handle` once before waiting is what caches it.
  Without that line the property throws InvalidOperationException ("Process has
  exited") or silently reads 0 — and a peak of 0 compares equal across arms, so
  the bug presents as "the allocators are identical" rather than as an error.

  Reports the MIN across repetitions, not the mean. Min is the right estimator
  for "how fast can this go": a shared CI runner only ever adds noise, so the
  fastest observed run is the closest to the true cost, while the mean tracks
  whatever else the runner was doing. This also follows the repo's established
  A/B method (plans/ + issues/fixed/mimalloc-performance-regression.md).

.PARAMETER Exe
  The executable to run.

.PARAMETER Arguments
  Arguments passed to it, as an array.

.PARAMETER Reps
  How many times to run. Default 3. n=1 is NOT a measurement — the musl A/B in
  this repo produced +2.9% and -4.5% on consecutive single runs, i.e. it could
  not even agree on the SIGN.

.PARAMETER Label
  A name for this arm, printed with the results.

.PARAMETER JsonOut
  Optional path to write machine-readable results for a comparison step.

.EXAMPLE
  ./measure-windows.ps1 -Exe .\yo-mimalloc.exe -Arguments check,./std -Reps 3 -Label mimalloc
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string[]]$Arguments = @(),
  [int]$Reps = 3,
  [string]$Label = 'run',
  [string]$JsonOut = ''
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Exe)) { throw "no such executable: $Exe" }
$exePath = (Resolve-Path $Exe).Path

$wall = @()
$peak = @()
$codes = @()

for ($i = 1; $i -le $Reps; $i++) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exePath
  # ArgumentList keeps the args as an argv array rather than re-parsing a
  # command line, so paths with spaces survive.
  foreach ($a in $Arguments) { $psi.ArgumentList.Add($a) }
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $p = [System.Diagnostics.Process]::Start($psi)

  # LOAD-BEARING — see THE GOTCHA above. Caches the native handle while the
  # process is alive so PeakWorkingSet64 survives its exit. Do not "clean up"
  # this apparently unused expression.
  $null = $p.Handle

  # Drain both pipes BEFORE waiting. A child that fills a redirected pipe
  # blocks forever if nobody reads it, and this workload is chatty enough to
  # do that — the deadlock would look like a hung runner, not a bug here.
  $stdout = $p.StandardOutput.ReadToEndAsync()
  $stderr = $p.StandardError.ReadToEndAsync()

  # Peak capture happens INSIDE the wait loop. On current .NET the post-exit
  # PeakWorkingSet64 read this script originally relied on returns EMPTY even
  # with the handle cached (null on pwsh 7.6 / .NET 9; alive reads are fine),
  # so the value is sampled while the process runs instead. On these
  # minute-scale workloads the peak is a sustained plateau, and a 200 ms
  # sampling interval cannot meaningfully miss it.
  $peakSample = [long]0
  while (-not $p.WaitForExit(200)) {
    $p.Refresh()
    if ($p.PeakWorkingSet64 -gt $peakSample) { $peakSample = $p.PeakWorkingSet64 }
  }
  $sw.Stop()
  $null = $stdout.Result
  $errText = $stderr.Result

  $p.Refresh()
  $peakBytes = $p.PeakWorkingSet64
  # Older runtimes still report the true OS peak after exit; take whichever
  # of that and the in-loop sample is larger (an exited process reads null on
  # new .NET, which falls through to the sample).
  if (-not $peakBytes -or ($peakSample -gt $peakBytes)) { $peakBytes = $peakSample }
  $code = $p.ExitCode

  if ($peakBytes -le 0) {
    throw "peak working set read back as $peakBytes — the handle was not cached, so this measurement is void"
  }
  if ($code -ne 0) {
    Write-Host "  rep ${i}: EXIT $code"
    if ($errText) { Write-Host ($errText -split "`n" | Select-Object -Last 20 | Out-String) }
    throw "$Label rep $i exited $code — a failed run cannot be compared"
  }

  $wall += $sw.Elapsed.TotalSeconds
  $peak += $peakBytes
  $codes += $code
  Write-Host ("  rep {0}: {1,8:N2}s  peak {2,8:N0} MB" -f $i, $sw.Elapsed.TotalSeconds, ($peakBytes / 1MB))
}

$minWall = ($wall | Measure-Object -Minimum).Minimum
$minPeak = ($peak | Measure-Object -Minimum).Minimum
$maxWall = ($wall | Measure-Object -Maximum).Maximum

Write-Host ""
Write-Host ("{0}: min wall {1:N2}s (spread {2:N2}s), min peak {3:N0} MB" -f `
  $Label, $minWall, ($maxWall - $minWall), ($minPeak / 1MB))

if ($JsonOut) {
  $result = [ordered]@{
    label      = $Label
    exe        = $exePath
    args       = $Arguments
    reps       = $Reps
    wallAll    = $wall
    peakAll    = $peak
    wallMinSec = $minWall
    peakMinB   = $minPeak
    # The spread is reported so a comparison can refuse to call a winner when
    # the difference between arms is inside one arm's own run-to-run noise.
    wallSpread = $maxWall - $minWall
  }
  $result | ConvertTo-Json -Depth 4 | Set-Content -Path $JsonOut -Encoding utf8
  Write-Host "wrote $JsonOut"
}
