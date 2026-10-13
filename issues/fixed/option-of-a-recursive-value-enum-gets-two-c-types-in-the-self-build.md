# `Option(TypeValue)` gets two C types in the self-build once `TypeValue` is a value enum

**Status:** FIXED 2026-10-13 (branch `feat/v4-recursive-enum-option-key`)

**Severity:** S1 — the self-build of a tree whose `TypeValue` is a value enum emits C that does not compile (bootstrap breakage for decision 21's conversion)

Found 2026-10-13 while converting `TypeValue` from `ref(enum)` to a value
enum with `Rc(Self)` children (plans/VALUES_BY_DEFAULT.md decision 21, V4).

## Symptom

`yo build --std-path ./std` with the v0.2.59 seed on branch
`feat/vbd-v4-typevalue` (commit 9eefb8c37) passes the evaluator (`yo check
./src` is 278/278) and fails in clang:

```
yo-out/aarch64-apple-darwin/bin/yo.c:281925:36: error: initializing '__yo_t_5105997683559461145' (aka 'struct __yo_t_5105997683559461145_struct') with an expression of incompatible type '__yo_t_9849932324351484803' (aka 'struct __yo_t_9849932324351484803_struct')
 281925 |         __yo_t_5105997683559461145 _file____User_temp_108847455895316052601 = __yo_fs_6731080222984595052(__yo_v_field_types, __yo_v_i);
```

20 errors before clang's error limit, all in `_intern_key_into`
(`src/types/intern.yo`), all the scrutinee temp of
`match(xs.get(i), .Some(x) => recur(&x, …), .None => ())`. The two structs
have the same layout and are one Yo type:

```c
struct __yo_t_5105997683559461145_struct { //  : Option(T)
struct __yo_t_9849932324351484803_struct { //  : Option(TypeValue)
```

`ArrayList(TypeValue).get` returns the second; the temp is declared with the
first, an instantiation recorded under the generic spelling `Option(T)`.

## Reproducer

Not yet minimal. The full tree reproduces it (checkout 9eefb8c37, `yo build
--std-path ./std` with v0.2.59). Three standalone shapes did NOT reproduce:
a value enum with `Rc(Self)`, `ArrayList(Self)` and `Option(Rc(Self))`
variants matched with `match(xs.get(i), …)` inside a `recur` function, in one
module and split across two; and a program importing the real
`src/types/definitions.yo` + `src/types/intern.yo` and calling
`type_intern_key`. So the split needs something else in the compiler's
module graph, most likely an `Option(T)` instantiated with `T` bound to
`TypeValue` before the enum is final (the recursive-enum self shell) and
memoized under that key.

## Fix direction

Find the instantiation that records `Option(TypeValue)` under the generic
key (bisect by deleting src modules from the closure until the clang error
goes away), then canonicalize the shell-era key the way
`issues/fixed/yo-self-codegen-recursive-enum-self-shell.md` did for its
case. Like the drop outlining, the fix has to be carried by a seed before
the converted tree self-builds. The regression test is the minimized
reproducer as a language test.

## Minimal reproducer (found 2026-10-13)

Not a module-graph effect: one file reproduces it with the v0.2.59 seed. The
needed ingredients are an `ArrayList(Self)` payload, an
`ArrayList(ArrayList(Self))` payload, and an `ArrayList(Self).get` inside the
enum's own arms next to a declared `Option(E)`:

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
TV :: enum(
  Leaf(n : i32),
  A(xs : ArrayList(Self)),
  C(zs : ArrayList(ArrayList(Self)))
);
weight :: (fn(t : &TV) -> i32)(
  match(
    t,
    .Leaf(n) => n,
    .A(xs) => match(xs.get(usize(0)), .Some(x) => recur(&x), .None => i32(0)),
    .C(_) => i32(0)
  )
);
first :: (fn(xs : &ArrayList(TV)) -> Option(TV))(xs.get(usize(0)));
main :: (fn() -> unit)({
  xs := ArrayList(TV).new();
  xs.push(TV.Leaf(n : i32(2)));
  match(first(&xs), .Some(f) => println(weight(&f)), .None => ());
});
export(main);
```

```
error: initializing '__yo_t_8679908803349998454' with an expression of incompatible type '__yo_t_12193877122402677336'
```

The earlier attempts had a single `ArrayList(Self)` payload, or no nested
list, so they did not reproduce it.

## Root cause

The two C types are two `type_key`s of one `Option(TV)`. The keys differ only
in how `TV`'s nested `ArrayList(ArrayList(Self))` renders: once its inner list
is expanded (`R#gs_<cfid>_<TV>`), once it is cut to the bare struct id by
`_type_key_at`'s cycle guard.

- `_patch_self_shell` (`src/types/creators.yo`) replaces the self-shell
  inside a recursive enum's payloads, but its visited guard descends into each
  container id once, so a container nested in one already visited keeps the
  shell. A debug dump of the self-build's `TypeValue` showed every
  `ArrayList(Self)` payload as `ArrayList(TypeValue)` and the inner list of
  `EnumT.variant_fields : ArrayList(ArrayList(Self))` as
  `ArrayList(TypeValue__self_shell)`. Another copy of the enum (the
  shell-resolved final that `ArrayList(Self).get`'s `Option(T)` reaches through
  `resolve_enum_shell`) carries a different mix.
- `type_key`'s cycle guard identifies a node by its id plus its type
  arguments' identities (`_tk_node_id` / `_tk_arg_id`), and `_tk_arg_id`
  spelled an enum argument by its raw id, so `ArrayList(shell)` and
  `ArrayList(final)` were different nodes. In one copy the inner list matched
  an already-expanded `ArrayList(TV)` and rendered id-only, in the other it
  did not and expanded. Everywhere else the key resolves shells (the Struct
  and EnumT arms), so the payloads key alike and only the guard split them.
- With `TypeValue` a `ref(enum)` this never showed: a reference enum field
  keys by its id alone, so `Option(TypeValue)`'s key never expanded
  `TypeValue`'s payloads. As a value enum it expands them.

## Fix

`_tk_arg_id` (`src/types/type_key.yo`) resolves a struct or enum self-shell
to its final before spelling the argument, so a shell and its final are one
node for the cycle guard, as they are one type in the key itself. The
`stable_type_identity` guard shares `_tk_node_id`, so it follows.

## Verification

- `tests/recursive_enum.test.yo` "Recursive value enum: ArrayList(Self).get and
  a declared Option(Self) are one type" (the reproducer's shape plus a grid
  read): the batch fails to compile in C under the v0.2.59 seed and passes
  with the fix.
- The `feat/vbd-v4-typevalue` self-emit with a compiler carrying this fix and
  the drop-function fix compiles in clang (0 errors; 200+ before).
