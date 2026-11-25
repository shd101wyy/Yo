# `impl(My, Future(i32, Io)())` on a user type is accepted silently and does nothing

**Severity:** S3 — a misleading missing diagnostic: the impl registers without a word, then every use of the type as a future (`io.await`, a `Impl(Future(...))` parameter) is E0602, whose help text ("add the `impl(T, SomeTrait(...))` near the type") sends the user back to the line that is already there.

**Found:** 2026-11-25, probe `p9` of VERDICTS-81 (allocation-free async), while checking whether a user type can implement `Future` by hand. It cannot: `Future` has no methods, and a future is a compiler-generated state machine or sync future.

## Reproducer

`tmp/fixme.yo`:

```yo
{ println } :: import("std/fmt");
My :: struct(n : i32);
impl(My, Future(i32, Io)());
main :: (fn(io : Io) -> unit)({
  v := io.await(My(n : i32(1)), io);
  println(&v);
});
export(main);
```

`yo check tmp/fixme.yo --std-path ./std`, verbatim, rc 1:

```text
error[E0602]: Argument for parameter "fut" does not implement required trait Future(T, E):
- Parameter: Impl(Future(T, E))
- Argument : My
  --> tmp/fixme.yo:6:17
  |
6 |   v := io.await(My(n : i32(1)), io);
  |                 ^^
help: run `yo explain E0602` for more information
yo: error: check: 1 file(s) failed evaluator coverage
```

Without the `await` (a `main` that only builds `My(...)`), the same `impl` line passes `check` with rc 0, so the registration itself produces no diagnostic. The same E0602 comes from passing `My(...)` to a function parameter typed `Impl(Future(i32, Io))`.

Binary: `Yo-wt/dyn-future-reject/yo-out/x86_64-unknown-linux-gnu/bin/yo` (built 2026-11-25 08:48 from develop plus the E0614 rider; `--version` prints 0.2.79), run in a tree at `origin/develop` `1ce232268` with that tree's `std`.

## Root cause

`impl(T, Future(...)())` is accepted as an ordinary trait impl: the registry key for a `FutureTraitT` is its base name (`get_trait_key`, `src/evaluator/values/impl.yo`). But satisfaction of `Future(T, E)` for an argument is decided by the compiler-known future types, not by the impl registry (`type_implements_future` and the E0602 path in `src/evaluator/trait-checking.yo`), so the registered impl is never consulted. The registration site has no check that its trait is one a user type can implement.

## Fix direction

Reject the registration where it happens: `impl(T, Future(...)())` on a user type is an error naming the reason ("a future is created by `io.async`; `Future` cannot be implemented by hand"), with a help line pointing at `io.async` and, for an erased value, `BoxFuture` once it exists (`plans/backlog/ALLOCATION_FREE_ASYNC.md`). The other candidate, making the impl count, is not an option: it would need a user-callable `poll`, which the design rejects (VERDICTS-81, option (b)). A diagnostic code is assigned by the fixing PR (`yo explain` text included).

## Test to add (the fixing lane)

A cli-case or `tests/` case that compiles the reproducer's `impl(My, Future(i32, Io)());` line alone (no `await`) and expects the new diagnostic at the `impl`, failing before the fix (rc 0, no diagnostic) and passing after. This doc moves to `issues/fixed/` in the fixing PR.
