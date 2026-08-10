# doc builder: generic-function signatures render differently under the two compilers

**Status: OPEN** (found 2026-08-10 while verifying `doc --format html`
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
