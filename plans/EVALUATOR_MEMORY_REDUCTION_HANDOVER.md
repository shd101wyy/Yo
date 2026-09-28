# Evaluator memory reduction — handover (2026-09-28)

**Status: ACTIVE handover.** Written for the agent who picks up
`plans/EVALUATOR_MEMORY_REDUCTION.md`. The plan is authoritative for design
and history (its §0.x sections). This file is the current state and the to-do
list. Rewritten 2026-09-28: the 2026-09-26/27 version had grown contradictory
sections, and several of its claims did not survive review (see §1.1).

## 0. Rules that bind every change here

- **Never trade speed for memory.** User directive, 2026-09-26: keep or
  improve `check`/`compile` wall time while cutting footprint.
  - Every memory PR reports wall time next to footprint, from the same A/B
    pairs.
  - A slowdown beyond noise (about 1–2 %) blocks the merge: find its cost.
  - On Linux, callgrind instruction counts are the noise-free tool
    (`valgrind --tool=callgrind`, about 50× slower; `check src/types/intern.yo`
    takes 5 s natively).
  - A correctness fix (a leak) whose instruction count is flat is not a trade.
- **Admin-merge once local gates pass** (user directive), and never while a
  release is being cut. The local battery:
  - `yo check ./src --std-path ./std` (score by rc);
  - `S1=<stage1> P=<tag> bash scripts/bootstrap/gates_fast.sh`;
  - `S1=<stage1> P=<tag> bash scripts/bootstrap/fixpoint_only.sh` (must print
    `FIXPOINT_HOLDS`);
  - the fast suite:
    `<bin> test ./tests --std-path ./std --exclude tests/internal --exclude tests/cli-cases`;
  - `<bin> test ./std --std-path ./std`;
  - the CLI corpus: `YO_SELF_BIN=<bin> bash scripts/cli-diff-test.sh`;
  - `tests/internal/{diagnostics_registry_examples,parser,module_invalidation}.test.yo`,
    one file per invocation, `--parallel 1`.
- **On the Linux box, score the fast suite by DIFF against develop, not by the
  count.** Develop itself fails about 560 tests there on LeakSanitizer reports
  (668 before §0.19 fixed 109 of them). They are real leaks, not WSL2
  artifacts (§3.1). Run develop's binary on a develop worktree in the same
  window and `comm` the two `✗` lists. The gate is "nothing new fails".
  Network tests (`tests/crypto`, `tests/http`) sometimes hang in
  `io_uring_enter` on a socket; kill the stuck batch binary and re-run that
  file alone.
- **Memory ratchets fail both ways at ±10 %** (`scripts/bootstrap/memory-ratchet.tsv`;
  CI jobs "Evaluator memory ratchet" and "Compiler build inside 8 GB"). A win
  turns CI red: read the measured kB from those two job logs and lower the
  baselines in the same PR. Current baselines: `check_src_main_max_rss_kb
  1071836` (lowered by §0.19's PR, from CI's own reading) and
  `compile_src_main_peak_kb 3527328`. The compile peak did not move with
  §0.19 (3,525,848 kB measured): that job's peak is not the evaluator's
  exit retention.
- **Measuring.**
  - On macOS, footprint noise is about ±180 MB for one binary. Use three or
    more interleaved pairs on a quiet machine.
  - On this Linux box, run the pairs simultaneously. Max RSS is repeatable to
    about 1 MB.
  - Build the baseline from the exact merge-base with the same builder.
  - A codegen change only shows its effect in a stage-2 compiler: use
    `fixpoint_only.sh`'s `/tmp/<P>_s2` from both trees.
- **Every bug found gets an `issues/fixed/<name>.md` doc and a test that fails
  first.** User-visible docs go in en-US and zh-CN.
- The Linux release bundles stay static musl. On this box they check about
  14 % slower than a locally built glibc compiler; that gap is accepted (user
  decision).

## 1. State of `develop`

### 1.1 Review of the 2026-09-27 session (#954, #957, #958)

A second agent's work was re-reviewed on 2026-09-28. What held up and what
did not:

