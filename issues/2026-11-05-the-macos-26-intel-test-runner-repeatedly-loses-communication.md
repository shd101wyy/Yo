# The macos-26-intel test runner repeatedly loses communication during "Run tests"

**Severity:** S3 (CI infrastructure): no compiler defect, but each occurrence turns a develop battery red and costs a rerun of a leg that takes 45–90 minutes.

**Status:** open. Filed 2026-11-05 by the fix-forward agent after the third battery in four days lost a `test (macos-26-intel)` shard this way.

## Occurrences

Every one is a `test (macos-26-intel) shard i/4` job of `test.yml`, killed inside the **Run tests** step (`yo test ./tests … --c-compiler clang --shard i/4`). The only annotation is GitHub's: "The hosted runner lost communication with the server. Anything in your workflow that terminates the runner process, starves it for CPU/Memory, or blocks its network access can cause this error."

| Date | Run | Job | Shard | Ran for |
| --- | --- | --- | --- | --- |
| 2026-11-01 | 41324778903 | 124915802099 | 1/4 | 45 min |
| 2026-11-01 | 41324778903 | 124915802094 | 2/4 | 92 min |
| 2026-11-04 | 41781197316 (seed bump to v0.2.74) | 126435940865 | 2/4 | 50 min |
| 2026-11-04 | 41783521590 | 126497007322 | 1/4 | 52 min |
| 2026-11-04 | 41783521590 | 126497007177 | 2/4 | 68 min |
| 2026-11-04 | 41917783443 | 126918747899 | 1/4 | 64 min |

In the develop runs checked (back to 2026-11-01), no other runner image shows this message, and the other macOS leg, `macos-latest` (arm64), has none. An ordinary red macOS-Intel shard looks different: 41668995729's shard 1/4 ends in `Process completed with exit code 1`.

## What is known

- The runner dies while the test suite runs, never in checkout, toolchain install or the suite-compiler build. A network block would hit the downloads first, so the likelier cause is GitHub's "starves it for CPU/Memory". The macOS Intel image is the smallest machine in the matrix (4 vCPU, 14 GB).
- The occurrences start on 2026-11-01, during the VBD flips. Those flips raised the compiler's own peak memory: the full compile of `src/main.yo` by 27% and the max RSS of `check src/main.yo` by 34%. `yo test` compiles one batch at a time (`--parallel` is accepted but ignored), so the peak is one batch compile, from `--test-batch-size` test files merged into one program, plus the runner itself.
- Not yet measured: the leg's peak memory, and which batch is compiling when the runner drops.

## Recommendation

Do two things, in this order:

1. **Measure before changing the matrix.** Add a background sampler to the macOS-Intel `Run tests` step (`vm_stat`/`memory_pressure` every 30 s into a log uploaded with `if: always()`). That tells memory starvation apart from a GitHub-side drop. If it is memory, lower that leg's `--test-batch-size` or split it into more shards. The leg is about 80 minutes, so more shards also cut the critical path.
2. **Until then, one automatic retry of a lost-communication leg.** AGENTS.md's rule is one manual rerun per flaky job, and this job now needs that rerun on most batteries. A rerun policy confined to this message (not to test failures) keeps a real failure red on its first occurrence.

Moving the shard to `macos-latest` would drop x86_64 macOS coverage, which nothing else in the matrix provides, so it is not recommended.

## Update 2026-11-10: the loss is not specific to macos-26-intel, and the data does not show memory growth

Three more losses on develop, on two other runner types, all with the same annotation ("The hosted runner lost communication with the server...") and all with `gh api repos/shd101wyy/Yo/actions/jobs/<id>/logs` returning HTTP 404 `BlobNotFound` (the log blob never lands):

| Date | Run (sha) | Job | Lost in | Ran for | Normal for that step |
| --- | --- | --- | --- | --- | --- |
| 2026-11-08 | 42502891207 (f23081973) | test (macos-26-intel) shard 2/4, 128822793948 | Compile the suite compiler natively | 49 min | 5-8 min (the other three shards ran 48-56 min of tests) |
| 2026-11-08 | 42532190979 (b1af0cd01) | test-wasm32_wasi, 128889041895 | Run WASI tests | 78 min | whole job 66-80 min (green runs 42605340282, 42708865105) |
| 2026-11-09 | 42708865105 (fe58873dd) | test suite (ubuntu-24.04-arm) shard 2/4, 129516870451 | Run tests | 56 min | 24-26 min |
| 2026-11-09 | 42708865105 (fe58873dd) | test (macos-26-intel) shard 1/4, 129522337326 | Run tests | 84 min | 50-70 min (siblings 69-94 min) |

Measured from step timings of the last eight develop batteries with a completed `test` leg (11-07 a25a71ee1 through 11-09 fe58873dd):

| `Run tests` step | 11-07 a25a71ee1 | 11-08 40e10e7e9 | 11-08 f23081973 | 11-09 3ff5d6f05 | 11-09 367f37489 | 11-09 f8c70b02a (shard 3 died in 7 min, red for another reason) |
| --- | --- | --- | --- | --- | --- | --- |
| ubuntu-24.04-arm shards 0-3 (min) | 23 23 24 21 | 24 24 24 21 | 22 24 24 23 | 23 23 25 22 | 23 24 26 24 | 23 23 24 - |
| macos-26-intel shards 0-3 (min) | 49 50 55 44 | 55 58 62 74 | 55 56 - 48 | 64 63 68 76 | 71 54 72 85 | 99 70 57 - |

What this says:

- **ubuntu-24.04-arm (4 vCPU, 16 GB) is flat**: every shard is 21-26 min in every battery, with the same files, before and after #1837-#1840 and the later borrow/liveness work. A per-file RSS growth that pushed a shard toward the RAM limit would first show as swap slowdowns; there are none. The shard that was lost normally ends at 24-25 min and was still "running" at 56 min, so it was frozen or the runner was gone for the last half hour, not slowly finishing.
- **macos-26-intel (4 vCPU, 14 GB) is slow and noisy**: the same shard varies 44-99 min between batteries with no code change in the shard's files, and its compile step varies 5-15 min. It trends up (shard 3: 44, 74, 48, 76, 85), which cannot come from the compiler's footprint alone because the identical binary on arm does not move. This is the shared-host contention the leg's Intel hardware already had, and the longer a job runs, the more exposure to a drop.
- **`yo test` does not parallelise**: `--parallel` is ignored by the runner, one batch compiles at a time (`--test-batch-size` files merged into one program), and `test.yml` sets no `YO_TEST_MAX_RSS_MB`. Only the steady state is measured: the per-file `profile: file ... rss=` lines are not printed by the CI `--verbose` call and the lost jobs' logs are gone, so peak RSS in CI is unknown, not shown to be fine.
- The losses straddle a GitHub Actions incident (2026-11-09 18:12Z-~19:00Z) only for 42677134002; the 2026-11-08 losses and the 11-09 23:35Z-01:11Z ones are outside it.

**Verdict:** flake or infrastructure (VM loss), not a compiler memory regression, with one gap: nothing in CI records memory, so "OOM" is neither proved nor excluded for the intel leg. The mitigation order in the Recommendation above stands; a sampler step cannot help a lost runner by itself (its upload step never runs, and the live log blob is what 404s), so write the samples with a `trap`-free background loop to the job log every 30 s (`vm_stat`/`free -m` lines survive up to the last flushed chunk) and, separately, decide whether to add a retry-on-"lost communication" policy; that is a maintainer decision about CI, not a code fix.
