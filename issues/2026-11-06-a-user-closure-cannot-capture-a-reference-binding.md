# A user closure cannot capture a reference binding (spelled files)

**Severity:** S2 — a closure that lists a reference binding in its capture list is rejected in every spelled file, so a closure cannot capture a borrow.

- Filed: 2026-11-06 (deref adoption lane, `vbd/deref-adoption`).
- Owners: the N1e-2b / R1 lane (the read rule's capture shape); adjacent to
  BRIEF-28 Q1 and to G1's unfiled "a user closure can't capture a
  `&mut Impl(FnMut)` parameter" (`~/Workspace/Yo-wt/v0273/fable/BRIEF-28-callonce-slots-and-mut-binding.md`).

## The bug

A closure whose capture list names a reference binding fails to evaluate in
every SPELLED file (user code, and std/src after N3's adoption sweep). Two
failure modes, same shape:

1. Before the adoption (any tree, a non-exempt user file): `error[E0920]:
   \`self\` is a \`&\` borrow ...` — an internal `.*` the closure/call
   machinery synthesizes hits the E0920 fall-through in
   `src/evaluator/exprs/property_access.yo` (auto-generated code kept the old
   reading, and the fall-through has no exemption gate of its own).
2. With the deref exemption fully deleted (the first cut of the adoption
   commit): `error[E0926]: \`y\` is a reference (\`&i32\`): reading the value
   it refers to is spelled \`y.*\`` — the capture-list judge reads the entry
   as a whole-value read, and the synthesized `___dup(r)` capture dup is
   judged too (`std/sync/once.yo`'s `call(f : &Impl(Fn() -> unit))`, which
   captures `f` in its `with_lock` closure, was the std-side exposure).

The same capture WORKS inside std today only because std was deref-exempt.

## Reproducer

```yo ignore
zz_cap5 :: (fn(go : bool) -> i32)({
  mut(x) := i32(1);
  y := &x;
  (g : Impl(Fn() -> i32)) = ({ y }() => y.*);
  g()
});
export(zz_cap5);
```

On develop `8d475cd81` + part B `9f221ac0f`, `yo check` of this in a
non-exempt file was E0920 (`self` is a `&` borrow). Re-verified 2026-11-07 on
develop `dddff6a67` (after #1816) and on the adoption branch: the error is
now E0926 at the capture (`y` is a reference (`&i32`): reading the value it
refers to is spelled `y.*`), and a renamed capture `{ r : y }` fails the
same way. A `&Impl(Fn() -> unit)` parameter captured the same way fails
identically.

## What the deref adoption does about it

The adoption branch (`vbd/deref-adoption`, N3 deref Generation B for
v0.2.77, VERDICTS-34) keeps compiler-synthesized `auto-generated://` code
on the old reading via an inline guard in `deref_rule_applies`
(`src/evaluator/utils.yo`): the capture `___dup(r)` machinery and the
derive-generated bodies do not spell `.*`, so judging them would reject every
closure capture of a reference. The PATH trees (std, src, scripts/,
build.yo, the store) are judged alike as planned. The spelled-file capture
shape stays broken exactly as it is on develop — not fixed here, because the
fix is the read rule's capture semantics (R1: a reference is `Copy`, so a
capture copies the reference), which is the R1 lane's design question.

## The fix this issue tracks

Make a capture-list entry that names a reference binding a reference read
(R1-clean: `&T` is `Copy`, the capture copies the reference; `&mut T`
reborrow per decision 43), including the synthesized `___dup`/`___drop`, and
then delete the adoption's `auto-generated://` guard (on develop that code is
kept on the old reading by `is_deref_rule_exempt`) together with the E0920
fall-through (SEED_VERSION_AUTOMATION.md's third deletion).
A failing-then-passing test belongs with that fix: the reproducer above
against `tests/local_borrows.test.yo`.
