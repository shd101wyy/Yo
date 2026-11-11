# A non-generic `Impl(Future(...))` parameter rejects a borrowing future operand

**Severity:** S3. A combinator written without `generic(...)`,
`wrap2 :: (fn(f : Impl(Future(i32, Io)), io : Io) -> Impl(Future(i32, Io)))(io.async({ f }(io : Io) => io.await(f, io)))`,
rejects `wrap2(mk(&x, io), io)` with E0909 ("This value borrows `s` … cannot be spawned or moved into a by-value
parameter"), while the same body declared `generic(T : Type)` with `f : Impl(Future(T, Io))` accepts it and freezes
`x`. The diagnostic also names `s`, the callee `mk`'s parameter, not the caller's `x`. Workaround: add a generic
parameter. Pre-existing: v0.2.76 gives the same E0909.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 C10). Confirmed on develop `64f33c710`. Filed apart from
`issues/2026-11-11-a-borrowing-future-bound-with-a-spelled-type-is-rejected-as-second-class.md` (C9): a different
check rejects it.

## Reproducers

`issues/repros/2026-11-11-a-non-generic-impl-future-parameter-rejects-a-borrowing-future-operand.yo`
(positive, expects accept):

```yo
mk :: (fn(s : &String, io : Io) -> Impl(Future(i32, Io)))(
  io.async({ s : &s.* }(io : Io) => {
    io.await(yield(io), io);
    println(`OUT: ${s.*}`);
    i32(1)
  })
);
wrap2 :: (fn(f : Impl(Future(i32, Io)), io : Io) -> Impl(Future(i32, Io)))(
  io.async({ f }(io : Io) => {
    io.await(yield(io), io);
    io.await(f, io)
  })
);
main :: (fn(io : Io) -> unit)({
  x := String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz");
  t := wrap2(mk(&x, io), io);
  println(`OUT: ${io.await(t, io).to_string()}`);
});
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76
error[E0909]: This value borrows `s` (a place in the future's origin), so it is second-class and cannot be spawned or moved into a by-value parameter (a borrowing future is awaited where it is made, §3.13 A2): a borrow never outlives the scope that lends it.
```

- `…-pos.yo` (control, accepted today): the generic `wrap(generic(T : Type), f : Impl(Future(T, Io)), io : Io)`
  over the same operand.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| non-generic `wrap2(mk(&x, io), io)`, awaited | E0909 | accept |
| the same, `sink(x)` before awaiting `t` (probe `u05`) | E0909 | E0911 at `sink(x)` |
| generic `wrap(mk(&x, io), io)`, awaited | accepted | accept |
| generic `wrap(mk(&x, io), io)`, `sink(x)` before the await (probe `u04`) | E0911 | E0911 |
| generic `wrap(f, io)` over a bound borrowing `f`, `sink(x)` before the await (probe `u03`) | E0911 | E0911 |

## Root cause

`_param_accepts_second_class` (`src/evaluator/calls/helper.yo`) decides which by-value parameter may take a
second-class (borrowing) argument: `io.async`/`io.await` always, `io.spawn` never outside std's unsafe files, and
otherwise `callee_is_generic && is_future_value_type(ptype) && is_future_value_type(result_ty)` — the combinator rule
(§3.13 A4). `wrap2`'s parameter and result are both futures; only `callee_is_generic` is false, because the
`generic(T : Type)` binder is what makes the callee generic, and an `Impl(...)` parameter alone does not.

## Expected

Accept, and freeze `x` through `t` (E0911 at a later write or move of `x`). `plans/VALUES_BY_DEFAULT.md` §3.13 A2
lists where a borrowing future may appear: "as the operand of a future-taking combinator (A4), whose own future is
then second-class too". Nothing there asks the combinator to be generic, and `Impl(Future(i32, Io))` in a parameter
already stands for the argument's own future type. The `callee_is_generic` conjunct should go (or count an `Impl`
parameter as generic). The message should name the caller's lent place, `x`, as the generic path does.

## Test

With the fix: corpus rows `async-combinator-non-generic` (accept) and `async-combinator-non-generic-write` (E0911)
beside the A4 rows in `tests/origins/corpus.tsv`; a case in `tests/async/combinators.test.yo`.
