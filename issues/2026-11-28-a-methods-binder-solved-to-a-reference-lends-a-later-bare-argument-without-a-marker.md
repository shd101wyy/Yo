# A method's binder solved to a reference lends a later bare argument without a marker

**Severity:** S3 — a rule hole without a memory-safety consequence. `h.pair(r, y)` with
`pair : (fn(generic(T : Type), self : &Self, a : T, b : T) -> T)` on an impl, `r : &X` and `y : X` a named local, is
accepted: `T := &X` from `r`, and the bare `y` is lent to `b` (the result reads `y`). Decision 33 says a bare named
place passes by value and a lend is written `&y`; the free function `pair(r, y)` is E0601 "it is &X from argument 1
but X from argument 2". The lend is borrow-checked (returning it out of `y`'s block is E0911), so nothing dangles.

- Filed: 2026-11-28 by the `v81-infer-first` lane, while checking VERDICTS-90's blame rule on the method path.
- Reproduces with the v0.2.80 seed. With VERDICTS-90 PR B, `h.pair(&x, y)` (a lend solving `T`) is accepted the same
  way, where the free `pair(&x, y)` is E0914 at the lend (the blame rule).

## Reproducer

```yo
X :: struct(n : i32);
H :: struct(k : i32);
impl(H, pair : (fn(generic(T : Type), self : &Self, a : T, b : T) -> T)(b));
pair :: (fn(generic(T : Type), a : T, b : T) -> T)(b);
main :: (fn() -> unit)({
  h := H(k : i32(0));
  x := X(n : i32(1));
  y := X(n : i32(2));
  r := &x;
  q := h.pair(r, y);
  _n := q.*.n;
  q2 := pair(r, y);
  ()
});
export(main);
```

Only the free call is rejected:

```text
error[E0601]: Incompatible types for generic parameter "T": it is &X from argument 1 but X from argument 2. Every mention of a type parameter in one call stands for one type.
   --> tmp/mb6.yo:12:17
```

Compiled and run without the free call, `h.pair(r, y)` returns a reference to `y` (prints `y`'s field).

## Root cause (not traced to the line)

The method path binds a method's own binders argument by argument through `check_if_function_parameter_matches_argument`
(`src/evaluator/calls/helper.yo`): `a` binds `T := &X`, and `b`'s argument `y : X` then meets the slot `&X`. It is most likely accepted
there by the read rule's compatibility (a by-value reference slot passes the place, as for a reference binding), so
no conflict is recorded and no marker is asked for. The inline `FuncVal` arm (`src/evaluator/calls/function.yo`) collects each
argument's binding and compares them (`_funcval_bind_foralls`), which reports the conflict.

## Expected

E0601 as for the free function, or, when the first argument is a lend that solved `T` (PR B), E0914 at the lend with
the blame rule's text.
