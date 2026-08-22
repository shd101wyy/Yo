# yo-self memory: the 7.4 M live `Variable`s come from COPYING envs that TS SHARES

**Status: §3 IMPLEMENTED 2026-08-17** on branch `p2/env-sharing`
(commits `9dda2a00a` + `dde0bae5d`): the def-time flatten copy is replaced by
`_share_def_time_frames` — shared `Variable` handles, per-frame FROZEN
membership (see the implementation-critical addendum at the end of §3, and
`issues/env-sharing-live-frame-membership-leak.md`). Measured on the
self-emit: peak footprint 14.55 → 12.21 GB (**−2.34 GB**), wall 678 → 232-283 s
(**~2.4-2.9×**); attribution beforehand confirmed the copy loop minted
2,760,212 of the 7.43 M live Variables and `YO_GC_FULL_PCT=130` moved nothing
(all live data). FIXPOINT_HOLDS with the sharing stage-1; emitted-C multiset
after id-normalization differs from flatten only by (a) one deduplicated
duplicate enum typedef (identity restoration — an improvement) and (b) 35
set_effect machines whose dead-slot arms became correct (the second latent
bug below). The `capture_env_for` second site (§3 end) remains OPEN.

Original 2026-08-05 analysis follows. This supersedes the "find the OTHER holder" open question left
by `plans/archive/YO_SELF_EXPRINFO_PRUNE.md`.

| Compiler      | wall    | peak footprint | instructions retired |
| ------------- | ------- | -------------- | -------------------- |
| TypeScript    | 113.08s | **6.05 GB**    | 2,367,461,951,614    |
| yo-self (r16) | 98.73s  | **9.08 GB**    | 1,630,914,249,562    |

Job for both: `compile yo-self/main.yo --release --emit-c --skip-c-compiler`.
yo-self is already FASTER and retires **31% FEWER instructions** — it is not
computing more, it is _storing_ more. (TS's `user` 131.94s > `real` 113.08s also
shows TS doing work on extra threads, i.e. V8's concurrent GC; yo-self is
strictly single-threaded, `user` 97.07 ≈ `real` 98.73.)

## 1. The answer

`_build_def_time_body_env` (`yo-self/evaluator/calls/function_type.yo:315-370`)
walks **every frame × every variable** of the caller environment and calls
`add_variable_to_env` for each one, constructing a fresh `Variable` + value cell +
name string + synthetic token per binding. **TypeScript constructs ZERO `Variable`s
at the corresponding point.**

TS, `src/evaluator/calls/function-type.ts:298-304`:

```ts
let env = pushEnvFrame(
  isInClosureContext
    ? callerEnv // SHARE the caller env outright
    : isAtModuleLevel
      ? callerEnv // SHARE the caller env outright
      : keepTopLevelFrameAndComptimeVariablesFromEnv(callerEnv)
);
```

And even the third (filtering) branch never allocates a `Variable` —
`src/env.ts:2245-2265`:

```ts
const newFrames = env.frames.map((frame, index) => {
  if (index === 0) return frame; // frame 0 shared as-is
  const newVariables = frame.variables.filter((v) => v.isCompileTimeOnly);
  return { ...frame, variables: newVariables }; // same Variable OBJECTS
});
```

`filter` retains references. A new frame wrapper and a new array, never a new
`Variable`.

yo-self takes its flattening-copy path **unconditionally**, including when
`strip_outer_runtime` is `false` — which is the common case (module level and
closure context, exactly the two branches where TS shares).

Scale: for a module-level fn the caller env holds the shared prelude frame
(1000+ bindings) plus the module frame (~660), so each def-time body eval mints
~1600 `Variable`s. At O(10⁴) def-time body evals that is millions — which is what
the census counts.

The copy is also a standing correctness hazard, and the code says so:

> "TS REUSES the definition env's Variable objects for def-time body eval
> (function-type.ts:499), so every flag survives there. **This flattening copy
> loses fields `add_variable_to_env` can't take**"

