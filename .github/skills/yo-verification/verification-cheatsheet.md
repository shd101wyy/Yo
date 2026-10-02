# Yo Verification Cheatsheet

Contracts, laws, invariants and the `yo verify` loop. Authority:
`docs/en-US/FORMAL_VERIFICATION.md`; this file is the workflow shortcut.

## The loop

| Goal | Command |
| --- | --- |
| Verify a file or directory | `yo verify ./src` (non-zero exit on failure) |
| Strict gate (spec dirs, CI) | `yo verify ./spec --strict` |
| Deny specific outcomes | `yo verify ./spec --deny assumed,outside-subset` |
| Full detail for one fn | `yo verify <path> --explain <id-substring>` — ids are `fn@<file>:<row>` / `law@<file>:<row>:<col>`, so match the FILE path or line; a bare fn NAME matches nothing (it is not in the id) |
| Machine report | `yo verify <path> --format json` |
| Pin a solver | `yo verify <path> --solver-path /usr/bin/z3` |
| Raise the budget | `yo verify <path> --rlimit 8000000` (default 5000000) |

- Modes per file: `runtime` (default; contracts lower to runtime `assert`),
  `pragma(Pragma.Verify);` (refutation = compile error),
  `pragma(Pragma.VerifyOrAssert);` (prove, else assert),
  `pragma(Pragma.NoContracts);` (erase). `--verify-mode` overrides when the
  file has no pragma; `yo verify` defaults its targets to `verify` mode.
- `yo check` proves entry files whose own pragma is verify/verify+ inline —
  a refuted obligation fails the check with its counter-example — but it
  applies no `--strict` deny set.
- The solver resolves from `YO_Z3_PATH`, then the pinned install under
  `~/.cache/yo/solvers/`, then auto-downloads. Results are cached
  content-addressed; repeated runs print the cache hit rate.

## Outcomes and the summary line

Every run ends with a greppable summary (zeros included):

```
verify: 2 ok, 1 assumed, 0 outside-subset, 0 unproven, 0 refuted, 0 solver-error, 0 subset-error (1 of the ok vacuous) — 3 queries, 2 cached (66%), 1 folded, 46 ms
```

| Outcome | Meaning | Passes a plain run? |
| --- | --- | --- |
| `ok` | every obligation proved | yes |
| `assumed` | contracts declared, body never walked (`assumed()` or mode) | yes — the trap |
| `outside-subset` | promised nothing the walk could enter | yes |
| `unproven` | solver could not decide (budget or missing fact) | yes (in `verify+`) |
| `refuted` | concrete counter-example | NO |
| `solver-error` | solver failed | NO |
| `subset-error` | the body uses a construct outside the subset | NO |

- `vacuous` counts `ok` fns that generated NO obligation at all (no
  `ensures`, no `assert`, no divisor/shift/index guard) — nothing was
  proved because nothing was asked. Every run's summary prints it;
  `--strict` does not fail on it.
- A refutation prints the model: `counter-example: x = #x000...0`. Read it
  first; it is usually the missing `requires`.
- `--format json`: top-level `summary` (all counts, `strict`, `denied`) and
  `functions[]` with per-obligation `name`, `verdict`, `goal` (the SMT-LIB
  asked), `model` (refuted only) and `site`.

## Contracts

```rust
pragma(Pragma.Verify);

abs_i32 :: (fn(x : i32, requires(x > i32(-2147483647)), ensures(r >= i32(0))) -> (r : i32))(
  if(x < i32(0), i32(0) - x, x)
);

safe_div :: (fn(x : i32, y : i32, requires(y != i32(0)), ensures(r == (x / y))) -> (r : i32))(
  x / y
);
```

- The return is named by the label `-> (r : i32)`; use that name in
  `ensures`. There is no magic `result` identifier.
- Modular table: the fn's own body ASSUMES its `requires` and PROVES its
  `ensures`; every call site PROVES the callee's `requires` and ASSUMES its
  `ensures`. No body is ever opened.
- `old(x)` is the two-state snapshot: param values at entry (works for
  params and `inout` names; body locals have no entry value).
