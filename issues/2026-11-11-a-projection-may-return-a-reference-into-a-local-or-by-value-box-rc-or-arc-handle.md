# A projection may return a reference into a local or by-value `Box`, `Rc` or `Arc` handle

**Severity:** S1. `get :: (fn(a : &String) -> &String)({ b := Box.new(…); &b.* })` and
`get :: (fn(h : Rc(X)) -> &String)(&h.s)` pass `yo check`: the function frees the box (drops its last handle)
when it returns, and the caller reads the payload through the result (ASan: heap-use-after-free). Pre-existing:
v0.2.76 accepts both.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A30). Confirmed on develop `64f33c710`. The design side
(a `.*` on an owning handle is a field step for rooting) was written into `REFERENCES_AND_ORIGINS.md` O3's return
rule on 2026-11-11.

## Reproducers

`issues/repros/2026-11-11-a-projection-may-return-a-reference-into-a-local-or-by-value-box-rc-or-arc-handle.yo`
(negative, expects E0912):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
get :: (fn(a : &String) -> &String)({
  b := Box.new(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
  &b.*
});
main :: (fn() -> unit)({
  k := String.from("k");
  println(`OUT: ${get(&k)}`);
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-by-value-rc.yo` (negative, E0912): `get :: (fn(h : Rc(X)) -> &String)(&h.s)` — auto-deref writes `h.*.s`;
  the callee drops the only handle at its end: heap-use-after-free.
- `…-pos.yo` (positive control): `&b.*.*` / `&h.*.*.s` through a `&Box(String)` / `&Rc(X)` PARAMETER, which lie
  in the caller's storage. POS_VERDICT

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `&b.*` / `&mut b.*` of a local `Box` returned (block tail or `return(…)`) | accepted, UAF | E0912 |
| `&h.*.s` / `&h.s` of a local `Rc` returned | accepted, UAF | E0912 |
| `&h.*.s`, `&h.s` of a by-value `h : Rc(X)` / `b : Box(X)` / `a : Arc(Y)` parameter | accepted, UAF | E0912 |
| a `self : Self` method returning `&self.h.*.s` (a struct with an `Rc` field, by value) | accepted, UAF | E0912 |
| a spelled holder over a by-value box, `-> V(b)` with `V(b)(r : &b.*.s)` | accepted, UAF (ledger) | E0912 |
| `.Some(&h.*.s)` of a local `Rc` returned as `Option(&String)` | E0912 | — |
| `V(a)(r : &h.*.s)` over a local `Rc`, returned as `V(a)` | E0912 (ledger) | — |
| `&x.s` of a by-value plain struct `x : X` | E0912 | — |
| `&b.*` of a by-value `b : Box(Dyn(Name))` | E0912 (ledger) | — |

The composite-result forms are caught by `return_check`, which roots `h.*.s` at `h`; only a reference result,
judged by the projection root rule, walks out through the `.*`.

## Root cause

`_projection_root_error` (`src/evaluator/builtins/ptr_fns.yo`), the root rule a `-> &T` body's yielded place is
judged by, stops at any `base.*` member:

```yo ignore
// A raw-pointer deref: the place is wherever the pointer points.
.Some(f) => if(ast_expr_is_atom_of(&f, "*"), Option(_ProjRootError).None, { … })
```

The comment states the case it was written for (`p.*` on a raw pointer, which only an `AllowUnsafe` file can
write), but the test is on the member alone, not on the base's type. The auto-deref of `h.s` on a handle is
rewritten to `h.*.s` (`make_deref_expr`, `src/evaluator/exprs/property_access.yo`), so it takes the same exit. A
`.*` on a reference parameter is also correctly "no error" here (its place is the caller's), which is why the
positive control passes and the bug hides: both kinds of `.*` return `.None`.

## Expected

E0912 at the definition of `get`, naming `b` / `h` as a local or a by-value parameter. O9: "A `&` borrow through a
read-only handle's deref has the handle's place as its origin" (`&h.*.x : &(X, h)`), and O3's return rule
(made precise 2026-11-11, A30): "a `.*` on an OWNING handle is a field step, not a way out of the frame … Only a
`.*` on a reference or a raw pointer leaves the frame, and then the origin is the reference's." The root rule must
continue to the base when the dereferenced value is a `Box`, `Rc` or `Arc` (a `Deref` handle), and stop only for a
reference or a raw pointer. The same reading belongs to R-LEND and R-TEMP (see
`issues/2026-11-11-a-temporary-reached-through-a-handle-deref-or-an-inner-projection-call-is-no-root-of-its-holder.md`).

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`; corpus rows in
`tests/origins/corpus.tsv` for the local `Box`, the by-value `Rc` parameter and the `self : Self` method form,
beside the existing `rc-handle-dropped` row.
