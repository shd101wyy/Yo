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

## Negative result 2026-07-25: String `==` pointer fast path — NO WIN

Tried: `(self_ptr &== other_ptr) ||` before the memcmp (std/string/
string.yo Eq impl). Measured on `check ./std` back-to-back under equal
load: baseline r3_s1 user 79.57s vs patched p1_s1 user 79.84s —
identical. REVERTED (behavior probes all green, but a no-benefit change
is not worth a gate cycle).

Why it can't help: the hot `String ==` calls are REJECTS on different
strings (env-lookup name compares) — the len check + first-byte memcmp
already reject cheaply. The 20-27% profile share is the PER-CALL
OVERHEAD: each `==` performs ~6-10 nested operations (two
`match(_bytes)` Option unwraps, `.len()` / `.ptr()` METHOD calls, each
with RC dup/drop pairs on the Option/ArrayList handles emitted by
codegen). The Yo-source body is already minimal — the cost is the RC
codegen around field reads and method receivers.

CONCLUSION: there is no cheap std-level lever. The perf work IS the
codegen borrow-elision arc (lever 1): teach the emitter (BOTH
src/codegen TS and yo-self/codegen, in lockstep for corpus DIFF 0 +
fixpoint) to pass borrowed reads to pure/borrowing callees without
dup/drop pairs — String `==`/len/hash arguments, match scrutinee field
reads, env-lookup Variable handle reads. That attacks the 60% decr_rc
AND the 20% String== simultaneously (they are the same traffic). Plan
it as its own multi-round arc with the full gate battery per round;
start from `_optimize_dup_drop_pairs`' existing begin-block machinery
(evaluator/exprs/begin.yo) and TS's equivalent.

## 2026-07-25 — MEASURED: exact attribution, and the fix

Prior rounds reasoned about the profile symbol-by-symbol. This round
measured the _dynamic_ traffic and attributed it to call sites, which
overturned two working assumptions.

### Method (cheap loop — reuse this)

The self-compile's clang step is only ~46 s; the ~55 min is entirely
evaluator/codegen runtime. So RUNTIME-level hypotheses do NOT need a
10-min s1 rebuild: patch the already-emitted `.c` and re-clang.

- `scratchpad/patch_decr_rc.py` — split decr_rc fast/slow path
- `scratchpad/patch_rc_counters.py` — dynamic RC counters at exit
- `scratchpad/patch_rc_attrib.py` — sampled `__builtin_return_address`
  attribution of decr_rc to CALL SITES (symbolize via `nm -n` + slide)
- `scratchpad/perf_ab.sh A B [reps]` — alternating A/B over `check ./std`

### Dynamic traffic, one `check ./std` (86 s)

    decr_rc  10,817,756,475   (fast/untracked 87.1%, frees 15.2%)
    incr_rc   9,207,372,734

~20 BILLION RC ops to type-check 153 files.

### Call-site attribution (top of 10.8e9 decrements)

| share | est. calls | site                                        |
| ----- | ---------- | ------------------------------------------- |
| 33.2% | 3.59e9     | `String ==` (4 sites)                       |
| 17.5% | 1.89e9     | `ast_expr_is_fn_call_of`                    |
| 9.6%  | 1.04e9     | `ast_expr_is_atom_of`                       |
| 13.9% | 1.50e9     | `_attach_early_return_only_drop_to_returns` |

### Negative result: inlining decr_rc is NOT the lever

`always_inline` fast path + outlined slow path: **-4.7%** only
(86.21 -> 82.15 s min user, 3 reps) for **+140% binary** (4.8 -> 11.6 MB).
So per-call overhead is minor; the cost is the header load itself and,
above all, the NUMBER of ops. Not landed on its own merits.

### ROOT CAUSE (the real one)

`match.ts:238` evaluated an _atom_ scrutinee directly but wrapped every
other scrutinee in an implicit `begin()` — which materializes an OWNING
TEMP: a `___dup` before the switch and a `___drop` after it. A field
read (`self._bytes`, `e.token`) is a **place**, not a temporary: it is
already owned by the enclosing scope for the whole match, and the arms
only borrow it. The three hottest functions above all match on a field,
so ~60% of all decr_rc traffic was this one redundant pair.

Note the corpus diff-test judges **run behavior, not C text**
(`scripts/diff-test.sh` header), so TS and yo-self may legitimately
differ in emitted C; the binding constraints are behavior parity,
test counts, and STRICT_FIXPOINT.

### Fix

Widen the predicate from "atom" to "place" — a bare field-access chain
(2-arg `.` call) rooted at a **runtime** variable. Routing places
through the exact same path as atoms means every downstream ownership
decision (binding registration, escape dup) is the already-proven atom
behavior, rather than a new elision rule.

The root must be a runtime variable: `Kind.Func` (an enum variant) is
also a 2-arg dot but has no `variableName` to bind — that regression
showed up immediately in `rc.test.yo` and is what the
`!isCompileTimeOnly` check excludes.

Effect on emitted C: `String ==` 4 dups + 4 drops -> **0**.

## 2026-07-25 — post-round-2 EMIT profile (the phase that matters)

