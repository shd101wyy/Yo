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

  THE GOTCHA THIS SCRIPT EXISTS TO ENCODE: .NET's PeakWorkingSet64 is NOT
  readable after the process exits. Caching `$p.Handle` while it is alive is
  necessary but NOT sufficient — `$p.Refresh()` then discards the cached values
  and they cannot be re-read from a dead process, which is how the first
  measured run failed (it read back EMPTY, not 0).

  So the peak is taken two ways, and neither relies on that property:

    1. GetProcessMemoryInfo (psapi) against the cached handle. This is the
       kernel's own PeakWorkingSetSize and remains valid for an exited process
       as long as a handle is open. Exact.
    2. Polling WorkingSet64 while the process runs, tracking the max. Always
       available, but can miss a spike between samples.

  (1) is preferred and (2) is the fallback, with the method reported alongside
  the number so a sampled figure is never mistaken for an exact one. A peak that
  fails to read is a HARD ERROR: 0 compares equal across arms, so a silent
  failure would present as "the allocators are identical" rather than as a bug.

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

# psapi's GetProcessMemoryInfo, which unlike Process.PeakWorkingSet64 keeps
# working once the process has exited (the handle keeps the accounting alive).
$sig = @'
[StructLayout(LayoutKind.Sequential)]
public struct PROCESS_MEMORY_COUNTERS {
  public uint cb;
  public uint PageFaultCount;
  public UIntPtr PeakWorkingSetSize;
  public UIntPtr WorkingSetSize;
  public UIntPtr QuotaPeakPagedPoolUsage;
  public UIntPtr QuotaPagedPoolUsage;
  public UIntPtr QuotaPeakNonPagedPoolUsage;
  public UIntPtr QuotaNonPagedPoolUsage;
  public UIntPtr PagefileUsage;
  public UIntPtr PeakPagefileUsage;
}
[DllImport("psapi.dll", SetLastError=true)]
public static extern bool GetProcessMemoryInfo(IntPtr hProcess, out PROCESS_MEMORY_COUNTERS counters, uint size);
'@
$havePsapi = $false
try {
  # NO -UsingNamespace here: Add-Type already emits
  # `using System.Runtime.InteropServices;` for -MemberDefinition, and adding it
  # again is a CS0105 duplicate-using ERROR. That silently sent every run down
  # the sampled fallback until a local run surfaced it.
  Add-Type -Namespace Win32 -Name Psapi -MemberDefinition $sig -ErrorAction Stop
  $havePsapi = $true
} catch {
  Write-Host "note: psapi shim unavailable ($($_.Exception.Message)); falling back to polling"
}

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

  # LOAD-BEARING. Caches the native handle while the process is alive; psapi
  # needs it to report the peak after exit. Do not "clean up" this apparently
  # unused expression.
  $handle = $p.Handle

  # Drain both pipes BEFORE waiting. A child that fills a redirected pipe
  # blocks forever if nobody reads it, and this workload is chatty enough to
  # do that — the deadlock would look like a hung runner, not a bug here.
  $stdout = $p.StandardOutput.ReadToEndAsync()
  $stderr = $p.StandardError.ReadToEndAsync()

  # Poll while it runs, as the fallback peak. Cheap next to a ~30 s workload.
  # Sample ONCE before the loop condition: a short-lived process can exit
  # between Start() and the first HasExited check, leaving zero samples and a
  # peak of 0 — which this script treats as fatal. Measured on a millisecond
  # workload locally.
  $sampledPeak = 0L
  try { $sampledPeak = $p.WorkingSet64 } catch { }
  while (-not $p.HasExited) {
    # Refresh() INSIDE the loop is required and is safe here. .NET caches
    # process property values, so without it WorkingSet64 returns the snapshot
    # taken at start forever and the "peak" is just the startup footprint —
    # measured locally as 1-3 MB for a 10 s compile, which is nonsense. The
    # destructive Refresh() is the one AFTER exit; while the process lives,
    # refreshing is exactly how the value advances.
    try { $p.Refresh(); $ws = $p.WorkingSet64; if ($ws -gt $sampledPeak) { $sampledPeak = $ws } } catch { }
    Start-Sleep -Milliseconds 25
  }
  $p.WaitForExit()
  $sw.Stop()
  $null = $stdout.Result
  $errText = $stderr.Result
  $code = $p.ExitCode

  # NO $p.Refresh() here — it discards .NET's cached values, and a dead process
  # cannot supply them again. That is exactly what voided the first run.
  $peakBytes = 0L
  $method = 'sampled'
  # The try/catch is required, not defensive dressing: Add-Type COMPILES the
  # P/Invoke declaration on any platform, so $havePsapi only proves the shim
  # built. On a host with no psapi.dll the CALL throws rather than returning
  # false, and an uncaught throw here would abort a measurement that the
  # polling fallback could have completed.
  if ($havePsapi) {
    try {
      $pmc = New-Object Win32.Psapi+PROCESS_MEMORY_COUNTERS
      $pmc.cb = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($pmc)
      if ([Win32.Psapi]::GetProcessMemoryInfo($handle, [ref]$pmc, $pmc.cb)) {
        $peakBytes = [int64]$pmc.PeakWorkingSetSize
        $method = 'psapi'
      }
    } catch {
      if ($i -eq 1) { Write-Host "note: psapi call failed ($($_.Exception.Message)); using polled peak" }
      $havePsapi = $false
    }
  }
  if ($peakBytes -le 0) { $peakBytes = $sampledPeak }

  # EXIT CODE FIRST. A child that dies immediately also yields no memory
  # samples, so checking the peak first reports "peak unreadable" and buries
  # the actual cause — which is exactly how this presented in local testing.
  # The diagnostic that names the real fault has to come first.
  if ($code -ne 0) {
    Write-Host "  rep ${i}: EXIT $code"
    if ($errText) { Write-Host ($errText -split "`n" | Select-Object -Last 20 | Out-String) }
    throw "$Label rep $i exited $code — a failed run cannot be compared"
  }
  if ($peakBytes -le 0) {
    throw "peak working set unreadable by BOTH psapi and polling — this measurement is void (0 would compare equal across arms and read as 'no difference')"
  }

  $wall += $sw.Elapsed.TotalSeconds
  $peak += $peakBytes
  $codes += $code
  Write-Host ("  rep {0}: {1,8:N2}s  peak {2,8:N0} MB  [{3}]" -f $i, $sw.Elapsed.TotalSeconds, ($peakBytes / 1MB), $method)
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
    peakMethod = $method
    # The spread is reported so a comparison can refuse to call a winner when
    # the difference between arms is inside one arm's own run-to-run noise.
    wallSpread = $maxWall - $minWall
  }
  $result | ConvertTo-Json -Depth 4 | Set-Content -Path $JsonOut -Encoding utf8
  Write-Host "wrote $JsonOut"
}
