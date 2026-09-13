# `[package] yo` (the MSRV field) is parsed into the manifest and never read

**Status:** OPEN. Found 2026-09-13 while deciding whether the toolchain pin
should move from `.yo-version` into `yo.toml`.

## What

`src/manifest.yo` documents and parses a minimum-compiler-version field:

```toml
[package]
name = "tetris_yo"
yo   = "0.2.30"     # minimum compiler version ("" = unset)
```

It is parsed (`src/manifest.yo:443`), stored on the struct
(`Manifest.yo_version`, `src/manifest.yo:174`) and set when the manifest is
constructed (`src/manifest.yo:550`). **Those three sites are the only
occurrences in the tree.** Nothing ever reads `yo_version` back, so declaring
it has no effect: a package that says it needs 0.3.0 compiles happily under
0.2.32, with no warning and no error.

```
$ grep -rn "yo_version" src/ | grep -v "^src/version"
src/manifest.yo:174:    yo_version : String,
src/manifest.yo:443:  yo_version := match(_string_field(package, String.from("yo"), …
src/manifest.yo:550:      yo_version : yo_version,
```

(`read_yo_version` in `src/main.yo` is a different thing — it reads the
`.yo-version` TOOLCHAIN pin, which does work.)

## Why it matters

This is the documented mechanism by which a package states what it needs. It
is the analogue of Cargo's `rust-version`, and the complement to
`.yo-version`: the pin selects a toolchain, the MSRV states a requirement.
Only the first half exists. A dependency that requires a newer compiler than
the one resolving it fails somewhere deep in evaluation with an unrelated
error, when the manifest already carried the information needed to say so.

It is also the exact shape of an already-recorded hazard in this repo: a
mechanism that is exported, documented and never called, with every gate green
— the field parses, the tests pass, and the feature does not exist.

## What it should do

At minimum, when `[package] yo` is non-empty and the running compiler is older
than it, fail with a diagnostic naming both versions and the manifest — for
the ROOT package and for every dependency's manifest, since the more valuable
case is a dependency declaring a floor the consumer's toolchain does not meet.

Open questions for whoever takes it:

- Is it a hard error or a warning? Cargo makes an unmet `rust-version` a hard
  error during resolution, and prefers older dependency versions that do match.
  Yo's resolver could do the same, but that is a resolution-policy change, not
  just a check.
- Is it exact-or-newer, or a range? The field is documented as "minimum", so a
  bare version meaning ">=" is the smaller and more predictable choice.
- Where is it checked? It must not be in the evaluator — `src/manifest.yo` is
  read without the evaluator by design, so the check belongs where the manifest
  is loaded.

## Related

- `plans/archive/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md` §4.1 (the manifest
  schema that introduced the field).
- `plans/reference/VERSION_MANAGEMENT.md` (`.yo-version`, the toolchain pin —
  the half that does work).
