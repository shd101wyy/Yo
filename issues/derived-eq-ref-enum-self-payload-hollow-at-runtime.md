# `derive(Eq)` on a ref enum with a `Self`-payload variant is HOLLOW at runtime

**Status: OPEN (surfaced by the V5 task-6 verifier work, 2026-09-13).**

## Summary

`derive(T, Eq(T))` on a `ref(enum(...))` whose variants carry `Self`
payloads produces an equality function whose **definition-time evaluation
fails and is swallowed** — the emitted C body is the `__attribute__((error))
` hollow stub. `yo check` stays GREEN (the swallow is silent); the failure
only appears at RUNTIME, as

```
yo: FATAL: reached fn_yo_id_<n>, whose body failed to transpile - its
definition-time evaluation failed and was swallowed. Re-run `yo check`
with YO_DEBUG_SWALLOW=1 to see the original error.
```

the first time the derived equality is CALLED (e.g. `==` on two values, or
`ArrayList(T).contains(...)`).

## Reproducer

`tmp/eqrefenum.yo` (compile + run with any current binary — verified with
the v0.2.32 seed):

```rust
{ println } :: import("std/fmt");

RKind :: ref(
  enum(
    Leaf,
    Node(elem : Self)
  )
);
derive(RKind, Eq(RKind));

main :: (fn() -> unit)({
  a := RKind.Leaf;
  b := RKind.Node(elem : RKind.Leaf);
  println(`eq=${((a == a)).to_string()}`);
  println(`ne=${((a == b)).to_string()}`);
});
export(main);
```

`yo check` passes. `yo compile ... --emit-c` succeeds (the equals body is
emitted as the error-attributed hollow stub `fn_yo_id_<n>(RKind*, RKind*)`),
and running the binary aborts with the FATAL above at the first `==`.

Variants narrowed so far:

- ref enum + `Self` payload + `derive(Eq)` + a runtime `==` → HOLLOW.
- The same shape WITHOUT the Self payload (only scalars/`String`) is the
  normal, working derive path (`TokenKind`-style equals are called
  everywhere).
- PLAIN enums with `Self` payloads are already rejected at definition
  (the V2 lesson), so the broken surface is specifically `ref(enum)` +
  `Self` + Eq.

## Where this bites the verifier

`VcSort` became a ref enum in V5 task 5 (`SeqS(elem : Self)` /
`FunS(domain : Self, range : Self)`) and carries `derive(VcSort,
Eq(VcSort))` since V2. Nothing called VcSort equality at runtime through
task 5, so the hollowness was latent; V5 task 6's first
`ArrayList(VcSort).contains(...)` hit the stub and aborted the verifier
driver with the FATAL. The walk now dedupes by the encoded sort KEY
string instead (no VcSort `==` at runtime).

## Root-cause pointer (for whoever fixes the derive)

`YO_DEBUG_SWALLOW=1 yo check` on the reproducer shows the derived
equals' trial at the `derive(...)` line swallow with NO printed error of
its own (`[trial] tmp/eqrefenum.yo:12:23` then `[flow-post]` — the
nearby `[swallow]` entries are prelude-internal and unrelated). The
swallowed error's own diagnostics appear to be lost rather than
attributed; recovering WHAT the trial throws (likely the synthesized
recursive call over the `Self` payload binding) is step one.
