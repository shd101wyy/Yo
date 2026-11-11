# std `mem.replace` and `Option.take` reject a value that carries an origin, inside std

**Severity:** S2. `mem.replace`, `mem.take`, `Option.take` and `Option.replace` fail with E0912 INSIDE the standard
library whenever `T` carries an origin — a holder `H :: struct(r : &String)`, `Option(&String)`, `Option(H)`:
"Cannot return the local borrow `old`: it borrows `dst` with `&`". Every "take the old value out of a slot" idiom
over a holder or an `Option` of references is unusable, sound or not; the error points into `std/mem.yo` /
`std/prelude.yo`. Pre-existing: v0.2.76 rejects the same programs with the same E0912.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 C2). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-std-mem-replace-and-option-take-reject-a-value-that-carries-an-origin-inside-std.yo`
(expects accept, `OUT: 6 4`):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
{ replace } :: import("std/mem");
H :: struct(r : &String);
main :: (fn() -> unit)({
  a := String.from("aaaa");
  c := String.from("cccccc");
  mut(h) := H(r : &a);
  old := replace(&mut h, H(r : &c));
  println(`OUT: ${h.r.len().to_string()} ${old.r.len().to_string()}`);
  ()
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76:
error[E0912]: Cannot return the local borrow `old`: it borrows `dst` with `&` and is second-class, so it may not
cross the function boundary (no return, store, escaping capture or spawn).
note: raised here, inside the standard library
   --> std/mem.yo:49:3
note: `old` borrows `dst` here:
   --> std/mem.yo:47:3        old := unsafe(__yo_ptr_read(p));
```

- `…-option-take.yo` (expects accept): `Option(H).Some(H(r : &a)).take()`; E0912 at `std/prelude.yo`'s `take`, "it
  borrows `self`".
- `…-neg.yo` (expects E0911): `replace(&mut o, Option(&String).Some(&b))` with `b` block-local and `o` read after the
  block. Rejected today, but by the same E0912 inside std; after the fix it must be rejected at the caller.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `mem.replace(&mut h, H(r : &c))`, both roots outliving `h` | E0912 inside std | accept |
| `Option(H).take()`; `mem.take(&mut o)` at `T := Option(H)` (ledger: m09) | E0912 inside std | accept |
| `Option(H).replace(…)` over a block local (ledger: holders o02) | E0912 inside std | E0911 at the caller |
| `o.take()` then a write of the root `a` the taken holder points into, then a read (holders o03) | E0912 inside std | E0911 at `a = mk()` |
| `mem.replace(&mut o, .Some(&b))` at `T := Option(&String)`, `b` block-local | E0912 inside std | E0911 at the caller |
| the same functions at a `T` without origins (`i32`, `String`, `ArrayList(i32)`) | accepted | accept |

## Root cause

All four bodies read the old value as `old := __yo_ptr_read(addr_of(<the &mut parameter>))` and return it. At a
`T` that carries an origin, the checker registers `old` as a local borrow of the PARAMETER `dst` (`self`), as the
second note shows, and `local_borrow_reject_result_borrow` (`src/evaluator/utils.yo`) then rejects the return of a
second-class borrow. Measured with a user copy of `replace` under `Pragma.AllowUnsafe` (outside std the
pointer is spelled `addr_of(dst.*)`): the binding `p` is not the cause — `old := unsafe(__yo_ptr_read(addr_of(dst.*)))`
with nothing in between is the same E0912.

Hypothesis for the site: R-CALL's root walk over the call's operands (`_origin_of_into` /
`_origin_carrying_roots_shallow` / `projection_call_root_args`, `src/evaluator/utils.yo`; `_strip_lend` reads an
`addr_of(x)` operand through as a call-site lend marker) makes the `addr_of` operand's place a root of a result
whose type carries an origin, so the value read through the pointer is rooted at the parameter's slot.

## Expected

Accept the sound uses; reject the unsound ones at the CALLER. `plans/backlog/BORROW_CHECKER_COMPLETENESS.md` keeps
raw pointers out of the model: "`addr_of(p)` is `access(p, lend-&)` for the statement and nothing after", so the
value `__yo_ptr_read` returns is not a borrow of `dst`. It is a `T`, whose origins are `T`'s: at the instantiation
they are the caller's, and O3's return rule (`plans/backlog/REFERENCES_AND_ORIGINS.md`) admits them ("an origin in
a result type may name only origin parameters or reference-typed parameters' places"). The caller then checks the
returned holder as it checks any call result (R-CALL), which is what rejects `…-neg.yo` with E0911.

## Test

With the fix: the two accept programs and the negative move to `tests/origins/unsound/`; corpus rows
`mem-replace-holder` (pos), `option-take-holder` (pos) and `mem-replace-block-local` (E0911) in
`tests/origins/corpus.tsv`; std's own tests for `std/mem.yo` gain a `replace` / `take` case over a holder.
