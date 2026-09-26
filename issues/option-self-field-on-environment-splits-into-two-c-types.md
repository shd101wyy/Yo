# An `Option(Self)` field added to `Environment` (a `ref(struct)`) is emitted as TWO C types — the self-build's C fails to compile

**Status: OPEN 2026-09-20 (surfaced by the F3 env-snapshot memo; the memo was
moved off the struct so the campaign is not blocked — this records the bug).**

## Symptom

Add `snapshot_memo : Option(Self)` as the last field of `Environment`
(`src/env.yo:570`), pass `Option(Environment).None` at its ten constructions,
`yo check ./src` is green, and `yo build` fails in clang:

```
yo.c:1781203:37: error: initializing '__yo_t_16911249082853750906' (aka 'struct __yo_t_16911249082853750906_struct')
  with an expression of incompatible type '__yo_t_816…'
  __yo_t_16911249082853750906 _file____User_temp_… = __yo_fs_13648156786940465914(g_loading_envs_m…, i);
```

`__yo_t_16911249082853750906_struct { //  : Option(<struct:struct_decl_src__env_r570c2>) }` —
the SELF-SHELL spelling of the module's struct — and the other type is
`Option(Environment)`. The `ArrayList(Environment).get` specialization returns
one, the temp at the call site (in `module_manager.yo`, `g_loading_envs`) is
declared as the other. Two spellings of one type: the id/era split class
(memory notes "identical-name unify error is an id/era split",
`_patch_self_shell`).

`Variable` avoids the shape with `is_owning_the_same_rc_value_as : Option(Box(Self))`
— the Box indirection is what the tree relies on.

## Minimal repro (found 2026-09-26)

`issues/repros/option-self-field-on-environment-splits-into-two-c-types.yo`:
one module, no module global needed.

```rust
Env :: ref(struct(n : i64, memo : Option(Self)));
first :: (fn(l : ArrayList(Env)) -> Option(Env))(l.get(usize(0)));
```

The `ArrayList(Env).get` specialization is emitted with the declared,
unsubstituted result: its C struct is commented `Option(T)`, while `first`
declares `Option(<struct:…Env…>)`. Measured controls:

- the same program without the `memo : Option(Self)` field prints 5;
- `l.get(...)` called directly in `main` on a local list prints the value;
- the call inside a helper whose parameter is `ArrayList(Env)` fails, in one
  module or across two;
- v0.2.43 fails identically.

So the trigger is a generic method specialized for a receiver whose element
type is a self-referential struct still carrying its `Option(Self)` shell,
reached from a function signature. The earlier two-module attempt called
`get` from `main`, which is why it did not reproduce.

## What to fix

A `ref(struct)` naming itself through `Option(Self)` must produce ONE type key
in every module that instantiates a generic over it; the shell → completed
patch (`_patch_self_shell`) evidently misses `Option(<shell>)` instantiations
that were minted by an importer's generic specialization. Until then the
tree's rule stands: a self reference on a ref struct goes through `Box(Self)`.
