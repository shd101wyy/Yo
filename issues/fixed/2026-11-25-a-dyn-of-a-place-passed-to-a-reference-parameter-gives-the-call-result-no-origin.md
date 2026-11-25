# `dyn(&place)` passed to a reference parameter gives the call's result no origin

**Severity:** S1. Safe code passes `yo check` and reads freed memory. The place `c` can be moved or dropped while a call result that points into it is still live (ASan: heap-use-after-free), and the result can also escape `c`'s block (it then prints a wrong value).

Filed 2026-11-25 by the `s1-dyn-ref-local` lane. The coordinator asked for a verdict on the audit probe
`probes/cells/tip/dv06_dyn_ref_generic_id.yo`: since #2070 it compiles and prints `OUT: 72`, but its header says
`// expect: E0911`. dv06 itself is sound; its header is stale, and this PR fixes it in the test 7 overlay. While
checking its siblings, a one-line move added to `dv01_dyn_ref_call_result_bound.yo` and to
`dv05_dyn_ref_holder_from_fn.yo` produces a program that is accepted and has undefined behavior. Seen on develop
`691b0d546` plus #2070 (`8df84c034`).

## Reproducer

`issues/repros/2026-11-25-a-dyn-of-a-place-passed-to-a-reference-parameter-gives-the-call-result-no-origin.yo`:

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
Name :: trait(name : (fn(self : &Self) -> &String));
Cat :: struct(s : String);
impl(Cat, Name(name : (fn(self : &Self) -> &String)(&self.s)));
_get_opt :: (fn(d : &Dyn(Name)) -> Option(&Dyn(Name)))(Option(&Dyn(Name)).Some(d));
main :: (fn() -> unit)({
  c := Cat(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz"));
  o := _get_opt(dyn(&c));
  {
    _d := c;
  };
  match(
    o,
    .Some(d) => println(`OUT: ${d.name().clone().len().to_string()}`),
    .None => ()
  );
});
export(main);
```

```bash
yo check repro.yo --std-path ./std     # rc 0: accepted
yo compile repro.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t && ./t
```

```text
==938113==ERROR: AddressSanitizer: heap-use-after-free on address 0x720a30fe2010 at pc 0x5e0bd1c365e5 bp 0x71ca2e9fec30 sp 0x71ca2e9fe3f0
READ of size 36 at 0x720a30fe2010 thread T1
```

| Shape (the same `main`, one line changed) | Result |
| --- | --- |
| `o := _get_opt(dyn(&c))`, then `c` is moved into `{ _d := c; }`, then `o` is read | accepted; heap-use-after-free |
| `o := { c := …; _get_opt(dyn(&c)) }`, then `o` is read | accepted; prints `OUT: 0` (36 expected): it reads the dead block's `c` |
| `mut(c)`, `o := _get_opt(dyn(&c))`, `c = Cat(…)`, then `o` is read | accepted (no memory error only because `o` points at the place `c`, which the write reuses) |
| `h := mkhold(dyn(&c))` (`mkhold :: (fn(d : &Dyn(Name)) -> Hd(d))`), then `c` is moved | accepted; heap-use-after-free |
| control: `_get_opt_c(&c)` with `_get_opt_c :: (fn(d : &Cat) -> Option(&Cat))`, then `c` is moved | E0911 `Cannot move c here: o borrows c` |
| control: `(d0 : &Dyn(Name)) = dyn(&c); o := _get_opt(d0)`, then `c` is written | E0911 |
| control: `gid(dyn(&c))` (`gid :: (fn(generic(T : Type), v : T) -> T)`), then `c` is moved, written, or the result escapes its block | E0911 each time |
| control: `Hd(c)(d : dyn(&c))` (the origin spelled), then `c` is written | E0911 |

## Root cause

The call result's origin comes out empty. `YO_DEBUG_ORIGIN=1` on the shapes above prints:

```text
[origin] _get_opt(dyn(&(c))) -> []
[origin] mkhold(dyn(&(c))) -> []
[origin] _get_opt_c(&(c)) -> [c(imm)]
[origin] gid(dyn(&(c))) -> [c(imm), c(imm)]
```

So no local borrow of `c` is registered for `o`, and nothing freezes `c` while `o` is live. The loss is in R-CALL
(`_origin_of_into`, `src/evaluator/utils.yo`). It handles a reference-parameter root with
`_origin_of_reference_arg_into`, which falls through to `_origin_of_into` on the argument `dyn(&c)`, and that yields
no root. The same argument at a by-value parameter (`gid`'s `v : T`) goes through `_origin_held_into` and does yield
`c`. So does `&c` at a sized reference parameter, and so does a `dyn(&c)` that is bound first and then passed by
name. The trace above shows only that the reference-root branch drops the lend of `c` inside `dyn(...)`. Which
predicate drops it is not yet pinned. The likeliest candidate is the R-NONE rule, which reads a reference-slot
argument at its pointee's type, and `Dyn(Name)` carries no origin. Confirm that with a print in
`_origin_of_reference_arg_into` before fixing it.

## Expected

`_get_opt(dyn(&c))` and `mkhold(dyn(&c))` have the origin `[c(imm)]`, as `_get_opt_c(&c)` does. The move and the
write are E0911, and the block escape is rejected as `gid`'s is (E0911, "`c`'s scope ends with the block").

## Test

The table's three accepted rows (the move, the write, the block escape) as `comptime_expect_error` cases in
`tests/dyn-pointer-kinds.test.yo`, and the reproducer pair under `tests/origins/unsound/`. Each passes `yo check`
today and is rejected with the fix. The audit probes `probes/cells/tip/dv01_dyn_ref_call_result_bound.yo` and
`dv05_dyn_ref_holder_from_fn.yo`, which never write `c`, stay accepted and ASan-clean.

## Fix

Confirmed with a print at R-NONE's early return in `_origin_of_into` (`src/evaluator/utils.yo`):

```text
[refarg] dyn(&(c)) -> _origin_of_into
[rnone] dyn(&(c)) : Dyn(Name) dropped
[refarg] upcast(dyn(&(c)), Dyn(Name)) -> _origin_of_into
[rnone] upcast(dyn(&(c)), Dyn(Name)) : Dyn(Name) dropped
```

A `dyn(&c)` passed bare to a `&Dyn(T)` parameter is read at its pointee's type, `Dyn(T)`, which carries no
origin, so R-NONE returned the empty set before R-COMP reached the lend `&c` inside it. R-NONE already kept two
reference values read at their pointee's type (a call whose callee returns a reference, an atom naming a
reference binding). It now keeps a third: a `dyn(...)` or `upcast(...)` call, which re-types its operand's
pointer. Its origin is then R-COMP's over its operand, the same computation as at a by-value slot (`gid`).
`dyn(&mut c)` gives `c(mut)`; an `upcast(dyn(&c), …)` gives `c(imm)`.

After the fix, these are rejected with E0911: the move, the write and the block escape of the table, `mkhold`
then a move, `_fwd(dyn(&c))` then a move, `_get_opt(upcast(dyn(&c), Dyn(Name)))` then a move, and a read of `c`
while `_get_mut(dyn(&mut c))`'s result lives. A `dyn(&mut c)` passed through `fn(d : &mut Dyn(T)) -> &mut Dyn(T)`
and bound by `r := …` was rejected as a borrow of a temporary before the fix. It now binds, and a read of `c`
while `r` lives is E0911.

Sibling wrappers audited at a reference parameter: `&Option(&Cat).Some(&c)` and a `cond` whose arms are
`dyn(&c)` values are rejected as a borrow of a temporary (R-TEMP), which is sound. The `cond` case is an
over-rejection, filed as `issues/2026-11-25-a-cond-of-dyn-references-passed-to-a-reference-parameter-is-read-as-a-temporary.md`.
`Box(&Cat)` is E0909, and `&c` is no block or arm value. A `dyn(&c)` at a by-value `Option`, as a
constructor's reference field or inside `Option(&Dyn(T)).Some(...)` already froze `c`.

Tests: seven `comptime_expect_error` rows and one positive row in `tests/dyn-pointer-kinds.test.yo`
("a dyn(&v) at a reference parameter lends v to the call's result", "a dyn(&v) call result outlives its
statement while v stays put"), and the pair `tests/origins/unsound/dyn-place-ref-param-result-move{,-pos}.yo`.
Test 7's overlay flips the headers of `dv01`, `dv04` and `dv05` to `// expect: accept`
(`scripts/test7/respell-manifest.tsv`).
