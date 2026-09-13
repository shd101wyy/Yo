# A boolean literal payload in an enum match pattern is not compared — it matches any payload

Status: FIXED 2026-09-13 — literal payload atoms (bool/int/float) now COMPARE
in both the evaluator (arm selection + no phantom binding) and codegen
(same-variant arms share one `case` with per-arm `if (<payload> == <literal>)`
guards). Tests: tests/match_bind_nothing.test.yo. String/char literals in
payloads still fail loudly at the "Expected identifier, `_`, or labeled
pattern" guard — unsupported, not silently wrong (left as is).

## Reproducer

```rust
{ println } :: import("std/fmt");
f :: (fn(x : Option(bool)) -> String)(
  match(
    x,
    .Some(false) => String.from("matched-Some-false"),
    _ => String.from("wildcard")
  )
);
main :: (fn() -> i32)({
  println(f(Option(bool).Some(true)));   // prints "matched-Some-false" — WRONG
  println(f(Option(bool).Some(false)));  // prints "matched-Some-false" — right
  println(f(Option(bool).None));         // prints "wildcard" — right
  i32(0)
});
export(main);
```

## Verdict

`match(x, .Some(false) => a, _ => b)` selects arm `a` for `.Some(true)`.
The `false` (and `true`) keyword atoms are treated as an unconstrained
payload binding, not as literal equality — so a pattern that LOOKS like it
discriminates on a boolean payload silently accepts both values. Any code
matching `.Some(false)` before a catch-all (the natural order) takes the
wrong arm for `.Some(true)`.

## Root cause (to be confirmed in the fix)

The match evaluator's atom-pattern handler presumably routes atoms that are
not recognized literals to binding positions; the boolean keywords parse as
plain atoms and are not in the recognized-literal set. The same likely
applies wherever `true`/`false` can appear as a pattern payload.

## Impact

Silent wrong-arm selection — the failure mode that made the Phase 3 watch
round skip invalidation for genuinely changed files
(`mm_definitions_changed` returning `.Some(true)` matched a `.Some(false)`
test). Found by asserting the round's observable behavior, not by the probe
above — the bug is easy to ship against.
