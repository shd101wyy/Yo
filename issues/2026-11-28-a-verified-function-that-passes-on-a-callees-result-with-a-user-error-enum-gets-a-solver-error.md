# A verified function that passes on a callee's `Result` with a user error enum gets a solver error

**Severity:** S2 — `yo verify` cannot judge a contracted function that receives a `Result(T, E)` with a user enum `E` from a callee and names no variant of `E`: Z3 rejects the script, so forwarding the error, returning the callee's result unchanged and recovering to a plain value all fail, while rebuilding the error proves.

- Filed: 2026-11-28, finding F9 of VERDICTS-96 (Fable 5.2, §9), with its probe `v06b`.
- Status: open. The test lands with E-1v of [`plans/backlog/ERRORS_AS_VALUES.md`](../plans/backlog/ERRORS_AS_VALUES.md) (v0.2.83–84), the verifier PR that makes `try` provable: every `try` forwards a callee's error without naming its variants.

## Reproducer

`issues/repros/2026-11-28-a-verified-function-that-passes-on-a-callees-result-with-a-user-error-enum-gets-a-solver-error.yo`:

```yo
// F9 (VERDICTS-96 probe v06b): passing on a callee's `Result(i32, Odd)` without naming a variant of `Odd`.
Odd :: enum(Odd);
derive(Odd, Copy, Clone);

half_e :: (
  fn(x : i32, requires(x >= i32(0)), ensures(match(result, .Ok(q) => ((q >= i32(0)) && (q <= x)), .Err(_) => true))) -> (result : Result(i32, Odd))
)(
  cond(
    ((x % i32(2)) != i32(0)) => Result(i32, Odd).Err(.Odd),
    true => Result(i32, Odd).Ok(x / i32(2))
  )
);

// A: forwards the bound error
fwd_bound :: (
  fn(x : i32, requires(x >= i32(0)), ensures(match(result, .Ok(q) => (q <= x), .Err(_) => true))) -> (result : Result(i32, Odd))
)(
  match(
    half_e(x),
    .Ok(v) => Result(i32, Odd).Ok(v),
    .Err(e) => Result(i32, Odd).Err(e)
  )
);

// B: rebuilds the error
fwd_rebuilt :: (
  fn(x : i32, requires(x >= i32(0)), ensures(match(result, .Ok(q) => (q <= x), .Err(_) => true))) -> (result : Result(i32, Odd))
)(
  match(
    half_e(x),
    .Ok(v) => Result(i32, Odd).Ok(v),
    .Err(_) => Result(i32, Odd).Err(.Odd)
  )
);

// C: returns the callee's result unchanged
fwd_whole :: (
  fn(x : i32, requires(x >= i32(0)), ensures(match(result, .Ok(q) => (q <= x), .Err(_) => true))) -> (result : Result(i32, Odd))
)(half_e(x));

// D: recovers to a plain value
recover :: (
  fn(x : i32, requires(x >= i32(0)), ensures(r <= x)) -> (r : i32)
)(
  match(
    half_e(x),
    .Ok(v) => v,
    .Err(_) => i32(0)
  )
);

main :: (fn() -> unit)(());
export(main);
```

`yo check` (v0.2.80, its bundled std, 2026-11-28): `evaluator OK`. `yo verify` (Z3 5.1.0):

```text
  ok       fn@….yo:5 [verify] — 3 obligation(s) proved
  solver-error  fn@….yo:15 [verify]
    fn@….yo:15/ensures#0: SOLVER-ERROR  z3 rejected the script: (error "line 7 column 19: invalid datatype declaration, unknown sort '__yo_denum_decl_…_Odd_r0c7'")
  ok       fn@….yo:26 [verify] — 2 obligation(s) proved
  solver-error  fn@….yo:37 [verify]
    fn@….yo:37/ensures#0: SOLVER-ERROR  z3 rejected the script: (error "line 7 column 19: invalid datatype declaration, unknown sort '__yo_denum_decl_…_Odd_r0c7'")
  solver-error  fn@….yo:42 [verify]
    fn@….yo:42/ensures#0: SOLVER-ERROR  z3 rejected the script: (error "line 7 column 19: invalid datatype declaration, unknown sort '__yo_denum_decl_…_Odd_r0c7'")
  ok       fn@….yo:51 [verify] — no obligations
verify: 3 ok, 0 assumed, 0 outside-subset, 0 unproven, 0 refuted, 3 solver-error, 0 subset-error (1 of the ok vacuous) — 9 queries, 0 cached (0%), 2 folded, 448 ms
```

(`…` is the file stem.) Expected: A, C and D prove, as B does.

Notes on the reproducer:

- VERDICTS-96's probe `v06b` writes the bodies with bare variants and leaves `Odd` move-only. `yo check` rejects that form for two other reasons: a bare variant in a `cond` or `match` arm under an `ensures` is `issues/2026-11-28-a-bare-variant-at-a-block-tail-is-not-inferred-when-the-function-has-an-ensures.md` (F10), and `match(result, …)` in an `ensures` consumes a move-only `result`, which is E0901 by decision 26 (`match(&result, …)` with `q.*` is the borrowing form). This reproducer names the `Result` type and derives `Copy` so that only the solver error is left. `yo verify` reports the same three solver errors on `v06b` as written.
- Naming the variant through the enum, `Result(i32, Odd).Err(Odd.Odd)` in `half_e`, is a subset error instead: "cannot verify: unbound runtime name 'Odd'". The inferred `.Odd` proves.

## Root cause

Inferred from the message, not read in `src/verifier/encode.yo` (VERDICTS-96 §9): when a function's own body names no variant of `Odd`, the script declares the `Result` datatype before the sort of its payload `Odd`, so the declaration refers to an unknown sort. B names `.Odd`, which declares the sort first, and proves.

## Fix

E-1v: the encoder declares a datatype's payload sorts before the datatype, whatever the body names. The same PR treats an early `return` (and so `try`) as an exit path that owes the `ensures`.

## Test

None in this filing: the bug is open with no fix. The test lands with E-1v: this reproducer as a `tests/spec` fixture where A, C and D prove.
