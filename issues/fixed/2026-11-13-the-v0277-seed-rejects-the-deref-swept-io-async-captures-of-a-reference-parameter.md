# The v0.2.77 seed rejects the deref-swept `io.async` captures of a `&` parameter (§3.13 A2)

**Severity:** S2: the seed v0.2.77 cannot type-check std or src after N3's deref
Generation B sweep, so stage 1 of the swept tree fails. That blocks deref Generation B
in v0.2.78 unless something bridges the seed. Nothing miscompiles. The tree's own
compiler accepts the swept tree: `check ./std` and `check ./src` give rc=0 with the
deletion binary.

Filed 2026-11-13 by the `sweep` lane during the v0.2.78 W1 rehearsal (VERDICTS-58
decision 17). `yo fix std src scripts build.yo --migrate deref` ran with the local
deletion binary on `339d14ff3` and rewrote 85 `io.async` capture lists in 18 files.
The rewrite has this form:

```yo ignore
io.async({ &self, io }(e : IoExn) => …)          // before: borrows what `self` refers to
io.async({ self : &self.*, io }(e : IoExn) => …) // after: the same, spelled under the deref rule
```

`yo check ./std --std-path ./std` with v0.2.77 then reports 28 errors, and `check ./src`
reports 217 errors (through std's imports and `src/fetch.yo`, `src/build_runner.yo`,
`src/lock_file.yo`, `src/version_cache.yo`). All of them are this one:

```text
error: An `io.async` body borrows a `&` parameter whole: `(self.(*))` is a place inside the parameter `self`, which the future copies when it is made (plans/VALUES_BY_DEFAULT.md §3.13 A2). Borrow the parameter, `{ &self }`, and read `(self.(*))` in the body.
    --> std/process/command.yo:784:28
```

## Root cause

The capture-list borrow path (`_evaluate_capture_list`,
`src/evaluator/values/anonymous_function.yo`) drops the reference's own `.*` from the
place's field path only when `deref_rule_applies` holds. In v0.2.77 that predicate is
false in std and src (`is_deref_rule_exempt`). Generation A' taught the readers of a
written `r.*` in std and src to use `deref_spelling_applies`, but it did not teach this
path. So the seed sees `&self.*` as the place `*` inside the parameter `self`, and A2
rejects it.

No spelling means the same thing under both compilers:

| spelling in std/src | v0.2.77 (A', std/src exempt) | tree (Generation B) |
| --- | --- | --- |
| `{ &self }` | borrows the referent (`&Self`) | E0926 |
| `{ self : &self.* }` | A2 error above | borrows the referent (`&Self`) |
| `{ self }` / `{ self : self }` | copies the referent (E0901 for a move-only `Self`) | copies the `&Self` (R-CAP-1) |

Probed 2026-11-13 with `std/zz_probe.yo` in a copy of the swept std.

## Second, smaller defect

The tree's A2 diagnostic said "Borrow the parameter, `{ &self }`". Under the deref rule
that spelling is E0926. The hint now names `{ self : &self.* }`.
`tests/async_await.test.yo` ("Test an io.async capture of a `&` parameter's field is
rejected with the borrow-the-referent hint") pins the hint and runs the hinted spelling.

## Options (coordinator decision)

1. **A seed rider.** Make the capture path strip a written `.*` under
   `deref_spelling_applies`, and ship it in a release before the sweep's stage 1. This
   costs a release, because v0.2.77 is already published.
2. **A one-release bridge in the tree.** The 85 sites keep `{ &p }`, which v0.2.77
   accepts. The Generation B compiler accepts `{ &p }` of a `&` parameter inside an
   `io.async` capture list as A2's "borrow the parameter whole" (it captures the `&T`).
   The recorder leaves these sites as written. The next release's sweep rewrites them
   to `{ p }`. This is a special case against P3 (`&r` is a `&&T` everywhere else).
3. **Hold the deref flip to v0.2.79.** v0.2.78 carries option 1's capture-path change,
   so it becomes the seed that accepts the swept spelling.

## Decision

VERDICTS-60 (2026-11-14) took option 3, refined: no spelling bridges the two compilers
and no extra release is cut. The deref sweep is split. Its text (every edit the v0.2.77
seed accepts) lands in v0.2.78, with every `io.async` capture list still spelled
`{ &p }`. The flip (those capture lists, the `MaybeUninit.as_ptr` body and the deletion
of `is_deref_rule_exempt`) is the first PR of v0.2.79, built by v0.2.78 as the seed.

## Fix

v0.2.78 carries the seed rider, so it is the seed that accepts the flip's spelling.

- `_evaluate_capture_list` drops a borrow entry's leading written `.*` of a reference
  binding wherever a written `.*` is the reference's own deref (`deref_spelling_applies`),
  in the trees that keep the old reading of a bare binding too, not only where
  `deref_rule_applies` holds. `{ p : &p.* }` (and `{ x : &p.* }`) then names what
  `{ &p }` names there: the `&` parameter whole, so A2 accepts it and the future keeps
  its own copy of the parameter (`__yo_lent_<label>`, `src/codegen/exprs/async.yo`,
  which keys on the label and an empty path). `{ &p }` keeps working in std and src
  until the flip. The by-value entry `{ r }` is unchanged in those trees; its meaning
  changes with the flip.
- The A2 hint names `{ p : &p.* }` (the second defect above).
- The other compile-time gap the flip needs, found while deciding this, is
  `issues/fixed/2026-11-14-an-inline-builtin-alias-that-derefs-its-reference-parameter-emits-a-type-as-the-operand.md`.

Tests: `std/deref_spelling.test.yo` ("an io.async capture `{ b : &b.* }` of a & parameter
borrows the parameter whole", failing before the fix with the A2 error above, and "a
closure's `{ r : &mut r.* }` borrows the referent whole while it lives");
`tests/async_await.test.yo` (the hint).
