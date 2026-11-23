# A `with` body returning its reference parameter is accepted and emits invalid C

**Severity:** S2 — `yo check` accepts a reference escaping `RefCell.with` / `ArrayList.with` / `Mutex.with_lock` through the generic result `R := &T`, and only the C compiler stops it; with valid C it would be a use-after-free.

Filed 2026-11-23 by the test 7 lane while respelling the audit corpus's drifted negatives
(`scripts/test7/respell-manifest.tsv`, plan `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). Probe: `probes/cells/rcc01_with_returns_ref.yo` (also `rcc01b`, `rcc11`, `iteration/x01.yo`, `iteration/r01.yo`, `boundary/c01-…`, `c02-…`
in `scripts/test7/audit-corpus.tar.gz`. Reproduced with a stage 1 of develop `f06ff5889`.

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
{ RefCell } :: import("std/sync/refcell");
{ ArrayList } :: import("std/collections/array-list");
main :: (fn() -> unit)({
  c := RefCell(String).new(String.from("abc"));
  r := c.with((fn(v : &String) -> &String)(v));
  c.replace(String.from("y"));
  println(`OUT: ${r.len().to_string()}`);
});
export(main);
```

```text
yo check repro.yo --std-path ./std        # rc 0
yo compile repro.yo --std-path ./std --cc clang
p.bin.c:3105:164: error: passing '__yo_t_N' (aka 'struct __yo_t_N_struct') to parameter of incompatible type '__yo_t_N *'
```

The same body through `ArrayList.with` types the bound result as the element, not the reference:
`r := xs.with(usize(0), (fn(v : &mut String) -> &mut String)(v))` makes `r.*` E0621 ("`r` has type `String`, a
value"), and `${r}` is accepted and fails in C the same way. Before the typed fn literal, these probes stopped at
E0926 (`v => v` reads `v` by value) or "`&v.*` lends a borrow … not an expression of its own".

## Root cause

Not traced to a line. `with : (fn(generic(R : Type), self : &Self, body : &mut Impl(FnMut(v : &T) -> R)) -> R)`
admits `R := &T` from a body that yields its parameter: the per-call origin of `v` is not a place the caller can
name, so the result should be rejected (E0912, the parameter's origin escaping the call) or `R` bounded
`Escapable`. Codegen then treats the projection-shaped result as a value of `T` (the C mismatch, and `R` typed as
`String` in `ArrayList.with`).

## Fix

Reject a `with`-style body whose result carries the body parameter's origin (E0912), or bound `R <: Escapable` on
the std `with` methods. Add the probes as `tests/origins/unsound/` rows.
