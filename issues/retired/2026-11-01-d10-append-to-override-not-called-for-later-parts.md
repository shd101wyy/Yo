# D10: an overriding `ToString.append_to` is not called for a later template part

> Filed 2026-11-01 by the B11 flip agent from a seed-binary run; retired the
> same day by the D10 owner: **not a develop regression** — the failure is the
> installed v0.2.73 seed's pre-D10 template lowering, not the tip's code. The
> filing text is kept verbatim below; the resolution and measurements follow
> it. Nothing was changed in the compiler.

## Resolution (2026-11-01, fix/d10-append-to-override): cannot reproduce with a tree binary — seed vs tree

The tip's compiler is CORRECT: on a develop `cdcd14d3e` tree built by the
v0.2.73 seed (`yo build --std-path ./std`), the tree binary passes the exact
test the filing names, whole file and pattern-filtered:

- `yo-out/.../yo test ./tests/fmt.test.yo --std-path ./std --parallel 1` →
  **18 passed**, including "D10: a later part uses the trait's append_to,
  default or overridden".
- `--test-name-pattern "append_to"` → **1 passed**.
- A standalone `main` discriminating the render (`x ${_D10Custom(n : i32(4))} y`)
  exits 0 (`x append_to y`) — first part, later part, with and without a
  `_D10Plain` default materialized first.

The failure reproduces exactly as filed — 17/18, that one test — with the
**installed seed v0.2.73** (`yo test`, `yo` = v0.2.73 on PATH), because the
seed predates D10 (#1699) and lowers a multi-part template with `+`-joined
`to_string()` calls, so `append_to` is never called for ANY part. `--emit-c`
on the same source:

- tree binary: 14 `__yo_tpl_N` builder references, the override's `append_to`
  symbol present and called for the custom part;
- seed: no builder local at all, `append_to` referenced once (the trait
  default's own definition — never called by the template).

The filing's "deterministic on plain develop `cdcd14d3e` (seed v0.2.73)" was
the clue: the CHECKOUT was the tip, the COMPILER was the seed. This is the
known Tier-1 hazard class ("`yo test` steps a SEED runs" — AGENTS.md): a test
that pins tree-binary-only lowering fails under the seed by construction, and
`tests/fmt.test.yo`'s D10 tests pin exactly that.

**What to do instead of a fix:** nothing in `src/`. Whoever re-checks this
class must put a tree-built `yo` first on `PATH` (`yo-out/<target>/bin/yo`)
before `yo test`. The test at `tests/fmt.test.yo` ("D10: a later part uses
the trait's append_to, default or overridden") is the correct pinning test
and passes on the tip; under a pre-D10 seed it cannot pass, which is the
expected seed-stair behavior between v0.2.73 and the next seed release.

## The filing (verbatim, B11 flip agent)

**Severity:** S2 — `tests/fmt.test.yo`'s "D10: a later part uses the trait's
append_to, default or overridden" fails deterministically on plain develop
`cdcd14d3e` (2026-11-01, seed v0.2.73): the file reports 17/18, and the
whole-suite run fails the same single test. Reproduced on the B8 tip and on
the B11 flip tree (identically — the failure predates and is independent of
both branches' changes).

### The failing assertion

```yo ignore
_D10Custom :: struct(n : i32);
impl(
  _D10Custom,
  ToString(
    to_string : (fn(self : &Self) -> String)(`to_string`),
    append_to : (fn(self : &Self, out : &mut String) -> unit)(out.push_str("append_to"))
  )
);
test("D10: a later part uses the trait's append_to, default or overridden", {
  assert(`x ${_D10Plain(n : i32(4))} y` == `x p4 y`, "the default append_to renders through to_string");
  assert(`x ${_D10Custom(n : i32(4))} y` == `x append_to y`, "an overriding append_to is the one a later part calls");  // FAILS
  ...
});
```

The batch binary run directly (`YO_TEST_INDEX=0`) prints:

    an overriding append_to is the one a later part calls (at std/assert.yo:39:17)

so `x ${_D10Custom(n : i32(4))} y` does not equal `x append_to y` — a later
part of a multi-part template does not reach the overridden `append_to`
(or renders through `to_string` instead). The neighbour tests pass: a
`String` part appended by borrow, spec'd later parts, nested templates, and
the FIRST-part cases (`${_D10Custom(n : i32(4))} y`).

### Repro

    yo test tests/fmt.test.yo --std-path ./std --parallel 1 \
      --test-name-pattern "append_to"

on a clean develop checkout fails; keep the batch with `YO_KEEP_BATCH=1` and
run it with `YO_TEST_INDEX=0` to see the assert.

### Ownership

develop's own state (D10 landed #1699; the neighbours #1700–#1712 may have
shifted the later-part lowering). The B11 flip does not change D10's
machinery (its std edits are mut-binding migrations in `std/fmt/format.yo` /
`spec.yo`, which this test does not reach before the assert). Fix-forward
on develop; whoever takes it should diff D10's template lowering between
#1699 and the tip.
