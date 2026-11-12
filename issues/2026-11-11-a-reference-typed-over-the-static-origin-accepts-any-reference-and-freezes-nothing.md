# A reference typed over the `static` origin accepts any reference and freezes nothing

**Severity:** S1. `o := Option(&(Rc(X), static)).Some(&b); drop(b);` passes `yo check` and reading `o` is a
heap-use-after-free; the same spelling launders a borrow of a local into an `Escapable` position (an `Rc`
payload), which the no-origin rule exists to prevent. New in the v0.2.77 window: `static` is decision 49's
spelling of the empty origin, and v0.2.76 answers `E0922 The origin \`static\` is not declared`.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A7). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-a-reference-typed-over-the-static-origin-accepts-any-reference-and-freezes-nothing.yo`
(negative, expects E0923):

```yo
main :: (fn() -> unit)({
  b := Rc.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz")));
  o := Option(&(Rc(X), static)).Some(&b);
  drop(b);
  match(o, .Some(r) => println(`OUT: ${r.*.*.s.len().to_string()}`), .None => println("none"));
  ()
});
```

```text
$ yo check repro.yo        # accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

`…-into-rc.yo` (negative, expects E0923): `mk :: (fn(x : &Rc(X)) -> Option(&(Rc(X), static)))(.Some(x));` returns
its parameter under `static`; the caller stores `Rc.new(mk(&b))` in an outer slot and reads it after `b`'s block:
ASan `stack-use-after-scope`. `Rc`'s payload bound (`T <: Escapable`) is satisfied because `&(T, static)` is
`Escapable` (O10), so the same route reaches `io.spawn`, a module-level binding and `Dyn(Trait)`.

`…-pos.yo` (positive control): the holder with its origin elided, read before `drop(b)`.

## The family (develop `64f33c710`)

| Position typed over `static` | Given | Verdict | Correct |
| --- | --- | --- | --- |
| a `:=` initializer `Option(&(Rc(X), static)).Some(&b)` | `&b`, a local | accepted, UAF | E0923 |
| a result `-> Option(&(Rc(X), static))` | the function's `&` parameter | accepted, UAF | E0923 |
| a typed local `(o : Option(&(Rc(X), static))) = …` | `&b` | accepted, UAF | E0923 |
| a struct field `r : &(Rc(X), static)` | `&b` | accepted, UAF | E0923 |
| a parameter `v : &(Rc(X), static)` | `&b` | accepted, UAF | E0923 |
| an alias `SRef :: &(Rc(X), static)`; a comptime constructor building `struct(r : &(T, static))` | `&b` | accepted, UAF | E0923 |
| a generic `p` FIXED by a `static`-typed destination (`store(&mut dst, &b)` with `dst : Option(&(T, static))`) | `&b` | E0923 | E0923 |

## Root cause

`REFERENCES_AND_ORIGINS.md` O1 ("The empty origin"): `∅ ⊆ p`, so a `static` reference coerces INTO every origin
position; the converse, storing a reference with a non-empty origin into a `static` slot, needs `{b} ⊆ ∅` and is an
origin mismatch (E0923). The checker reads a declared `static` as "no origin declared": `_origin_names_into`,
`_type_origin_names_into` and `_result_origin_names_into` (`src/evaluator/types/function.yo`) return no names for
`static`, and the store, assignment and return checks treat an empty name list as an elided (flow-inferred)
position, which accepts anything and then records no loan. Only the path that unifies a generic origin parameter
against the slot (`lend_through`) distinguishes "declared empty" from "not declared", which is why the last row is
rejected.

## Expected

E0923 wherever a value whose origin is not empty is stored into, returned as, or passed to a position typed over
`static`; nothing else changes (a `static` value still fits every origin position).

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`; corpus rows
`static-slot-given-local` (E0923) and `static-into-rc` (E0923) beside P12's `global-static-ref`.
