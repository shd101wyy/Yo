# `yo fix --migrate deref` cannot evaluate a migrated `io.async` capture of a `&` parameter

**Severity:** S2: the migration stops on code that is already migrated. A file whose `io.async` capture
list borrows a `&` parameter whole, `{ r : &r.* }` (the spelling §3.13 A2 asks for), "does not evaluate"
under `yo fix --migrate deref`, so nothing in it, or in any file that imports it, is migrated. Nothing
miscompiles: `check`, `compile` and `test` read the capture correctly.

**Status:** FIXED in the v0.2.79 deref flip (`vbd/deref-flip`). Found 2026-11-16 by the flip lane: once std's
`io.async` capture lists were swept, the deletion binary's migration over src stopped in 87 files, every one
of which imports `std/process` or another swept std module.

## Reproducer

`tests/cli-cases/fix-migrate-deref-keeps-a-migrated-io-async-capture/fixture/main.yo`:

```yo
Res :: struct(n : i32);
read_n :: (fn(r : &Res, io : Io) -> Impl(Future(i32)))(
  io.async({ r : &r.* }(io : Io) => {
    return(r.*.n);
  })
);
```

With develop `1f9ac3d8b`'s compiler, `yo fix main.yo --migrate deref` prints
`fix: main.yo does not evaluate` and exits 1. The hidden error (`YO_AUDIT_DEREF=1 yo check`) is A2's:

```text
error: An `io.async` body borrows a `&` parameter whole: `(r.(*))` is a place inside the parameter `r`, …
```

## Root cause

The capture path (`_evaluate_capture_list`, `src/evaluator/values/anonymous_function.yo`) drops the written
`.*` of a reference binding from the captured place's hops, so `{ r : &r.* }` borrows the parameter whole.
The seed rider (#1940) wrote that strip with `!deref_rule_recording()`: in recording mode it kept the `*`
as a hop, meaning "maybe old source, the payload". A2 then rejects the hop. But the recorder reads a written
`.*` the old way only where old source could have written it (`property_access.yo`): through a `Box`, a
handle or a pointer, in a file that shows no new spelling.

## Fix

The strip applies in recording mode under the same rule: the text is new spelling
(`deref_text_is_new_spelling`: a file with evidence, or the repository's swept trees), or the referent is
not read through by `.*` (`deref_reads_through_pointee`), where old source could not have written the `.*`
at all (it was E0920). The cli case above applies nothing, evaluates, and keeps the file.
