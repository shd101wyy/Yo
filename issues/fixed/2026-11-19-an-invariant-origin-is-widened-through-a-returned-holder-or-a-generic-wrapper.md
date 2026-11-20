# An invariant origin is widened through a returned holder or a generic wrapper

**Severity:** S1 — use-after-free in safe code: `Slot(p) :: struct(dst : &mut Option(&(Rc(X), p)))` is invariant in `p`. A helper `widen(generic(p, q), s : Slot(p), w : &(Rc(X), q)) -> Slot((p, q))` that returns `s` unchanged is accepted. The caller then stores a block-local `&y` into the outer `slot` through the widened holder, and the read after the block is an ASan heap-use-after-free.

- Filed: 2026-11-19 by the test 7 lane, from the rehearsal of test 7 leg (b) (`scripts/test7.sh`; `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). The program is from the 2026-11-11 audit's frozen probe corpus (`scripts/test7/audit-corpus.tar.gz`, `probes/generics/v06-helper-widen.yo, v06b-helper-widen-direct.yo and v02-generic-wrapper-T.yo`).
- Reproduces on develop `939fe7160` (a stage 1 of `d8f0d89fa`) and on the pending cluster branch `v0279/clusters` `76f6aaf03` (a stage 1 built from it). The cluster branch's fixes do not close it.
- **Status: FIXED** on `v0280/s1-origins` (the v0.2.80 s1-origins lane). The reproducers are the G-B rows `tests/origins/unsound/t7-widen-invariant-result.yo`, `t7-widen-invariant-result-direct.yo` and `t7-generic-wrapper-mut-store.yo`.

## Reproducer

`tests/origins/unsound/t7-widen-invariant-result.yo` (the reproducer as filed, with its header comment):

```yo ignore
// expect: E0923
// Widening an invariant holder by returning it from a helper typed Slot((p, q)).
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
Slot :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(dst : &mut Option(&(Rc(X), p))));
widen :: (fn(generic(p : Origin, q : Origin), s : Slot(p), w : &(Rc(X), q)) -> Slot((p, q)))(s);
put :: (fn(generic(p : Origin), s : &mut Slot(p), v : &(Rc(X), p)) -> unit)({
  s.dst.* = .Some(v);
});
main :: (fn() -> unit)({
  x := Rc.new(X(s : String.from("x")));
  mut(slot) := Option(&(Rc(X), x)).Some(&x);
  {
    y := Rc.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz")));
    mut(s2) := widen(Slot(x)(dst : &mut slot), &y);
    put(&mut s2, &y);
  };
  match(slot, .Some(r) => println(`OUT: ${r.*.*.s.len().to_string()}`), .None => println("none"));
  ()
});
export(main);
```

Also `tests/origins/unsound/t7-widen-invariant-result-direct.yo`: the write through the widened holder's field directly (probe v06b).

Also `tests/origins/unsound/t7-generic-wrapper-mut-store.yo`: the invariance lost through a user generic wrapper `W(&mut Option(T))` at `T := H` (probe v02).

```bash
yo check tests/origins/unsound/t7-widen-invariant-result.yo --std-path ./std                       # rc 0: accepted
yo compile tests/origins/unsound/t7-widen-invariant-result.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t
ASAN_OPTIONS=detect_stack_use_after_return=1 ./t
```

ASan, on the cluster-branch binary (develop gives the same report):

```text
ERROR: AddressSanitizer: heap-use-after-free on address … thread T1
READ of size 8 at … thread T1
… is located 16 bytes inside of 32-byte region
SUMMARY: AddressSanitizer: heap-use-after-free
```

## What happens

O3-3 makes an origin under `&mut` invariant. A24's fix (#1939) applies that invariance to a `&mut` nested inside a by-value ARGUMENT at a call. Two positions are still not covered:

1. **A function's result.** `widen`'s body returns `s : Slot(p)` as `Slot((p, q))`. That is a subset coercion of an invariant parameter, and `return_check` should reject it at the definition (E0923). The caller then trusts the widened type: `put(&mut s2, &y)` (or `s2.dst.* = .Some(&y)`) stores `&y` into `slot`.
2. **A user generic wrapper at the type level.** `put(generic(T), w : W(&mut Option(T)), v : T)` at `T := H` (`H :: struct(r : &Rc(X))`) accepts `H(r : &y)` from an inner block into the outer slot. The invariance of `T` under `&mut`, reached through the type constructor `W`, is not enforced when `T` is unified.

## Neighbours

- **Rejected, E0923:** passing `Slot(x)(dst : &mut slot)` and `&y` to `put` directly, which is A24's fixed form.
- **Accepted, ASan heap-use-after-free:** the three reproducers, on develop and on `v0279/clusters`.

## Audit row and cluster

A24 (`issues/fixed/2026-11-11-a-mut-nested-inside-a-by-value-argument-does-not-make-its-origin-invariant-so-a-call-widens-it.md`), cluster 5 ("a signature is trusted without its check": invariance under a by-value wrapper). The audit ledger lists v02 under G-F1 (A24). It lists v06/v06b under G-F1 too, and its G-F9 note calls their diagnostics wrong, which predates their acceptance. These are residuals of a fixed row.

## Closing it

Fix the rule or wall the position (a rejection with an error code at exactly these positions). Then move the reproducers into `tests/origins/unsound/` so G-B pins the result, and add their attribution rows to `scripts/test7/attribution.tsv` as rejected.

## Root cause

1. **The result.** `return_check` (`src/evaluator/utils.yo`) judged a result's ROOTS (a local is E0912, a parameter
   outside the spelled result origin E0923). `widen`'s `s` is a by-value parameter: it has no root of its own, and its
   type's origin `p` is inside the spelled `(p, q)`, so the covariant reading passed. Nothing compared the value's type
   with the declared result at the positions O3 step 3 makes invariant.
2. **A24's own fix held by a coincidence of names.** An instance's field types keep the type constructor's OWN
   parameter names (`Slot(x)`'s field is `dst : &mut Option(&(Rc(X), p))` with `Slot`'s `p`, not `x`).
   `_mut_pointee_origin_names` collected those names and step 1 compared them with the signature's: A24's row
   spells `generic(p : Origin), s : Slot(p)` over `Slot :: (fn(comptime(p) : Origin) ...)`, so it matched. Renaming
   either side (`generic(r : Origin), s : Slot(r)`, or `comptime(z)` in `Slot`) reopened A24: both are accepted and
   ASan-dirty on the clusters binary. The return check's first cut had the same blind spot (a field pairs `p` with
   `p`). Filed and fixed on its own:
   `issues/fixed/2026-11-20-a24s-invariance-check-matches-the-type-constructors-parameter-names-against-the-signatures.md`.
3. **The generic wrapper.** `lend_through`'s step 3 (the flow write-back, `src/evaluator/calls/function.yo`) ran only
   for a parameter whose own type is a top-level `&mut`. A24's fix taught step 1 to fix the origins under a `&mut`
   nested in a by-value parameter, but `W(&mut Option(T))` spells no origin parameter at all: `T` is the inference
   variable, and only step 3 solves it. So `put(W(...)(inner : &mut slot), H(r : &y))` never joined `y` into `slot`.

## Fix

1. A type constructor's argument takes its variance from its fields by the constructor's own parameter names
   (`_ctor_arg_is_invariant`, `src/evaluator/utils.yo`): the struct's `constructor_func_id` (an enum's registered
   constructor) names the type function, whose parameter at that position is searched for below a `&mut` pointee in
   the fields, recursively through a nested constructor's invariant arguments. `invariant_origin_names(ty)` lists the
   origins a type spells at its invariant positions, and step 1's nested form uses it instead of the field names.
2. `return_check` pairs the declared result with the value's type (`_return_check_invariant_origins`,
   `_invariant_origin_pairs`): through reference pointees, constructor arguments (each invariant by 1 or below a
   `&mut`), fields over substituted type arguments, enum payloads and tuple components, every invariant origin
   position must carry exactly the spelled set, else E0923 at the result. A covariant position (`View(p)`'s `&(T, p)`
   field) still widens, and a position the value leaves elided is judged by the roots as before.
3. Step 3 also walks a by-value parameter's nested `&mut` pointees (`_nested_mut_pointees`: struct fields and type
   arguments, enum payloads, tuple components; a `&` stops the walk). When their origin or type parameters are not
   fixed by step 1, the call's other arguments over the same parameters are solved (`_lend_through_solve`, shared with
   the top-level form) and written back into the places the argument's `&mut` borrows (its `origin_of` roots in `&mut`
   mode), through `_lend_write_back_into`. `slot` then holds `y`'s origin, and the read after `y`'s block is E0911.

Rows (`tests/origins/unsound/`, every negative accepted before the fix): `t7-widen-invariant-result` (the probe v06),
`t7-widen-invariant-result-direct` (v06b) and `t7-widen-invariant-tuple-result` (the holder inside a tuple result),
E0923; `t7-generic-wrapper-mut-store` (v02) and `t7-generic-wrapper-tuple-mut-store` (`Tuple(&mut Option(T), i32)`),
E0911. Positive twins: `t7-widen-invariant-result-pos` (the holder returned at its own origin),
`t7-widen-invariant-result-direct-pos` (a covariant `View(p)` widened through a result) and
`t7-generic-wrapper-mut-store-pos` (the wrapper stores a holder over an outer place), all clean under ASan.
