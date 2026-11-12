# A closure capturing a reference cannot return a future that captures the reference

**Severity:** S2 — a valid program is rejected: a local closure that captures `&x` and returns `io.async({ x } …)` is E0912 "the origin names a local of this function", although the future borrows only the caller's `x` and never outlives it.

Found 2026-11-12 by the audit re-probe (`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md`, probe `async-effects/i04pos`).

## Reproducer

`issues/repros/2026-11-12-a-closure-capturing-a-reference-cannot-return-a-future-that-captures-the-reference.yo`:

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
LONG :: "0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz";
main :: (fn(io : Io) -> unit)({
  x := String.from(LONG);
  (mk : Impl(Fn() -> Impl(Future(unit, Io)))) = ({ &x, io }() => io.async({ x }(io : Io) => { println(`OUT: ${x.*}`); }));
  f := mk();
  io.await(f, io);
});
export(main);
```

```text
$ yo check repro.yo     # develop 4f8f975b3
error[E0912]: Cannot return a value holding `x`: the origin names a local of this function, and a result may name only origin parameters or reference-typed parameters' places (decision 43, plans/backlog/REFERENCES_AND_ORIGINS.md O3).
  --> repro.yo:9:68
```

| Binary | Verdict |
| --- | --- |
| v0.2.76 | E0926 (`x` is a reference: the seed cannot spell this program) |
| audit tip `64f33c710` | accepted |
| develop `4f8f975b3` | E0912 |

The parameter twin, a named function `mk(x : &String, io : Io) -> Impl(Future(unit, Io))` returning the same `io.async({ x } …)`, is accepted on develop. Since v0.2.76 cannot spell the program this is not a release regression, but it is a regression against the audit tip.

## Cause (suspected)

#1905 (capture origins of `{ p }` / `{ self }`, and an `io.async` capturing a reference parameter) gives the inner `{ x }` capture the origin of the closure's capture slot, and the closure body's O3 return rule treats that slot as a local of the closure rather than as the place the capture `&x` borrows (`x` of `main`). Not bisected.

## Expected

Accepted: the closure's result carries `x` of `main` through the `&x` capture, the same origin the parameter twin's result carries through its reference parameter. `f` is then frozen against writes to `x` while it lives.

## Test

With the fix: this program as a positive test beside the closure-capture tests (`tests/closure_capture_list.test.yo`) and a corpus row beside `async-captures-ref-param`.