`is_module_level` and `is_reassignable` have each been patched back individually
after a bug; any flag added in future is silently wrong until someone notices.
Sharing makes every flag correct by construction and lets those patches go away.

## 2. Why the rejected ExprInfo prune bought exactly 1.13 GB

Reconciled quantitatively, from the census in `YO_SELF_EXPRINFO_PRUNE.md` §1:

```
3.35 M ExprInfo            1527 MB
  env       → 3.33 M Environment      373 MB   ← the prune freed THIS layer
  frames    → 3.32 M ArrayList(Frame) 266 MB   ← and THIS layer
  Frame     → 7.43 M Variable        1664 MB   ← and nothing below it
    value   → 6.33 M ArrayList(EvalValue) 506 MB
    name/…  → large share of 8.00 M ArrayList(u8) 640 MB
```

`3,084,494 × 112 B (Environment) = 345 MB` plus `× 80 B (ArrayList(Frame)) =
247 MB` ≈ 592 MB, plus malloc size-class and header overhead ≈ **the 1.13 GB
measured**. The layer below did not move because those 3.32 M frame-lists point at
only ~157,587 DISTINCT `Frame`s (~84-105 references each): Frame retention is
all-or-nothing per scope, so releasing 91% of the _references_ frees no `Frame`.

**`ExprInfo.env` was never the problem.** The `Variable`s are not garbage being
retained — they are live, legitimately reachable, and should never have been
created.

## 3. The fix

Mirror TS exactly, in `_build_def_time_body_env`:

- `strip_outer_runtime == false` → build the new `Environment` sharing **all**
  caller frames by reference, then push the parameter frame.
  (= TS `pushEnvFrame(callerEnv)`.) `Frame` is `ref(struct(...))` so pushing the
  existing handle is a pointer copy. `push_env_frame` already exists at
  `yo-self/env.yo:2474`.
- `strip_outer_runtime == true` → share frame 0 by reference; for frames 1..n
  build a new `Frame` whose `variables` list holds the **same** `Variable` handles
  filtered to `is_compile_time_only`; then push the parameter frame.
  (= TS `keepTopLevelFrameAndComptimeVariablesFromEnv`.)

Expected: every object removed also removes its **56 B RC header** (§4a), so the
gross is larger than the struct bytes alone:

| removed                           | count  | struct + 56 B header (+ buffer) | gross    |
| --------------------------------- | ------ | ------------------------------- | -------- |
| `Variable`                        | 7.43 M | 192 + 56                        | 1.84 GB  |
| `ArrayList(EvalValue)` value cell | 6.33 M | 80 + 56 + 32                    | 1.06 GB  |
| name `ArrayList(u8)` (share)      | ~4 M   | 80 + 56 + 32                    | ~0.67 GB |

That is the ceiling if EVERY such object traces to this copy, which it does not —
some bindings are legitimate. **Measure the attribution before implementing**:
instrument the `add_variable_to_env` call site at `function_type.yo:339` and count
what fraction of the 7.43 M it produces (`scripts/bootstrap/instrument_calls.py --fn`).
Even 50% realization is ~1.5 GB. It should also _reduce_ wall time (millions of
fewer allocations).

Consistency check that makes this plausible: the census finds only **157,587
distinct `Frame`s** holding 7.43 M `Variable`s — 47 per frame on average. A handful
of thousands of flattened def-time frames at ~660-1600 bindings each would account
for the overwhelming majority of them, with the other ~150,000 ordinary frames
holding almost nothing.

### Concrete shape (primitives all verified present)

`snapshot_env` (`env.yo:1695`) is _exactly_ TS's `pushEnvFrame` minus the pushed
frame — compare them side by side:

```ts // src/env.ts:919-924
return {
  functionDeclarationFrameLevel: env.functionDeclarationFrameLevel,
  frames: [...env.frames, newFrame],
  modulePath: env.modulePath,
  inputString: env.inputString,
};
```