- Trait contracts: impl variance is checked automatically
  (`trait.requires ⇒ impl.requires` contravariant, `impl.ensures ⇒
  trait.ensures` covariant) as synthetic `impl-variance@…` tasks.
- Generic callees: `requires`/`ensures` discharge per monomorphized call
  site; the generic body itself stays unwalked.
- Mutual recursion: `decreases(M)` on every clique member; clique-edge
  calls prove the callee's measure at the actuals.

## Loop invariants

```rust
pragma(Pragma.Verify);

sum_to :: (
  fn(
    n : i32,
    requires(n >= i32(0), n <= i32(1000)),
    ensures(result == ((n * (n + i32(1))) / i32(2)))
  ) -> (result : i32)
)({
  i := i32(0);
  acc := i32(0);
  while(i < n, {
    invariant(i >= i32(0), i <= n, acc == ((i * (i + i32(1))) / i32(2)));
    i = (i + i32(1));
    acc = (acc + i);
  });
  acc
});
```

- `invariant(...)` is the loop body's FIRST statement and takes
  comma-separated predicates; `decreases(M)` follows it with a single
  measure expression. In a SIGNATURE, `decreases(M1, M2, ...)` is a
  lexicographic measure: each recursive call must lower `M1`, or keep `M1`
  and lower `M2`, and so on (encoded as bit-vector concatenation); every
  component must be non-negative on entry. A `while` loop's `decreases`
  still takes one measure.
- The havoc rule: prove the invariant on entry, assume it over a havoced
  state, re-prove it after the body; the exit assumes
  `invariant && !(cond)`. Strengthen until the post-condition is derivable
  from `invariant && !cond` — a too-weak invariant shows up as `unproven`
  on the `ensures`, not as a loop error.
- `decreases` proves non-negativity and strict decrease — the loop variant,
  and (in a signature) the recursion measure that makes self-calls sound.
- The `requires` bound above is not decoration: bitvector arithmetic must
  stay in range for the equality to hold — range bounds are part of the
  claim.

## Laws: claims outside the code

```rust
pragma(Pragma.Verify);

abs_value :: (
  fn(
    x : i64,
    requires((x > i64(-1000)) && (x < i64(1000))),
    ensures((r >= i64(0)) && (r < i64(1000)))
  ) -> (r : i64)
)(cond((x >= i64(0)) => x, true => -x));

// LAW: doubling an absolute value over the contracted domain stays non-negative.
// The law's own `requires` is what discharges `abs_value`'s at each call site.
abs_doubles_nonneg :: law(
  fn(
    x : i64,
    requires((x > i64(-1000)) && (x < i64(1000))),
    ensures((abs_value(x) + abs_value(x)) >= i64(0))
  ) -> unit
);
```

- The argument is a written-out fn TYPE with clauses and NO body. It
  evaluates to `unit`; codegen emits nothing.
- Proved from the callee's CONTRACT, never its body. A law that cannot
  prove is usually telling you the callee's `ensures` is weaker than you
  thought — here the UPPER bound in `ensures` is what makes the sum provable
  (two unbounded non-negatives can overflow).
- Rejected forms (all compile errors, not silent passes): a non-`unit`
  return, no `ensures`, `assumed()`, `decreases(...)`, a named alias
  instead of the written-out fn type.
- Reported as `law@<file>:<row>:<column>`; two laws on one line stay
  distinct. A law's predicates are name-resolved under verification only —
  a dangling name is caught by `yo verify`, not `yo check`.
- A law's callee may be IMPORTED from another file — the `spec/`-directory
  convention (`yo verify ./spec --strict`, `docs/en-US/FORMAL_VERIFICATION.md`
  §Laws). So may a callee named in a function's own `requires`/`ensures`.
- In runtime mode a law is an accepted no-op marker, so specification text
  never breaks an ordinary build.

## Refinements (`std/spec`)

```rust
{ NonZero, check_non_zero } :: import("std/spec/refine");

safe_div :: (fn(num : i32, denom : NonZero(i32)) -> i32)(num / denom);

match(check_non_zero(i32(2)),      // runtime gate: Option(NonZero(i32))
  .Some(denom) => safe_div(i32(10), denom),
  .None => i32(0)
);
```

