# A run-time `ensures` is skipped by an early `return` or an `unwind`

**Severity:** S1 — a false proof: a function whose `ensures` is checked at run time returns a value that breaks it, through an early `return(v)` or a handler's `unwind(v)`, and no assert fires. A `Pragma.Verify` caller assumes that contract, proves a divisor nonzero from it, and the proved division fails at run time.

- Filed: 2026-11-28, finding F8 of VERDICTS-96 (Fable 5.2, §9), with its probes `v01`, `v09`, `v11` and `v12`.
- Status: open. The test lands with E-0b of [`plans/backlog/ERRORS_AS_VALUES.md`](../plans/backlog/ERRORS_AS_VALUES.md) (v0.2.82), which fixes the `return` half; the `unwind` half is closed by E-0b's rule and then by E-5, which deletes `unwind`.
- Related: the verifier side of an early return was fixed in `issues/fixed/2026-10-23-the-verifier-walk-ignores-an-early-return.md`; the run-time side was not.

## Reproducer

`issues/repros/2026-11-28-a-run-time-ensures-is-skipped-by-an-early-return-or-an-unwind/`, four programs:

```yo
// early-return.yo
{ println } :: import("std/fmt");

clamp_early :: (
  fn(x : i32, ensures(r <= i32(10))) -> (r : i32)
)({
  if(x > i32(10), {
    return(i32(99));
  });
  x
});

main :: (fn() -> unit)({
  println(`clamp_early(50) = ${clamp_early(i32(50))} (the contract says <= 10)`);
});
export(main);
```

- `result-early-return.yo`: the same through the `match` arm that `try(expr)` will produce, `.Err(e) => return(.Err(e))`, under `ensures(match(result, .Ok(_) => true, .Err(e) => (e <= i32(100))))`.
- `unwind.yo`: `clamp` carries `ensures(r <= i32(10))` and installs `(h : Raise) = (code -> unwind(i32(99)))`; the callee raises.
- `verified-caller/`: `lib.yo` is a run-time-mode module with `nonzero :: (fn(x : i32, ensures(r != i32(0))) -> (r : i32))`, whose body does `return(i32(0))` when `x == i32(0)`. `main.yo` is `Pragma.Verify` and divides by `nonzero(x)`.

v0.2.80 (the seed), its bundled std, Z3 5.1.0, 2026-11-28. `yo check` on each of the four: `evaluator OK`. Compiled and run:

```text
early-return.yo:        clamp_early(50) = 99 (the contract says <= 10)                rc 0
result-early-return.yo: pass(5) ok 6
                        pass(500) err 500 (the contract says <= 100)                  rc 0
unwind.yo:              clamp(50) = 99 (the contract says <= 10)                      rc 0
```

`verified-caller/main.yo`:

```text
  ok       fn@main.yo:6 [verify] — 1 obligation(s) proved
  n/a      fn@main.yo:12 [verify] — no contracts; body outside the verifiable subset: call to a callee without contracts (not spec-transparent: its body is outside the verifier subset (recursive ghost_fn without a resolvable body))
integer division or remainder by zero (at main.yo:10:6)
```

rc 134. The control, the same contract broken by the body's tail value (`clamp_tail :: (fn(x : i32, ensures(r <= i32(10))) -> (r : i32))(x)`), stops with `ensures failed: r <= i32(10) (at ctl.yo:4:25)`, rc 134. VERDICTS-96 `v01c` shows the planned default too: under `Pragma.VerifyOrAssert` the report says "verify+ fallback: the runtime assert stays", and the binary prints 99.

## Root cause

The contract layer checks one exit, the body's value. The lowering in `src/evaluator/builtins/contracts.yo` (the comment at line 1109 on `06c6306f3`) is `{ <ret> := (<body>); assert(E1); ...; <ret> }`. An early `return(v)` leaves the function without passing the `assert`. An `unwind(v)` from a handler the function installed sets the function's result from the handler literal, through the flag protocol, and skips the assert the same way.

The two halves have different repairs (VERDICTS-96 §2.2):

- **`return`.** Local: each `return(v)` is a path that owes the `ensures` at `v`, and the verifier already finds the site. `try(expr)` is this exit, so the repair is a prerequisite of L-1.
- **`unwind`.** Not local: the value is produced in another function and delivered to a frame chosen at run time. No definition in `src/`, `std/` or `tests/` both installs an unwinding handler and carries a contract clause (VERDICTS-96 §5's census: 0 of 295 contracted definitions in `tests/`).

## Fix

E-0b (v0.2.82, lane E): a contracted body's `ensures` is asserted on every `return(...)`, and an `ensures` on a function that installs an unwinding handler is a compile error. E-5 deletes `unwind`.

## Test

None in this filing: the bug is open with no fix. The test lands with E-0b: the four programs as run-time tests (each stops with `ensures failed`), and `verified-caller/` with `unwind.yo`'s installer as the new error.
