# A reference-typed call result passed inline as the stored value of a store call carries no origin

**Severity:** S1. `put(&mut h, pick(&x.*.s))` passes `yo check` when `x` lives in an inner block and `h` outlives it:
`pick`'s `&String` result is passed inline as the stored value, the store's flow join gets no root for it, and `x`'s
cell is freed at the block's end while `h` still points into it (heap-use-after-free under ASan). Binding the result
first (`r := pick(&x.*.s); put(&mut h, r)`) is rejected with E0911, as are a bare `&x.*.s` and an
`Option(&String)`-typed result passed inline. Present on develop `6c90536aa`; not probed on v0.2.76.

Found 2026-11-13 by the borrow-program generator (`scripts/origins-gen.py`, G-D) on its first run against develop's
tip: the signature `slot:int/ref/clo/store/scope_end/x/after`, minimized further by hand to a plain function call.
Not an audit row (`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A1–A56 has no inline reference-typed
result at a store sink); the audit's §6 generator axis "nested call result" is the position that found it.

## Reproducer

`issues/repros/2026-11-13-a-reference-typed-call-result-passed-inline-as-the-stored-value-of-a-store-call-carries-no-origin.yo`
(negative, expects E0911):

```yo ignore
X :: struct(s : String);
put :: (fn(generic(p : Origin), dst : &mut &(String, p), v : &(String, p)) -> unit)({ dst.* = v; });
pick :: (fn(a : &String) -> &String)(a);
main :: (fn() -> unit)({
  z := Rc.new(X(s : String.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")));
  mut(h) := &z.*.s;
  {
    x := Rc.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz")));
    put(&mut h, pick(&x.*.s));
  };
  println(`OUT: ${h.*.slice_copy(usize(0) .. usize(5))}`);
});
```

```text
$ yo check repro.yo        # develop 6c90536aa: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-bound.yo` (negative, E0911): the same with `r := pick(&x.*.s);` first. Rejected today: this is the control the
  hole is measured against.
- `…-pos.yo` (positive control): the slot is read inside the block; runs clean.

## The family (the generator's `slot` grid, develop `6c90536aa`)

| Stored value at `put(&mut h, …)` | Verdict | Correct |
| --- | --- | --- |
| `&x.*.s` (a bare lend) | E0911 | E0911 |
| `r` (a local bound from `pick(&x.*.s)`) | E0911 | E0911 |
| `mkh(&x)` returning `Option(&String)` inline | E0911 | E0911 |
| `pick(&x.*.s)` returning `&String` inline (a function item or a local closure) | accepted (UAF) | E0911 |

## Expected

E0911 at the call: the inline result's origin is the union of its reference arguments' origins (O2), so the stored
value is rooted at `x`, whose scope ends before `h`'s last use.

## Root cause

Not diagnosed. The flow join that registers a stored value's roots (`src/evaluator/utils.yo`, the `n2b` join, whose
§7 scope check raises the E0911 above) is fed by the stored argument's origin; a reference-typed call result in
argument position evidently contributes none, where a bound one and a composite result do.

## Fix and test

A G-B row (`tests/origins/unsound/`) with the negative and its positive control moves in with the fix, with the
generator signature `slot:*/ref/call/store/scope_end/x/after` in `tests/origins/gen-known.tsv` removed in the same PR.
