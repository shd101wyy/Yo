# A box lent where a `&Dyn` is taken has no migration after the flip

**Severity:** S2 (code that v0.2.77's `--migrate unsized` left as written stops compiling on v0.2.78, with a bare type mismatch and no tool to repair it)

## What happened

Before the decision 49 S2 flip, `Box(Dyn(T))` was an alias of the owning value `Dyn(T)`, so `&b` of one was
a `&Dyn(T)`, and passing it where a `&Dyn(T)` is taken was correct. VERDICTS-40 §5 planned a migration
family (d) that rewrites such a lend as `&b.*`, and VERDICTS-55 confirmed it. It never landed: v0.2.77's
`--migrate unsized` records kinds 1, 2, 3, 5 and 6 and the type spellings, and nothing for (d). After
the flip `Box(Dyn(T))` is the prelude's real `Box`, `&b` is a `&Box(Dyn(T))`, and nothing coerces it to a
`&Dyn(T)` (no deref coercion, approved 2026-11-07). Code migrated by v0.2.77 then failed on v0.2.78:

```text
error[E0601]: Cannot unify incompatible types:
Expected: "Dyn(Fn(&mut i32) -> unit)"
Given: "Box(Dyn(Fn(&mut i32) -> unit))"
```

The same mismatch hit an enum payload (`.Some(&self.cause)` into an `Option(&Dyn(...))` result). The
plan's text (VERDICTS-61 decision 6, `plans/handover/VBD_RELEASE_SCHEDULE.md` item 51) assumed v0.2.78
still accepted "the `&d`-into-`&Dyn` lend" for S3b-`Dyn` to delete in v0.2.79; the flip never had it.
The language tests that tripped it: `shared_borrow_write`, `ref_payload_binding` and `fn` (a `Box(Dyn)`
temporary passed to a `&Dyn` parameter).

## Fix

Coordinator verdict, option B: no coercion.

- `legacy_box_dyn_lend` (`src/evaluator/utils.yo`), at a call argument (`_evaluate_funcval_runtime_call`)
  and a constructor field (`calls/type.yo`), raises E0601 naming the object's lend, `&b.*`, and the
  two-step upgrade of v0.2.77 code. A `Box(Dyn)` temporary gets the help `dyn(&v)` or a bound box.
- Under `yo fix <path> --migrate unsized` the site is recorded instead of raised: kind 7, a named place or
  field chain, gets `.*` appended; kind 8, a temporary, is listed. The evaluation then goes on to the
  file's other sites.
- E0619's help, `yo explain E0619` and `E0601`, the `yo fix` help and `ERROR_DIAGNOSTICS`/`DYN_DESIGN`
  (en-US, zh-CN) state the two steps: on v0.2.77, `yo fix <path> --migrate unsized` for the types; then
  on v0.2.78, `yo fix <path> --migrate unsized` for the lends.
- S3b-`Dyn`'s "delete the lend" item is moot. The correction is recorded in
  `plans/handover/VBD_RELEASE_SCHEDULE.md` item 51.

## Tests

- `tests/dyn.test.yo`, "a Box(Dyn) lent where a &Dyn is taken": `&b` at a parameter and at a field is
  E0601 with the `&b.*` help, and `&b.*` lends the object.
- `tests/cli-cases/fix-migrate-unsized-lends`: the migration writes `&b`, `&mut d` and `&h.b` as `&b.*`,
  `&mut d.*` and `&h.b.*`, lists the temporary, and the file then type-checks.
- `tests/shared_borrow_write.test.yo` and `tests/ref_payload_binding.test.yo` were migrated by the new
  mode. `tests/fn.test.yo`'s temporaries were rewritten by hand.