- **#957's `g_match_arms` purge** found a real registry, but the fix had three
  problems:
  - it added a parallel owner index keyed by the entry module's as-typed path,
    which never matched the `file://` purge key;
  - it recorded in one-shot commands;
  - its test bypassed the real invalidation path.

  Reworked onto `record_owned_expr_id` / `take_owned_expr_ids`
  (`issues/fixed/match-arm-registry-retains-every-generation-of-compiled-arms.md`).
- **The Linux census of #954/#957** used a heuristic chunk walk. The deep walk
  segfaulted, and the zero-hit scan was unreliable, so none of §0.18's byte
  figures exist. Its "Pattern +1 is a missing release" and "the `:=`
  indexed-read leak is a large slice of §3.1" were both wrong (plan §0.18
  corrections). The census is exact now (§0.19).
- **`peak_histogram.py` (claimed to close Phase 0 step 2)** injects the
  allocator-wrapping registry that #957 itself removed from the census for
  costing 7× and wedging at full scale. It has never completed a
  `check src/main.yo` run. Its per-mark rows carry size classes and sites
  only for the top N; the exit rows duplicate the census. **Not done** (§3.5).
- **#958, the builtin-name reservation**, is sound and merged. Its handover
  text claimed the `__yo` prefix was reserved, which the PR itself dropped.

### 1.2 Landed since the last handover

| PR | Change | Measured |
| --- | --- | --- |
| #951 | capture values read through the fetched capture source | wall −2.9 % (pays back #932) |
| #954 | Linux census tooling (heuristic), `YO_DEBUG_SCOPE_DROPS`, docs: `Option` of a handle is one pointer | — |
| #957 | holder_report.py, `g_match_arms` purge (reworked by §0.19's PR) | — |
| #958 | plain-named builtin dispatch names are reserved for bindings | — |
| #967 | exact Linux census; `--rc-balance`; **closures release their captures**; #957 rework | stage-2 `check src/main.yo` max RSS 1,282 → 1,165 MB (−9.2 %); exit census 942 → 763 MB; LEAK 129.5 → 17.8 MB |
| #970 | `yo build` stamps the compiler binary; bound-await scrutinee hoists; async continuation pool freed at thread exit | LeakSanitizer fast suite: 109 → 252 fixed vs develop |
| #971 | arm windows construct-local; codegen-only tables skipped in `check`/`verify`/`doc`/`lsp` (plan §0.21) | stage-1 max RSS −33.9 MB (−2.8 %) |
| #972 | `Token` positions are `u32`, 80 → 64 B (plan §0.22); census `HOLDER_DUPSTR` (§0.23) | stage-1 max RSS −30.1 MB (−2.5 %) |
| #973 | an awaited `match` scrutinee and hoisted state-machine locals are released at completion | 52 more LeakSanitizer failures fixed; `async_await.test.yo` 160/60 → 212/11 |
| #979 | node strings interned (dot/number tokens, fixed punctuation, desugar keywords); function-id registries share the id handle (plan §0.23) | stage-1 max RSS 1,146,640 → 1,107,468 kB (−3.4 %) |
| #980 (peer) | fixes #973: an early `return` of a hoisted state-machine local read the field after the completion drop zeroed it (stage-2 `yo install` segfault on a cold cache). **#973's local gates never ran `install`.** | — |

Release v0.2.45 is published and is the seed.

## 2. In flight

Nothing. `mem/lsp-type-registry-purge` is parked, not to be merged (§3.5, Phase 1 step 3).

## 3. Remaining work, ranked by the §0.19 census

The fixed stage-2 compiler keeps **763 MB** of RC objects at
`check src/main.yo` exit. First-reach attribution gives the shared program
graph to whichever root is walked first (now `g_type_intern`, 281 MB), so read
the per-root rows only as exclusive shares (`HOLDER_DEEP_LAST`). By type, the
retained set is:

| type | MB | what |
| --- | --- | --- |
| `AstExpr` | 189 | the AST, including specialization clones |
| `ArrayList(u8)` | 185 | strings |
| `Token` | 139 | 76 B each |
| `ArrayList(Self)` | 94 | mostly `ArrayList(AstExpr)` argument lists |
| `ArrayList(Variable)` + `Variable` | 44 | |
| `TypeValue` | 12.5 | |