`check ./std` is evaluator-only. Sampling a live stage3 emit (`sample
<pid> 20`) gives the CODEGEN-phase profile, which is different:

| symbol                     | samples | share |
| -------------------------- | ------- | ----- |
| `__yo_decr_rc`             | 7354    | 43%   |
| `yo_id_4050` (`String ==`) | 6414    | 38%   |
| `_platform_memcmp` + stub  | 1519    | 9%    |
| `_tlv_get_addr`            | 419     | 2%    |

`String ==` is now SOURCE-OPTIMAL — the match-place elision removed all
four `___dup`s, and the emitted body is a clean switch + length check +
memcmp (verified in /tmp/r2_stage2.c). It is 38% purely from CALL
VOLUME, and each call still makes four non-inlined accessor calls
(`ArrayList.len()` x2, `.ptr()` x2) before the memcmp.

So the two remaining structural levers are:

1. **Inline trivial accessors in codegen.** `yo_id_3053...(b)` is
   `ArrayList.len()` — a real call to read a field. Every `String ==`
   pays four of them. TS gets this free (property access).
2. **Intern identifiers / type keys.** yo-self compares names, fids and
   type keys as byte strings; TS compares JS strings the engine already
   interned, so `===` is a pointer compare. This is the big one and the
   reason `String ==` can be ~40% of an emit at all.

Emit progression (same machine, gate-chain measurements):

    original baseline   ~55-65 min
    round 1 (920c2876d + a92e7c9a5)   stage2 46.8 min / stage3 37.9 min
    round 2 (codegen String.from)     stage2 35.9 min

Round-2 note: stage3 < stage2 in round 1 (37.9 vs 46.8) because s2 is
built from yo-self's OWN elided emit — the port pays for itself.

## UNSOUND idea — do NOT prune the early-return drop walk on `controlFlow`

`_attach_early_return_only_drop_to_returns` (13.9% of decr traffic) walks
the whole begin-block subtree once per early-return variable, and it only
ever acts on `return`/`unwind` nodes — so pruning subtrees that contain
neither looks free. It is not: **`Expr.$.controlFlow` is NOT a subtree
summary.** `begin.ts:2251` sets a begin block's flow from
`lastExpr.$.controlFlow` alone (tail-position semantics), so

    { if(x, { return(1); }); foo(); }

carries NO return flag — the flow comes from `foo()`. Pruning on it would
skip a needed drop attachment, i.e. a LEAK: silent, no crash, and easy
for the battery to miss.

Sound alternative — hoist the walk instead of pruning it. Today it is
O(V x subtree). Walk ONCE collecting `{node, cleanupPoint}` pairs at
every `return`/`unwind`, then loop the V variables over that list:
O(subtree + V x returns), with provably identical attachment decisions
(the predicate is per-(variable, cleanupPoint) and order-independent).
Collect the NODE too, not just the token — `attachIfCleanupPointNeedsDrop`
reads `expr.$.env` of the visited node.

Profile note: the emit `sample` shows this function deeply RECURSIVE but
with small self-time; its cost is the decr_rc traffic it generates, not
its own instructions.

## Negative result 2026-07-25: frame-index threshold 64 -> 16 — SLOWER

`_frame_positions` (yo-self/env.yo) linear-scans a frame's variables
(each a `String ==`) when the frame has < 64 bindings, else uses the
`g_frame_indexes` side table. Since identifier lookup is what drives the
`String ==` volume (`evaluate_identifier_and_operator` is a top caller in
the emit profile), indexing smaller frames looked promising.

Measured (`check ./std`, 3 alternating reps): 29.71 s -> 30.08 s min
user, **+1.2% SLOWER**. REVERTED.

Why: building an index for a small frame costs a name hash plus a global
HashMap lookup keyed by `frame.index_key` (itself a String hash+compare)
— more than scanning a handful of names. The threshold is not the lever;
INTERNING is (make the compare an id compare everywhere, which removes
both the scan cost and the hashing).

## 2026-07-27 — lever 1 (String== accessor inlining) measured: ~-2%, NOT the lever

Direct `_length`/`_ptr` field reads replacing the four `.len()`/`.ptr()`
accessor calls in `std/string/string.yo`'s `==` (and the same semantics
note added there). Measured:

- `check ./std` A/B (3 alternating reps): **-2.0%** min user.
- Full stage2 emit, quiet machine: **42.0 min** vs pat2's 42.8 min
  (same-day code + concurrent sweep load) — noise-level.

Landed anyway (strictly positive, zero measured risk: corpus 141/0,
battery at baseline, std 153/153, stage2 real hollow=1) but the "four
non-inlined accessor calls" premise was wrong at -O2 — clang was already
inlining them. NOTE the moving baseline: the 2026-07-25 round-2 stage2
was 35.9 min; the three 2026-07-27 batches (labeled-arg validation,
partial application, degrades — all per-call evaluator work) grew a
quiet-machine emit to ~42 min. Perf and correctness are trading against
each other right now.

Remaining levers, unchanged priority: **interning identifiers / fids /
type keys** (String== is ~38% of the emit purely from call volume — id
compares remove both the compare and the frame-scan hashing), then the
sound O(subtree + V×returns) hoist of
`_attach_early_return_only_drop_to_returns`.
