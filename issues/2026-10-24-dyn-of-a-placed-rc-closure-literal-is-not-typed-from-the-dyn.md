# `dyn(rc(<closure>, alloc : …))` rejects the closure literal that `dyn(rc(<closure>))` accepts

**Severity:** S2 — a valid program is rejected ("Expected a function type"): a closure literal cannot be placed
in an allocator through `dyn(rc(…, alloc : …))`, which is the placement spelling of
`plans/backlog/ALLOCATOR_PLACEMENT.md` §2.4. The workaround is to bind the closure with a declared type first.

**Status:** open. Found 2026-10-24 while checking the placement examples of `plans/backlog/ALLOCATOR_PLACEMENT.md`.

## Repro

`issues/repros/2026-10-24-dyn-of-a-placed-rc-closure-literal.yo`:

```
$ yo compile issues/repros/2026-10-24-dyn-of-a-placed-rc-closure-literal.yo -o a.out
error: Expected a function type, got:
u => (u + k)
   --> issues/repros/2026-10-24-dyn-of-a-placed-rc-closure-literal.yo:12:36
```

Line 10 (`dyn(rc(u => (u + k)))`) compiles and prints 42 when line 12 is commented out. Measured with the installed
v0.2.69, and with `--std-path ./std` on develop `48b8e93a1` (`dyn.yo` is unchanged at `82671f612`). Binding the closure first works:
`(f : Impl(Fn(u : i32) -> i32)) = (u => (u + k));` then `dyn(rc(f, alloc : .Some(a)))`.

## Root cause

`evaluate_dyn_value` gives a closure literal inside a cell constructor its type from the `Dyn`'s `Fn` trait. It
passes the cell's type as the expected type of the `rc(...)` call, so `V` binds to the `Fn`-carrying wrapper before
the closure is evaluated. The match that enables this requires exactly one argument
(`src/evaluator/values/dyn.yo:986`, `dbc_args.len() == usize(1)`, whose only argument must be a `=>` call). With
`alloc :` the call has two arguments, the special case does not fire, and the closure reaches `rc`'s generic `V`
with no expected type.

## Fix direction

Accept a cell call whose first argument is the closure literal and whose remaining arguments are the cell
constructor's labeled `alloc :`. The cell type and the expected type do not depend on `alloc`. The match must also
accept an `Rc.new`/`Arc.new` member-call head, with or without `alloc :`: today only an atom head such as `rc`
matches (`.Atom` plus `shared_cell_type_name_of_constructor`, `src/evaluator/values/dyn.yo:991`), so
`dyn(Rc.new(u => …))` would not be typed from the `Dyn` even without `alloc`. That is a separate path from
static-argument inference A3, which changes what `dyn`'s auto-box synthesizes
(`plans/backlog/STATIC_ARGUMENT_INFERENCE.md`).

## Test

Add a case to `tests/rc_cell.test.yo`'s "dyn over an rc-wrapped closure types the closure from the Dyn": the same
three closures with `alloc : .Some(arena.allocator())`. Each call returns the same value, and
`arena.live_blocks()` counts one block per `Dyn`. The case fails to compile today.
