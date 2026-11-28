# A `comptime(T)` that no runtime parameter's type names is abstract in the body: `ArrayList(T).new()` is E0610

**Severity:** S2 — a valid function such as `make :: (fn(comptime(T) : Type, n : usize) -> usize)({ out := ArrayList(T).with_capacity(n); out.capacity() })` is rejected with E0610, no method `with_capacity` on `ArrayList(T)`, because its body is checked with `T` abstract. The workaround is a runtime parameter of type `T`. VERDICTS-97 judged the `Impl(FnOnce(...))` shape S3; the narrowed shape is any `comptime(T)` that only the result or nothing names, so S2.

- Filed: 2026-11-28, finding 4 of [`plans/backlog/GENERATORS.md`](../plans/backlog/GENERATORS.md) §10 (VERDICTS-97 probe `p02b`, found while writing the eval shim). It blocks no generator PR.
- Status: open.
- Related, not a duplicate: `issues/2026-11-28-an-argument-typed-from-a-parameter-that-names-a-comptime-type-keeps-the-type-abstract.md` (the argument, not the body, keeps the abstract `T`).

## Reproducer

- `issues/repros/2026-11-28-a-comptime-type-that-no-runtime-parameter-names-is-abstract-in-the-body.yo`, the probe: `collect_with :: (fn(comptime(T) : Type, sink(body) : Impl(FnOnce(g : &mut ArrayList(T)) -> unit)) -> ArrayList(T))` whose body starts `mut(out) := ArrayList(T).new();`. Expected output `1`.
- `issues/repros/2026-11-28-a-comptime-type-that-no-runtime-parameter-names-is-abstract-in-the-body-minimal.yo`, narrowed: `make :: (fn(comptime(T) : Type, n : usize) -> usize)` with `ArrayList(T).with_capacity(n)`. Expected output `4`.

## Output

The v0.2.80 seed (`~/.local/bin/yo`, bundled std), 2026-11-28, `yo check`. The probe:

```text
error[E0610]: No method "new" on ArrayList(T): the type has no field or method with that name.
  --> 2026-11-28-a-comptime-type-that-no-runtime-parameter-names-is-abstract-in-the-body.yo:9:27
  |
9 |   mut(out) := ArrayList(T).new();
  |                           ^
help: run `yo explain E0610` for more information
yo: error: check: 1 file(s) failed evaluator coverage
```

The narrowed file:

```text
error[E0610]: No method "with_capacity" on ArrayList(T): the type has no field or method with that name.
  --> 2026-11-28-a-comptime-type-that-no-runtime-parameter-names-is-abstract-in-the-body-minimal.yo:6:22
  |
6 |   out := ArrayList(T).with_capacity(n);
  |                      ^
help: run `yo explain E0610` for more information
yo: error: check: 1 file(s) failed evaluator coverage
```

A stage 1 of `d5f2a339e` (develop `56933fcd8` plus one fix, run with this tree's std) prints the same two errors.

## Which signatures show it

Seed v0.2.80, each a function whose body calls a static method of `ArrayList(T)`:

| Parameters besides `comptime(T) : Type` | Result |
| --- | --- |
| none (`-> ArrayList(T)`, body `ArrayList(T).new()`) | E0610 |
| `n : i32` or `n : usize` | E0610 |
| `k : Impl(Fn() -> i32)`, `body : Impl(FnOnce(g : &mut i32) -> unit)`, or the probe's `Impl(FnOnce(g : &mut ArrayList(T)) -> unit)` | E0610 |
| `x : T` | compiles and runs |
| `x : Option(T)` | passes `yo check`; the C fails at the argument (the related doc above) |

## Root cause (first pass)

The body appears to be evaluated once with `T` as an unbound binder when no runtime parameter's type names `T` outside an `Impl(...)`, instead of being deferred to each call's specialization as it is when a parameter is typed `T`. A static method on `ArrayList(T)` with `T` unbound finds no impl, so the call is E0610. Where the def-time pass decides to defer is not yet located.

## Test

The test lands with the fix (G-0d): both reproducers and the table's E0610 rows as cases in `tests/`.