```rust
// yo-self/env.yo:1710-1715 — same four fields, new list, SAME Frame refs
Environment(frames : fr, module_path : env.module_path,
            function_declaration_frame_level : env.function_declaration_frame_level,
            input_string : env.input_string)
```

So the ~55-line copy loop at `function_type.yo:317-370` becomes:

```rust
fresh_env := cond(
  !(strip_outer_runtime) => snapshot_env(caller_env),
  true => _keep_top_level_frame_and_comptime_variables(caller_env)
);
___fr := fresh_env.push_frame(false);
```

with a new helper (defined ABOVE this function — Yo has no forward references)
porting `env.ts:2245-2265`: frame 0 pushed as-is; every other frame replaced by
`new_frame(f.is_begin_block)` whose `variables` receives the **same `Variable`
handles** filtered to `is_compile_time_only`. `Frame` is `ref(struct(...))` and
`new_frame(is_begin_block : bool) -> Frame` exists at `env.yo:372`.

Note yo-self's call sites pass
`strip_outer_runtime = ctx.is_evaluating_function_body_or_async_block.is_some()`
(`function_type.yo:864`, `:1092`), the mirror of TS's `isAtModuleLevel`. yo-self has
no equivalent of TS's _first_ branch (`isInClosureContext ? callerEnv`), so that
distinction should be checked while porting.

### IMPLEMENTATION-CRITICAL (learned the hard way, 2026-08-17): freeze frame membership

The doc's `snapshot_env`-based sketch below is WRONG as written: TS can share
live frames only because its `addVariableToEnv` is PERSISTENT (new frame + new
frames list per add, env.ts:660-688) — captured envs keep point-in-time
membership. yo-self frames append IN PLACE, so pushing live `Frame` handles
lets bindings added AFTER a definition leak into its body env and every
recorded `ExprInfo.env`: std/fs/file.yo's late method `fd` then made codegen's
`_last_is_compile_time_only(env, "fd")` silently DROP the `fd := self._fd`
statements (undeclared-identifier C, fixpoint CLANG_RC=1). Share the Variable
handles but rebuild EVERY frame (frame 0 included) with a fresh variables
list: `_share_def_time_frames`. Regression test:
`tests/late_sibling_method_name_shadow.test.yo`. Full record:
`issues/env-sharing-live-frame-membership-leak.md`. The same rule applies to
any future sharing lever (capture_env_for included).

The id reseed also exposed a second latent bug — `_find_bundle_var_field`
picked the set_effect bundle target by HashMap-iteration first-match where TS
iterates an insertion-ordered Map; 35 of 66 machines in the flatten baseline
were already writing the dead slot. Fixed deterministically (prefer aliased,
tie-break numerically-smallest id) in `dde0bae5d`.

### Two risks specific to this change

1. **`__recur_fn` becomes visible.** The copy loop skips it explicitly
   (`!(cv.name == "__recur_fn")`), and grepping `src/` shows TS has **no
   `__recur_fn` at all** — it is a yo-self-only mechanism. Sharing frames makes it
   reachable from the body env for the first time. Check whether any lookup or the
   flow-soundness pass now finds it where it previously could not.
2. **`pf_level` gets deeper.** `t_some_t(pn, pf_level)` stamps the param frame's
   level onto minted `SomeT`s. Flattening made that level ~1; sharing makes it the
   true stack depth (which is what TS uses). If the level participates in `SomeT`
   identity or comparison, emitted output can shift — the corpus diff-test and the
   emitted-C byte-identity check are the gates that would catch it.

Note this likely makes the `sig_some_ts` stamping in the same function redundant:
that machinery exists only because a _fresh_ env lost the signature's `SomeT`
identity. Sharing restores the identity TS has, which is what the comment at
`function_type.yo:287` says TS gets for free. Verify, then delete.

### Second site (same class) — MEASURED AND REFUTED 2026-08-17

