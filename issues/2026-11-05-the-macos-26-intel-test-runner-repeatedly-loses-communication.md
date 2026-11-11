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

## Update 2026-11-11: 24 losses since 2026-10-25, none before; memory measured and ruled out

Two develop batteries in a row (42896112313 on cd99fc50c, shard 0/4, died in "Compile the suite compiler natively" after 46 min; 42936276334 on f784ff74f, shard 2/4, died in "Run tests" after 92 min) each lost one `test (macos-26-intel)` shard with the same annotation and no log (`BlobNotFound`). The previous battery, 42865362929 on 26a422d55, was green. The scan below covers every non-green `test.yml` run from 2026-10-20 to 2026-11-11 (645 runs, annotations API, `gh api repos/shd101wyy/Yo/check-runs/<job-id>/annotations`), so it supersedes the partial tables above.

### The complete list

24 jobs carry the "lost communication" annotation: 22 on macos-26-intel (shard 0: 5, shard 1: 8, shard 2: 7, shard 3: 2), one on `test suite (ubuntu-24.04-arm)` and one on `test-wasm32_wasi`.

| Date | Run | Job | Leg | Ran for | Step it was in |
| --- | --- | --- | --- | --- | --- |
| 2026-10-25 | 40152812164 | 121063833913 | intel 0/4 | 52 min | not recorded |
| 2026-10-25 | 40208251681 | 121229667205 | intel 0/4 | 47 min | not recorded |
| 2026-10-26 | 40281614774 | 121450199340 | intel 2/4 | 45 min | not recorded |
| 2026-10-26 | 40319341850 | 121605586724 | intel 3/4 | 52 min | not recorded |
| 2026-10-27 | 40520726671 | 122327061578 | intel 1/4 | 65 min | not recorded |
| 2026-10-28 | 40622912600 | 122615841907 | intel 2/4 | 60 min | not recorded |
| 2026-10-30 | 41059825875 | 124105996302 | intel 3/4 | 64 min | not recorded |
| 2026-10-30 | 41059825875 | 124105996663 | intel 1/4 | 81 min | not recorded |
| 2026-10-31 | 41192537744 | 124548806495 | intel 0/4 | 52 min | not recorded |
| 2026-11-01 | 41324778903 | 124915802094 | intel 2/4 | 92 min | not recorded |
| 2026-11-01 | 41324778903 | 124915802099 | intel 1/4 | 45 min | not recorded |
| 2026-11-03 | 41616447027 | 125885873746 | intel 1/4 | 50 min | not recorded |
| 2026-11-04 | 41781197316 | 126435940865 | intel 2/4 | 50 min | Compile the suite compiler natively |
| 2026-11-04 | 41783521590 | 126497007177 | intel 2/4 | 68 min | Run tests |
| 2026-11-04 | 41783521590 | 126497007322 | intel 1/4 | 52 min | Run tests |
| 2026-11-04 | 41917783443 | 126918747899 | intel 1/4 | 64 min | Run tests |
| 2026-11-05 | 42020243410 | 127280177784 | intel 1/4 | 85 min | Run tests |
| 2026-11-05 | 42059169876 | 127396017962 | intel 0/4 | 59 min | Run tests |
| 2026-11-08 | 42502891207 | 128822793948 | intel 2/4 | 49 min | Compile the suite compiler natively |
| 2026-11-08 | 42532190979 | 128889041895 | wasi | 79 min | Run WASI tests |
| 2026-11-09 | 42708865105 | 129516870451 | arm suite 2/4 | 56 min | Run tests |
| 2026-11-09 | 42708865105 | 129522337326 | intel 1/4 | 84 min | Run tests |
| 2026-11-10 | 42896112313 | 130210906606 | intel 0/4 | 46 min | Compile the suite compiler natively |
| 2026-11-11 | 42936276334 | 130293420870 | intel 2/4 | 92 min | Run tests |

### What the scan shows

- **It started on 2026-10-25, not on 2026-11-01 and not with the Nov 10-11 merges.** Of the macos-26-intel jobs of develop pushes: 0 of 114 lost from 2026-10-20 to 2026-10-24, 14 of 246 (5.7%) from 2026-10-25 to 2026-11-04, 6 of 122 (4.9%) from 2026-11-05 to 2026-11-11. At a 5% rate, 114 clean jobs happen about 1 time in 600, so the onset is real. The first loss is in 40152812164 (push of cf3adb02b, 2026-10-25). The day around it landed `--allocator debug` (3b908095f), the macro-fixture deletion and a dozen evaluator fixes; nothing in them touches the runner, and three of the losses precede any test.
- **Three losses happen in "Compile the suite compiler natively"** (11-04, 11-08, 11-10): one single-threaded `clang -O2` of the cross-emitted C, minutes after checkout, before any test file runs. A test cannot cause those.
- **Only 3 of the 24 jobs overlap a githubstatus.com Actions incident window** (Actions incidents on 10-21, 10-26, 10-30, 11-04 x3, 11-05 x2, 11-09 x2, 11-10 are listed by `https://www.githubstatus.com/api/v2/incidents.json`); the 2026-11-10 and 2026-11-11 losses are outside every incident.
- **The runner image did not change**: `macos-26` 20260824.0517.1 on 2026-10-24 and on 2026-11-10 (runner 2.338.0 and 2.338.2).
- **Exposure grew.** The median green macos-26-intel job of a develop push took 40 min (10-20..10-24), 43 min (10-25..11-04) and 64 min (11-05..11-11); the longest 63, 124 and 184 min. A longer job meets more of whatever kills the VM, but the 0-of-114 baseline had 63-minute jobs too.
- **The job log is small, so a log flood is not it**: a healthy shard's log is 0.7-0.9 MB (3.8-4.6 k lines).

