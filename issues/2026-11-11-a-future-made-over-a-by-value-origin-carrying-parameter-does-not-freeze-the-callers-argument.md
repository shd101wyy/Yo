# A future made over a by-value origin-carrying parameter does not freeze the caller's argument

**Severity:** S1. `mk :: (fn(generic(p : Origin), h : H(p), io : Io) -> Impl(Future(unit, Io)))(io.async({ h }(io : Io) => …h.r.*…))`
called as `f := mk(H(x)(r : &x), io); sink(x); io.await(f, io)` passes `yo check`: the future's origin never reaches
`x`, `x` is moved while `f` lives, and the await reads freed memory (ASan: heap-use-after-free). The non-async twin
(`pass(H(x)(r : &x))` returning `h`) is correctly E0911. Pre-existing: v0.2.76 accepts it too.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A51). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-a-future-made-over-a-by-value-origin-carrying-parameter-does-not-freeze-the-callers-argument.yo`
(negative, expects E0911):

```yo
H :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(r : &(String, p)));
sink :: (fn(v : String) -> unit)({
  println(`sink ${v.len().to_string()}`);
});
mk :: (fn(generic(p : Origin), h : H(p), io : Io) -> Impl(Future(unit, Io)))(
  io.async({ h }(io : Io) => {
    io.await(yield(io), io);
    println(`OUT: ${h.r.*}`);
  })
);
main :: (fn(io : Io) -> unit)({
  x := String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz");
  f := mk(H(x)(r : &x), io);
  sink(x);
  io.await(f, io);
});
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
sink 72
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-bound.yo` (negative, E0911): the holder is bound first, `h := H(x)(r : &x); f := mk(h, io);`: the same crash.
- `…-sync.yo` (control, E0911 today): `pass :: (fn(generic(p : Origin), h : H(p)) -> H(p))(h)`, `g := pass(H(x)(r : &x)); sink(x)`.
- `…-pos.yo` (positive control): the future is awaited before `x` moves.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `f := mk(H(x)(r : &x), io)`, `x` moved, `f` awaited | accepted, heap-use-after-free | E0911 |
| the holder bound first, then passed by value | accepted, heap-use-after-free | E0911 |
| non-async: `g := pass(H(x)(r : &x))`, `x` moved, `g.r` read | E0911 | E0911 |
| a `self : &Self` method's `io.async({ self : &self.* } …)`, `w` moved before the await (probe `n04`) | E0911 | E0911 |

## Root cause

Two places drop the origin, both read in the source:

1. In `mk`'s body, `_register_borrowing_future` (`src/evaluator/calls/function.yo`) re-roots a borrow a captured
   value carries at the captured binding only when that binding is a borrow parameter or a future operand
   (`variable_is_borrow_parameter || variable_is_future_operand_parameter`). `h` is a by-value parameter whose type
   carries the origin parameter `p`; the borrows `collect_type_borrows` reads off `H(p)` have no capture site and
   name no binding of this scope, so no `FutureRoot` is recorded. `YO_DEBUG_ORIGIN=1` prints `h -> []` for the capture.
2. At the call, `_note_future_producing_call` → `_future_call_lends_into` maps the result future's origin to the
   arguments only through `_borrows_root_named(leaf_bs, &label)`: an argument is mapped when the future's origin
   names its PARAMETER LABEL. A future over `h : H(p)` would name `p`, the origin parameter, which no label matches.
   The non-async path maps a result's origin parameters through the argument's origin (O-1's R-CALL), which is why
   `pass` is E0911.

## Expected

E0911 at `sink(x)`. `plans/backlog/REFERENCES_AND_ORIGINS.md` O8 ("As built", made precise 2026-11-11): "The mapping
covers every origin the result future names, not only the lent arguments … an origin parameter substituted through a
BY-VALUE origin-carrying argument (`mk(H(x)(r : &x), io)` for `h : H(p)`) freezes `x` like any call result's origin".
The future's origin is `p`; R-CALL substitutes `p` from the argument `H(x)(r : &x)`, whose origin is `{(x, &)}`.

## Test

With the fix: the two negatives and the positive control move to `tests/origins/unsound/` (the `-sync` control
documents the twin); a corpus row `async-forward-by-value-holder` (E0911) beside `async-forward-param`.
