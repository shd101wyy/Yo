# A generic fn's `Option(U)` result, specialized at an `Option` another call returned, is a second C type

**Severity:** S2. A valid program fails in the C compiler, and `yo check` passes. Any
generic constructor applied to its own result (`wrap(wrap(x))`, `Some` of a `Some` built by
a generic helper) hits it when the outer result flows into a declared `Option(Option(T))`.

**Found:** 2026-10-01, by the adversarial review of `tss/generic-extern-trial`. It is not
caused by that branch: its build fails with the same two clang errors as the seed, and the
reviewer found the C byte-identical with the fix switched off. It reproduces on v0.2.43 and
v0.2.48 with the same two clang errors.

## Reproducer

`issues/repros/a-generic-fns-option-result-at-a-specialized-option-is-a-second-c-type.yo`:

```rust
wrap :: (fn(generic(U : Type), x : U) -> Option(U))(.Some(x));
wrap2 :: (fn(x : i32) -> Option(Option(i32)))({
  y := wrap(x);
  wrap(y)
});
```

```
$ yo compile issues/repros/a-generic-fns-option-result-at-a-specialized-option-is-a-second-c-type.yo
error: returning '__yo_t_2204585333134751227' … from a function with incompatible result type '__yo_t_9366833957449532790'
```

The generic form (the reviewer's) adds a second error inside `wrap`'s specialization:

```rust
wrap2 :: (fn(generic(T : Type), x : T) -> Option(Option(T)))({ y := wrap(x); wrap(y) });
```

```
error: returning '__yo_t_2204…' from a function with incompatible result type '__yo_t_1387…'
error: initializing '__yo_t_3927…_tag' with an expression of incompatible type '__yo_t_7931…'
```

## Measured matrix (v0.2.48, `yo compile`, then run)

The body of `wrap2`, with `wrap` as above:

| `wrap2` | result |
| --- | --- |
| `fn(x : i32) -> Option(Option(i32))`, `{ y := wrap(x); wrap(y) }` | C error |
| same signature, `wrap(wrap(x))` | C error |
| same signature, `{ (r : Option(Option(i32))) = wrap(wrap(x)); r }` | C error |
| same signature, `{ (y : Option(i32)) = .Some(x); wrap(y) }` | prints 9 |
| same signature, `Option(Option(i32)).Some(wrap(x))` | prints 9 |
| `fn(generic(T), x : T) -> Option(Option(T))`, `{ y := wrap(x); wrap(y) }` | C error (two) |
| generic, `{ y := Option(T).Some(x); wrap(y) }` | prints 9 |
| generic, `.Some(.Some(x))` | prints 9 |
| no `wrap2`: `main` matches on `wrap(wrap(i32(9)))` directly | prints 9 |

The trigger is the argument of the OUTER `wrap`. When it is the result of another `wrap`
specialization (`Option(U)` with `U := i32`), the outer specialization's `Option(U)` with
`U := Option(i32)` gets a C type distinct from the declared `Option(Option(i32))`. When it
is a declared `Option(i32)`, the two agree. Both C structs have the same layout (a payload
of `__yo_t_7931…`, the one `Option(i32)` C type). Only the key differs. `main` without a
declared result type never compares the two, so it compiles.

## Cause (not yet confirmed)

Codegen keys an enum by its eval `id` plus its variant fields, then collapses
layout-identical instantiations through the structural signature in
`src/types/type_key.yo` (`g_enum_sig_keys`, `issues/fixed/yo-self-iterator-option-identity.md`).
The `_type_key_at` cycle guard (`g_tk_visited`) renders an enum id already on the expansion
path as id-only. Hypothesis: both `Option(U)` instantiations made by `wrap`'s specialization
carry the same id (the id of `wrap`'s `Option(U)` return type, not re-minted by
substitution). Keying the outer one would then reach the inner one as a field with an id
already on the path. The field renders id-only, so the outer signature differs from the
declared `Option(Option(i32))`, whose payload expands. This would explain why a declared
`Option(i32)` argument (a different id) works. It has not been checked with a probe. The
first step is a `type_key` debug print of both keys. `EnumT` has no `type_arguments` field
(`issues/method-on-a-phantom-generic-enum-is-not-found-through-a-comptime-type-param.md`,
`tss/phantom-enum-type-args`), and that is the likely place for a fix that gives every
enum instantiation a stable key. Gate any fix on byte identity of the self-compile C.
