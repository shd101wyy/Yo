# E0617 rejected a statement whose every path returns

**Severity:** S2 — valid code was rejected. `std/async/channel.yo`'s `send` failed
to compile wherever it was specialized, which voided all 20 tests of
`tests/async/channel.test.yo` in their batch.

**Status:** FIXED 2026-10-01, in the ATS-lessons stack (#1075), before E0617
reached develop.

## Symptom (measured, a tree build of `ddb3176b7`)

```rust
f :: (fn(a : bool, b : bool) -> Result(unit, i32))({
  cond(
    a => return(Result(unit, i32).Err(i32(1))),
    b => return(Result(unit, i32).Err(i32(2))),
    true => {
      println("x");
      return(Result(unit, i32).Ok(()));
    }
  );
  Result(unit, i32).Ok(())
});
```

```
error[E0617]: This statement drops a Result: its value is never used. ...
  --> tmp/e617exit.yo:3:3
```

The `cond` produces no value: every arm leaves the function. But its type is the
type of what the arms return, a `Result`, and E0617 judged the statement by its
type alone. `yo check ./std` did not see it, because `send` is generic and only
instantiation evaluates its body. The language suite found it at
`std/async/channel.yo:159`.

## Fix

`_stmt_always_exits` (`src/evaluator/exprs/begin.yo`) decides on the statement's
SOURCE form, `expr_to_eval`. The evaluated node is not reliable for this, and was
measured not to work.

A statement always exits when it is one of:

- `return(...)` or `unwind(...)`;
- `break` or `continue`;
- a block whose last statement always exits;
- a `cond` or `match` all of whose arms always exit.

Such a statement is not a must-use candidate.

Two shapes had to be handled:

- **The trailing `;`.** `{ a; return(x); }` parses with a trailing `tuple()` after
  the last `;`, so the block's last element is a unit. The check skips trailing
  units before looking at the last statement. That was the second measured miss:
  the same function written without the final `;` passed.
- **The control.** A `cond` whose arms PRODUCE a `Result` without returning is
  still rejected (`tmp/e617keep.yo`: rc=1).

## Regression test

`tests/cli-cases/check-must-use-ignores-exiting-statements`. Its fixture puts an
all-`return` `cond` statement before a dropped `Result`. The first diagnostic
must be the dropped call (`main.yo:20`). Under the unfixed rule it is the `cond`
(`main.yo:8`).
