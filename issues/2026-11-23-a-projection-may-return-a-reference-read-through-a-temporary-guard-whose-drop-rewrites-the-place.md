# A projection may return a reference read through a temporary guard whose drop rewrites the place

**Severity:** S1 — safe code passes `yo check` and reads freed memory: the guard is dropped at the end of the projection body, its `Drop` replaces the `Box` the returned reference points into, and the caller reads the old payload.

Filed 2026-11-23 by the test 7 lane while respelling the audit corpus's drifted negatives
(`scripts/test7/respell-manifest.tsv`, plan `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). Probe: `probes/cells/gu10_guard_proj_temp_return.yo`
in `scripts/test7/audit-corpus.tar.gz`, respelled in `scripts/test7/respelled/`. Reproduced with a stage 1 of develop
`f06ff5889` (src and std unchanged through `b69bce2f5`).

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
Cell :: struct(b : Box(String));
Guard :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(c : &mut(Cell, p)));
impl(
  generic(p : Origin),
  Guard(p),
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      self.c.b = Box.new(String.from("released"));
    })
  )
);
impl(Cell, borrow_mut : (fn(self : &mut Self) -> Guard(self))(Guard(self)(c : self)));
impl(generic(p : Origin), Guard(p), get : (fn(self : &Self) -> &String)(&self.c.b.*));
f :: (fn(c : &mut Cell) -> &String)(&c.borrow_mut().get());
main :: (fn() -> unit)({
  mut(c) := Cell(b : Box.new(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz")));
  r := f(&mut c);
  println(`OUT: ${r.len().to_string()}`);
});
export(main);
```

```bash
yo check repro.yo --std-path ./std                    # rc 0: accepted
yo compile repro.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t && ./t
# ERROR: AddressSanitizer: heap-use-after-free
```

The probe itself (a `String` field, `self.c.s = String.from("released")`) is accepted too and reads the new string,
so ASan stays quiet on it; the `Box` payload makes the stale read visible.

## Root cause

Not traced to a line. This is the return-position residual of
`issues/fixed/2026-11-19-a-reference-read-through-a-temporary-guard-outlives-the-guards-drop.md`: that fix makes a
binding (`r := id(c.borrow_mut().get())`) and an `origin_of` read root at the temporaries, but a projection body
that yields `&c.borrow_mut().get()` is checked by the single-root rule against `c` alone, and the temporary guard's
drop at the end of the body (a write of `c.b`) is not an access against the place the result lends.

## Fix

Treat a temporary's drop inside a projection body as an access against the yielded place, or reject a projection
result read through a temporary with a `Drop` impl (the wall). Add the reproducer to `tests/origins/unsound/`.
