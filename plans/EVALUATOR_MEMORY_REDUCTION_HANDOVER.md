# Evaluator memory reduction — handover (2026-09-26)

**Status: ACTIVE handover.** Written for the agent who picks up
`plans/EVALUATOR_MEMORY_REDUCTION.md`. It records what landed in the 2026-09-24…26
session, the state of the in-flight work, and every remaining item in enough
detail to start without re-reading the whole plan. The plan stays
authoritative for design and history (§0.x sections); this file is the
to-do list.

## 0. Rules that bind every change here

- **Never trade speed for memory.** User directive, 2026-09-26: keep or improve
  `check`/`compile` wall time while cutting footprint. Every memory PR reports
  interleaved wall time next to footprint, from the same A/B pairs. A slowdown
  beyond noise (about 1–2 %) blocks the merge: profile it (`sample <pid>`, frames
  named with `YO_DEBUG_FN_ORIGIN=1`) and remove the cost.
- **Admin-merge once local gates pass** (user directive). The local battery is:
  - `yo check ./src --std-path ./std` (score by rc; `grep "error in"` is always 0 on today's output);
  - `S1=<stage1> P=<tag> bash scripts/bootstrap/gates_fast.sh`;
  - `S1=<stage1> P=<tag> bash scripts/bootstrap/fixpoint_only.sh` (must print `FIXPOINT_HOLDS`);
  - the fast suite: `<bin> test ./tests --std-path ./std --exclude tests/internal --exclude tests/cli-cases`;
  - `<bin> test ./std --std-path ./std`;
  - the CLI corpus: `YO_SELF_BIN=<bin> bash scripts/cli-diff-test.sh`;
  - `tests/internal/{diagnostics_registry_examples,parser,module_invalidation}.test.yo`, one file per invocation, `--parallel 1`.
- **Memory ratchets fail both ways at ±10 %** (`scripts/bootstrap/memory-ratchet.tsv`;
  CI jobs "Evaluator memory ratchet" and "Compiler build inside 8 GB"). A win
  turns CI red: open the PR, read the measured kB from those two job logs, and
  lower the baselines in the same PR. Baselines at hand-off are
  `check_src_main_max_rss_kb 1381732` and `compile_src_main_peak_kb 4062412`.
- **Measuring on macOS:** footprint noise is about ±180 MB for the same binary.
  - Use interleaved pairs (three or more) on a quiet machine (no suite or build running).
  - Build the baseline from the exact merge-base, with the same builder.
  - An emitted-C A/B must have both compilers emit the SAME tree.
  - Below about 100 MB, use the holder census or the Linux ratchet.
- **Every bug found gets an `issues/fixed/<name>.md` doc and a test that fails
  first.** Docs go in en-US and zh-CN.
- **Known environmental noise on this Mac:**
  - Seven CLI cases (`build-stamp-dotted-dir`, `init`, `init-build-test`, `init-cwd`,
    `init-existing`, `skills-install`, `skills-install-zh`) differ with any
    locally built binary, develop's included: they need an installed-bundle layout.
  - `tests/thread.test.yo` can die with "Capture type not found for closure"
    depending on the checkout directory. That is yo-16's path-dependent ICE, not a
    memory change; run the file in another worktree to confirm.
  - macOS `--sanitize thread` segfaults every test (not a signal).

## 1. What landed this session (all merged on `develop`)

| PR | Change | Measured |
| --- | --- | --- |
| #908 | `compile` runs the C compiler in a fresh image (`__cc-plan`); 8 GB CI job | build 9.7 → 6.35 GB |
| #912 | chunk-job memory cap; `--emit-c-to` help | — |
| #913 | executed CTFE clones drop their metadata | build 6.35 → 4.85 GiB |
| #915 | synthesized tokens share their module's source text | check 2,504 → 2,159 MB |
| #920 | derived FuncVals take their parent's aligned handles | check 2,069 → 1,551 MB |
| #921 | 8 GB swapfiles; `BUILD_ON_8GB_MACHINES` closed | — |
| #922 | capture handles are slices of the frames' own lists | check ≈ −170 MB |
| #923 | `http_limits` tests on loopback | — |
| #929 | one-shot commands record no owner logs (§0.15) | ≈ 62 MB (census) |
| #931 | CONTRIBUTING refresh (en + zh-CN) | — |
| #932 | a handle-backed FuncVal keeps no capture value snapshot (§0.16) | check ≈ −310 MB; Linux check 1,664,136 → 1,381,732 kB, build 4.31 → 3.87 GiB; **wall +3 % — see §2.2** |
| #935 | expression ids start at 1; `compile` reports the safe-code rejection | — |
| #937 | `sizeof`/`alignof` of a nullable-pointer Option; one niche predicate in `src/types/guards.yo` | — |

Release v0.2.43 was cut mid-session (the seed is v0.2.43).

## 2. In flight

### 2.1 Phase 3 — the `Option(ref)` niche (this PR, branch `mem/option-ref-niche`)

**What it does.** `can_optimize_as_nullable_pointer` (`src/types/guards.yo`)
also accepts a non-atomic reference handle (`ref(struct)`, `ref(enum)`), so
`Option(Ref)`, every `String` (`newtype(_bytes : Option(ArrayList(u8)))`) and any
two-variant enum with one fieldless variant and one handle payload (e.g.
`Tree :: enum(Leaf, Node(child : Box(Self)))`) lower to the bare pointer, with
NULL for the fieldless variant. `Token` 107 → 76 B and `ExprInfo` 214 → 153 B
in the census, and the stage-2 compiler is about 6 % faster (≈ 110 → 103 s on
`check src/main.yo`).

**Bugs it exposed and this PR fixes** (each with an `issues/fixed/` doc and a
test that fails first):

| Issue doc | Fix |
| --- | --- |
| `nullable-pointer-arm-binding-stores-into-a-same-named-hoisted-slot.md` | slot resolution via the pattern atom's env |
| `nullable-pointer-match-wildcard-arm-overwrites-the-some-arm.md` | first-match classification; `_` claims the unclaimed case (sync + async) |
| (in the same doc's tests) labeled/curly payloads, bare `.Variant` arms | arms classified by VARIANT NAME (`nullable_arm_selects_payload`), binder via `nullable_arm_payload_binder` (`src/codegen/utils/index.yo`) |
| `nullable-pointer-match-never-releases-its-scrutinee.md` | `_gen_nullable_ptr_match` / `_gen_simple_enum_match` emit the match's deferred drops |
| (codegen) `JoinHandle.await` built a tagged Option literal | niche branch in `src/codegen/exprs/await.yo` |
| (codegen) `Type.Variant` of a niche enum built a tagged literal | `NULL` in `src/codegen/exprs/property_access.yo` |

`compile-allocator-fixed-oom` was re-recorded: the fixed-heap OOM now requests
72 B instead of 80, because an object shrank.

**Results of the final battery:** see §2.1.1. If it is incomplete, the next
agent re-runs it (commands in §0) before merging.

#### 2.1.1 Final battery (fill in when it completes)

RESULTS_PLACEHOLDER

**If the A/B still shows no footprint win after the leak fix,** re-take the
holder census on the new stage-2 C (recipe in §4.1) and compare the `LEAK`
group and the unreached-root (`R`) rows against the base census
(`/tmp/claude-501/hc3_p3base/holders_dump.txt` on this machine; re-create it from
the merge-base otherwise). Any group that grows is another niche path with a
missing release or retain: find it with the rc-event pipeline (§4.2).

**Sites to audit if anything else misbehaves under the niche** (all consult
`can_optimize_as_nullable_pointer`):
- `codegen/types/generation.yo` (typedefs);
- `functions/constructors.yo` (dispose/traverse);
- `exprs/drop_dup.yo` (inline drop/dup);
- `exprs/match.yo` / `async/state_code_gen.yo` (matches);
- `exprs/other_fn_call.yo` (runtime enum construction);
- `exprs/comptime_value.yo` (comptime literals);
- `exprs/downcast.yo`, `exprs/property_access.yo`, `exprs/await.yo`, `exprs/async.yo` (slot types);
- `codegen_c.yo` (on-demand declaration).

A site that emits `.tag` / `.data.` for an enum without asking the predicate
first is the bug class.

**Docs to write when it merges:**
- plan §0.17 (numbers from §2.1.1);
- the status line at the top of `EVALUATOR_MEMORY_REDUCTION.md`;
- the Phase 3 section marked LANDED;
- the ratchet re-baseline from CI.

A user-visible note is also worth adding to `docs/*/` (en + zh-CN): `String` and
`Option` of a handle are one pointer in size, and `sizeof(Option(*T))` is the
pointer's.

### 2.2 The #932 slowdown fix (branch `perf/capture-val-lookups`, pushed, no PR)

#932 read every capture value through `fv_capture_val`, which does a registry
lookup (`get_funcval_cap_slices`) plus a slice walk per element. Loops over a
FuncVal's ~1,760 captures did this per element:
- `_impl_type_captures_sig`;
- the closure re-evaluation in `helper.yo`;
- the operator/method CTFE env builders in `function.yo`;
- codegen trace specialization;
- `fv_capture_vals`.

`check src/main.yo` got 3 % slower (99.6 → 102.8 s).

The branch (one commit on 0e6f2500b) adds `fv_source_count` / `fv_source_val`
(`src/env.yo`), which read through the `FvCaptureSource` the callers already
hold, and makes `fv_capture_vals` one sequential pass over the slices.
`check ./src` is clean. **Not yet done:**
1. Rebase onto develop.
2. Build a stage 1 from it and one from its merge-base, with the same builder (`yo`).
3. Run four interleaved `check src/main.yo` pairs on a quiet machine. The wall time
   must be back at or below the pre-#932 level, and the footprint unchanged.
4. Emit `src/main.yo` with both compilers on the same tree and `cmp`: the C
   must be byte-identical.
5. Run the full local battery, then open the PR and merge.

If the time is still over, the next suspect is the per-element slice walk
(`cap_slices_get`, O(#slices)) in the same loops; walk the slices sequentially
(the `fv_capture_vals` shape) instead of indexing.

## 3. Remaining plan items, in suggested order

Numbers are from the holder census of the develop compiler at hand-off: 1,086 MB
retained at `check src/main.yo` exit (the peak is the retained set plus about 150 MB).

### 3.1 The `LEAK` group (~250 MB, pre-existing on develop)

About 2.24 M objects no root reaches but whose refcount stays above what the
unreached set explains:
- `ExprInfo` 76 MB;
- `Variable` 40 MB;
- `Environment` 26 MB;
- `ArrayList(Frame)` 16 MB;
- …

Unreached-root rows: `Pattern` (35 K, one external ref each, held by `Arm`),
`TypeValue` (24 K / 124 K refs), `Environment` (10.6 K), `EvalValue`, and 38
`HashMap(usize, ExprInfo)` held by raw buffers.

- Either an untracked holder retains them, or they are missing releases.
- `S hits-per-unreached-object 0:672 K` says most have NO pointer anywhere, which
  means missing releases.
- Method (§4.2): `alloc_site_census_t.py <C> a.c dump.txt ExprInfo --rc-events` →
  `holder_census_t.py a.c b.c h.txt` → `clang -g` → run with
  `HOLDER_MIN=1000 HOLDER_SCAN=1 HOLDER_COLLECT=1 HS_ONLY_MARKED=1 HS_MIN=999999999999` →
  `rc_event_report.py dump.txt <bin> <fidmap>`.

This is likely the single largest lever left, and it is leak-fixing (no speed
cost).

### 3.2 `ArrayList(u8)` — 216 MB of strings

Exclusive holders:
- `g_type_intern` keys: 35 MB, 24 K keys of 1.4–3.6 KB each;
- `g_token_intern`: 21 MB;
- `g_ifc_memo` keys: 18 MB;
- `g_func_type_registry`: 12 MB;
- `g_specialized_base`: 11 MB;
- `g_stable_occurrence`: 11 MB;
- `g_method_callee_values`: 10 MB.

Designs:
- (a) **`type_intern` keys:** store a 64-bit hash plus the canonical node and verify
  on hit. This needs a structural-equality function exactly as fine as
  `type_intern_key` (never coarser: `src/types/intern.yo`'s header explains the
  2026-07-02 wrong-merge). Do NOT use a probabilistic 128-bit-only key without
  the user's agreement. Measure the CPU cost: interning is on `substitute`'s hot
  path.
- (b) The other memo keys: check whether each key can be a numeric id (fid index,
  type id) instead of a rendered string.

### 3.3 The AST population — `AstExpr` 191 MB (3.1 M nodes) + `ArrayList(AstExpr)` 88 MB + `Token` (149 MB after Phase 3)

This is Phase 4 of the plan ("the specialization population"). Design 1:
- key `ExprInfoTable` by `(spec_id, ExprId)`;
- stop `clone_expr_fresh_ids` per specialization;
- keep fresh ids for synthesized nodes only.

§0.2d measured 1.30 M cloned nodes as its target. It is a large, cross-cutting
change: every id-keyed walk (`_optimize_dup_drop_pairs`, deferred-drop lists)
must be listed first. Prototype on `create_specialized_function_inline`
(`calls/helper.yo`) and measure the `AstExpr` count.

Speed: fewer clones should be faster, but verify.

### 3.4 Token diet (after Phase 3: 76 B × 1.95 M)

`row`/`column`/`character`/`byte_offset` are four `usize` fields; `u32` would save
16 B per token (≈ 31 MB). `module_path` + `input` could be one handle to a shared
source record (−8 B). Every consumer of `tok.row` etc. changes type, so this is a
big but mechanical edit. Weigh it against 3.1–3.3 first.

### 3.5 Plan steps still open (see the plan for full text)

- **Phase 0 step 2** — `scripts/bootstrap/peak_histogram.py`: allocator-boundary
  histogram of live bytes by 16 B size class at each high-water mark, with return
  addresses. It gives the PEAK composition (the census gives exit retention).
- **Phase 1 step 2** — a `YO_DEBUG_WALKS=1` assertion build proving the one-shot
  walk is dead.
- **Phase 1 step 3** — the LSP retains only open documents' walk contexts.
- **Phase 1 step 5** — the registry sweep table: classify the ~288 module-level
  globals {bounded, per-module, per-function, process}, and owner-tag the
  per-function `g_func_*` tables so `mm_invalidate_document` purges them.
  Measure with a long `yo lsp` session.
- **Phase 5b** — `Symbol` (interned identifier strings).
- **Phase 6** — the RC header / `Variable` diet: a 56 B cycle header on
  cycle-capable types. `Variable` is 45 MB for 250 K objects.

## 4. Tools and recipes (all in `scripts/bootstrap/`)

### 4.1 Holder census (exit retention by root and type)

```bash
python3 scripts/bootstrap/holder_census_t.py <stage2>.c holders.c holders_dump.txt
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O1 -I$(brew --prefix openssl@3)/include \
  -o yo_holders holders.c -L$(brew --prefix openssl@3)/lib -lssl -lcrypto -lm
HOLDER_DEEP=1 HOLDER_SCAN=1 ./yo_holders check src/main.yo --std-path ./std
grep '^D ' holders_dump.txt   # D <objects> <bytes> <root> : <type>
```

`HOLDER_DEEP_LAST=<root>` walks one root last, which gives its exclusive share.
The visitors were updated this session for the two-argument `traverse_fn`
visitor (#902).

### 4.2 Finding a missing release: the rc-event log

1. Emit the stage-2 C with `YO_DEBUG_FN_ORIGIN=1` (a debug knob added this session:
   every definition gets `/* yo-origin <module>:<line> <c name> */`).
2. Build the fid map from those comments: for each, the nearest `name ::` at or
   above the line in the source is the Yo name. That takes ten lines of Python;
   see `.github/instructions/debugging.instructions.md` "Naming `yo_id_…`
   frames". (`fid_name_map.py` predates #914's anchored ids and maps nothing.)
3. `alloc_site_census_t.py IN.c a.c dump.txt <Type> --rc-events`, then
   `holder_census_t.py a.c b.c h.txt`, then `clang -g -fno-omit-frame-pointer -O1`,
   then run with `HOLDER_MIN=1000 HOLDER_SCAN=1 HOLDER_COLLECT=1 HS_ONLY_MARKED=1 HS_MIN=999999999999`.
4. `rc_event_report.py dump.txt <bin> <fidmap> 4`. An increment with no matching
   decrement across a window is the leak. Read the emitted C of that function
   next to the source shape.

### 4.3 Stage-2 A/B for layout changes

A codegen change that alters data layout (Phase 3) only shows its memory effect
in a compiler BUILT by the new compiler. Use `fixpoint_only.sh`'s `/tmp/<P>_s2`
from both trees and compare `check src/main.yo` on those.

## 5. Coordination

Peer sessions yo-16 (type-system soundness) and yo-ca (parallelism) merge into
the same files, especially `calls/*.yo`, `env.yo`, `types/*.yo` and `codegen/*`.
Rebase before gating, never merge a docs-only PR while a develop battery you
wait on is pending, and tell them when you touch shared files.
