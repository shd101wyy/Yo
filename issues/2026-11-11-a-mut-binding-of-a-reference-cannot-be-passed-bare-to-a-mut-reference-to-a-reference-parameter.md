# A `&mut` binding of a reference cannot be passed bare to a `&mut` reference-to-a-reference parameter

**Severity:** S2. `rp := &mut r; set(rp, &other)` with `set`'s parameter `dst : &mut &(Rc(X), p)` is rejected with
E0601 ("Expected: `&Rc(X)`, Given: `&mut &Rc(X)`"), although a `&mut` binding passed to a `&mut` parameter is a
reborrow everywhere else. The workaround `set(&mut rp.*, &other)` type-checks. Not expressible on v0.2.76 (the
parameter type itself is new this cycle).

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 C11), as probe 1 of VERDICTS-58. Measured on develop
`64f33c710`. The soundness side of the same parameter type is
`issues/2026-11-11-a-mut-lend-of-a-reference-binding-to-a-spelled-origin-parameter-does-not-widen-the-bindings-flow-set.md`.

## Reproducer

`issues/repros/2026-11-11-a-mut-binding-of-a-reference-cannot-be-passed-bare-to-a-mut-reference-to-a-reference-parameter.yo`
(expects: accepted; the program is sound, `other` lives as long as `r`):

```yo
set :: (fn(generic(p : Origin), dst : &mut&(Rc(X), p), v : &(Rc(X), p)) -> unit)({
  dst.* = v;
});
main :: (fn() -> unit)({
  outer := mk();
  other := mk();
  mut(r) := &outer;
  rp := &mut r;
  set(rp, &other);
  println(`OUT: ${r.*.*.s.len().to_string()}`);
});
```

```text
$ yo check repro.yo
error[E0601]: Cannot unify incompatible types:
Expected: "&Rc(X)"
Given: "&mut &Rc(X)"
   |     set(rp, &other);
   |         ^^
```

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `rp := &mut r; set(rp, &other)` | E0601 | accepted (a reborrow of `rp`) |
| `set(&mut rp.*, &other)` | accepted | accepted |
| `set(&mut r, &other)` (no intermediate binding) | accepted | accepted |
| `p := &mut x; f(p)` for `f(a : &mut T)` with `T` not a reference | accepted | accepted |

## Root cause

Hypothesis, from the message: the argument check compares the binding's type with the parameter's POINTEE
(`&Rc(X)`), the comparison it uses for an argument written `&mut place`, and the "a bare `&mut` binding at a `&mut`
slot is a reborrow" step strips one reference level too few when the pointee is itself a reference. The site is
the reference-argument matching in `src/evaluator/calls/function.yo`; not confirmed in the source.

## Expected

`plans/backlog/REFERENCES_AND_ORIGINS.md` O3 "Reborrows": "a `&mut` passed to a `&mut` slot is reborrowed
(`&mut r.*`)". `BORROW_CHECKER_COMPLETENESS.md` §7 P3 admits `&mut &(T, p)` parameters; the bare form is the same
reborrow one level up.

## Test

A case in `tests/ref_of_ref.test.yo` with the fix; the reproducer is its
positive program.
