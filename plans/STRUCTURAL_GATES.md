# Scope: structural-gate tests (5 of the 18 ./tests fails)

All 5 fail identically — `comptime_expect_error(...)` expects a compile error,
but yo-self evaluates the construct successfully (the rejection gate doesn't
fire). Crucially, **all are standalone type/impl-level checks — NOT behind the
def-time-body-eval wall** (unlike flowability), so they're tractable now.

Two independent sub-clusters.

## Cluster A — raw-pointer-in-safe-code (LOW risk, cleanest)

Tests: `safe_code_structural_gates`, `extern_unsafe_wrap`.
Repro: `takes_ptr :: (fn(p : *(i32)) -> i32)(...)`, `(fn(s : *(char)) -> usize)(strlen(s))`
— a raw pointer type `*(T)` (or `&(x)` address-of) named in a file WITHOUT
`pragma(Pragma.AllowUnsafe);`. "Phase C structural gates" (plans/MEMORY_SAFETY.md).

**TS gates (both use `isImplicitlyUnsafeCapableFile`):**
- `calls/pointer.ts:75-86` — evaluating a `*(T)` TYPE throws
  `Raw pointer types ('*(...)') are not available in safe code` when
  `!context.unsafeContext && !isImplicitlyUnsafeCapableFile(modulePath)`.
- `exprs/_expr.ts:1237-1248` — the `&+`/`&-`/`&/` (and `&(x)` address-of) gate,
  same condition.

**yo-self status:** `is_implicitly_unsafe_capable_file` IS ported
(`evaluator/memory_safety.yo:97`) and `ctx.unsafe_context` exists, but the gates
are NOT wired: `calls/pointer.yo`'s `evaluate_raw_pointer_call` has no pragma
check (only `builtins/unsafe.yo` checks it, for `unsafe(...)`).

**Fix:** add the gate to `evaluate_raw_pointer_call` (pointer.yo) — mirror
pointer.ts:75-86 — and the address-of/`&+`/`&-` gate to the matching yo-self
site (port of _expr.ts:1237). Both are ~6-line guards using already-ported
helpers.

**Why low-risk:** the gate fires ONLY in non-`pragma` files. std/ and yo-self/
declare `pragma(Pragma.AllowUnsafe);` (and use `*(T)` pervasively), so they're
unaffected; only safe user files (the test fixtures) start rejecting. Validate
per-file anyway (a stray non-pragma std file using `*(T)` would surface).

## Cluster B — Send / negative-impl (MEDIUM risk)

Tests: `negative_impl`, `thread_safety`, `sync/mutex`.
Repros:
- conflict: `impl(ConflictType, Send()); impl(ConflictType, !(Send))` → must reject.
- standalone negative (must still WORK): `impl(MySendStruct, !(Send()))` overrides
  auto-derive so the type no longer counts as Send.
- `Mutex(NonSendObj)` where `Mutex(T)` has `where(T <: Send)` → must reject.

**TS mechanism:** `values/impl.ts:270-300` — a `negativeImplRegistry`
(`Set<"typeId:traitTypeId">`) + `negativeGenericImplRegistry`. `impl(T, !(Trait))`
registers a negative entry; Send/Acyclic derivation and the
positive+negative conflict check consult it; `Mutex(T)`'s `where(T <: Send)`
fails because `type_implements_send(NonSend)` returns false (negative or
non-derived).

**yo-self status:** `values/impl.yo` has NO negative-impl registry (grep: none).
So `impl(T, !(Send))` is inert → no conflict detection, no auto-derive override.

**Fix:** port the negative-impl registry + registration (impl.ts:270-300) into
`impl.yo`; wire the conflict check (positive+negative for same type/trait →
throw) at impl registration; make `type_implements_send`/`type_implements_acyclic`
(trait_checking.yo) consult the negative registry; verify `Mutex`'s
`where(T <: Send)` is actually enforced at instantiation (apply_where_clause
constraints + type_implements_send). Broader: touches impl registration + Send
derivation + where-clause enforcement, and the standalone-negative positive
cases must keep working.

## Recommended order

1. **Cluster A first** — 2 tests, ~2 small contained gate ports, low risk,
   helpers already exist. Clean win toward matching TS on ./tests.
2. **Cluster B next** — 3 tests, the negative-impl registry port + Send
   consultation + where-clause check. Medium risk; validate the standalone
   negative-impl positive cases don't regress.

Both are independent of the def-time-body-eval wall (the flowability/contracts
blocker), so progress here doesn't depend on that multi-layer feature.

## Reference points
- TS: `calls/pointer.ts:75-86`, `exprs/_expr.ts:1237-1248`,
  `values/impl.ts:270-300`, `memory-safety.ts:86` (`isImplicitlyUnsafeCapableFile`).
- yo-self: `evaluator/memory_safety.yo:97` (gate helper ported),
  `calls/pointer.yo` (`evaluate_raw_pointer_call` — needs the gate),
  `values/impl.yo` (needs the negative-impl registry),
  `evaluator/trait_checking.yo` (`type_implements_send`/`_acyclic`).
- Tests: `tests/{safe_code_structural_gates,extern_unsafe_wrap,negative_impl,thread_safety,sync/mutex}.test.yo`.