The remedy sketched below (memoize/share the `capture_env_for` rebuild) was
built twice and refuted twice; **do not retry memo variants here**:

- The rebuild population: 242,154 rebuilds minting 144,492,981 Variables per
  self-emit (~597/rebuild), 99% from DERIVED FuncVal creation
  (specialization, impl shells, ctl-inline) — not `evaluate_anonymous_function`.
- By-source memo (registered at the anon-fn creation site): 37 hits.
- Content-fingerprint memo (`len:first:last:module` + full element-wise
  validation, VarRef-by-name): 587 hits (0.24%) — the lists are genuinely
  content-unique (specializations bind different concrete types; ctl mints a
  fresh `create_type_value(...)` wrapper per creation) — and the unbounded
  table ADDED 2.1 GB retention.
- The only lever left for this site is the TS-shape live share
  (`functionValue.env`: frozen-membership frames of live Variables, replacing
  flat lists + VarRef) — a SEMANTICS change (dup-accounting risk on runtime
  captures) needing its own campaign.

Related same-day results: the self-emit "perf drift" was attributed (NOT a
compiler regression — today's compiler is 1.6-1.7× faster than r16's; the
tree got 2.7× heavier), the full `check` closure peaks at 1.89 GB vs the
12.2 GB emit (**~85% of footprint is EMISSION-PHASE specialization
structures** — the next census target, along with the 56 B RC-header shrink),
and a libc-vs-mimalloc A/B on macOS showed identical footprint (the r15
"mimalloc fatter" note does not reproduce post-sharing). Records:
`issues/retired/yo-self-emit-perf-drift-since-r16.md`.

#### Original sketch (superseded)

**Second site (same class)**

`capture_env_for` (`yo-self/env.yo` ~1785) rebuilds the entire flattened lexical
scope per `FuncVal`, ~660 bindings per build with no TS counterpart. The capture-env
MEMO already landed but cannot hit across `FuncVal` creations because `func_id` is
minted fresh per `FuncVal`. Same remedy: share frames instead of rebinding.

## 4a. The verified census, and why the RC header is the other half of the gap

Measured, not estimated — `/tmp/re/live_counts.txt` joined with `/tmp/re/live_map.txt`
(+1 per `__yo_new_*`, −1 per `___dispose`, `scripts/bootstrap/live_census.py:36-58`):

```
TOTAL LIVE RC OBJECTS = 52,776,480
RC HEADER ALONE       = 2.96 GB      (the GC-only 48 B of it = 2.53 GB)
```

against a **3.03 GB** gap. Top types:

| type                                               | live count  | header cost |
| -------------------------------------------------- | ----------- | ----------- |
| `ArrayList(u8)` (strings)                          | 8,003,726   | 0.45 GB     |
| `Variable`                                         | 7,427,895   | 0.42 GB     |
| `ArrayList(EvalValue)` (value cells)               | 6,329,326   | 0.35 GB     |
| `AstExpr`                                          | 4,876,676   | 0.27 GB     |
| `ArrayList(usize)` (frame-index position lists)    | 4,325,244   | 0.24 GB     |
| `ExprInfo`                                         | 3,354,693   | 0.19 GB     |
| `Environment`                                      | 3,334,266   | 0.19 GB     |
| `ArrayList(Frame)`                                 | 3,320,767   | 0.19 GB     |
| `Token`                                            | 2,238,681   | 0.13 GB     |
| `ExprInfoRare`                                     | 1,740,679   | 0.10 GB     |
| `ArrayList(ArrayList(String))` (`path_collection`) | 1,566,938   | 0.09 GB     |
| **`Frame`**                                        | **157,587** | —           |

The two levers are COMPLEMENTARY, not competing: §3 removes objects (and each
removed object takes its header with it), while §4's header work makes the
remaining ~50 M cheaper. Do §3 first — it is required by the port rules anyway,
it lowers wall time, and it does not touch the GC.

### The one experiment to run before trusting the 52.8 M multiplier

