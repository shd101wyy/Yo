# `yo doc` renders every trait-impl method with an empty doc instead of inheriting the trait's

**Status:** open. Found while measuring `///` coverage for the std doc sweep
(2026-09-11). **Filed, not fixed** — the fix is in `src/doc/builder.yo`.

## Symptom

A method defined inside a trait impl group appears in `yo doc`'s output as a
method of the type, with `doc` empty, unless it carries a doc comment of its
own:

```
$ yo doc ./std --format json -o /tmp/d --std-path ./std
$ # fs/watch, types[].methods:
FsEventKind.to_string   doc: false      (traitImpls: ToString, Format)
FsEventKind.format      doc: false
Watcher.dispose         doc: false      (traitImpls: Dispose)
```

`ToString`, `Format` and `Dispose` all document those methods at the trait
declaration, and `std/fs/watch.yo`'s module header explains what `dispose` does
on drop. None of that reaches the rendered page for these three entries; each
renders as a bare signature.

Measured on `develop` (7915c0f37) with `--std-path ./std`, so this is not the
token-only fallback of
`issues/yo-doc-without-std-path-silently-emits-token-only-docs.md`.

## Scale

454 trait-impl methods across `std/` carry no doc comment of their own
(`hash`, `clone`, `next`, `next_back`, `to_string`, `cmp`, `dispose`, `index`,
`default`, `to_comptime_string` — mostly one per implementing type; 139 of them
in `std/prelude.yo` alone). Every one of them renders blank today.

## Why the fix belongs in the tool, not in `std/`

Rustdoc, which this library follows deliberately, shows a trait impl's methods
with the TRAIT's documentation when the impl does not override it — the contract
is stated once at the trait and inherited by every implementation. Writing 454
per-instance restatements of "returns the hash of `self`" into `std/` would be
noise, would drift from the trait's text, and would still leave every user
crate's impls blank.

The std doc sweep therefore deliberately left these undocumented (recorded in
`plans/STD_API_STABILIZATION.md` §4) on the understanding that this is a doc-tool
gap.

## Fix

In `src/doc/builder.yo`, when a type's method comes from a trait impl and has no
doc comment of its own, fall back to the doc comment on that trait's method
declaration, and mark it in the model as inherited so a renderer can label it
("from `ToString`") the way rustdoc does. The trait is already known — the
type's `traitImpls` list carries its name — and the trait's own method docs are
already extracted, so both halves are in hand.

An impl-site comment must keep winning over the trait's: several `std/` impls
document a divergence at the impl (`imm/*`'s `IntoIterator` says it is eager
rather than lazy), and that text must not be replaced by the trait's generic
version.

## Landed 2026-09-11 — and what still blocks the rest

`src/doc/builder.yo` gained `_inherit_trait_method_docs`, run from
`build_cross_references` over ALL modules (a trait and its implementors are
almost never in one file). An impl-site doc always wins, and the lookup is
keyed on the type's own `trait_impls` list so a method that merely shares a
name inherits nothing. `DocFunction` carries `inherited_from`, the JSON
renderer emits `inheritedFrom`, and the HTML and markdown renderers label it
the way rustdoc does.

Measured on `yo doc ./std`: **110 methods now inherit**, out of the ~454 this
issue counted. The remainder is blocked on a separate defect —
`issues/yo-doc-renders-std-prelude-as-an-empty-module.md` — because
`Iterator` (213 impls), `Eq` (169), `Default` (160), `Ord` (134),
`Dispose` (81), `Clone` (70), `Hash` (67) and the rest are declared in
`std/prelude.yo`, which `yo doc` renders as 0 types, 0 traits, 0 functions.
When that is fixed they inherit for free, with no edit to `std/`.
