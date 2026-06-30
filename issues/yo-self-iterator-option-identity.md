# yo-self: iterator `next()` mints a second `Option(i32)` id (incompatible-struct C error)

## Symptom

The self-compiled binary fails to C-compile any program that iterates an
`ArrayList(i32)` via its iterator (the `for` macro, or manual
`into_iter().next()`):

```rust
it := al.into_iter();
match(it.next(), .Some(v) => …, .None => …);
```

C error:

```
error: assigning to '__yo_enum_yo_id_3853_i32' (aka 'struct __yo_enum_yo_id_3853_i32_struct')
       from incompatible type '__yo_enum_yo_id_3805_i32' (aka 'struct __yo_enum_yo_id_3805_i32_struct')
```

TS compiles + runs it fine. Repro: `/tmp/cgbugs/45_iter_next.yo`, `/tmp/cgbugs/35_for.yo`.

## Root cause (generic-instantiation struct-identity residual)

`Option(i32)` is instantiated in two different specialization contexts and gets
TWO distinct struct ids that never unify:

- `id_3805` — the element `Option(i32)` from `ArrayList(i32).get()`.
- `id_3853` — the `Option(i32)` return type of the iterator's generic `next()`.

In the iterator `next()` C body, the `.None` branch builds `id_3853` while the
`.Some(value)` branch's `value` comes from `get()` typed `id_3805`, and both are
assigned into one result temp → incompatible struct types.

Plain two-site `Option(i32)` (two ordinary functions returning `Option(i32)`,
cross-assigned) does NOT collide (`/tmp/cgbugs/44_opt_identity.yo` passes). So the
collision is specific to `Option(T)` instantiated inside a generic trait-method
specialization (iterator `next()`) vs inside another generic method (`get()`) —
the comptime-fn cache for `Option(i32)` misses across these two specialization
contexts and mints a fresh id.

This is the same family as the struct-identity-cache work (tasks #29/#30/#40,
`compatibility.yo` exact-cache-key + `_ctfe_args_equal`); this is a residual in
the iterator/generic-trait-method specialization path, not yet covered.

## Scope / priority

- OFF the P1 critical path: yo-self's only real `for` use is over a HashMap
  iterator (`suspension_analysis.yo:329`), which the stage-2 self-compile already
  handles; the ArrayList-element `Option(i32)` double-id is what triggers this.
- A genuine binary codegen-correctness bug for user programs that iterate
  ArrayLists — worth fixing, but it is in the known-hard struct-identity family
  (not a localized fix like the match-arm env leak).

## Next step when picked up

Trace where the iterator `next()` specialization instantiates `Option(i32)` and
why its comptime-fn cache lookup misses the `id_3805` already minted by `get()` —
compare the cache key (`_ctfe_args_equal` / resolved-arg identity) between the two
call contexts. Likely the iterator's `Item`/`T` is carried as a distinct SomeT
identity that doesn't resolve to the same concrete `i32` cache key.
