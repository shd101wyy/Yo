# An invariant origin is widened through a returned holder or a generic wrapper

**Severity:** S1 — use-after-free in safe code: `Slot(p) :: struct(dst : &mut Option(&(Rc(X), p)))` is invariant in `p`. A helper `widen(generic(p, q), s : Slot(p), w : &(Rc(X), q)) -> Slot((p, q))` that returns `s` unchanged is accepted. The caller then stores a block-local `&y` into the outer `slot` through the widened holder, and the read after the block is an ASan heap-use-after-free.

- Filed: 2026-11-19 by the test 7 lane, from the rehearsal of test 7 leg (b) (`scripts/test7.sh`; `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). The program is from the 2026-11-11 audit's frozen probe corpus (`scripts/test7/audit-corpus.tar.gz`, `probes/generics/v06-helper-widen.yo, v06b-helper-widen-direct.yo and v02-generic-wrapper-T.yo`).
- Reproduces on develop `939fe7160` (a stage 1 of `d8f0d89fa`) and on the pending cluster branch `v0279/clusters` `76f6aaf03` (a stage 1 built from it). The cluster branch's fixes do not close it.
- **Status: OPEN.** It blocks claim (S) in v0.2.80 (VERDICTS-58 decision 7(b)) until it is fixed or walled. It does not gate the v0.2.79 cut.

## Reproducer

`issues/repros/2026-11-19-an-invariant-origin-is-widened-through-a-returned-holder-or-a-generic-wrapper.yo`:

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

Also `issues/repros/2026-11-19-an-invariant-origin-is-widened-through-a-returned-holder-or-a-generic-wrapper-direct.yo`: the write through the widened holder's field directly (probe v06b).

Also `issues/repros/2026-11-19-an-invariant-origin-is-widened-through-a-returned-holder-or-a-generic-wrapper-generic-wrapper.yo`: the invariance lost through a user generic wrapper `W(&mut Option(T))` at `T := H` (probe v02).

```bash
yo check issues/repros/2026-11-19-an-invariant-origin-is-widened-through-a-returned-holder-or-a-generic-wrapper.yo --std-path ./std                       # rc 0: accepted
yo compile issues/repros/2026-11-19-an-invariant-origin-is-widened-through-a-returned-holder-or-a-generic-wrapper.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t
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
