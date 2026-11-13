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

## Decided: split; flip in v0.2.79 (VERDICTS-60, 2026-11-14)

Option 2 is rejected: under P3 `&p` is a `&&T`, and the parameter slot it would borrow dies at the return. The
sweep is split.

- **The deref text** (v0.2.78, W1). The whole `--migrate deref` rewrite of std, src, scripts and `build.yo`,
  minus 93 lines in 21 files. Those are every capture list inside an `io.async(` literal (92 lists, 113
  entries), which stay `{ &p }` / `{ &mut p }`, and `MaybeUninit.as_ptr`, which stays `addr_of(self)`; its
  swept `addr_of(self.*)` emits invalid C under both compilers, an issue of its own. The exemption stays.
- **The deref flip** (the first PR of v0.2.79, with `SEED_VERSION` at v0.2.78). It sweeps the held-back lines
  and deletes `is_deref_rule_exempt`.
- **Two seed riders in v0.2.78.**
  - The capture path drops a written `.*` from a borrow entry's place wherever `deref_spelling_applies`, and the
    A2 hint names `{ p : &p.* }`.
  - The inline-builtin alias rule reads `p.*` of a `&T` parameter as `p`.

No capture spelling means "the future holds the `&Self`" under both compilers. VERDICTS-60 probed 19
candidates; none was accepted by both:

| capture list | seed v0.2.77 | Generation B |
| --- | --- | --- |
| `{ &self }` | ok | E0926 |
| `{ self : &self.* }` | A2 error | ok |
| `{ self }` / `{ self : self }` / `{ s : self }` | E0901 (copies `Res`) | ok (copies the `&Res`) |
| `p := &self.*;` `{ p }` | E0901 | ok |
| `p := &self.*;` `{ p : &p.* }` / `{ &p }` | E0912 | E0912 / E0926 |
| `{ s : (&self.*) }`, `{ self : &(self.*) }` | A2 error | ok |
| `{ s : _same(&self.*) }`, implicit capture | E0901 | E0901 |

This doc moves to `issues/fixed/` with the flip. Until then, std and src write an `io.async` capture of a
reference parameter as `{ &p }` (`.github/instructions/yo-syntax.instructions.md`).
