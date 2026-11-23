# `Box.new` of a reference-holding payload reports an E0911 from inside `Box.new`

**Severity:** S3 — the program is rejected, as it should be, but with an E0911 naming `Box.new`'s internals (`cell`, `unsafe.cast`) instead of the E0909 container wall that `Box(&String).new(&s)` gets.

Filed 2026-11-23 by the test 7 lane while respelling the audit corpus's drifted negatives
(`scripts/test7/respell-manifest.tsv`, plan `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). Probe: `probes/cells/dy02_dyn_box_of_ref_holder.yo`
in `scripts/test7/audit-corpus.tar.gz`. Reproduced with a stage 1 of develop `f06ff5889`.

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  s := String.from("abc");
  b := Box.new(Option(&String).Some(&s));
  println("OUT");
});
export(main);
```

```text
error[E0911]: Cannot bind `cell` to `unsafe((unsafe.cast)(&(addr), *(T)))`: its value holds a reference into `*(T)`, a temporary that ends with this statement, while `cell` lives on
  |   b := Box.new(Option(&String).Some(&s));
help: bind `*(T)` to a local first and lend the local
```

## Root cause

`Box.new`'s generic body is evaluated at `T := Option(&String)` before the payload's `Escapable` wall fires; its
internal R-TEMP check reports first. `Box(&String).new(&s)` hits the wall (E0909) because the type is spelled.

## Fix

Check the `Box`/`Rc` payload wall (`Escapable`, E0909) at the call before specializing the body.
