# An `FnMut` closure stores its per-call reference parameter through a method of a `&mut` capture

**Severity:** S1 — use-after-free in safe code: a closure `{ s : &mut slot }(v : &Rc(X)) => { _old := s.replace(v); }` passed as `&mut Impl(FnMut(v : &Rc(X)) -> unit)` stores the per-call `v` into the caller's `slot`. `each` drops the `Rc` after the call, and reading `slot` afterwards is an ASan heap-use-after-free.

- Filed: 2026-11-19 by the test 7 lane, from the rehearsal of test 7 leg (b) (`scripts/test7.sh`; `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). The program is from the 2026-11-11 audit's frozen probe corpus (`scripts/test7/audit-corpus.tar.gz`, `probes/closures/h16.yo`).
- Reproduces on develop `939fe7160` (a stage 1 of `d8f0d89fa`) and on the pending cluster branch `v0279/clusters` `76f6aaf03` (a stage 1 built from it). The cluster branch's fixes do not close it.
- **Status: FIXED** on `v0280/s1-origins` (the v0.2.80 s1-origins lane). The reproducer is the G-B row `tests/origins/unsound/t7-fnmut-capture-method-stores-param.yo`.

## Reproducer

`tests/origins/unsound/t7-fnmut-capture-method-stores-param.yo` (the reproducer as filed, with its header comment):

```yo ignore
// expect: E0923
// H2 through Option.replace (prelude method) on the captured slot
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
each :: (fn(f : &mut Impl(FnMut(v : &Rc(X)) -> unit)) -> unit)({
  k := Rc.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz")));
  f(&k);
});
main :: (fn() -> unit)({
  mut(slot) := Option(&Rc(X)).None;
  each(&mut ({ s : &mut slot }(v : &Rc(X)) => {
    _old := s.replace(v);
  }));
  match(slot, .Some(r) => println(`OUT: ${r.*.*.s.len().to_string()}`), .None => println("none"));
});
export(main);
```

```bash
yo check tests/origins/unsound/t7-fnmut-capture-method-stores-param.yo --std-path ./std                       # rc 0: accepted
yo compile tests/origins/unsound/t7-fnmut-capture-method-stores-param.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t
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

The direct store `s.* = .Some(v)` in the same closure is E0923 ("Cannot store a value holding `v` into `slot` through the capture `s : &mut slot`: `v`'s origin is this literal's per-call parameter"). That is A35/A50's fix. The same store spelled as a method call on the capture, `s.replace(v)` (`Option.replace(self : &mut Self, v : T)`), is accepted. The method's `lend_through` into its receiver is not run against the capture's outer place, so the per-call origin of `v` escapes into `slot`.

## Neighbours

- **Rejected, E0923:** the direct store `s.* = .Some(v)`.
- **Accepted, ASan heap-use-after-free:** `s.replace(v)` in the probe, on develop and on `v0279/clusters`.

## Audit row and cluster

This neighbours A35 (`issues/fixed/2026-11-11-an-fnmut-closures-by-value-state-can-store-a-per-call-reference-parameter-or-a-body-local.md`) and A50 (`issues/fixed/2026-11-11-a-body-may-store-a-reference-to-its-own-by-value-capture-through-a-mut-capture.md`), both cluster 7 (captures). The missing step is a method's `lend_through` into a capture (A4's mechanism, cluster 5), so the fix belongs where A4's method form was fixed.

## Closing it

Fix the rule or wall the position (a rejection with an error code at exactly these positions). Then move the reproducers into `tests/origins/unsound/` so G-B pins the result, and add their attribution rows to `scripts/test7/attribution.tsv` as rejected.

## Root cause

Not the capture: the hole was `lend_through`'s step 3 (`src/evaluator/calls/function.yo`) for a specialized generic
container's method, and it is wider than the closure. Two gaps, plus one found beside them:

1. **A `T := &X` argument was never selected.** `Option(&Rc(X)).replace(self : &mut Self, value : T)` reaches step 3
   with slots that spell no origin parameter and no type variable, so the store's candidates are the arguments whose
   type occurs among the pointee's type arguments (A4's `by_type_argument`). A binder-typed by-value slot specialized
   to a reference is R3's `ValueSlot(&Rc(X))`, while `Option`'s type argument is the bare `&Rc(X)`:
   `_type_occurs_in_type_arguments` compared the wrapper and never matched. With `T := H` (A4's own row, a struct) the
   slot is plain `H` and it matched, which is why A4's fix covered holders and not references. The same `ValueSlot`
   made `_origin_position_pairs` pair nothing for `value : T` at `T := &(X, p)`, so step 2's exact check never saw
   such an argument either.
2. **A write-back into a `&mut` PARAMETER skipped the subset check.** Step 3 joined the solved roots into the holder
   with `bind_join_roots_for`. For a `&mut` capture that reaches `_capture_store` (E0923 for a per-call parameter);
   for a parameter of the body it joined silently, while the direct store `s.* = .Some(v)` goes through
   `place_write_join`'s subset checks (E0923: each elided `&` is its own origin, O2). With spelled origins the
   difference is a use-after-free: `f(generic(p, q), s : &mut Option(&(Rc(X), p)), v : &(Rc(X), q))` calling
   `s.replace(v)` or `store(s, v)` was accepted, and the caller fixes `p` from its slot and leaves `q` free.

## Fix

- `_lend_through_solve` (step 3's solve, extracted so the nested-`&mut` form of the generic-wrapper fix can share it)
  unwraps a `ValueSlot` before the occurs check, and `_origin_position_pairs` reads through a `ValueSlot` on either
  side.
- Step 3 writes back through `_lend_write_back_into`: a holder that is a parameter of the body being evaluated (its
  declared slot, `param_declared_origin_slot`) has each stored argument judged by `place_write_join`, exactly as the
  store through it would be; any other holder (a flow-inferred local, a `&mut` capture) joins as before.

Rows (`tests/origins/unsound/`, every negative accepted before the fix): `t7-fnmut-capture-method-stores-param` (the
reproducer), `t7-user-generic-method-capture-stores-param` (a user generic container's `&mut self` method on the
capture), `t7-generic-method-stores-ref-param` (`s.replace(v)` across two spelled origins),
`t7-generic-method-stores-holder-param` (the same with a by-value holder `H(q)`) and
`t7-generic-free-fn-stores-ref-param` (`store(s, v)`), all E0923; positive twins
`t7-fnmut-capture-method-stores-param-pos` (the closure stores a reference it captured from outside) and
`t7-generic-method-stores-ref-param-pos` (both parameters over one `p`), both clean under ASan. Found beside it and
filed: `issues/2026-11-20-a-lend-passed-to-a-methods-by-value-binder-parameter-is-reported-as-e0910-not-e0914.md`.
