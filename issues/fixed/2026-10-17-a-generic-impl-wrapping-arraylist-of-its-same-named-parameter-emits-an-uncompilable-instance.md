# A generic impl that wraps `ArrayList(T)` in another generic over a same-named `T` emits an instance C cannot compile

**Severity:** S2. A valid program fails in the C compiler. The shape is a generic impl whose binder is spelled like the binder of a generic it instantiates over `ArrayList(<its own binder>)`, and std hits it as soon as generic state moves into `RefCell(X(T))` (decision 46). Renaming either binder works around it.

**Status:** FIXED 2026-10-20 (see "Root cause and fix"). **Found:** 2026-10-17, while moving `std/async/channel.yo`'s state into `Rc(RefCell(_ChannelState(T)))` for decision 46 Generation B (#1421). It is not a regression: v0.2.63 and develop `ed733408c` fail the same way.
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

## Measurement round 2026-10-18 (emitted-C evidence; first fix falsified)

The emitted C of the reproducer pins WHEN the nested instance is minted, and
a first fix attempt narrows WHERE it is not:

- **The nested `W(ArrayList(ArrayList(T)))` is minted at DEFINITION-TRIAL
  level, with `T` still abstract.** In the C, the good trial instance's
  constructor takes `_ptr : void**` (an `ArrayList(T)` whose element type is
  a raw binder), while the bad instance's constructor takes
  `_ptr : __yo_t…**` — an `ArrayList` OF the trial `ArrayList(T)` type. Both
  `W` instances exist before `main` is ever evaluated.
- **Falsified fix** (branch `fix/generic-impl-arraylist-same-named-binder`,
  parked, not merged): binder-identity-keyed substitution entries —
  `subst_add_binder` records the binder SomeT's id, and an entry whose
  replacement mentions a SomeT sharing its own (name, frame level) (the
  `T@L ↦ ArrayList(T@L)` shape) then matches only that binder's own
  occurrences — applied at the two `find_methods_from_generic_impls` `spec_s`
  sites, plus a deep SomeT gate on constructor/traversal emission
  (`type_deep_contains_some_type`, the same `Fn`/`Future` carve-outs as the
  shallow check) and the `std/async/channel.yo` `Msg`→`T` revert. Builds
  green (`build`, `check src`, `check std` all rc=0) and the emission gate is
  sound on its own, but the reproducer still fails: **the capture does not
  flow through those two sites.**
- **Narrowed suspicion:** the constructor/result-type path resolving the
  receiver instance's field binder through an ENV binding —
  `_do_chain_resolve` (`src/types/env_lookup.yo`) already has the
  identity discipline from `a-caller-binder-named-t-collides`
  (`_bindings_that_may_be_for`: a binding recorded for another binder is
  that binder's alone), so the remaining hole is a `T` binding recorded
  WITHOUT its binder id (an unrecorded binding "may be for" any same-named
  `T`). The fix is to record `variable_set_bound_some_id` at the site that
  binds the impl's `generic(T)` into the method body env —
  `_inject_forall_captures` / `_build_def_time_body_env` are the candidates
  — NOT to widen resolution.
- The parked branch also carries the regression test
  (`tests/impl.test.yo`, "a generic impl wrapping ArrayList of its same-named
  parameter compiles"), fails-before verified against a develop-built binary:
  the pristine file passes 16/16; with the test the batch fails at the C
  compiler with `implicit declaration of function`, this issue's signature.

## Root cause and fix (2026-10-20)

The capture is in `substitute` itself (`src/types/substitution.yo`), not in
an env binding. A probe build printing every SomeT replacement whose type
mentions the same (name, level) showed the nesting step directly:
`T@3#4236 -> ArrayList(T)` under the map `{T@3 = ArrayList(T)}`, where
`#4236` is `Ch`'s own binder and the `T` inside the replacement is that
same `#4236`. The entry was made for `W`'s binder (`W`'s `T` :=
`ArrayList(<Ch's T>)`, both binders at frame level 3), and the SomeT arm's
(name, level) fallback applied it to `Ch`'s `T` as well. Applying
`T := ArrayList(T)` to its own `T` nests one level per application, so the
receiver instance became `W(ArrayList(ArrayList(T)))`.

Recording binder ids on the forall bindings (`_inject_forall_captures`,
`_funcval_bind_foralls`) and making the runtime-call return substitution
binder-keyed were both tried first and left the C failure unchanged: the
same (name, level) entry reaches `substitute` through several
return-substitution sites, and keying each of them is the wrong level for
the rule.

**Fix:** the SomeT arm's (name, level) fallback goes through
`_subst_lookup_for_some`, which refuses an entry whose type strictly
contains the occurrence's own SomeT id (an occurs check). `T := W(T)`
replacing its own `T` is an infinite type, so such an entry can only have
been made for another binder that shares the spelling. A replacement that
IS the SomeT (a constraint refinement `T := T : (Integer)`) is still
applied. `_type_mentions_some_id` walks fields, elements and pointees
(`get_all_some_types`) plus the type arguments of a top-level instance
or pointee, so a phantom argument there counts too. A phantom argument
under a tuple, array or function type is not inspected; no known shape
needs it.

`std/async/channel.yo` spells its binder `T` again (the #1421 `Msg`
workaround is reverted), and `tests/impl.test.yo` ("a generic impl
wrapping ArrayList of its same-named parameter compiles") is the
regression test. Before the fix the batch fails at the C compiler with
this issue's signature; after it, 17/17 pass.

The codegen half of the fix direction (never emit a registry type with a
SomeT at any depth) is not part of this fix: with the substitution
corrected, the nested instance is never minted.
