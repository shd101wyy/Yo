# yo-self compiles itself 5× slower than the TS compiler — 91% of CPU is RC churn + String equality

**Status: DIAGNOSED 2026-07-23 (profile-verified). Not yet fixed.**

## Symptom

Compiling `yo-self/main.yo` (the stage2/stage3 emit): the TS compiler (bun,
JIT, GC) takes ~10 min; the self-hosted s1 — a clang `-O2` NATIVE binary —
takes ~55 min for the same job. Both single-threaded. A native binary losing
5× to interpreted TS means the port is doing categorically more work per
operation, not that "Yo is slow."

## Profile (macOS `sample`, 15 s of the stage2 emit's evaluation phase)

Worker thread, 12,202 samples, top of stack:

| Frames                                    | Samples | Share   |
| ----------------------------------------- | ------- | ------- |
| `__yo_decr_rc`                            | 7,030   | **58%** |
| `String ==` (`fn_..._id_281__u61__u61_`)  | 3,285   | **27%** |
| `evaluate_identifier_and_operator` (self) | 828     | 7%      |
| malloc/free/memmove/printf etc.           | ~600    | 5%      |

(The 12,202 `__ulock_wait` line is the parked MAIN thread in `pthread_join`
on the worker — harmless.)

**91% of all CPU time is refcount decrements, string equality, and identifier
lookup.** The call-graph spine funnels through
`evaluate_function_call → try_to_call_function_with_arguments →
check_if_function_parameter_matches_argument → … →
evaluate_identifier_and_operator`, i.e. the per-call parameter-matching
machinery evaluating identifiers. `__yo_decr_rc` leaves hang under BOTH
`evaluate_identifier_and_operator` and under `String ==` itself — every
string comparison drops owned operand copies.

Raw profiles: `/tmp/s1_profile_early.txt` (~1 min in) and
`/tmp/s1_profile_late.txt` (~35 min in). Both show the SAME shape (late:
`__yo_decr_rc` 65%, `String ==` 23%, identifier lookup 6%,
`_platform_memcmp` 2.6%) — the diagnosis holds across the entire emit, so
the levers below apply to the whole 55 minutes, not just the early phase.

## Why the TS compiler doesn't pay this

The algorithms are the same (the port is 1:1) — the PER-OPERATION cost is
not:

- **Identity is object identity in TS.** Types, functions, and variables
  compare by pointer; yo-self renders and compares STRING ids
  (`yo_id_5000_rtparam0_gs_...`, `type_key` strings reaching 100s of KB for
  recursive types) and does `String ==` per env-frame entry during lookup.
  JS string equality also has an interned/pointer fast path; Yo's `String ==`
  is a call + length check + memcmp + RC traffic on the operands.
- **No refcounting in TS.** Every Variable/TypeValue/handle copy in yo-self
  is an `__yo_incr_rc`/`__yo_decr_rc` pair; bun's GC defers and batches all
  of that. At 58% of samples, RC is not overhead — it IS the program.
- **Env lookup**: linear frame scans with string-compared names in both
  compilers, but each step costs ~10-50× more in yo-self for the reasons
  above.

## Levers, in expected-impact order

1. **Elide RC churn on borrowed reads (codegen/optimizer).** The biggest
   single win: `String ==`'s operands and env-lookup reads are BORROWS — the
   dup-before/drop-after pairs the emitter inserts around them are
   semantically unnecessary. The dup/drop pair optimizer
   (`_optimize_dup_drop_pairs`) already exists for begin-blocks; extending
   borrow-elision to call arguments of pure/borrowing builtins (String `==`,
   `.len()`, hash) attacks the 58% directly.
2. **String `==` fast paths.** Check `len` first (cheap reject), then
   POINTER equality of the byte buffers (interned/shared backing → true
   without memcmp). Small, local, safe.
3. **Name/id interning.** Intern variable names and func/struct id strings
   into a global pool so identity compares are pointer compares. This is the
   structural fix that mirrors TS object identity — but it is invasive
   (touches env, function_value, expr_info registries).
4. **Hash the env frames** (name → slot index per frame) instead of linear
   scans — turns the 7% self + its share of the string compares into O(1).
5. **Registry scans**: `g_comptime_fn_caches` (per-fid bucket list, linear
   `_ctfe_args_equal` per entry), `g_struct_finals`, `g_stable_to_key`
   (HashMap keyed by full `type_key` strings — hashing cost proportional to
   key length; key by the interned short C name instead).

## Guardrails

Any of these changes goes through the FULL gate battery + STRICT_FIXPOINT —
they touch the exact machinery (identity, RC) the Gap-6 campaign is
stabilizing. Do them AFTER the campaign lands, one lever per commit. The
prize is real: cutting the emit from 55 → ~15 min would cut every future
gate chain from ~2.5 h to ~1 h.

## Fresh profile 2026-07-25 (live stage3 emit, r3_s2, 10s sample)

Worker thread top-of-stack (~8000 samples): `__yo_decr_rc` 4772 (~60%),
`yo_id_4050` = String `==` 1612 (~20%), `yo_id_279014` =
evaluate_identifier_and_operator 991 (~12%), `_tlv_get_addr` 472 (~6%).
Full file: /tmp/r3_stage3_profile.txt. Notes vs the 07-23 profile:

- The env-frame lazy name index (env.yo `g_frame_indexes`, frames >= 64
  vars) ALREADY EXISTS and is included in this baseline — the remaining
  identifier-lookup cost is small-frame linear scans + the String
  traffic they drive.
- `_tlv_get_addr` at 6% says something in the hot path goes through
  thread-local storage — check whether `__yo_decr_rc` is an
  OUT-OF-LINE runtime call (not static inline) and/or uses TLS; making
  the incr/decr fast path `static inline` in the C runtime template is
  a mechanical, behavior-identical change (must be applied to BOTH the
  TS and yo-self copies of the template to keep corpus DIFF 0 and the
  fixpoint).

## Working order for task #10 (one lever per commit, full gates each)

1. String `==` fast path (std/string/string.yo): pointer-equality
   shortcut on shared byte buffers (pass-by-value String copies share
   the ArrayList handle) + fewer owned temporaries in the body (each
   `match(self._bytes, ...)` costs Option/handle RC pairs).
2. RC-op COUNT reduction — the real 60% lever. `__yo_decr_rc` is
   ALREADY `static inline` with an untracked-object fast path that
   avoids TLS (a prior round; see the comment in the runtime template).
   The remaining cost is the NUMBER of calls on TRACKED (cyclic-capable)
   evaluator objects (TypeValue/AstExpr/Environment), each paying the
   `__yo_gc_collecting` TLS read — hence \_tlv_get_addr's 6%. Attack
   via borrow elision on call arguments of pure/borrowing callees
   (lever 1 of the original list; paired TS src/codegen +
   yo-self/codegen change), NOT via runtime-template tweaks.
3. Registry keys: `g_stable_to_key` & friends are HashMaps keyed by
   FULL type_key strings (100s of KB for recursive types — hashing is
   O(key length) per lookup); key by interned short ids instead.
4. Identifier lookup: lower the frame-index threshold / measure
   small-frame scan share.
