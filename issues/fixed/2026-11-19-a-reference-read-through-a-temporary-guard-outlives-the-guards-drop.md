# A reference read through a temporary guard outlives the guard's drop

**Severity:** S1 — use-after-free in safe code: `r := id(c.borrow_mut().get())`, where the guard's `Drop` replaces `c.xs`, is accepted. The temporary guard is dropped at the end of the statement, which frees the element `r` points into, and `r.*` is an ASan heap-use-after-free. The form `c.borrow_mut().me().get()` behaves the same.

- Filed: 2026-11-19 by the test 7 lane, from the rehearsal of test 7 leg (b) (`scripts/test7.sh`; `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). The program is from the 2026-11-11 audit's frozen probe corpus (`scripts/test7/audit-corpus.tar.gz`, `probes/cells/gl02_guard_temp_via_id.yo and gl03_guard_temp_chain.yo`).
- Reproduces on develop `939fe7160` (a stage 1 of `d8f0d89fa`) and on the pending cluster branch `v0279/clusters` `76f6aaf03` (a stage 1 built from it). The cluster branch's fixes do not close it.
- **Status: FIXED** on `v0280/s1-calls` (2026-11-20). It blocked claim (S) in v0.2.80 (VERDICTS-58 decision 7(b)). See "Fix" below.

## Reproducer

`tests/origins/unsound/c6-temp-guard-read-through-id.yo`:

```yo ignore
// expect: E0911
{ ArrayList } :: import("std/collections/array_list");
{ String } :: import("std/string");
{ println } :: import("std/fmt");
longs :: (fn() -> String)(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
Cell :: struct(xs : ArrayList(String));
Guard :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(c : &mut(Cell, p)));
impl(generic(p : Origin), Guard(p), Drop(drop : (fn(self : &mut Self) -> unit)({
  self.c.xs = ArrayList(String).new();
})));
impl(Cell, borrow_mut : (fn(self : &mut Self) -> Guard(self))(Guard(self)(c : self)));
impl(generic(p : Origin), Guard(p), get : (fn(self : &Self) -> &String)(&self.c.xs(usize(0))));
impl(generic(p : Origin), Guard(p), me : (fn(self : &Self) -> &Self)(self));
id :: (fn(a : &String) -> &String)(a);
mkc :: (fn() -> Cell)({
  mut(xs) := ArrayList(String).new();
  xs.push(longs());
  Cell(xs : xs)
});
main :: (fn() -> unit)({
  mut(c) := mkc();
  r := id(c.borrow_mut().get());
  println(`OUT: ${r.*}`);
});
export(main);
```

Also `tests/origins/unsound/c6-temp-guard-read-through-method-chain.yo`: the `.me().get()` chain form (probe gl03).

```bash
yo check tests/origins/unsound/c6-temp-guard-read-through-id.yo --std-path ./std                       # rc 0: accepted
yo compile tests/origins/unsound/c6-temp-guard-read-through-id.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t
ASAN_OPTIONS=detect_stack_use_after_return=1 ./t
```

ASan, on the cluster-branch binary (develop gives the same report):

```text
ERROR: AddressSanitizer: heap-use-after-free on address … thread T1
READ of size 8 at … thread T1
… is located 0 bytes inside of 96-byte region
SUMMARY: AddressSanitizer: heap-use-after-free
```

## What happens

`Guard(p)` holds `c : &mut(Cell, p)` and has a `Drop` that writes `self.c.xs`. `get(self : &Self) -> &String` returns `&self.c.xs(0)`. Its origin is the field's, which roots at `c` through the guard. The guard is a temporary of the statement. R-TEMP should make the reference's origin include the temporary, so storing it in `r` past the statement is E0911/E0912. A31's fix (#1906) unions a read through a holder's `&mut` field with the holder for a NAMED holder. A temporary holder that is reached through an identity call (`id(...)`) or a method chain (`.me().get()`) is not a root of `r`, so the guard's drop at statement end is not seen as a write under a live loan.

## Neighbours

- **Accepted, ASan heap-use-after-free:** `id(c.borrow_mut().get())` (probe gl02) and `c.borrow_mut().me().get()` (probe gl03), on develop and on `v0279/clusters`.
- **Fixed by the cluster branch (E0911):** the R-TEMP forms through a handle's `.*` or an inner projection call (A23: `F3b`, `tm22`, `tm24`, `tm25`). That fix covers projections, not a guard with a `Drop`.

## Audit row and cluster

The audit ledger files these probes under C-F2: A31, `issues/fixed/2026-11-11-a-read-through-a-holders-mut-field-does-not-keep-the-holder-frozen.md`, described as "temporary guard escapes guard3 check". Both A31 and A23 are cluster 6 ("rooting through an owning handle, and the reborrow union"), and the temporary is A23's R-TEMP. This is a residual of a fixed row.

## Closing it

Fix the rule or wall the position (a rejection with an error code at exactly these positions). Then move the reproducers into `tests/origins/unsound/` so G-B pins the result, and add their attribution rows to `scripts/test7/attribution.tsv` as rejected.

## Fix

Both forms pass a projection call's result on as the argument of another projection call: `c.borrow_mut().get()` to
`id`'s `a : &String`, and `c.borrow_mut().me()` as `.get()`'s receiver. That argument is a COMPUTED reference, not a
place. Its origin is R-CALL's over the inner call's root arguments, and the temporary guard `c.borrow_mut()` is one of
them (R-TEMP). Two sites read it as a place with `local_borrow_place_of`, which treats a call as its callee's place
and so walks `c.borrow_mut().get()` to `c`, skipping the guard:

- `_bind_projection_result` (`src/evaluator/exprs/initialization-assignment.yo`), for `r := id(...)` and
  `r := ….me().get()`. A root argument that is a computed reference (`is_computed_reference_operand`) now takes its
  places from `origin_of`, and a temporary among them is E0911 naming it ("holds a reference into
  `c.borrow_mut()`, a temporary that ends with this statement").
- `origin_of`'s recorded-lend shortcut (`_origin_of_into`, `src/evaluator/utils.yo`), for every sink that reads an
  origin: the typed declaration `(r : &String) = id(...)` and a holder `Option(&String).Some(id(...))`. A computed
  reference no longer takes the place shortcut and falls through to R-CALL, as A5 and A56 made a free function's
  and a closure value's call results do.

The same change fixes a false rejection. `r := id(id(&x))` was E0911 "a place inside `id(&(x))`, which is a
temporary", because the place walk found no place in the inner call. Its roots are now R-CALL's, here `x`.

Tests (G-B): `c6-temp-guard-read-through-id.yo` (gl02), `c6-temp-guard-read-through-method-chain.yo` (gl03),
`-id-typed.yo`, `-id-holder.yo`, the positive twin `c6-temp-guard-read-through-id-pos.yo` (the read inside the
statement, and a named guard), and `c6-nested-identity-projection-pos.yo`.
