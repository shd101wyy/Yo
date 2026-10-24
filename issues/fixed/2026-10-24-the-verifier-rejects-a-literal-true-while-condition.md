# The verifier rejects a literal `true` while condition

**Severity:** S2 — a valid verify-mode function written with the infinite-loop
idiom `while(true, { invariant(...); …; if(done, { break; }) })` fails `yo verify`
with a subset error instead of being proved.

**Status:** fixed 2026-10-24 (branch `style/while-true`). **Found:** 2026-10-24
while rewriting every `while(runtime(true), …)` to `while(true, …)`: the
verifier A/B over `tests/spec/fixtures/valid` turned `break_sum` from `ok`
(8 obligations proved) into `subset-error`.

## Reproducer

`tests/spec/fixtures/valid/loop_break.yo` with its head spelled `while(true, …)`:

```yo
pragma(Pragma.Verify);

break_sum :: (
  fn(
    n : i32,
    requires(n >= i32(0), n <= i32(1000)),
    ensures(result == ((n * (n + i32(1))) / i32(2)))
  ) -> (result : i32)
)({
  mut(i) := i32(0);
  mut(acc) := i32(0);
  while(true, {
    invariant(i >= i32(0), i <= n, acc == ((i * (i + i32(1))) / i32(2)));
    cond(
      (i == n) => {
        break;
      },
      true => {
        i = (i + i32(1));
        acc = (acc + i);
      }
    );
  });
  acc
});
```

`yo verify` reported `subset-error: unbound runtime name 'true'`.

## Root cause

A `while` condition is always evaluated as a runtime expression, so the
evaluator records no comptime value on the `true` atom of the loop head.
`_expr_term` (`src/verifier/vc.yo`) turns an atom into a term through the
comptime value first and the walk's bound names second; a boolean literal
with no folded value matched neither and fell through to the
unbound-name subset error. The old spelling `while(runtime(true), …)` hid
this: `runtime(e)` is walked as the identity, and the inner `true` there
carries its folded value.

## Fix

`_expr_term` maps an atom whose token kind is `TokenKind.Bool` to its
`BoolLit` before looking the name up. `loop_break.yo` now spells the head
`while(true, …)` and proves 8/8 again; `runtime_identity.yo` keeps a valid
fixture walking the `runtime(e)` identity, which `loop_break.yo` covered before.