The census counts uncollected cyclic garbage as LIVE (it only decrements in
`___dispose`), and the full collector lets the tracked set reach **2× live** before
scanning (`__yo_gc_full_pct` = 200, `src/codegen/functions/generation.ts:2087`,
auto-fired from inside `__yo_gc_register` at :2347-2352). So up to half of the
52.8 M could be garbage, which would deflate every per-object estimate here.

One run of an ALREADY-BUILT binary settles it, needs no rebuild, cannot change the
emitted C or the fixpoint, and uses LESS RAM than a normal run:

```bash
/usr/bin/time -l env YO_GC_FULL_PCT=130 /tmp/re/s1r16 compile yo-self/main.yo \
    --release --emit-c --skip-c-compiler -o /tmp/re/gcpct.c &> /tmp/re/gcpct.log
grep -E 'peak memory footprint|real' /tmp/re/gcpct.log
```

`YO_GC_FULL_PCT` is honoured only if > 100 (`generation.ts:2286-2291`). Baseline
9.08 GB / 98.7 s.

- Peak drops > ~0.5 GB → a real share of the census is uncollected garbage; the
  per-object multipliers here are inflated proportionally, and lowering the default
  becomes a nearly free win (in BOTH emitters: `generation.ts:2087` and
  `yo-self/codegen/.../gc_runtime.yo:322`).
- Peak flat (within ~100 MB) → the 52.8 M are genuinely reachable and the 2.53 GB
  of GC-only header is confirmed as ~83% of the gap.

Do NOT test a LARGER `FULL_PCT` — that raises the tracked-set ceiling and risks OOM
on a 16 GB machine.

## 3b. Post-allocator profile (2026-08-22) — the next time levers, ranked

After the macOS system-allocator flip
(issues/fixed/macos-yo-build-still-mimalloc-despite-settled-decision.md,
`check ./src` 225.6 → 95.3 s), fresh `sample` profiles of the worker thread
show memory management is STILL ~40% of remaining CPU:

- **`__yo_decr_rc` ≈ 16% self time** — the single biggest named cost, stable
  across early/late phases. Lever: inline the non-final fast path
  (decrement + branch) at the drop site in emitted C and call the runtime
  only on hitting zero / GC bookkeeping. Campaign-sized (touches every drop
  in the emitted C; fixpoint + UAF-history gates apply).
- **libsystem malloc/free ≈ 16% + memset/memmove/memcmp ≈ 7%** — allocation
  VOLUME. Levers, in order: the open `capture_env_for` share (§3 second
  site), the String-identity plumbing below, then §4's RC-header diet
  (fewer bytes per object also cuts memset).
- **String-keyed identity long tail**: the hottest named Yo functions are
  enum-id string transforms, `String.split(separator)`, visited-`HashSet(String)`
  probes, and is-call-named string compares — type/enum ids are heap Strings
  split and re-hashed per lookup. An interned-id (u64 handle) representation
  for type/enum ids is a real lever but a broad refactor; cheaper first bite:
  stop re-splitting/cloning in the hottest paths.
- Cycle collector: measured only ~4% of `check` wall (`YO_GC_THRESHOLD=0`
  A/B) — NOT the cost it was assumed to be; do not prioritise collector
  pacing for batch compiles.

## 4. Other levers found in the same sweep (independent of the above)

