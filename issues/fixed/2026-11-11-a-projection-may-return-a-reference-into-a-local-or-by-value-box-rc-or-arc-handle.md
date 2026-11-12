# A projection may return a reference into a local or by-value `Box`, `Rc` or `Arc` handle

**Severity:** S1. `get :: (fn(a : &String) -> &String)({ b := Box.new(…); &b.* })` and
`get :: (fn(h : Rc(X)) -> &String)(&h.s)` pass `yo check`: the function frees the box (drops its last handle)
when it returns, and the caller reads the payload through the result (ASan: heap-use-after-free). The local-handle
form is pre-existing (v0.2.76 accepts it). The by-value parameter form is new since v0.2.76, which rejects it only by
accident: an E0910 ("This argument moves `h`, which an earlier argument of the same call lends") at the callee's
synthesized `___drop(h)`.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A30). Confirmed on develop `64f33c710`. The design side
(a `.*` on an owning handle is a field step for rooting) was written into `REFERENCES_AND_ORIGINS.md` O3's return
rule on 2026-11-11.

## Reproducers

`tests/origins/unsound/proj-ret-local-box-deref.yo` (negative, expects E0912; filed under `issues/repros/` with
this doc's name, moved with the fix):

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

- `tests/origins/unsound/proj-ret-byvalue-rc-field.yo` (filed as `…-by-value-rc.yo`; negative, E0912): `get :: (fn(h : Rc(X)) -> &String)(&h.s)` — auto-deref writes `h.*.s`;
  the callee drops the only handle at its end: heap-use-after-free. v0.2.76: the accidental E0910 above.
- `tests/origins/unsound/proj-ret-byvalue-rc-field-pos.yo` (filed as `…-pos.yo`; positive control): `&b.*.*` / `&h.*.*.s` through a `&Box(String)` / `&Rc(X)` PARAMETER, which lie
  in the caller's storage. Accepted, runs clean.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `&b.*` / `&mut b.*` of a local `Box` returned (block tail or `return(…)`) | accepted, UAF | E0912 |
| `&h.*.s` / `&h.s` of a local `Rc` returned | accepted, UAF | E0912 |
| `&h.*.s`, `&h.s` of a by-value `h : Rc(X)` / `b : Box(X)` / `a : Arc(Y)` parameter | accepted, UAF | E0912 |
| a `self : Self` method returning `&self.h.*.s` (a struct with an `Rc` field, by value) | accepted, UAF | E0912 |
| a spelled holder over a by-value box, `-> V(b)` with `V(b)(r : &b.*.s)` | accepted, UAF (ledger) | E0912 — not this rule: see Fix |
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

## Fix

`deref_is_owning_handle_step` (`src/evaluator/utils.yo`) answers whether a `.*` steps INTO an owning handle: the
dereferenced value's type is a `Box` (`unique_box_payload_type`) or an `Rc` / `Arc` (`cell_handle_view`). Both
checker walks the audit named (§5 item 6) now read such a `.*` as a field step and continue to its base; a `.*` on
anything else (a reference, a raw pointer) keeps its old meaning, the place is wherever it points.

- **The projection root rule** (`_projection_root_error`, `src/evaluator/builtins/ptr_fns.yo`): `&b.*`,
  `&mut b.*`, `&h.*.s`, `&h.s` and `&self.h.*.s` are rooted at `b` / `h` / `self`, so a local or a by-value
  parameter is E0912 with the existing "`b` is a local" / "`h` is a by-value parameter: its storage ends with the
  call" message. Through a `&` / `&mut` parameter (`&b.*.*`, `&h.*.*.s`, `&h.s` with `h : &Rc(X)`, `self : &Self`)
  the root is that parameter, as before, and the result is accepted.
- **R-TEMP** (`is_temporary_operand`, the same file as the predicate): `long().*.s` and `Box.new(…).*` are fields
  of the temporaries `long()` / `Box.new(…)`, so `v = mkv(&long().*.s)` past the statement is E0911. This is the
  `.*` half of `issues/2026-11-11-a-temporary-reached-through-a-handle-deref-or-an-inner-projection-call-is-no-root-of-its-holder.md`
  (A23); its inner-projection-call half (`mkv(mkx().get())`) is a different exit and stays open there.

Every row of the family table with a reference result (`-> &T` / `-> &mut T`) now gives E0912. The spelled-holder
row (`-> V(b)` over a by-value `b : Box(X)`) does not change, and it is not this rule: `return_check` already roots
`b.*.s` at `b` (the composite rows were rejected before this fix for a LOCAL handle), and then lets the by-value
parameter `b` through because the result's spelled origin names it. The plain-struct form `-> V(x)` with
`V(x)(r : &x.s)` over a by-value `x : X` is accepted the same way, with no handle in it. That is
`issues/2026-11-11-a-composite-result-that-holds-a-reference-into-a-by-value-parameter-is-accepted.md` (A10),
whose family table now carries the row.

## Test

`tests/origins/unsound/` (G-B, `scripts/origins-unsound.sh`): `proj-ret-local-box-deref` (the local `Box`),
`proj-ret-byvalue-rc-field` (the by-value `Rc` parameter), `proj-ret-byvalue-self-rc-field` (the by-value `self`
with an `Rc` field), each E0912 and each with a `-pos` twin through a reference parameter that runs ASan-clean; the
R-TEMP half adds `holder-from-temporary-rc-deref` / `holder-from-temporary-box-deref` (E0911) and
`holder-from-temporary-rc-deref-pos`. `tests/origins/reference_read_rule.test.yo` carries a `comptime_expect_error`
row per shape (a local `Box` as a tail, through `return(…)` and as `&mut`; a local `Rc` with and without the
written `.*`; by-value `Rc`, `Box` and `Arc` parameters; a by-value `self`) and a runtime test of the
reference-parameter positives. The negative rows are accepted by develop `64f33c710` (the audit's measurement);
v0.2.76 accepts the local forms and rejects the by-value forms only through the accidental E0910. No
`tests/origins/corpus.tsv` rows were added: each corpus row is also encoded for the reference checker in
`tests/origins/model_corpus.test.yo`, and the G-B pairs above already pin the shapes.
