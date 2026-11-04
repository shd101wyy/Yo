# `yo fix --migrate deref` adds a second `.*` on a second run

**Severity:** S3: a migration tool corrupts code it already migrated. A second `yo fix <path> --migrate deref` over a migrated file appends another `.*` to every read through a reference to a `Box`, an `Rc`/`Arc`, a pointer or a cell handle. The result usually fails to type-check, and the tool reports nothing. N3's sweep over std and src depends on the mode.

**Status:** FIXED 2026-11-04 (vbd/d43-step2-n1e2, N1e-2a). The fix covers a file that already reads any reference with `.*`, and a `b.*.*` read anywhere. The test is the cli case `tests/cli-cases/fix-migrate-deref-twice`; it fails on the N1e-1 binary (#1752) and passes after the fix.

## Reproducer

`tests/cli-cases/fix-migrate-deref-twice/fixture/main.yo`, migrated twice:

```yo
peek :: (fn(n : &i32) -> i32)(n);
unbox :: (fn(b : &Box(i32)) -> i32)(b.*);
```

The first run writes `n.*` and `b.*.*`, which is correct. The second run rewrites `b.*.*` to `b.*.*.*`. Re-running the mode over `tests/` after the develop merge (2026-11-04) over-migrated 24 lines, among them `a.*.*.*.count`, `self.*.*.*.*` and a cell handle's `___dup(self.*.*)`. They were reverted by hand in N1e-1 (#1752).

## Root cause

The migration reads old source. In old source, `b.*` on `b : &Box(T)` is the `Box`'s payload, and the recorder rewrites it to `b.*.*` (`property_access.yo`, the `.*` arm under `deref_rule_recording()`). A migrated file spells the reference's own deref the same way, `b.*`. The recorder judged every such `.*` by the pointee's type alone, so it read the new spelling as the old payload read again.

## Fix

The site is no longer an ordinary append. It is recorded as its own edit kind (3, "payload"). Two pieces of evidence settle the ambiguity:
- A written `r.*` on a reference whose pointee no `.*` reaches into (`n.*` with `n : &i32`) cannot be old source: that `.*` was E0920 before N1e-1. The evaluation notes its file (`note_deref_migrated_file`), and `_run_migrate_deref` (`src/main.yo`) leaves that file's payload edits as written, naming each one.
- In `r.*.*`, when the payload the old reading would reach is not itself read through by `.*` (`deref_payload_type`), the old reading of the chain is ill-typed. The inner `.*` is then the reference's deref an earlier run wrote. This decides the chain without other evidence, and it also notes the file.

What remains open: a file whose only references are to `Box`/`Rc`/pointer/cell handles, read only by a single `.*` (`h.*` with `h : &Rc(T)`), holds no evidence either way. A second run still doubles that `.*`. Run the mode once per file.
