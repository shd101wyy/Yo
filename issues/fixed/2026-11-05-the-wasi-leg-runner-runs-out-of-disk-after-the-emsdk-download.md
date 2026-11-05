# The wasi leg's runner runs out of disk right after the emsdk download

**Severity:** S3 (CI infrastructure): no compiler defect, but each occurrence turns a develop battery red and blocks a release cut until the leg is rerun.

**Status:** fixed (2026-11-05). Both wasm legs free the runner's unused toolchains before installing Emscripten.

## Occurrences

`test-wasm32_wasi` on `ubuntu-latest` died within a minute of starting, before any Yo code ran. The runner itself crashed writing its diagnostic log:

```
System.IO.IOException: No space left on device : '/home/runner/actions-runner/cached/2.338.2/_diag/Worker_<ts>.log'
```

| Date | Run | Job | Died in step | Ran for |
| --- | --- | --- | --- | --- |
| 2026-11-04 | 41873995899 (develop 45ba11087) | 126730180082 | 6, "Build stage-1 with the seed" (just started) | 56 s |
| 2026-11-05 | 41945982719 (develop 68b45b81d, the v0.2.75 freeze) | 126979174934 | 5, "Setup Node.js" | 52 s |

In both, every step before the crash had passed, including `Setup Emscripten` (`mymindstorm/setup-emsdk@v14`, version 6.0.6). That step downloads and unpacks the emsdk toolchain, several GB, onto a hosted image that starts with limited free space on `/`. `test-wasm32_emscripten` runs the same step and has not hit it yet, so the margin is small rather than always exhausted. AGENTS.md treats a second failure of one job as real, so this is filed rather than rerun again.

## Fix

`.github/workflows/test.yml`: both `test-wasm32_wasi` and `test-wasm32_emscripten` gain a "Free runner disk space" step before `Setup Emscripten`. It removes toolchains these jobs never use (`/usr/share/dotnet`, `/usr/local/lib/android`, `/opt/ghc`, the CodeQL tool cache, about 25 GB) and prints `df -h /` before and after, so a future recurrence shows the numbers in the log.

## Recommendation if it recurs

Read the two `df -h /` lines. If the space after the cleanup is ample and the job still dies, the cause is something writing during the job, not the image: add a `df -h /` after `Setup Emscripten` and after the stage-1 build to find it.
