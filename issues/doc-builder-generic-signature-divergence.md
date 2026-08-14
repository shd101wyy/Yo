# doc builder: generic-function signatures render differently under the two compilers

**Status: FIX IMPLEMENTED 2026-08-14, pending differential re-verification.**
Both builders now render TOP-LEVEL function signatures (and the
parameters/typeParams/returnType tables) from the declaration source tokens:
`extractTopLevelFnSignatures` + `parseSourceFnSignature` + `renderTokenSpan`
in `src/doc/builder.ts`, mirrored as `_extract_top_level_fn_signatures` +
`_parse_source_fn_signature` + `_render_token_span` in
`yo-self/doc/builder.yo`. `where(...)` clauses stay verbatim in `signature`
but are not emitted as parameter/typeParam entries. A generic fn with a
where-constraint and a `?=` default (`describe`) was added to all three
`tests/cli-cases/doc-*/fixture/point.yo`. Remaining: rebuild the self-hosted
binary, re-record the three doc-case goldens, and confirm byte parity.

**Was: OPEN** (found 2026-08-10 while verifying `doc --format html`
byte-parity on `std/assert.yo`). Affects ALL doc formats (json shows it
too), so it predates the html work — the P1 doc differential fixtures
(`tests/cli-cases/doc-json/fixture`) simply contain no generic functions.

```
self: "signature": "fn(generic(T) msg : T : (ToString)) -> unit"
TS:   "signature": "fn(generic(comptime(T) : Type), msg : T) -> unit"
```

Two separate divergences on `panic`/`assert` (generic fns with a
`T : (ToString)` where-style constraint):

1. The generic-parameter clause: TS renders `generic(comptime(T) : Type),`
   as its own parameter; yo-self folds it into `generic(T) <first-param>`.
2. The parameter type: TS prints the bare `T`; yo-self appends the
   constraint (`T : (ToString)`).

The where/constraint model is carried differently by the two builders
(`src/doc/builder.ts` vs `yo-self/doc/builder.yo` — the signature assembly
and the DocParam.type extraction for generic params). Fix in whichever side
diverges from the SOURCE signature the maintainer prefers, add a generic fn
(with a constraint) to `tests/cli-cases/doc-json/fixture`, and re-verify all
three doc differential cases.

## Analysis addendum (2026-08-11)

Measured against the SOURCE (the canonical target), both sides diverge:

```
source: fn(generic(T : Type), msg : T, where(T <: ToString)) -> unit
TS:     fn(generic(comptime(T) : Type), msg : T) -> unit
self:   fn(generic(T) msg : T : (ToString)) -> unit
```

- TS (`src/doc/builder.ts:159`): the signature is `typeToString(funcType)` —
  the SHARED type printer. It leaks the internal `comptime()` wrapper on
  generic params and never prints where-constraints. Fixing typeToString
  changes every error message (blast radius!) — do NOT fix it there for
  doc purposes.
- self (`yo-self/doc/builder.yo`): its own printer folds `generic(T)` onto
  the first parameter (missing comma and `: Type`), appends the constraint
  to the parameter type (`T : (ToString)`), and DROPS `?=` defaults
  (TS keeps them — see `assert`).

Recommended fix shape: render doc signatures from the DECLARATION SOURCE
TOKENS instead of the evaluated type — Yo function declarations always
spell the full type (`name :: (fn(...) -> ...)(body)`), so the source text
IS the canonical signature (fmt-canonical, constraint- and default-
preserving), and both builders converge by construction. Then add a generic
fn with a where-constraint + a `?=` default to
`tests/cli-cases/doc-json/fixture` and re-verify the three doc differential
cases.