`ExprInfo` has left the top of the table: the per-module tables are released
now that closures stop pinning them.

### 3.1 Leaks

- **The LEAK residue (17.8 MB).**
  - `Variable` 43 K (6 MB);
  - zero-hit `Token` 9 K and `HashMap(String, unit)` 4.3 K (both below 1 MB);
  - `TypeValue` 20.8 K with about 5.7 references each from untracked holders.

  Method: `alloc_site_census_t.py <C> a.c d.txt <Type> --rc-balance`, then
  `rc_balance_report.py` (§4.2).
- **LeakSanitizer reports in the fast suite on Linux**: 549 at #967, 297
  after #970 and #973 (fast suite 4,227 passed / 299 failed). They are the
  same missing-release families in user-shaped programs, not WSL2
  artifacts.
  - The largest files now are all I/O:
    - `http/http` 31, `http/server` 11;
    - `fs/file` 23, `fs/dir` 13, `fs/fs_convenience` 11;
    - `async/combinators` 20;
    - `net/tcp` 19;
    - `io/bufio` 12;
    - `async_await` 11;
    - `process/command` 10.
  - Coordinate with the Linux async-I/O runtime work: another session owns
    `runtime_io_*.yo` and `runtime_core.yo`.
  - The state-machine drop gate was the family behind #973. A body that
    ends without `return(...)` takes `state_machine.yo`'s separate
    "Drop local variables before completion" path, which is worth auditing
    next.
  - Group them by file (`grep -B1 "Memory leak detected"` on the fast-suite
    log) and fix the largest families first. Each fix gets a Dispose-counter
    test.
  - They pass CI only because CI does not arm LeakSanitizer on these legs.
    Check `test.yml` before assuming that.

### 3.2 Strings: `ArrayList(u8)`, 185 MB

**Re-ranked by content (plan §0.23, `HOLDER_DUPSTR=1`):** 1.28 M live strings
hold 194 MB, but only 422 K distinct contents exist, so **71.9 MB (37 %) is
redundant copies**. Two families:
- tiny node strings minted per AST node instead of interned: a 1-char string
  ×198 K, `tuple` ×48 K, `begin` ×34 K, `=>` ×30 K, `Some`/`None`/`cond`/
  `true` ×15 K each;
- registry keys cloned per table: `g_funcval_cap_vars` 12.0 MB,
  `g_func_type_registry` 10.8 MB, `_type_trait_methods` 10.4 MB,
  `g_specialized_base` 9.4 MB, `g_type_intern` 7.1 MB of copies.

Interning the first family at its mint site, and sharing the handle instead
of `.clone()` for the second, is where the §3.2 bytes are. The lexer's
`intern_token_str` is the precedent (value strings are audited
never-mutated).


The exclusive holders measured before §0.19 (re-measure with
`HOLDER_DEEP_LAST`):
- `g_type_intern` keys, about 35 MB (24 K keys of 1.4–3.6 KB);
- `g_token_intern`, 22 MB;
- `g_ifc_memo` keys, 18 MB;
- `g_func_type_registry`, 14 MB;
- `g_specialized_base`, 10 MB;
- `g_stable_occurrence`, 11 MB;
- `g_method_callee_values`, 37 MB first-reach.

