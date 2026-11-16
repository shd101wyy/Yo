# A deletion binary built on today's develop rejects swept `&x.*` lends of an `Rc`-handle binding in src

**Severity:** S2: a risk for the v0.2.79 deref flip lane. Text the v0.2.78 deref sweep wrote into src, which the current compiler accepts under the std/src exemption, is E0601 once the exemption is deleted. If the flip deletes it as planned, src stops compiling at these lines until they are understood.

**Status:** FIXED in the v0.2.79 deref flip (see "Resolution" below). Found 2026-11-15 by the sweep lane while folding develop `cf41795c3`..`e3c456200` into `vbd/deref-text`.

## What happens

The text sweep wrote these lines in src:

```yo ignore
// src/evaluator/values/impl.yo:217, pts bound by `match(ty, Rc(.Func({ param_types : pts, … })) => …)`, ty : &TypeValue
slot_pointee_at(&pts.*, i),
// src/codegen/functions/declarations.yo:133-134, result_slot bound the same way from `result : Rc(Self)`
result_is_ref := t_slot_is_borrow(&result_slot.*);
result := t_slot_pointee(&result_slot.*);
```

A deletion binary is develop plus `c18c9f556` (`is_deref_rule_exempt` deleted). The one used here is `vbd-logs/sweep/bin/yo-del3`, built on `07757f676` = develop `cf41795c3` + the sweep. It rejects the first line in check mode:

```text
error[E0601]: Cannot unify incompatible types:
Expected: "Rc(SharedListCell(Rc(Self)))"
Given: "SharedListCell(Rc(Self))"
    --> src/evaluator/values/impl.yo:217:31
```

So `pts.*` is read as the `Rc`'s payload, not as the reference's own deref. When line 217 is replaced by a bare `pts`, the same failure moves to `declarations.yo:134`.

## What does not reproduce it

The same shape in a user file, `issues/repros/2026-11-15-migrate-deref-doubles-a-swept-star-when-the-recorders-old-reading-aborts-the-files-evaluation.yo`, passes `yo check` with the deletion binary against a fully swept std copy, and with the v0.2.78 tree binary. That file has a generic `List(T) = Rc(Cell(T))` field in a recursive enum, matched inside an `Rc` payload and lent with `&pts.*`.

The difference therefore lies in the src context, not in the bare pattern. Candidates:
- the file's pragmas (`AllowUnsafe`);
- `SharedList`'s definition through `src/types/definitions.yo`;
- the binding's earlier `pts.len()` receiver use in the same arm;
- an interaction with `issues/fixed/2026-11-15-migrate-deref-doubles-a-swept-star-when-the-recorders-old-reading-aborts-the-files-evaluation.md` (only if a recording run's state leaks into the check).

## Reproduce

1. Take `vbd/deref-text` @ `4e892db73` (or develop after it merges) and apply `c18c9f556`, resolving it as `sweep-bin-del3` @ `50d7e419a` did: theirs, plus the rider's `deref_spelling_applies` call in `anonymous_function.yo` renamed to `deref_rule_applies`.
2. Re-sweep the 94 held-back lines. They block the deletion binary first: the `*T` `Clone` result type is E0926 in the prelude, which `derive(Allocator, Copy, Clone)` instantiates.
3. Run `<deletion binary> check src/evaluator/exprs/while.yo --std-path ./std`.

## For the flip lane

The flip PR must run step 3 over all of src before deleting the exemption for real. A swept site of this class needs a reading that both the tree binary and the deletion binary accept. Passing the reference itself (`slot_pointee_at(pts, i)`) is accepted by the deletion binary at line 217. Settle the real rule before choosing a respelling.

## Resolution (2026-11-16, the flip lane)

**It is the recorder, not the type checker.** With a clean deletion binary on develop `1f9ac3d8b`
(`vbd-logs/derefflip/bin/yo-del1`: develop plus the exemption's deletion, nothing else):

- `yo-del1 check src/evaluator/values/impl.yo --std-path ./std` passes (rc 0) once std's held-back
  `io.async` capture lists are swept, and `check ./src` reports 256/274 files. Every failure is one E0926
  at `src/evaluator/calls/function.yo:5290`, a develop-new line that the text sweep never saw. Line 217's
  `slot_pointee_at(&pts.*, i)` and `declarations.yo:134` type-check.
- The error quoted above, `Expected Rc(SharedListCell(…)) Given SharedListCell(…)`, is exactly the
  recorder's OLD reading of `pts.*`: the payload of the `Rc` that `pts` refers to. `yo fix --migrate deref`
  evaluates an edit-3 site that way in a file with no evidence yet. That is the src route of
  `issues/fixed/2026-11-15-migrate-deref-doubles-a-swept-star-when-the-recorders-old-reading-aborts-the-files-evaluation.md`.
  The sweep lane's runs that showed it were recording runs, and their importers stopped with it.

**Fix:** the recorder reads every written `.*` in the repository's swept trees (std, src, `scripts/`,
`build.yo`) as the new spelling (`is_deref_swept_tree`, `deref_text_is_new_spelling`; the d49-flip lane's
`bcb908907`, carried by the flip). The flip's migration of std and src with the deletion binary
(`bin/yo-del3`, 114 files: every file develop changed after the text sweep's base, plus the held-back files)
evaluated every file and applied 10 edits, all on develop-new lines of `function.yo`. Before the fix, 14 src
files did not evaluate.

**Test:** `std/deref_spelling.test.yo`, "&pts.* lends the Rc handle a reference match binding names": the
same shape (an `Rc`-handle payload binding of a reference scrutinee, lent `&pts.*` in a `while`), judged
in std since the flip.
