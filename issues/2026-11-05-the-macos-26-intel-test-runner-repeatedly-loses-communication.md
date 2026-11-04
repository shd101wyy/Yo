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
