# A generic impl that wraps `ArrayList(T)` in another generic over a same-named `T` emits an instance C cannot compile

**Severity:** S2. A valid program fails in the C compiler. The shape is a generic impl whose binder is spelled like the binder of a generic it instantiates over `ArrayList(<its own binder>)`, and std hits it as soon as generic state moves into `RefCell(X(T))` (decision 46). Renaming either binder works around it.

**Status:** OPEN. **Found:** 2026-10-17, while moving `std/async/channel.yo`'s state into `Rc(RefCell(_ChannelState(T)))` for decision 46 Generation B (#1421). It is not a regression: v0.2.63 and develop `ed733408c` fail the same way.
**Reproducer:** `issues/repros/2026-10-17-a-generic-impl-wrapping-arraylist-of-its-same-named-parameter-emits-an-uncompilable-instance.yo`

## Symptom

```yo
{ ArrayList } :: import("std/collections/array_list");
{ assert } :: import("std/assert");
W :: (fn(comptime(T) : Type) -> comptime(Type))(struct(_b : isize, _value : T));
impl(
  generic(T : Type),
  W(T),
  new : (fn(value : T) -> Self)(Self(_b : isize(0), _value : value))
);
Ch :: (fn(comptime(T) : Type) -> comptime(Type))(struct(_st : W(ArrayList(T))));
impl(
  generic(T : Type),
  Ch(T),
  new : (fn() -> Self)(Self(_st : W(ArrayList(T)).new(ArrayList(T).new())))
);
main :: (fn() -> unit)({
  c := Ch(i32).new();
  assert(c._st._value.len() == usize(0), "empty");
});
export(main);
```

`yo compile` evaluates it without complaint, and then the C compiler fails:

```
v9.c:3834:51: error: incompatible pointer types passing '__yo_t_9961311394636792657 **' (aka 'struct __yo_t_9961311394636792657_struct **') to parameter of type '__yo_t_5373372963848264851 **' [-Werror,-Wincompatible-pointer-types]
v9.c:3944:5: error: call to undeclared function '__yo_fs_2135739689903018491'; ISO C99 and later do not support implicit function declarations [-Wimplicit-function-declaration]
v9.c:3955:78: error: call to undeclared function '__yo_fs_593046872969607852'; ISO C99 and later do not support implicit function declarations [-Wimplicit-function-declaration]
```

The variants:

- Renaming `Ch`'s binder to `U` compiles and runs.
- Renaming the inner generic's binder instead does not help when the call goes through `RefCell(St(T))`, because `RefCell`'s own binder is `T`.
- A user `ref(struct(p : Option(T), n : usize))` in place of `ArrayList(T)` compiles. So does `Option(T)` or a bare `T` payload.
- `Box(ArrayList(T))` fails the same way; `W(T)` does not need a `Box`.

In decision 46's `Channel(T)` the failure is `call to undeclared function 'yo_id_…'` for the dispose function of `RefCell(_ChannelState(T))` and `ArrayList(…)`.

## What the C shows

The C carries two `W(ArrayList(T))` struct instances from the definition-time trial of `Ch.new`:

- one with `_value : ArrayList(T)`, which is right for the trial;
- one with `_value : ArrayList(ArrayList(T))`, whose `_ptr` is `ArrayList(T)**` instead of `void**`.

The display name stays `W(ArrayList(T))`. So `W`'s binder `T` was bound to `ArrayList(T_Ch)` and then substituted a second time, and `T_Ch` was captured as if it were `W`'s `T`. `src/types/substitution.yo`'s `SomeT` arm falls back to `subst_lookup(s, &n, lvl)`, keyed by (name, frame level). Its comment already notes that a binder sharing another's spelling is caught by an entry keyed this way. Two top-level impls give their binders the same frame level, so the substitution `T@L ↦ ArrayList(T@L)` is not idempotent, and a second application nests it.

Codegen then emits the nested instance. `type_contains_some_type` (`src/types/utils.yo`) inspects only the top level of a field type, so `_has_generic_fields` (`src/codegen/functions/constructors.yo`) does not see the `SomeT` two levels down, behind `*ArrayList(ArrayList(T))`. A constructor, a dispose thunk and `ArrayList`'s `Drop` specialization are emitted for it, and the `__yo_fs_*` helpers that `Drop` calls never are.

## Fix direction

- Key the binder lookup by identity when a substitution's replacement mentions a `SomeT` with the binder's own (name, level), as `issues/fixed/a-caller-binder-named-t-collides-with-io-async-t.md` did for `io.async`'s binder. Then find the second application.
- Separately, codegen should never emit a registry type that contains a `SomeT` at any depth. `_collect_some_types_into` is the deep walk.
- A regression test is `tests/` with this reproducer as a test case, landing with the fix: a test that fails to C-compile takes its whole batch down.

## Workaround in the tree

`std/async/channel.yo` spells its binder `Msg` (#1421), so `RefCell(_ChannelState(Msg))` and `ArrayList(Msg)` never share a spelling with `RefCell`'s or `ArrayList`'s `T`. Revert that rename when the fix lands.
