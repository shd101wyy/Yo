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

## Minimal repro: NOT yet found

A two-module program (`Env :: ref(struct(frames : ArrayList(i64), memo : Option(Self)))`
in a library module with a module-level `ArrayList(Env)` and a getter; `main`
imports it and matches `envs().get(i)`) compiles and runs correctly with the
v0.2.38 seed. The in-tree trigger involves more: `Environment` is imported by
~250 modules and `ArrayList(Environment)` is instantiated both before and after
the struct completes in different modules' evaluation order. Reproduce in tree:
`git stash`-free — apply the field on `perf/evaluator-memory-p2-f3`'s parent
commit and run `yo build`.

## What to fix

A `ref(struct)` naming itself through `Option(Self)` must produce ONE type key
in every module that instantiates a generic over it; the shell → completed
patch (`_patch_self_shell`) evidently misses `Option(<shell>)` instantiations
that were minted by an importer's generic specialization. Until then the
tree's rule stands: a self reference on a ref struct goes through `Box(Self)`.
