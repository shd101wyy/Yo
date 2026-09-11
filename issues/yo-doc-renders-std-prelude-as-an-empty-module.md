# `yo doc` renders `std/prelude` as an empty module — 0 types, 0 traits, 0 functions

**Status:** OPEN. Found 2026-09-11 while implementing trait-doc inheritance
(`issues/fixed/yo-doc-trait-impl-methods-never-inherit-the-trait-doc.md`). It is
what stops that fix from reaching most of the library.

## Symptom

```
$ yo doc ./std --format json -o /tmp/d --std-path ./std
$ # the prelude's entry in doc.json:
prelude: types 0  traits 0  functions 0
```

`std/prelude.yo` is 12 057 lines. It declares the core traits — `Iterator`,
`Eq`, `Ord`, `Default`, `Dispose`, `Clone`, `Hash`, `Index`, `IntoIterator`,
`FromIterator`, `Acyclic`, `DoubleEndedIterator` — plus `Option`, `Result`,
`Box`, `Range`, the numeric types and their inherent methods. None of it
appears. The module is emitted, so nothing reports an error; it is just empty.

This is NOT the token-only fallback of
`issues/stddoc-core-yo-doc-degrades-a-whole-module-to-nameless-constants.md`:
that one needs a missing `--std-path` and produces name-only `constants`
entries. Here `--std-path ./std` is passed and the result is *nothing at all*.

## Why it matters beyond the prelude's own page

Trait-impl methods inherit their documentation from the trait
(`src/doc/builder.yo`'s `_inherit_trait_method_docs`). That pass can only
inherit from a trait that is IN the doc set, so with the prelude empty it
reaches 110 of the ~454 undocumented trait-impl methods. Counting the impls
whose trait is referenced but absent:

| trait referenced by impls | impls that cannot inherit |
| --- | --- |
| `Iterator` | 213 |
| `Eq` | 169 |
| `Default` | 160 |
| `Ord` | 134 |
| `DoubleEndedIterator` | 114 |
| `Dispose` | 81 |
| `Clone` | 70 |
| `Hash` | 67 |
| `Index` | 64 |
| `IntoIterator` | 51 |
| `FromIterator` | 51 |
| `Acyclic` | 39 |

Every one of those renders as a bare signature today, and will keep doing so
until the prelude is extracted — after which they inherit for free, with no
edit to `std/`.

Only 14 traits reach the doc set at all, which is the same finding from the
other side.

## Where to look

`src/doc/builder.yo`'s evaluator half (`build_doc_module`) and
`src/doc/extractor.yo`. Two candidates, in order:

1. **The prelude is special-cased in module loading.** It is the one module the
   compiler loads implicitly and caches (`src/module_manager.yo`'s cached
   prelude env), so the doc builder may be handed the CACHED env — already
   consumed — rather than a fresh evaluation, and see no items.
2. **Size or shape.** 12 k lines with ~1235 top-level exprs is far larger than
   any other module; a limit, a timeout, or a fallback that silently yields an
   empty module would look exactly like this.

The first is much likelier and is cheap to test: document a two-line module
that the prelude also defines, and see whether the items appear.

## Acceptance

`yo doc ./std` shows `Iterator`, `Eq`, `Dispose` and friends with their
declared methods, and the inherited-doc count rises from 110 toward the ~454
the coverage measurement predicts — without a single new `///` in `std/`.
