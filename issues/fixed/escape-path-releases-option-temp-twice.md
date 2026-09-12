# The effect-escape path released an enum/Option-typed argument temp a second time

**Status: FIXED 2026-09-12** (`p1/resolver-lock-v2`, with the bare-arm drop fix).
Found by the per-function emission A/B of the compiler's own tree: eleven functions
lost exactly one `__yo_decr_rc` each under the fixed compiler, and every one of them was
this shape.

## Symptom

A may-unwind call whose argument is a temp of enum/Option shape (a `String`, an
`Option(T)`) inside an ordinary BLOCK body:

```rust
flag := is_latest(version.to_string(), "latest");   // is_latest may unwind
```

The emitted C released the `to_string()` temp right after the call (the call's own
post-call flush) and then AGAIN inside the `if (__yo_effect_escaped) { … return; }` block
that follows it:

```c
  bool t28104 = yo_id_9056(t28102, …);
switch ((t28102).tag) { case SOME: __yo_decr_rc(t28102.data.Some.value); … }   // flush
  if (__yo_effect_escaped) {
    // Drop local variables before early return
switch ((t28102).tag) { case SOME: __yo_decr_rc(t28102.data.Some.value); … }   // again
    …
    return (__yo_t47){0};
  }
```

A double free whenever the callee actually unwinds. It sat in the compiler's own
emission (`src/version.yo`'s `.yo-version` check, `src/main.yo`'s argument parsing, …)
and never fired in the corpus because those escape paths are rarely taken. A ref-typed
temp (`__yo_decr_rc(p)`, single line) was NOT affected.

## Reproducer

`tests/algebraic_effects.test.yo` "may-unwind call in an if condition releases an
Option-typed argument temp exactly once": inside a two-statement block body,
`r := if(raise(mk_ue_opt(n)), n * 3, n)` — the `ctl` handler parks every `Some` payload
in a module-level keeper, resumes for odd tags and unwinds for even ones — so a correct
compiler disposes nothing during the loop and exactly one per argument when the keeper is
cleared. On the develop compiler the loop already disposes five (the second release takes
each unwound-through object to zero); the shape must be a BLOCK body — a bare
single-expression body has no enclosing scope drops pending, and a block whose `if` arms
are themselves blocks parses differently — which is why the first two drafts of the test
were green on the broken compiler.

## Root cause

`generate_pending_deferred_drops` (`src/codegen/exprs/return.yo`) on the escape path
passes `skip_already_dropped = true` — it must release temps the node's own flush has NOT
yet released — and relied on nothing else to tell "already emitted". The scope-end
flushes (`generate_deferred_drop_expressions` in `drop_dup.yo`, `_emit_deferred_drops` in
`begin.yo`) did record into `emitted_deferred_drop_ids`, but only inside their
`code.len() > 0` branch. An enum/Option-typed drop is a multi-line `switch` the drop
generator writes to the emitter itself, returning "", so exactly those drops were emitted
and never recorded (the class `issues/fixed/short-circuit-chain-inner-operand-temps-still-leak.md`
found in `and_or.yo`).

## Fix

- `generate_pending_deferred_drops` skips a drop whose id is already in
  `emitted_deferred_drop_ids`.
- Both scope-end flushes record unconditionally and emit conditionally, as `and_or.yo`
  already did.

## Gates

- The new test above (red on the develop compiler, green after).
- `tests/algebraic_effects.test.yo` "unwind argument built by a may-unwind call" and the
  bare-arm keeper test (the same mechanism through the bare-arm pending feed —
  `issues/fixed/short-circuit-rhs-temp-in-bare-arm-body-drops-out-of-scope.md`).
- Emission A/B of the compiler tree, develop compiler vs this one: the only functions
  with FEWER releases are the eleven escape blocks above, each minus the duplicate; no
  function lost a dup.
