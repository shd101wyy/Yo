# `io.await` in a `cond` condition: yo-self accepts it, TS rejects it

**Status: OPEN.** Found 2026-08-15 when the divergence blocked the v0.2.5
release.

## The divergence

```rust
io.async((e : IoExn) => {
  match(opt, .Some(d) => { if(e.io.await(f(d), e.io), { … }); }, .None => ());
})
```

- **yo-self**: accepts it. `check ./yo-self` 248/248, the language suite, the
  differential, the hollow sweep and stage-3 byte-identity all pass.
- **TS**: rejects it —

```
Error: std/prelude.yo:7663:5: `io.await` in a `cond` condition inside an
`io.async` block must BE the first condition — it cannot be nested inside a
larger expression, and it cannot be in a later branch.
```

`prelude.yo:7663` is the `if` MACRO (`cond(unquote(condition) => …)`), so the
error names the expansion rather than the offending call site — which makes it
considerably harder to locate than it needs to be.

## Which one is right?

Unknown, and that is the point. Either

- **yo-self is too permissive** — it accepts a shape its own state machine
  cannot lower correctly, and the emitted C is wrong in some way no current
  test exercises; or
- **the TS restriction is stronger than necessary** — yo-self lowers it fine
  and TS is refusing something legal.

The second is plausible: this repo has form for yo-self leading TS (see the
"yo-self sometimes leads TS" pattern). But nobody has checked, and shipping a
compiler pair that disagrees about what compiles is its own problem.

## Why no PR check catches it

**`node out/cjs/yo-cli.cjs compile yo-self/main.yo` appeared ONLY in
`release.yml`'s seed-bundles job** (until the gate below). In PR CI the `test` matrix uses the SEED,
bootstrap-fixpoint goes seed → stage-1, and the differential uses stage-1 — so
the TypeScript compiler never compiles `yo-self/main.yo`.

A construct yo-self accepts and TS rejects therefore passes EVERY PR check and
detonates at release time. That is exactly what happened: the code landed in
#128 with 16/16 green and broke the release run.

**This gap is worth closing regardless of which compiler turns out to be
right** — it is the reason a whole class of divergence is invisible until a
release.

**CLOSED 2026-08-16**: `test.yml`'s `ts-unit-tests` job now runs
`compile yo-self/main.yo --skip-c-compiler` (187 s locally, and that job already
builds the TS compiler, so it costs nothing else). It dies with `src/` in Group
E, which is correct — the gate only means anything while both compilers exist.

Two things found while verifying it red-first, both worth knowing:

- **It must be `compile`, not `check`.** `check ./yo-self` returns **rc=0** with
  the offending shape reintroduced: the restriction lives in async
  state-machine CODEGEN, which `check` never reaches. Only `compile` fails
  (rc=1, "must BE the first condition"). A `check`-based gate would have been
  pure false confidence.
- **The restriction is narrower than this issue's title suggests.** An await
  that IS the sole/first condition is accepted by TS — `if(e.io.await(f, e.io),
{...})` on its own compiles fine. What TS rejects is an await _nested inside a
  larger expression_ (`if(!(e.io.await(...)), ...)`) or in a _later_ branch. The
  first red probe here used the legal form and passed, which is what exposed the
  distinction.

## Encountered as

`yo-self/version_cache.yo`, P3 item 1's installer/cache unification. Fixed at
the call site in `66c390730` by hoisting the awaits out of cond positions; the
divergence itself is untouched.
