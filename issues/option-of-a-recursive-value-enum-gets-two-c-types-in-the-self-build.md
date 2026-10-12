# `Option(TypeValue)` gets two C types in the self-build once `TypeValue` is a value enum

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