| Lever                                              | Saving               | Risk | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | -------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RC header 56 → 24 B                                | ~1.6 GB              | HIGH | `__yo_ref_header_t` (verified in emitted C, `r16_emit.c:281`) carries `gc_next/gc_prev/roots_next/roots_prev` + `dispose_fn/traverse_fn`. Replace the 2 fn pointers with a `type_id` + static switch, and the intrusive roots list with an array. The header's own comment records a prior 64→56 B win as "~8 B/object ⇒ ~0.4 GB at self-compile scale", implying **~50 M live RC objects** — the multiplier for every per-object win. NOTE the first word is FULLY packed (`u32 + u8 + u8 + u16` = 8 B), so a `type_id` must steal bits from `borrow_count`/flags. Must land in BOTH `src/codegen` and `yo-self/codegen` to preserve the fixpoint; the GC header has a UAF history here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Option(T)` niche for ref-semantics `T`            | ~0.5 GB              | MED  | The nullable-pointer niche optimization exists in both compilers but is gated to raw `*(T)`. `ExprInfo` alone: 456 → 312 B.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ~~`Frame.where_clause_constraints` eager HashMap~~ | ~78 MB, not ~1.15 GB | —    | **CORRECTED DOWN.** One analyst costed this at ~496 B per frame and attributed ~1.15 GB to it, assuming millions of frames. The census shows only **157,587** live `Frame`s, so the true ceiling is 157,587 × 496 B ≈ 78 MB. Real, but an order of magnitude smaller than claimed — do not prioritise it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ExprInfo.popped_env_frame`                        | 54 MB                | NONE | **Dead in BOTH compilers.** yo-self declares it (`expr_info.yo:427`, inline in `ExprInfo`) and initialises it, but the write was removed (`evaluator/exprs/begin.yo:2253`) and nothing reads it. TS declares it (`src/expr.ts:395`) and writes it (`begin.ts:2258`) but never reads it either. Remove from both.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `g_frame_indexes` diet                             | **~1.4 GB**          | MED  | **VERIFIED from the census, and its own doc comment is WRONG.** `env.yo:395-397` claims the table "stays tiny (the shared prelude frame + module frames — dozens, not millions)". Actual: `FrameNameIndex` = **6,113** live, holding **4,325,244** one-element `ArrayList(usize)` position lists = **708 per index**. Cost: 4.33 M × (80 struct + 56 header + 32 buffer) = **0.73 GB**, plus exactly one key-clone String each (`env.yo:428` does `entry.positions.set(v.name.clone(), np)`), which accounts for 4.33 M of the 8.00 M live `ArrayList(u8)` ≈ **0.66 GB**. Context: `env.yo:353` already calls this a "yo-self divergence from TS's linear scan", and `src/env.ts:767-781` records that **TS deliberately DELETED its equivalent** because "the per-frame `Map<string, Variable[]>` value allocations accumulated across all frames kept alive by every module's ExprInfo table … peak heap exceeded 8 GB (vs. ~3 GB on develop)". Fix WITHOUT losing the wall-time win: (a) single-position fast path so the common one-name-one-slot case needs no `ArrayList(usize)`, and (b) stop cloning the key — `HashMap.set` stores the key by handle and the index is evicted with its frame, so the clone looks unnecessary (verify). Deleting the index outright would restore TS parity but risks the lookup regression it was added to fix. |

> **Update 2026-08-07:** the 2048-entry size bound on `g_frame_indexes`
> LANDED (with the shrink-site `invalidate_frame_index` that makes the
> wholesale clear sound — `issues/fixed/yo-self-frame-index-bound-breaks-fixpoint.md`),
> which caps the accumulation this row measures. The per-entry diet ideas
> (single-position fast path, no key clone) remain valid further levers.

## 5. Gates (mandatory before landing any of this)

1. `S1=<bin> P=<tag> bash scripts/bootstrap/gates_fast.sh` — repros, 20-file
   battery with hollow detection, corpus diff-test 155, `check ./std` 153. Exits
   non-zero on any failure.
2. `scripts/bootstrap/fixpoint_only.sh` — stage-2 ≡ stage-3 byte-identical.
3. Peak-footprint measurement; **the emitted C must be byte-identical to the
   baseline.** A change that lowers footprint but alters the output is a
   miscompile, which is exactly how the rejected prune was caught.

Measure peak footprint, never RSS: on a 16 GB machine RSS is clamped (runs
spanning 7.9-11.5 GB of footprint all reported 8.17-8.51 GB RSS). "GB" throughout
this file is decimal (1e9), matching the rest of the ledger.
