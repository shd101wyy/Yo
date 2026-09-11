# `yo doc` renders `std/prelude.yo` with ZERO members — and two classification defects underneath it

**Found**: 2026-09-11, re-measuring the doc-coverage row of
`plans/STD_API_STABILIZATION.md` after #589 (the re-export fix) took the
published number from 1554 to 1293 undocumented of 3345. The residue was
supposed to be trait-impl methods the inheritance pass could not reach; it is
not. **Class**: a shipped CLI renders the most-read module in the language as
an empty page. **Status**: OPEN.

## Measured

`yo doc ./std --format json` on `32778097d` + #590:

```
$ yo doc ./std/prelude.yo --format json -o /tmp/docpre --std-path ./std
  1 module, 0 items documented in 0.9s
```

Zero. `std/prelude.yo` is 12k lines and declares `Option`, `Result`, `Box`,
`Range`, `Io`, `Future`, `JoinHandle`, the numeric types and their inherent
methods, and every core trait (`Clone`, `Eq`, `Ord`, `Hash`, `Dispose`,
`Default`, `Iterator`, the operator traits). The rendered page has the module
doc and the `## Stability` marker and nothing else.

The same file under a different path documents fine:

```
$ cp std/prelude.yo /tmp/predoc/mymod.yo
$ yo doc /tmp/predoc/mymod.yo --format json -o /tmp/predoc/out --std-path ./std
  1 module, 527 items documented in 1.0s
```

527 vs 0, same bytes. So this is the PATH, not the content.

## Root cause (1): the prelude cache hit returns a Unit module type

`mm_load_file` (`src/module_manager.yo:855`) has a deliberate guard — a prelude
that is already cached must never be re-evaluated, because re-registering its
impls under fresh type identities corrupts where-constrained generic-impl
resolution for every file checked afterwards
(`issues/fixed/seed-built-stage1-array-fill-method-miss.md`). The guard is
right. What it returns is not:

```rust
ModuleLoadOutcome(
  ok : true,
  module_value : EvalValue.UnitVal,
  module_type : TypeValue.Unit,
  env : <the cached prelude env>,
  ...
)
```

`build_doc_module` (`src/doc/builder.yo:2817`) opens with
`if(!is_module_type(module_type), { return(result); })` and hands back a
DocModule with empty `functions`/`types`/`traits`/`constants`. Every other
consumer of the outcome uses the `env`, which is why nothing else noticed.

`yo doc ./std` always loads the prelude first — every other file clones it —
so by the time the directory walk reaches `std/prelude.yo` as a TARGET the
cache is warm and the target documents as empty. The copy above documents
because its path does not end in `prelude.yo`, so it takes the ordinary
module path.

## Root cause (2): a load that FAILS falls back to token-only docs, which classify everything as a constant

