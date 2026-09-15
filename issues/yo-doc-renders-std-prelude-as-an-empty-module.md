# `yo doc` renders `std/prelude` as an empty module — 0 types, 0 traits, 0 functions

**Status: OPEN, but NARROWED — the emptiness is fixed and the remaining
defect is different and sharper.** The prelude is no longer empty; 49 of its
declarations now render. What is still missing is every PARAMETERISED
declaration — 62 of them, including `Option`, `Result`, `Box`, `Range`, `Eq`,
`Ord`, `Index`, `Arc` and the whole operator-trait family. Re-measured
2026-09-15; see "Re-measured" at the end before working from the text above.

**Was: OPEN.** Found 2026-09-11 while implementing trait-doc inheritance
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

---

## Re-measured 2026-09-15 — half fixed, and the other half has a precise cause

`yo doc ./std/prelude.yo --format json` against a tree-built compiler now
reports **50 types, 31 traits** where this doc recorded `types 0 traits 0
functions 0`. The emptiness itself was fixed by
`issues/fixed/yo-doc-renders-the-prelude-empty.md` (same date, different
filename — the namespace is now built from the cached env and handed back from
both prelude branches of `mm_load_file`).

**So this doc is NOT simply a duplicate of that one**, which is what it looks
like at a glance and what a title-similarity scan flags it as. Of the sixteen
names this doc lists by hand as missing, **nine now appear and seven still do
not**: `Eq`, `Ord`, `Index`, `Option`, `Result`, `Box`, `Range`.

### The rule, measured over the whole file rather than the seven examples

| declaration form | in prelude | documented |
| --- | ---: | ---: |
| `X :: trait(…)` / `struct(…)` / `enum(…)` — direct | 49 | **49 (100%)** |
| `X :: (fn(comptime(T) : Type) -> comptime(Type\|Trait))(…)` — parameterised | 64 | **2 (3%)** |

The extractor recognises a name bound *directly* to a `trait` / `struct` /
`enum` and misses one bound to a **comptime function that returns a `Type` or
`Trait`** — which is how every generic type and every parameterised trait in
the prelude is declared. That is why `Dispose`, `Clone` and `Iterator` render
(all plain `:: trait(`) while `Option`, `Result`, `Box`, `Range`, `Index`,
`Eq`, `Ord`, `Arc` and the entire operator-trait family (`Add`, `BitAnd`,
`BitOr`, `BitXor`, `BitLeftShift`, `BitRightShift`, …) do not.

The two parameterised declarations that DO render are `MapFieldsFn` and
`MapVariantsFn`; worth a look when fixing, since whatever makes those two
visible is probably the shape the other 62 need.

### Why this matters more than the original framing

"The prelude renders empty" reads as a module-level plumbing bug, and it was
one. What is left is a **declaration-form** bug with a much wider blast radius
than the prelude: any module declaring a generic type the same way loses it
from the docs. The prelude is simply where 64 of them sit together.

It also still blocks what this doc was filed for — trait-doc inheritance cannot
reach `Eq`/`Ord`/`Index` while the extractor cannot see them.

### Method note

This was nearly retired as a duplicate on the strength of the title match plus
the headline number going from 0 to 50. Checking the SPECIFIC names the doc
named — rather than the count it led with — is what separated "fixed" from
"half fixed", and the whole-file measurement is what turned the remaining half
into a one-line root cause instead of a list of seven missing names.
