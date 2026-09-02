# Builtin names silently shadow same-named user definitions (OPEN-DESIGN)

**PRODUCTION CASUALTY (2026-08-30):** a local named `short` in
`src/version_cache.yo`'s `download_version` resolved to the prelude C-interop
integer type inside a template interpolation; the def-eval failure was
swallowed, the WHOLE async body shipped hollow, and **`yo version install`
was silently broken in the released v0.2.19 and v0.2.20** (rc=0 no-op /
bare-SIGABRT rc=134 —
issues/fixed/wrong-arity-call-silently-accepted-version-install-broken.md). This
issue is no longer theoretical: pick option 1 (reserve) or 2 (prefer user
bindings), or at minimum land option 3's shadowing diagnostic, before the
next release.

**Found 2026-08-06** while attempting to fix
`issues/retired/ctfe-elided-unit-call-arg-temp-leak.md` (whose diagnosis this
finding invalidates — see the banner there).

## The hole

A user definition with the same name as a builtin type-checks fine but is
**dead code**: both compilers' dispatch checks builtins BEFORE user bindings.

- Evaluator: `src/evaluator/exprs/_expr.ts:750` routes `consume(x)` to
  `evaluateConsume` (`src/evaluator/builtins/consume.ts`) even when the user
  defined `consume :: (fn(x : MyVal) -> unit)(...)` in scope.
- Codegen: `src/codegen/exprs/generation.ts:1010` does the same.

Demonstrated: a program defining and calling its own `consume` never calls
it — the builtin evaluates the argument (attaching an owned RC temp), marks
it consumed, and discards it, which reads like a leak but is the builtin's
legal semantics. Renaming the function to `eat_it` produces fully correct C
(real call + scope-end and escape-path drops).

## Secondary observation

Statement-position builtin `consume(<fresh owned value>)` is a silent leak
instrument; an evaluator diagnostic (warning on consuming a freshly
constructed value in statement position) may be worth adding regardless of
the shadowing decision.

## Decision needed

1. **Reserve builtin names** — reject user definitions whose name collides
   with a builtin (clear, breaking for existing code that shadows harmlessly).
2. **Prefer user bindings** — resolve identifiers through the env first and
   fall back to builtins (matches user intuition; needs an audit of prelude
   internals that rely on builtin-first dispatch).
3. Keep builtin-first but **warn on shadowing definitions** (cheapest,
   catches the confusion without changing semantics).

Either way the fix must land in BOTH compilers (dispatch sites above + the
yo-self mirrors in `yo-self/evaluator/exprs/_expr.yo` /
`yo-self/codegen/exprs/generation.yo`).

## Third face (2026-08-26): a LOCAL cannot shadow a prelude TYPE NAME as a method receiver

Found writing D5's `tests/io/bufio.test.yo` — a local named `short` (the
C-interop integer type) broke method calls on it:

```rust
short := Option(i32).Some(i32(1));
short.is_none()   // Error: No matching call found with arguments: (short.is_none)()
```

The dot-call receiver resolution treats `short` as the TYPE (static-dispatch
path) before consulting the environment, so the local is unreachable as a
receiver. Any in-scope type name behaves this way (`int`, `long`, `uint`,
`String`, …). The failure is loud but the diagnostic names neither the
shadowing nor the type — it cost a multi-probe bisect to trace, because the
same test passed verbatim with the local renamed `b`.

Repro: `issues/repros/local-named-short-not-usable-as-receiver.yo`.

Same decision as above, sharpened: either locals shadow (env-first receiver
resolution), or declaring a binding whose name collides with an in-scope
type/builtin is REJECTED with a diagnostic that says so. The silent
middle — declaration legal, use broken — is the worst option and is what
ships today.
