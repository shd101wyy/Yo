# A reference-field write is rejected as a read of the reference

**Severity:** S2. Writing a reference field, `h.r = &y` (O3's canonical place write `v.xs = &y`), is rejected with
E0926 "`h.r` is a reference (`&Rc(X)`): reading the value it refers to is spelled `h.r.*`", pointing at the LEFT
side. The text describes a read, and its suggested repair `h.r.* = …` writes the referent, a different program.
`t.0 = &y`, `a.b.r = &y`, `p.r = &y` and `h.r = v` with `v` a reference parameter (no `&` expression at all) are
rejected the same way. Workaround: rebuild the whole holder (`h = H(r : &y, n : h.n)`), which is accepted.
Pre-existing: v0.2.76 rejects the field, parameter and tuple forms with the same E0926.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 C6). Confirmed on develop `64f33c710`. Not P2: see Root
cause.

## Reproducers

`issues/repros/2026-11-11-a-reference-field-write-is-rejected-as-a-read-of-the-reference.yo` (positive, must be
accepted and print `OUT: 72`):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
mk :: (fn() -> Rc(X))(Rc.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"))));
H :: struct(r : &Rc(X), n : i32);
main :: (fn() -> unit)({
  z := mk();
  y := mk();
  mut(h) := H(r : &z, n : i32(0));
  h.r = &y;
  println(`OUT: ${h.r.*.*.s.len().to_string()}`);
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76 alike
error[E0926]: `h.r` is a reference (`&Rc(X)`): reading the value it refers to is spelled `h.r.*`
   |
   |   h.r = &y;
   |     ^
help: write `h.r.*`; `h.r.field`, `h.r.method()` and `h.r(i)` read through it, and `f(h.r)` passes it to a reference parameter
```

- `…-param.yo` (positive): `set(generic(p : Origin), h : &mut G(p), v : &(Rc(X), p))` with the body `h.r = v`;
  no `&` expression anywhere.
- `…-tuple.yo` (positive): `mut(t) := (&z, i32(0)); t.0 = &y;`.
- `…-whole.yo` (positive, accepted today): the workaround, `h = H(r : &y, n : h.n)`.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `h.r = &y`; `a.b.r = &y`; `p.r = &y` through `p := &mut h` (ledger) | E0926 at the left side | accept (E0911 when `y` dies first) |
| `t.0 = &y` on a tuple holding a reference | E0926 at the left side | accept |
| `h.r = v`, `v : &(Rc(X), p)` a parameter, `h : &mut G(p)` | E0926 at the left side | accept |
| `h = H(r : &y, n : h.n)` (whole holder) | accepted | accept |
| `h.o = .Some(&y)` (a field holding an `Option(&T)`), `y` dying first | E0911 (the flow check) | same |
| `out(i) = &x` (an element of `ArrayList(&(i32, (x, z)))`, corpus `place-write-join`) | reaches the flow check | same |
| `mut(r) := &a; r = &y` (re-point a binding) | accepted | accept |

## Root cause

Verified in the source. The property-assignment path of `src/evaluator/exprs/assignment.yo` ("Property / index LHS")
evaluates the left side with `ctx.is_lhs_of_assignment = true` and the expected type cleared. The reference-field
read rule (`_reference_field_read_type`, `src/evaluator/exprs/property_access.yo`, N1e-2) rejects a bare reference
field unless the node is deref-exempt (`deref_exempt_mark`) or the position expects a reference
(`reference_read_wanted`, which reads `ctx.expected_type`). Neither holds for an assignment target, and the rule does
not consult `is_lhs_of_assignment`, so the target `h.r` is judged as a by-value read (E0926,
`reject_reference_field_without_deref`). The reference-binding form `r.* = v` gets its `deref_exempt_mark` from the
same function; the field form has none.

P2 (`&x` as an expression, `BORROW_CHECKER_COMPLETENESS.md` §7, lane `vbd/p2-ref-expr`) is not what blocks this: the
error is at the left side, `r = &y` on a binding is accepted today (`bind_join` treats a bare lend on the right of
`=` as the re-point), P2's position list does not include the right side of `=`, and `…-param.yo` contains no `&`
expression at all. Whether `&y` on the right of a FIELD write then type-checks cannot be measured until the left side
is accepted.

## A `&mut` lend of a `&`-typed field or tuple slot (added 2026-11-12, audit re-probe pass 2)

The same misreading rejects a `&mut` LEND of a reference-typed field: passing the field to a
`dst : &mut &(T, p)` parameter is a write of the place `s.r` (A28's shape, one step down), not a write through the
`&` it holds. Measured on develop `4f8f975b3` (re-probe `probes2/e_field_direct_pos`, `e_tuple_field_pos`; their
negative twins, where `inner` dies first, get the same E0908, so no hole hides behind it); v0.2.76 cannot spell
`&mut &(T, p)`:

```yo ignore
S :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(r : &(Rc(X), p), n : i32));
mut(s) := S(outer)(r : &outer, n : i32(0));
set(&mut s.r, &inner);   // E0908 "Cannot write through `s.r`: it is a `&` reference field"
set(&mut t.0, &inner);   // `t : (&Rc(X), i32)`: the same E0908
```

The deeper forms `&mut pp.*.r` and `&mut w.0.r` are rejected the same way. Expected: accepted, with `s`'s flow set
joined by `inner`'s origin exactly as A28's fix (#1916) does for `set(&mut r, &inner)`; E0911 when `inner` dies
before `s` is used.

## Expected

Accepted. `REFERENCES_AND_ORIGINS.md` O3, "Place writes": "`v.xs = &y` requires `y`'s origin ⊆ `v`'s declared origin
set; `v.xs.* = ys` writes through it", and §5's place-write row (`p.f = v`: the root holder's set grows by
`origin_of(v)`, `place_write_join`). So the field write is a write of the place `h.r`, checked by the subset rule
against a spelled origin and joined into `h`'s flow set otherwise; with `y` dying before `h`'s last use it is E0911,
as `h.o = .Some(&y)` already is. Severity S2: a designed-accepted program is rejected (with a workaround), and the
diagnostic misdescribes the program.

## Test

With the fix: the three positive programs go to `tests/ref_binding.test.yo` (or the corpus as `ref-field-write`,
`ref-field-write-param`, `ref-tuple-elem-write`, ACCEPT), and a negative twin `ref-field-write-dies` (E0911) to
`tests/origins/unsound/`.
