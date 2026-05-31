# Generic-Method-Resolution Knot — Rework Plan

> **Scope.** The single root cause behind **132 / 133** failing Phase-3
> evaluator files (`check ./yo-self`): a method on a generic-type
> instantiation (`HashMap(String, X).new()`, etc.) resolves to `unit`. This
> doc scopes the dedicated rework after ~12 incremental attempts charted the
> dead ends. See `BOOTSTRAPPING_EVALUATOR.md` Phase 3 / Stage 1–4 for the
> full attempt log.

## What is solid (committed foundation)

- **Memoization** (`663fca9f`): the live FuncVal-callee path delegates
  type-returning calls to `evaluate_comptime_fn_call` (+ `ctx.comptime_fn_caches`).
- **`constructor_func_id`** on `TypeValue.Struct` (`0d4e951f`) =
  TS `StructType.functionValue.funcId`; set at the comptime-call site,
  preserved through `substitute()`, compared in `synthesizer.yo`.
- **`result_is_comptime_only`** on `TypeValue.Func` (`755d54f9`) =
  TS `FunctionParameter.isCompileTimeOnly` on the return; gates delegation.
- **PROVEN** (Stage 3 probes): with the concrete stamped, the synthesizer
  **does** unify the impl pattern `HashMap(K,V)` against the concrete
  `HashMap(String,X)` (`same=T`). The matching mechanism works.

## The two coupled sub-problems

**P1 — the annotation/inline-path concrete is unstamped.** In a
type-annotation position (`(g : HashMap(String,X)) = …`) the callee resolves
to a _specialized struct-return_ Func whose `result_is_comptime_only` is
false, so it takes the non-memoized inline path → the concrete gets a fresh
id and no `constructor_func_id` → synthesize can't unify it. Stage 3 fixed
this by stamping at `struct.yo` from the enclosing known-type-constructor →
`same=T`. **But that re-introduced P2.**

**P2 — recursive same-constructor synthesis doesn't terminate.** Once
same-constructor field-recursion is enabled, `imm_vec`/`imm_threading`/
`priority_queue` SIGBUS. TS terminates via Type-OBJECT identity
(`checkedTypePairs` uses `===`); yo-self's guard keys on string ids
(`synthesis_type_id`), which only catches a cycle when the same id recurs.

## DIAGNOSED (BEGIN step 1, done): the SIGBUS is infinite inline-path instantiation

Re-ran the Stage-3 binary (`/tmp/yo-self-dbg4`: `constructor_func_id`
stamping active + `[GATE]`/`[SC]` probes) on `imm_vec`. Findings:

- **Only 94 `[SC]` lines, no explosion** → the crash is NOT same-constructor
  Struct field-recursion. The "recursive `Vec` node" assumption was WRONG
  (`Vec` is the flat `object(_ptr,_len,_cap)`).
- **The crash boundary is a flood of `[GATE] ArrayList itht=F crc=F`** — the
  same `ArrayList` instantiation taken through the **non-memoized inline
  path** over and over. So the SIGBUS is **infinite inline-path `ArrayList`
  re-instantiation**: an un-memoized `ArrayList(...)` call re-evaluates its
  body / specialization, which re-instantiates `ArrayList(...)`, each call a
  fresh un-cached evaluation → unbounded recursion → stack overflow. (The
  same=T synthesize match merely _triggers_ the path; the loop is in the
  FuncVal-call instantiation, not in synthesize.)

This **confirms mechanism 1** (memoize every instantiation) is the fix: if
the inline-path `ArrayList(X)` call hit the comptime cache instead of
re-evaluating, the re-instantiation would return the cached type and the loop
would break.

### Refined open question (BEGIN step 2)

**Stage 4a already tried routing `itht=F crc=F` calls through
`evaluate_comptime_fn_call` via the known-tc gate, and STILL SIGBUS'd.** So
routing alone didn't break the loop. Why? Two candidates to instrument next:

1. **The known-tc gate didn't fire for these `ArrayList` calls** — was
   `ArrayList`'s func_id marked known-tc _before_ these calls? (Order: the
   mark happens when a Type-returning `ArrayList` call is cached; if the
   looping calls precede any Type-returning one, they're unmarked.)
2. **It routed but the `(func_id, args)` cache missed** — the looping
   `ArrayList(X)` calls have args that `_ctfe_args_equal` treats as unequal
   (e.g. a `SomeT` arg with a fresh id each time, or a `type_contains_some_type`
   exact-match that never matches), so each "memoized" call is a cache MISS →
   re-evaluates → loops anyway. **This is the likely culprit** and the thing
   to verify: instrument `evaluate_comptime_fn_call` to log cache hit/miss +
   the arg signature for `ArrayList` calls under Stage 4a.

## Approach (after the diagnostic confirms the recursion)

The faithful goal: make yo-self's string-id cycle guard behave like TS's
object-identity guard. Candidate mechanisms (choose by what the diagnostic
shows):

1. **Memoize ALL type-constructor instantiations** (outer + nested), so every
   `Foo(i32)` is one stable-id `TypeValue`; then the existing id-keyed
   `_has_type_pair` guard catches cycles exactly as TS's `===` does. Requires
   routing the inline/annotation path AND nested-node calls through
   `evaluate_comptime_fn_call`, AND verifying the `(func_id, args)` cache
   actually DEDUPs them (Stage 4a routed but still SIGBUS → the dedup likely
   failed; the diagnostic must show why — cache-miss on arg comparison?).
2. **Guard the cycle on `constructor_func_id` pairs** when same-constructor
   (stable across instantiations), not raw ids — but must avoid false-merging
   distinct instantiations within one synthesis (e.g. `Pair(Vec(i32),
Vec(str))`); key on `(cfid, arg-signature)` to disambiguate.
3. **Bound recursion** — REJECTED: a `checked.len()` bound backfired
   (SIGSEGV incl. prelude; normal same-constructor synthesis visits many
   pairs and throwing deep crashes).

## Validation (mandatory each step)

- Build `/tmp/yo-self-bin`; **baseline-vs-fix per-file diff** harness
  (`$? $file` per file, `join`) over `./std`, `./tests`, `./yo-self`
  (eval-only). Aggregate counts have hidden 0-improved/regressed results
  repeatedly — always per-file.
- Regressor watch: `imm_vec`, `imm_threading`, `priority_queue` must NOT
  SIGBUS; `std` must stay 151/151.
- Target: `.new()` resolves (the `type_trait_methods.yo` error moves past
  `Given: unit`) AND a real batch of the 132 flips, with zero regressions.

## BEGIN — progress

- **Step 1 (DONE):** diagnosed the SIGBUS via `/tmp/yo-self-dbg4` → it is
  **infinite inline-path `ArrayList` re-instantiation**, not synthesize
  recursion (see "DIAGNOSED" above). Mechanism 1 (memoize every
  instantiation) confirmed as the fix direction.
- **Step 2 (NEXT):** re-apply Stage 4a's known-tc delegation routing +
  instrument `evaluate_comptime_fn_call` to log, for `ArrayList` calls,
  **cache HIT vs MISS** and the arg signature. Goal: confirm whether the
  loop persists because (a) the gate doesn't fire (func_id unmarked at that
  point) or (b) the `(func_id,args)` cache MISSES (likely: `_ctfe_args_equal`
  treats the args as unequal each call — a `SomeT`/`type_contains_some_type`
  exact-match never matching). The fix follows from which: (a) mark earlier /
  widen the gate; (b) fix the cache-key equality so identical instantiations
  dedup (the real mechanism-1 enabler).
- **Step 3:** with the cache deduping, re-confirm `.new()` resolves +
  recursion terminates, run the full per-file diff, and only then land it.

_(ENV: `bun` drops from PATH; `BUN=/nix/store/*-bun-1.3.3/bin/bun`. Build
loop ~5 min; classify by exit code, per-file diff, not aggregate.)_
