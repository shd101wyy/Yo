# A named async `fn` behind `Box(Dyn(Fn(...) -> Impl(Future(...))))` fails in clang with incompatible pointer types

**Severity:** S2 — a program `yo check` accepts fails at the C compiler (two `-Wincompatible-pointer-types` errors); no wrong code reaches a binary.

Filed 2026-11-25 by the dyn-future-reject lane, from probe `j3` of VERDICTS-80. Reproduced with the v0.2.79 seed and with a develop stage 1 (`78a71eae1`): the same two errors.

## Reproducer

```yo
{ println } :: import("std/fmt");
one :: (fn(io : Io) -> Impl(Future(i32, Io)))(io.async((io : Io) => i32(1)));
main :: (fn(io : Io) -> unit)({
  (mk : Box(Dyn(Fn(io : Io) -> Impl(Future(i32, Io))))) = dyn(Box.new(one));
  v := io.await(mk(io), io);
  println(&v);
});
export(main);
```

`yo check`: evaluator OK. `yo compile repro.yo --cc clang`:

```text
./j3.bin.c:1278:10: error: incompatible pointer types returning '_file____home_temp_5907756808890452371_sync_fut_t *' (aka 'struct _file____home_temp_5907756808890452371_sync_fut_t_struct *') from a function with result type '__yo_t_8381625107937523703 *' (aka 'struct __yo_t_8381625107937523703_struct *') [-Werror,-Wincompatible-pointer-types]
 1278 |   return ((_file____home_temp_5907756808890452371_sync_fut_t* (*)(__yo_t_2472863051630647847 __yo_v_io))(*(void**)self_ptr))(arg1);
./j3.bin.c:8380:100: error: incompatible function pointer types passing '__yo_t_8381625107937523703 *(__yo_t_2472863051630647847)' (aka 'struct __yo_t_8381625107937523703_struct *(struct __yo_t_2472863051630647847_struct)') to parameter of type '_file____home_temp_5907756808890452371_sync_fut_t *(*)(__yo_t_2472863051630647847)' (aka 'struct _file____home_temp_5907756808890452371_sync_fut_t_struct *(*)(struct __yo_t_2472863051630647847_struct)') [-Wincompatible-function-pointer-types]
 8380 |   __yo_t_1421287966358835542 _file____home_temp_43475628340837382700 = __yo_fs_4708949315179876189(__yo_fnval_thunk_yo_id_16116266361483019148000000, (__yo_t_13739048886423768693){ .tag = __YO_T_13739048886423768693_NONE });
2 errors generated.
```

## Root cause (first pass)

Two C spellings of one function's result meet without a conversion:

- The async `fn` value is passed as its thunk `__yo_fnval_thunk_…`, whose C result is the generic future interface `__yo_t_8381625107937523703*` (`Future(i32, Io)`). `Box.new`'s specialization was generated over the function's concrete type, whose result is the state machine's own struct, `…_sync_fut_t*`. The argument and the parameter disagree.
- The `Dyn`'s `call` wrapper (`src/codegen/functions/dyn.yo`, the payload-convention arm over a named function) calls through the function's own prototype (`…_sync_fut_t*`) and returns that pointer from a slot whose ABI is the interface pointer, with no cast.

The future struct starts with `__YO_FUTURE_PREFIX`, so an upcast to the interface pointer is the conversion both sites need (the one a `Impl(Future(T, E))` struct field gets from `_future_field_upcast` in `src/codegen/exprs/other-fn-call.yo`), and the `Box.new` specialization and the thunk should agree on one C type for the payload. The open `issues/2026-10-25-a-list-of-async-function-values-does-not-compile.md` stores the same kind of value in an `ArrayList((fn(...) -> Impl(Future(...))))` and fails differently (a swallowed definition-time error); the two may share the payload-type half.
