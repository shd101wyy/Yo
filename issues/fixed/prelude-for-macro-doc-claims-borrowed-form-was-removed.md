# The `for` macro's doc comment in `std/prelude.yo` still says the borrowed form `for(coll, inout(x) => body)` "was REMOVED" — the form is live one screen below the comment

**Status:** FIXED 2026-09-23
**Severity:** papercut (documentation) — the code is correct, tested and used;
the macro's own doc comment denies it exists, in the one file every Yo
programmer reads first.
**Found:** 2026-09-23, during the soundness/correctness audit of
`plans/archive/INOUT_LOCAL_BINDINGS_AUDIT.md` (verified with `yo 0.2.39` against
the tree's `std/`).

## Symptom

`std/prelude.yo:9904-9907`, the doc comment on the `for` macro:

```rust
/// The old borrow form `for(coll, inout(x) => body)` was REMOVED: it
/// required `ref`s into reallocatable storage, which is no longer
/// expressible. Object elements mutate in place through the value
/// handle; struct elements use an index loop with `get`/`set`.
```

Directly below it, the same macro implements exactly that form — the
`is_ref_form` arm (`std/prelude.yo:9976-10017`: hidden pin local, the
`__BorrowGuard` acquire, `__yo_borrow_check`, per-element
`inout(x) := ptr.*`) and the `is_map_ref_form` arm
(`std/prelude.yo:10018-10051`, the `(k, inout(v))` shape). The form is the
audit's §7 decision 2 (PR #476, merged 2026-09-08) and is gated by
`tests/for_macro_borrow.test.yo` (26/26 passing, re-verified 2026-09-23) and
`tests/for_macro_borrow_strict.test.yo`.

## Root cause

The comment is the **v4.1-era removal note**, added in `4bcdddc41`
(2026-06-12, #74) and never touched since (`git log -S 'was REMOVED: it' --
std/prelude.yo` shows exactly that one commit). When Phase C re-added the
borrowed form, the audit's doc-sweep list (§8 B6) enumerated
`docs/*/FLOWABILITY.md`, `docs/*/MEMORY_SAFETY.md`, the instruction files,
both cheatsheets, the three stale seams and `plans/README.md` — but not the
`for` macro's own comment in `std/prelude.yo`, so it survived the sweep.

## Fix

Rewrite the comment to describe both arms as they are: the value form
(`into_iter`, elements dup'd/copied), the borrowed form (pinned collection,
runtime borrow flag, in-place element binding, invalidating operations panic),
and the map form (key by value, value borrowed), pointing at
`plans/archive/INOUT_LOCAL_BINDINGS_AUDIT.md` §7. Keep the "Object elements
mutate in place through the value handle" guidance for the value form.

## Verification

- `tests/for_macro_borrow.test.yo` 26/26 and
  `tests/for_macro_borrow_strict.test.yo` 1/1 with `yo 0.2.39`,
  `YO_STD=$PWD/std` (2026-09-23) — the code the comment denies is exercised
  by every one of those tests.
- A doc-only edit; no behavior to re-gate beyond `yo check ./std`.

## Fix (2026-09-23)

The comment now documents all three arms — the value form, the borrowed
`for(coll, inout(x) => body)` (pin, borrow flag, in-place binding,
invalidation panics, the `Array(T, N)`/chain exclusion) and the map
`(k, inout(v))` form — plus a borrowed-form example, pointing at
`plans/archive/INOUT_LOCAL_BINDINGS_AUDIT.md` §7.

## Verification

Doc-only edit to `std/prelude.yo`. The six inout gating files re-run green
through the tree-built binary (which parses the edited prelude on every
compile): `ref_local_binding` 16/16, `for_macro_borrow` 26/26,
`for_macro_borrow_strict` 1/1, `ref_borrow_invalidation` 4/4,
`ref_field_borrow` 15/15, `ref_params` 8/8; `yo fmt --check` clean.