The copy above is not the full evaluator path — it is the FALLBACK. `mm_load_file`
on a bare copy of the prelude does not evaluate (the file is the prelude and
not at the prelude's path), so `_document_file` reports "evaluation failed,
using token-only docs" and `build_doc_module_from_tokens` runs. That builder
knows only what the tokens say:

```
mymod: functions 0, types 35, traits 0, constants 492
Iterator const   Eq const   Ord const   Dispose const
Default const    Clone const  Hash const
Option type      Result type  Box type
```

Every declaration it cannot see a `trait_impls` entry for becomes a constant
with `type_ : "(unknown)"` — including every `trait(...)`. The full path
classifies properly (`std/fmt/to_string`'s `ToString` renders as a trait with
its `to_string` documented), so this is the fallback's ceiling, not a defect
in the dispatch. It matters here only because it is what the prelude would get
if root cause (1) were fixed by routing the prelude to the fallback instead of
giving it a real namespace.

A trait that lands in `constants` cannot feed the trait-doc inheritance pass
(`_inherit_trait_method_docs`, `src/doc/builder.yo:2116`): it collects donors
from `module.traits`, and `std/`'s core traits are never in anyone's `traits`
list. That is the whole residue — the current undocumented top names are
`next` (36), `dispose` (28), `default` (28), `source` (26), `to_string` (24),
`==`/`!=` (22 each), `<`/`<=`/`>`/`>=` (14 each), `into_iter` (16), and the
`Iterator` combinators (13 each). Every one of them is an impl of a trait
declared in `std/prelude.yo`.

## Root cause (3): the token-only builder drops every doc comment it extracted

```
constants with doc: 0 / 492
```

Not one. `build_doc_module_from_tokens` passes `doc : Option(String).None` on
both the type and the constant literal, with the note "TS omits the doc field
here (builder.ts:1509 literal has no `doc`)" — a faithful port of a defect.
The text is in hand two lines above (it built `sections` from exactly that
comment and does keep its `deprecated`/`examples`), so this is a one-field fix
on each. The full path already passes `doc : doc`; only the fallback loses it,
which is what every module whose evaluation fails renders with.

## Why the three are one issue

Fixing (1) alone publishes 527 prelude members with no docs on 492 of them and
still no trait donors. Fixing (2) and (3) without (1) changes nothing for
`std/` — the prelude is the module they are about. The doc-coverage row of
`plans/STD_API_STABILIZATION.md` is measured on the PUBLISHED number, and this
is the gap between that number and the source.

## Root cause (4), found by measuring the fix: a DERIVED impl is invisible

With the prelude rendering, `Iterator.next`, `Clone.clone`, `Hash.hash` and
`Default.default` became donors and their impls' names left the undocumented
list outright. `source` (25) and `to_string` (24) did NOT, even though
`Error.source` and `fmt/to_string`'s `ToString.to_string` are documented. The
recipients all report `trait_impls = None`:

```
bare source on async/index    TimeoutError   trait_impls = None
bare source on crypto/random  CryptoError    trait_impls = None
bare source on encoding/json  JsonError      trait_impls = None
```

Every one of them gets `Error` from `derive(Type, Error(...))`, and
`extract_trait_impls_from_tokens` scans for the identifier `impl` only. The
trait-doc inheritance pass keys on `trait_impls`, so a derived impl can never
inherit anything — and the type's page does not list the trait either, which
is wrong on its own terms: a derived `Eq` is an implemented `Eq`.

`derive(...)` takes the same argument shape as `impl(...)` (`Type` first, then
the traits), so the same walk reads both. Only the NAME scanner learns this:
the impl-INFO scanner beside it reads method bodies out of the call, and a
derive call has none.

## Measured, step by step

`yo doc ./std --format json`, undocumented functions+methods over the total:

| | undocumented / total |
| --- | --- |
| before #589 | 1554 / 3345 |
| #589, re-exported declarations | 1293 / 3345 |
| root cause (1), the prelude renders | 1207 / 3368 |
| `Dispose.dispose` + `Error.source` documented | 1178 / 3368 |
| root cause (4), a derived impl counts | **1161** / 3368 |

The total grows by 23 at step 3 because the prelude's own members start
counting. `std/prelude.yo` itself goes from **0 items** to **957**, and from
0 traits to 31. `next`, `default`, `clone` and `hash` leave the undocumented
list outright at step 3; `dispose` at step 4; `source` at step 5.

(The JSON's `trait_impls` field is NOT the oracle for step 5 — it still
serializes as `None` on a derive-only type while the inherited doc is plainly
there. Read the method's `doc`, not the list.)

## What is left, characterized

1161 is not 0, and the remainder is three separate things, none of them "a
`///` nobody wrote in a module that has them":

- **`libc/*`: 338** (math 177, stdio 46, stdlib 45, string 36, stdatomic 34).
  Raw C bindings. `sys/externs`'s reasoning covers them exactly: not public
  API and not intended to become it.
- **`==`/`!=` (24 each) and `<`/`<=`/`>`/`>=` (14 each): ~104.** `Eq` and `Ord`
  are generic trait CONSTRUCTORS — `Eq :: (fn(comptime(T) : Type) ->
  comptime(Type))(...)` — so their value is a FuncVal and the builder's
  `.TypeVal` dispatch never sees a `TraitT` to put in `traits`. Until a trait
  constructor's returned trait is documented as one, these have no donor.
- **`to_string`: 24.** These types get `to_string` from `derive(Type,
  Error(...))`, because D15 makes `derive(Error)` imply `ToString` — but the
  `Error` trait declares only `source`, so the `ToString` donor is never
  consulted. The doc pipeline does not know that implication.
- The rest is genuinely uncommented source, and `string/index` (138) +
  `string/string` (122) is where a doc sweep would now pay.

## Fix

1. Build the prelude's module namespace from the CACHED env and hand it back
   from BOTH prelude branches of `mm_load_file` — the cache hit and the first
   load. The guard against re-evaluation stays exactly as it is; only the
   recorded outcome changes. Both branches matter: a directory walk takes the
   first, and `yo doc <one file>` takes the second.
2. Nothing — (2) is a consequence of (1) and of the fallback's ceiling, and
   the fallback stops being the prelude's path once (1) lands.
3. Pass the extracted doc into the token-only builder's `DocType` and
   `DocConstant` literals.
4. Count `derive(Type, Trait(...))` as a trait impl in
   `extract_trait_impls_from_tokens`.

## Regression test

`tests/internal/doc_*.test.yo` — the doc builder is already tested there
(`doc_reexport_docs`, `doc_render_markdown`). Add: a module whose load outcome
carries a Unit module type still documents its declarations; a `trait(...)`
declaration lands in `traits` and its methods donate to an implementor's
undocumented method; a constant keeps its doc comment. The end-to-end number
(`yo doc ./std --format json`, undocumented count) is the campaign's measure
and belongs in the plan doc, not in a test.
