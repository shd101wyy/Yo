# `yo fix --migrate deref` doubles a migrated `.*` when its own old reading stops the file's evaluation

**Severity:** S2: the migration tool corrupts code that is already migrated. A second run over a migrated file can turn `&pts.*` into `&pts.*.*`, which does not type-check, and it only reports that the file "does not evaluate". The v0.2.79 deref flip re-runs the migration over std and src, which already hold sites of this shape.

**Status:** FIXED in the v0.2.79 deref flip. Found 2026-11-15 by the sweep lane while folding develop into `vbd/deref-text`.

## Reproducer

`issues/repros/2026-11-15-migrate-deref-doubles-a-swept-star-when-the-recorders-old-reading-aborts-the-files-evaluation.yo` is already in the new spelling, and `yo check` accepts it. It contains a binding of an `Rc`-handle field, matched inside an `Rc` payload, and lent with `&pts.*`:

```yo
Cell :: (fn(comptime(T) : Type) -> comptime(Type))(struct(items : ArrayList(T)));
List :: (fn(comptime(T) : Type) -> comptime(Type))(Rc(Cell(T)));
N :: enum(Leaf, Func(param_types : List(Rc(Self)), n : i32));
count :: (fn(l : &List(Rc(N))) -> usize)(l.items.len());
f :: (fn(t : &Rc(N)) -> usize)(
  match(
    t,
    Rc(.Func({ param_types : pts, n : _ })) => count(&pts.*),
    _ => usize(0)
  )
);
peek :: (fn(n : &i32) -> i32)(n.*); // evidence that the file is migrated, evaluated after f
```

`yo fix <file> --migrate deref`, run with the v0.2.78 tree binary (the deref-text stage 1), prints:

```text
fix: <file> does not evaluate; its references are migrated only as far as evaluation reached
fix: applied 1 edit(s) …
```

It rewrites `count(&pts.*)` to `count(&pts.*.*)`.

## Root cause

This is the case `issues/fixed/2026-11-04-migrate-deref-adds-a-second-star-on-a-second-run.md` left open, reached by a new route:
- While recording, an edit-3 ("payload") site in a file that `note_deref_migrated_file` has not seen yet is evaluated the OLD way, as the `Rc`'s payload. That is `property_access.yo`'s old-payload evaluation, gated on `deref_file_migrated` since `2cd3b1113`.
- For `&pts.*`, the old reading is a `&Cell(…)` at a `&List(…)` parameter. The evaluation throws E0601, which stops the file before it reaches the evidence site (`peek`'s `n.*`).
- The file is therefore never noted as migrated, so the apply stage treats the recorded payload edit as a fresh one and appends the second `.*`.

In short, the evidence rule depends on evaluation order, and the recorder's own speculative old reading can end evaluation before any evidence is reached.

## Where it bit

- Folding develop into `vbd/deref-text` (2026-11-15), a re-run with a deletion binary doubled `src/evaluator/values/impl.yo:217` (`slot_pointee_at(&pts.*, i)`) and `src/codegen/functions/declarations.yo:134` (`t_slot_pointee(&result_slot.*)`).
- Each doubled line stopped the file at that site, and with it every file that imports it: 14 src files went unmigrated (the fold kept only edits on develop-new lines, `vbd-logs/sweep/tools/ownfilter.py`).

## Fix direction

When the old reading of an edit-3 site fails to type-check, try the new reading before giving up:
- If the new reading succeeds, the site is migrated text: note the file and leave the site as written.
- Otherwise, collect a file's evidence before applying any of its edit-3 sites, for example by scanning it syntactically for a written `.*` whose pointee no `.*` reaches into.

The test is a `tests/cli-cases/fix-migrate-deref-*` case over the repro: it must leave the file unchanged and report no evaluation failure.

## Fix (2026-11-16, the v0.2.79 deref flip)

Two routes, two fixes:

- **The repository's trees.** The recorder reads every written `.*` in std, src, `scripts/` and `build.yo`
  as the new spelling (`is_deref_swept_tree`, `deref_text_is_new_spelling`, from the d49-flip lane's
  `bcb908907`). No old source is left there, so no edit-3 site is recorded or evaluated the old way.
  `issues/fixed/2026-11-15-the-deletion-binary-rejects-the-swept-lend-of-an-rc-handle-binding-in-src.md`
  was this route.
- **Any other file.** This is the first fix direction above. `_run_migrate_deref` (`src/main.yo`)
  evaluates again every file that did not evaluate, in one child process (`YO_FIX_DEREF_ASSUME_MIGRATED`).
  That process reads the written `.*`s of the failed files that recorded an edit-3 site and showed no
  evidence as the new spelling from the start (`note_deref_assumed_migrated`, which `deref_file_migrated`
  consults). A file that evaluates there is migrated text, or imports some: the child's sites replace the
  host's for it, and an assumed file counts as migrated. A file that fails in both is reported as before.

**Test:** `tests/cli-cases/fix-migrate-deref-old-reading-stops-a-migrated-file` (the reproducer). It
applies 0 edits and reports no evaluation failure. Develop `1f9ac3d8b` applies `&pts.*.*` and reports
the file as not evaluating.
