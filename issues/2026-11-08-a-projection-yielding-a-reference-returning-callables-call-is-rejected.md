# A projection that yields a reference-returning callable's call is rejected

**Severity:** S2 — valid programs are wrongly rejected: a `-> &T` function whose body is `f(v)` for `f : Impl(Fn(x : &T) -> &T)` fails with E0601 (`i32` vs `*(i32)`, the pre-decision-43 internal result form), so the HRTB-style row P14 of `plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (`fn-type-linked-result`, "at parity by O2 … nothing to build") is not actually writable today.

Filed 2026-11-08 by the G1 lane (`vbd/g1-fnmut-slots`) from a side finding of the VERDICTS-35 consult (reproducers first written under `~/Workspace/Yo-wt/fable-q1/`, local). Reproduced on the v0.2.75 seed and on a tree binary built from `vbd/g1-fnmut-slots@213c7b008` (develop `dddff6a67` base); not reachable from `OnceCell.get_or_init` (its `T` is a value).

## Reproducer

`issues/repros/2026-11-08-a-projection-yielding-a-reference-returning-callables-call-is-rejected.yo`:

```yo
apply_v : (fn(f : Impl(Fn(x : &i32) -> &i32), v : &i32) -> &i32)(f(v));
main :: (fn() -> unit)({
  o := i32(3);
  a := apply_v(x => x, &o);
  cond((a.* == i32(3)) => (), true => __yo_panic("r"));
});
export(main);
```

```text
error[E0601]: Cannot unify incompatible types: "i32" and "*(i32)"
  --> probe_refcb4.yo:2:66
```

The same E0601 with the slot lent, `f : &mut Impl(FnMut(x : &i32) -> &i32)` called as `apply_mut(&mut (x => x), &o)`. Dereferencing the call instead, `(fn(f : &Impl(Fn(x : &i32) -> &i32), v : &i32) -> i32)(f(v).*)`, fails differently: `error: Last expression in "begin" is not evaluated correctly`.

## What is pinned today

The tested shapes (`tests/origins/corpus/closure-returns-param.yo`, `tests/borrow_spelling.test.yo` near L628) take the callable BY VALUE and return `i32` from `f(v).*`; N1c-3's "a projection is called through … an `Impl`/`Dyn(Fn(...) -> &T)`" is covered only for that deref'd shape. A projection result typed `&T` taken from the callable's call, and the `&`/`&mut` slot spellings, are not.

## Where to look

The callable's declared result `&i32` is unified against `*(i32)`, the
internal pointer form a `-> &T` call result carries, where the enclosing
projection's result is checked. Forwarding a DIRECT projection call is not
accepted either, with a different error: on the same tree binary,
`g :: (fn(x : &i32) -> &i32)(x); apply_d : (fn(v : &i32) -> &i32)(g(v));`
(and the `&g(v).*` spelling) is rejected with "This function returns `&i32`,
a projection (decision 24): … this body has type `i32`", and `&f(v).*` on
the callable gives "&: failed to evaluate the argument expression for
reference". So the gap is a projection body whose result is another call's
reference result, not something specific to closures; the closure path
fails earlier, in unification.

## Test

The fix adds the three shapes (by-value, `&`, `&mut` slots; the `-> &i32` body and the `.*` body) to `tests/borrow_spelling.test.yo` or `tests/fn_mut.test.yo`, plus the P14 corpus row, and moves this doc to `issues/fixed/`.
