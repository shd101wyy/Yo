# An argument typed from a parameter that names a `comptime(T)` keeps `T` abstract in the emitted C

**Severity:** S2 — a call whose argument takes its type from a parameter type naming a `comptime(T) : Type` parameter (a closure literal at `F <: FnOnce(g : &mut ArrayList(T))`, a `.None` at `x : Option(T)`) passes `yo check`, and the C compile fails because the argument is built at the abstract `T`; no wrong code reaches a binary. The workaround is an annotated argument or a `generic(T : Type)` that a runtime argument fixes.

- Filed: 2026-11-28, finding 3 of [`plans/backlog/GENERATORS.md`](../plans/backlog/GENERATORS.md) §10 (VERDICTS-97 probe `p02a`, found while writing the eval shim). The `Option(T)` shape was found while narrowing it. It blocks no generator PR.
- Status: open.
- Related, not a duplicate: `issues/2026-10-27-a-local-function-value-with-a-comptime-type-parameter-is-called-through-a-c-function-pointer.md` (a local `fn` value with a `comptime` parameter, a different call path) and `issues/2026-11-28-a-comptime-type-that-no-runtime-parameter-names-is-abstract-in-the-body.md` (the body, not the argument, sees the abstract `T`).

## Reproducer

- `issues/repros/2026-11-28-an-argument-typed-from-a-parameter-that-names-a-comptime-type-keeps-the-type-abstract.yo`: `collect_with(generic(F : Type), comptime(T) : Type, sink(body) : F, where(F <: (FnOnce(g : &mut ArrayList(T)) -> unit))) -> ArrayList(T)` called as `collect_with(i32, g => { g.push(i32(1)); g.push(i32(2)); })`. Expected output `2`.
- `issues/repros/2026-11-28-an-argument-typed-from-a-parameter-that-names-a-comptime-type-keeps-the-type-abstract-option.yo`: `make :: (fn(comptime(T) : Type, x : Option(T)) -> usize)` called as `make(i32, .None)`. Expected output `0`.

## Output

The v0.2.80 seed (`~/.local/bin/yo`, bundled std), 2026-11-28. Both files: `yo check` reports `evaluator OK`. `yo compile` on the closure file:

```text
/tmp/genplan-out/a.out.c:2392:59: error: incompatible pointer types passing '__yo_t_3625182621501080596 *' (aka 'struct __yo_t_3625182621501080596_struct *') to parameter of type '__yo_t_18144938423292761045 *' (aka 'struct __yo_t_18144938423292761045_struct *') [-Werror,-Wincompatible-pointer-types]
1 warning and 1 error generated.
yo: error: compile: C compiler failed (exit 1) on /tmp/genplan-out/a.out.c
```

On the `Option` file:

```text
/tmp/genplan-out/a.out.c:2389:179: error: passing '__yo_t_281079847263211483' (aka 'struct __yo_t_281079847263211483_struct') to parameter of incompatible type '__yo_t_14164386760141089438' (aka 'struct __yo_t_14164386760141089438_struct')
9 warnings and 1 error generated.
yo: error: compile: C compiler failed (exit 1) on /tmp/genplan-out/a.out.c
```

A stage 1 of `d5f2a339e` (develop `56933fcd8` plus one fix, run with this tree's std) gives the same two errors with other type hashes.

In the emitted C, `__yo_t_3625182621501080596` is commented `//  : ArrayList(i32)` and `__yo_t_18144938423292761045` `//  : ArrayList(T)`: the specialization's `out` is an `ArrayList(i32)` and the closure's parameter an `ArrayList(T)`. In the `Option` file the argument is the literal `(__yo_t_281079847263211483){ .tag = __YO_T_281079847263211483_NONE }`, a struct commented `//  : Option(T)`, passed to the specialization `…_i32_id_i32_rtparam0_Type…` whose parameter is the `Option(i32)` struct.

With the bound spelled `FnOnce(g : &mut T)` and `T.default()` in the body, the closure's parameter is emitted as `void**`:

```text
error: incompatible pointer types passing 'int32_t *' (aka 'int *') to parameter of type 'void **' [-Werror,-Wincompatible-pointer-types]
```

## Root cause (first pass)

The expected type an argument takes from its parameter is the parameter's declared type before the call's `comptime(T)` argument is substituted into it. The specialization itself is built at `T := i32` (its name carries `i32`, its body uses `ArrayList(i32)`), but the argument that is typed from the expected type (a closure literal's parameters, a bare `.None`) is typed and emitted at the abstract `T`. A `generic(T : Type)` fixed by a runtime argument does not show it.

## Test

The test lands with the fix (G-0d): both reproducers and the `&mut T` shape as cases in `tests/`.