The designs:
- (a) **`type_intern` keys:** a 64-bit hash plus the canonical node, verified
  on hit by a structural equality exactly as fine as `type_intern_key`, never
  coarser (`src/types/intern.yo`'s header explains the 2026-07-02 wrong-merge).
  No probabilistic 128-bit-only key without the user's agreement. The verifier
  mirrors a ~500-line renderer, and interning sits on `substitute`'s hot path,
  so measure instructions before and after.
- (b) The other memo keys: check whether each can be a numeric id (fid index,
  type id) instead of a rendered string.

### 3.3 The AST population: `AstExpr` 189 MB + argument lists 94 MB + `Token` 139 MB

This is Phase 4 of the plan, now the largest lever. Design 1:
- key `ExprInfoTable` by `(spec_id, ExprId)`;
- stop `clone_expr_fresh_ids` per specialization;
- keep fresh ids for synthesized nodes only.

§0.2d measured 1.30 M cloned nodes. It is a large, cross-cutting change: list
every id-keyed walk first (`_optimize_dup_drop_pairs`, the deferred-drop
lists, `g_match_arms`, `g_arm_init_ranges`, `g_method_callee_*`). Prototype on
`create_specialized_function_inline` (`calls/helper.yo`) and measure the
`AstExpr` count.

### 3.4 Token diet (80 B × about 1.9 M)

LANDED on branch `mem/token-u32` (plan §0.22): the four positions are `u32`,
80 → 64 B a token, −30.1 MB max RSS. Sharing `module_path` + `input` in
one source record was built and REJECTED 2026-09-29 (plan §0.24). It saves
17 MB under glibc, but costs about +4.5 MB under mimalloc and nothing is
saved on macOS/Windows (16 B quanta). The per-lexing records (one per
synthesized snippet) outweigh the 8 B a token. What remains open is a
4-byte source index in place of both handles (no new object, but the table
needs an owner purge).

### 3.5 Plan steps still open

- **Phase 0 step 2**: the peak histogram (§1.1). Rebuild it on the exact chunk
  walk. Snapshot the live-chunk composition by size class when RSS crosses a
  growth mark (poll `/proc/self/statm` from a timer thread; walk the heap
  under the malloc lock), instead of wrapping every allocation.
- **Phase 1 step 2**: CLOSED 2026-09-28 (plan text). `ModuleWalk.ctx` is an
  `Option`, and `_force_pending_def_impl` turns forcing a released walk into
  an internal error, so every green one-shot gate proves the invariant.
- **Phase 1 step 3** (LSP retains only open documents) LANDED 2026-09-24.
  Plateau on stage-2, 2026-09-28: editing leaf documents is flat (196 → 231 MB
  over 4 rounds). Editing std modules the cached prelude imports still grows
  ~19 MB a round, led by `g_struct_finals`. An owner purge of the type-id
  registries was tried and rejected because it was slower and fatter: the
  prelude keeps the old generation alive
  (`issues/lsp-memory-grows-per-open-edit-close-round.md`). Measure on
  stage-2 only; seed-built binaries show the seed's leaks.
- **Phase 1 step 5**: the table is written (plan §0.20,
  `scripts/bootstrap/registry_table.py`). Its four levers (plan §0.21):
  1. LANDED (branch `mem/arm-ranges-local`): the codegen-only tables are
     skipped in `check`, `verify`, `doc` and the LSP
     (`set_codegen_tables_enabled`), and the arm windows are local to their
     construct. −33.9 MB max RSS.
  2. NOT TAKEN: the branch-init log's indices are held across nested
     evaluations and ~40 catch sites. §0.21 has the sound design (about
     16 MB).
  3. Tried 2026-09-28 for the type-id registries and rejected (see Phase 1
     step 3 above). The prelude-imported std modules need a different design.
  4. Folded into §3.2: `check` runs the verifier too, so the cost is the
     duplicated id strings, not the recording.
- **Phase 5b**: `Symbol`, interned identifier strings (feeds §3.2 and §3.4).
- **Phase 6**: the RC header / `Variable` diet.

### 3.6 Speed levers found while measuring (not memory, but the same gate)

- The cycle collector costs about 2 % of `check src/main.yo` wall time and
  reclaims nothing measurable. `YO_GC_THRESHOLD=0` gives 251 s instead of
  256 s at identical RSS. The runtime comment on `YO_GC_THRESHOLD` already
  suggests disabling it for the compiler. Measured 2026-09-28 (stage-2 of
  `59ef41250`); NOT established:
  - `YO_GC_THRESHOLD=0` turns off only the incremental (Bacon-Rajan)
    trigger. The allocation-driven full-heap scans (2× live) still run;
    `YO_GC_FULL_PCT=100000` turns those off.
  - `compile src/main.yo --skip-c-compiler`, one run each: user 375.9 →
    369.4 s, max RSS 3,245 → 3,248 MB, emitted C byte-identical.
  - LSP plateau (10 std files × 6 rounds): 230.3 vs 230.5 MB, same round
    times. The collector reclaims nothing measurable.
  - `check src/main.yo`, default / incremental off / both off, user seconds:
    - forward order: 218 / 265 / 284;
    - reverse order, with the load average rising from 2 to 20: 613 / 414 /
      477.

    Whichever run came later was slower. On a shared box the noise is
    about ±30 %, which swamps a ~2 % lever.

  Next step: an instruction count (cachegrind on a smaller input, or an
  idle machine), with the incremental and full triggers measured
  separately. A switch would need a runtime entry, because the env knob is
  read before `main` runs. It is also seed-gated: `src/main.yo` can call it
  only once a release carries it.
- `__yo_decr_rc` is 19 % of all instructions in `check`, and one `__yo_fs_…`
  function is 9.5 % (callgrind, §0.19). Name that function with
  `YO_DEBUG_FN_ORIGIN=1` before optimizing anything.

## 4. Tools and recipes (all in `scripts/bootstrap/`)

### 4.1 Holder census: exit retention by root and type

```bash
yo compile src/main.yo --emit-c --skip-c-compiler --allocator system --std-path ./std -o s2   # or fixpoint_only.sh's /tmp/<P>_stage2.c
python3 scripts/bootstrap/holder_census_t.py s2.c holders.c holders_dump.txt
clang -std=c11 -D_GNU_SOURCE -fno-strict-aliasing -fwrapv -w -O1 -o yo_holders holders.c \
  $(pkg-config --cflags --libs openssl) -lm -lpthread        # macOS: the brew openssl flags
HOLDER_MIN=1000 HOLDER_SCAN=1 HOLDER_DEEP=1 HOLDER_COLLECT=1 ./yo_holders check src/main.yo --std-path ./std
python3 scripts/bootstrap/holder_report.py holders_dump.txt
awk '$1=="D" && $4=="LEAK"' holders_dump.txt | sort -k3 -n -r | head   # the unreachable group
```

- On Linux the binary re-executes itself under walkable glibc tunables. The
  dump's `# chunks … exact 1` line confirms it; `HOLDER_NO_REEXEC=1` opts out.
- `HOLDER_MIN` defaults to 1,000,000 tracked objects. Since §0.19 a full
  `check` ends with about 634 K, so pass it explicitly.
- `HOLDER_DEEP_LAST=<root>` walks that root last and gives its exclusive
  share.

### 4.2 Finding a missing release

- **An object dup'd many times (a table, an env):** `--rc-balance`.

  ```bash
  YO_DEBUG_FN_ORIGIN=1 yo compile src/main.yo --emit-c --skip-c-compiler --allocator system --std-path ./std -o origin
  python3 scripts/bootstrap/fid_name_map.py origin.c fidmap.tsv
  python3 scripts/bootstrap/alloc_site_census_t.py origin.c bal.c bal_dump.txt "HashMap(usize, ExprInfo)" --rc-balance
  clang … -O1 -g -fno-omit-frame-pointer -o yo_bal bal.c …
  ./yo_bal check src/main.yo --std-path ./std
  python3 scripts/bootstrap/rc_balance_report.py bal_dump.txt yo_bal fidmap.tsv
  ```

  A function with a positive live net and about 0 freed net is where the
  missing release belongs.
- **An object with few events:** `--rc-events` plus `rc_event_report.py`, the
  first and last 8 events per leak root (the plan §0.8 recipe).
- Either way, reproduce in a 15-line program with a `Dispose` counter
  asserting exactly one dispose, and read the emitted C.

### 4.3 Stage-2 A/B

`fixpoint_only.sh` leaves `/tmp/<P>_stage2.c` and `/tmp/<P>_s2`. Build one from
each tree and run `check src/main.yo` on the SAME tree, both at once:

```bash
for s in base fix; do /usr/bin/time -f "$s wall=%e rss=%MkB" /tmp/${s}_s2 check src/main.yo --std-path ./std & done; wait
```

## 5. Coordination

- Peer sessions (type-system soundness, parallelism, drop-liburing) merge into
  the same files, especially `calls/*.yo`, `env.yo`, `types/*.yo` and
  `codegen/*`. Rebase before gating.
- Never merge a docs-only PR while a develop battery you wait on is pending.
- Never merge while a release is being cut.
