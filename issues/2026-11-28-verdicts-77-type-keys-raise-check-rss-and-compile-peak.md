# VERDICTS-77's type keys raise `check src/main.yo` RSS by 17% and the compiler build's peak by 12%

**Severity:** S3 — a performance regression: `check src/main.yo` takes ~340 MB more memory and
`compile src/main.yo` ~640 MB more, with no change in what the compiler accepts or emits. Develop's memory
ratchets failed on it and were re-baselined (VBD rule: no perf gates during VBD); the fix is post-VBD work.

- Filed: 2026-11-28 by the `fix-develop-56933` lane.
- Introduced by #2122 (4d1aacecb, VERDICTS-77 PR 1) and #2123 (3259bf4a6, VERDICTS-77 PR 2).
- Re-baselined to develop's battery at f6d5f1b12 (run 46142653267) in `scripts/bootstrap/memory-ratchet.tsv`:
  `check_src_main_max_rss_kb` 1,871,608 → 2,222,504, `compile_src_main_peak_kb` 5,066,692 → 5,800,148. A fix
  lowers both rows again.
- The work ratchet (allocation calls) failed on the same battery; it is not part of this doc (the
  evaluator-work branch reclaims it).

## Measurements

Develop's battery on 56933fcd8 (run 46054783154) failed the RSS ratchet at 2,237,504 kB (ceiling
2,058,768) and the build-memory ratchet at 5,882,504 kB (ceiling 5,573,361); the battery on d7b564754
(run 46048814988) passed both. The battery runs between them were cancelled, so each squash commit was
measured locally by the CI jobs' own method: the seed builds stage 1 with the tree's std, stage 1 emits the
stage-2 C with `--allocator mimalloc`, clang -O2 links it with the vendored mimalloc; then
`memory_ratchet.sh` (max RSS of `check src/main.yo`) and `compile_memory_ratchet.sh`'s measurement
(`memory.peak` of `compile src/main.yo --optimize 2` with the C compiler, in a user cgroup scope instead of
the job's `sudo` one). The two endpoints use the batteries' own `bootstrap-stage2` binaries. Every number is
from one box, so the steps compare; the absolute values run ~3% above CI's, and the box's run-to-run noise
on the RSS row is ~2%.

| Head | PR | check RSS (kB) | compile peak (kB) |
| --- | --- | ---: | ---: |
| d7b564754 | (last green) | 1,996,860 | 5,349,700 |
| b76eb8592 | #2120 dov-s2 | 1,990,856 | 5,355,988 |
| 062144934 | #2121 example regressions | 1,983,312 | 5,360,816 |
| 4d1aacecb | #2122 VERDICTS-77 PR 1 | 2,083,492 | 5,575,444 |
| 3259bf4a6 | #2123 VERDICTS-77 PR 2 | 2,309,792 | 5,899,624 |
| 8016f8a63 | #2124 infer-first A | 2,313,904 | 5,916,944 |
| 56933fcd8 | #2125–#2127 | 2,333,760 | 5,990,532 |

#2121 is clean; #2122 adds ~100 MB of check RSS and ~215 MB of compile peak, #2123 ~226 MB and ~324 MB.
#2124–#2127 add ~24 MB and ~91 MB together (#2125 and #2127 change std modules `src/main.yo` does not
import). A stage-1 proxy agrees (max RSS of
`check src/types/substitution.yo`: 429,380 kB at b76eb8592, 428,744 at 062144934, 441,904 at 4d1aacecb,
452,636 at 3259bf4a6). #2131 (the fix for the two-same-shaped-structs bug #2123 also introduced) moves none
of the rows: 2,280,288 → 2,299,352 kB check RSS, 7,690,620,735 → 7,701,303,856 allocation calls, compile peak
5,935,412 → 5,928,248 kB, all against run 46054783154's stage-2 binary on one tree.

## Root cause (as far as it is pinned)

Both PRs change how `type_key` (`src/types/type-key.yo`) renders a recursion it does not expand, and type
keys are the keys of the evaluator's type-identity memos, so their length is resident memory:

- #2122 renders the cut of a recursive enum, and every enum past the depth cap (`depth > 4`), as
  `rec:<declaration identity>|<argument keys>` (`_tk_enum_cut`) instead of the bare instance id. The argument
  keys are full renders, and an argument past the cap renders its own cut, so a key past depth 4 now spells
  the whole argument structure where it used to stop at an id.
- #2123 makes only a recursive enum a node of the cycle guard (`enum_is_recursive`), so a non-recursive
  instance met twice on one path (an `Option(Rc(N))` around a recursive `N`) is expanded again instead of
  cut; gives a generic struct instance's cut the same argument rendering (`gs_<constructor>_<argument
  keys>`); and adds the substituted-shell registries (`g_shell_subst_finals`, `g_shell_base_lists`,
  `g_struct_final_args`, `g_enum_final_args`), each holding type values for the life of the compile.

Which of these carries #2123's 226 MB has not been measured: no per-memo size counter exists. The next
step is one (entries and total key bytes per type-key-keyed memo, and the registries' sizes) at 4d1aacecb
and 3259bf4a6.

## Fix direction (post-VBD)

Keep the identity the keys encode (VERDICTS-77 I2: a substituted copy and the constructor's instance key
alike) and shorten what is stored: render a cut's argument keys through an interned or hashed token instead
of the text, as the C type name already reduces a key to a 64-bit hash. Re-measure both rows and lower their
baselines in the same PR.