### Memory, measured

Linux x86_64, the first failing sha's binary (cd99fc50c), `/usr/bin/time -v`, one `yo test <file> --c-compiler clang` per file, over the exact file lists `--shard 0/4` and `--shard 2/4` select at cd99fc50c (172 files, all passed; the shard 1/3 files were not measured):

| Measurement | Max RSS |
| --- | --- |
| `clang -O2` of the 136 MB emitted compiler C (the "Compile the suite compiler natively" step; 12 min on this box) | 1.88 GB |
| Largest test file, shard 0 (`tests/derive.test.yo`) | 1.04 GB |
| Next five, shard 0 (`comptime`, `http/http`, `send_sync`, `async/channel`, `closure_capture_list`) | 0.68-0.80 GB |
| Largest test file, shard 2 (`tests/async_await.test.yo`, also the slowest at 2 min 38 s) | 0.76 GB |
| Median file, both shards | 0.55 GB |

The figure is the largest single process of the `yo test` tree (the batch compile child), and `yo test` runs one batch at a time. The files #1885-#1890 added (`dyn_pointer_kinds`, `unsized_places`, `unsized_pointers`, `brace_record_dot`) are small: `unsized_pointers` peaks at 0.56 GB, the others sit in the median. Against 14 GB that rules out memory starvation by our code on this leg. The 26a422d55 comparison was not taken: with a 1 GB ceiling there is no top offender to compare. macOS may differ from Linux by a constant factor, not by 10x; the arm64 Linux leg that lost a shard in 42708865105 has run flat at 21-26 min for weeks.

### Observation: `--shard i/n` shifts the files of every shard whenever a test file is added

`--shard` stripes the sorted file list (`index % n`), so adding one file moves every later file one shard over. Between 26a422d55 and f784ff74f four test files were added (`brace_record_dot`, `dyn_pointer_kinds`, `unsized_places`, `unsized_pointers`), and every shard's list changed: only 12 of shard 2/4's 86 files at f784ff74f were also in shard 2/4 at 26a422d55 (12 of 86 for shard 1, 12 of 86 for shard 3, 13 of 87 for shard 0). At cd99fc50c, before `brace_record_dot` landed, shard 0/4 still shared 85 of its 86 files with 26a422d55. So "shard 2 failed" at f784ff74f is not "the same files as the shard that was green on 26a422d55", and a per-shard duration series (the 44-99 min per shard in the tables above) mixes different files from battery to battery; nothing in a failure set can be attributed to a shard's contents. Not a cause of the losses (the loss is the VM, not a file), but it removes the one thing that would have made a repeated shard number meaningful.

### Verdict

Infrastructure (the hosted macOS Intel VM or its agent), S3 as filed. No file or test of ours is implicated by anything measured: peak memory is 1-2 GB of 14 GB, three losses precede the tests, and the onset (2026-10-25) is a date, not a diff. The remaining unknowns are the VM's disk and process/file-descriptor headroom, which no measurement here covers.

### Recommendation (replaces the earlier ordering; nothing else changes)

1. **Release handling.** A lost macos-26-intel job on a release-candidate battery gets `gh run rerun <id> --failed` (AGENTS.md's one rerun). A second loss on the same tip counts as infrastructure only if the rerun's lost job is a different shard or a different step; the same shard and step lost twice is investigated (disk, descriptors and process count on that leg) before the release goes ahead.
2. **Record what the VM does before it dies**, because a lost runner's logs never land: in the `Run tests` and "Compile the suite compiler natively" steps of the macOS Intel leg start a background loop that prints `df -h /`, `vm_stat | head -4` and `ps -A | wc -l` every 30 s (printed lines survive up to the last flushed chunk). That settles disk and process headroom, the two causes this document cannot rule out. If a retry-on-"lost communication" policy is wanted, it belongs in the same maintainer decision as the sampler.
3. Keep the leg: moving its shards to `macos-latest` drops x86_64 macOS coverage (see above).