- Named refinement families live in TWO modules: `std/spec/refine` exports
  `NonZero(T)`, `Bounded(T, lo, hi)` with runtime gates `check_non_zero`,
  `check_bounded`; `std/spec/numeric` exports `Positive`, `Negative`,
  `NonNegative`, `NonPositive`, `Even`, `Odd` with their own `check_*`
  gates (and `unchecked_*` escapes under `Pragma.AllowUnsafe`). Import from
  the module that owns the name.
- A refined parameter carries its predicate into every verified caller —
  the caller must discharge it (checked gate, prior contract, or literal).
- Ghost quantifiers are contract-only: `forall(...)`, `exists(...)`,
  `==>` inside `requires`/`ensures`/laws.

## What verifies today (subset highlights)

- Verified: integer/bool arithmetic and comparisons, `cond`/`if`, let
  bindings and calls to contracted callees, `assert`/`old`, `match` over
  value enums, `while` + `invariant`, `decreases`, `break`/`continue`,
  `inout` params, ghost `Seq`/`Multiset`/`Set`/`str_bytes`, fixed
  `Array(T, N)` reads/writes and `ms_of(a)` (permutation specs),
  `ArrayList(T)` of integer/bool element types modeled by
  (contents, len) with the std mutators' contracts, ghost code erasure,
  trait-method contract inheritance, `forall`/`exists` in contracts.
- Outside the subset (a use is a precise `cannot verify: <construct>` /
  subset-error): `object`/heap, string CONTENT, floats, effects, `unsafe`,
  FFI, `for` loops (need the iterator model), nested lists.
- Automatic obligations on unannotated code (AoRTE): divisor-nonzero,
  shift-in-width, index-in-bounds — each with its position in the name.
- Integers are exact-width bitvectors; in safe code arithmetic that would
  overflow aborts rather than wraps, so a proven `ensures` holds on every
  run that returns.

## Verification in the build

```rust
build :: import("std/build");

proofs :: build.verify({ name : "proofs", root : "./src" }); // mode Verify, strict false
spec_gate :: build.verify({ name : "spec-gate", root : "./spec", strict : true });

install :: build.step("install", "Build all artifacts");
install.depend_on(spec_gate);
```

`VerifyConfig` fields: `name`, `root`, `(mode : VerifyMode) ?= Verify`,
`(strict : bool) ?= false`. `yo build <name>` runs the verification step as
part of the DAG; a denied outcome fails the build.

## Lemmas: recursive `ghost_fn` with `decreases` (R2 slice 1, #1075)

A `ghost_fn` with `decreases` MAY recurse: it becomes an **uninterpreted
function defined by a triggered axiom**, its own verify task proves the
measure decreases, and callers reason from its `ensures` — the lemma layer
(BEND B2 / ATS R2 slice 1). A `ghost_fn` WITHOUT contracts is still inlined
at its call sites (and a recursive one without `decreases` is a subset
error). Lexicographic `decreases(m1, m2, ...)` measures let one lemma cover
a recursion no single measure can.

## Not available yet

- Proving the overflow trap never taken; string-content reasoning; `for`
  loops over anything but an `ArrayList` variable (a `for` over a list
  variable verifies, with `produced(xs)` in a leading `invariant(...)`:
  `yo context --doc FORMAL_VERIFICATION`, § Verified `for` loops). If a spec
  needs them, mark the fn `assumed()` deliberately and say so — never
  silently.

## Recipes

| Symptom | First move |
| --- | --- |
| `refuted` with a model | read the counter-example; add/strengthen `requires`, or the claim is wrong |
| `unproven` on an `ensures` after a loop | invariant too weak: it must imply the post-condition under `!cond` |
| `unproven`, solver returned unknown | raise `--rlimit`; check for `solver-error` first |
| `vacuous` ok | the fn generated no obligation at all (no `ensures`, no `assert`, no guard) — add the claim you meant |
| law cannot prove though the code is right | the callee's `ensures` is weaker than the law needs — strengthen the CONTRACT |
| `cannot verify: <construct>` | the body is outside the subset: restructure, or `verify+` to fall back to the assert |
| counter-example value looks insane (MIN_INT) | overflow-shaped: the fact needs a range `requires`, not "more proof" |
