# A generic trait impl over `Array(T, N)` emits `(// Unknown type: Array(u16, N))` into the `==` argument cast, destroying the C

**Status: FIXED 2026-09-05** (change 1 only — see "Fix" below; change 2, the
`// Unknown type:` fallback itself, is still open). **Class**: crash
(build-breaking) — the emitted C did not compile, and the `//` comment swallowed
the rest of the line, so the error cascade pointed nowhere near the cause.

**Found**: 2026-09-04, measuring the `net` row of the std API audit. This is
what blocks the correct, prelude-wide fix for
`issues/derive-eq-clone-ord-over-a-fixed-size-array-field-aborts-at-runtime.md`.

## Symptom

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio"));
open(import("std/string"));
open(import("std/fmt"));

impl(
  generic(T : Type, N : usize),
  where(T <: Eq(T)),
  Array(T, N),
  Eq(Self)(
    (==) : (
      fn(lhs : Self, rhs : Self) -> bool
    )({
      i := usize(0);
      while(runtime(i < N), {
        cond(
          (lhs(i) == rhs(i)) => (),
          true => {
            return(false);
          }
        );
        i = (i + usize(1));
      });
      return(true);
    })
  )
);

main :: (fn() -> unit)({
  s1 := Array(u16, usize(4)).fill(u16(0));
  s2 := Array(u16, usize(4)).fill(u16(0));
  s2(usize(3)) = u16(1);
  unsafe(printf("start\n"));
  cond(
    (s1 == s2) => { unsafe(printf("equal\n")); },
    true => { unsafe(printf("not equal\n")); }
  );
});
export(main);
```

`yo check` passes ("evaluator OK"). `yo compile … --optimize 2`:

```
aei.out.c:1392:3: error: expected expression
 1392 |   if (__yo_effect_escaped) {
      |   ^
aei.out.c:1458:60: error: expected ';' at end of declaration
 1458 | static void __yo_dispose_dispatch(void* ptr) { (void)ptr; }
aei.out.c:1458:60: error: expected '}'
aei.out.c:1384:23: note: to match this '{'
 1384 | void __yo_user_main() {
3 errors generated.
yo: error: compile: C compiler failed (exit 1) on aei.out.c
```

None of those lines is the problem. The problem is line 1391:

```c
  bool _file____priv_temp_9330 = yo_id_7479_rtparam0_Array_u16__4__rtparam1_Array_u16__4__ret_bool((// Unknown type: Array(u16, N))(s1), (// Unknown type: Array(u16, N))(s2));
```

The `//` comment eats the closing parens and the semicolon, so the next
statement (`if (__yo_effect_escaped)`) is parsed as part of the initializer.

Note what the specialization got right — the callee's own name and both its
declaration and definition resolved `N` to `4`:

```c
static inline bool yo_id_7479_rtparam0_Array_u16__4__rtparam1_Array_u16__4__ret_bool(Array_uint16_t_4 lhs, Array_uint16_t_4 rhs);   // line 357
static inline bool yo_id_7479_rtparam0_Array_u16__4__rtparam1_Array_u16__4__ret_bool(Array_uint16_t_4 lhs, Array_uint16_t_4 rhs) {  // line 1402
```

Only the caller-side argument cast kept the unresolved length. The cast is not
even needed here — the argument types already match the parameter types
exactly.

## Narrowing — it is specific to operator dispatch

Three probes, all under `yo 0.2.24 --std-path ./std --optimize 2`:

| shape | result |
| --- | --- |
| inherent generic method over `Array(T, N)` taking a second `Self`, called as `s1.same_as(s2)` | compiles, prints `equal`, **0** `Unknown type` markers |
| user trait `Same(Rhs)` implemented on `Array(T, N)`, method takes a second `Self`, called as `s1.same_as(s2)` | compiles, prints `equal`, **0** markers |
| `Eq(Self)` implemented on `Array(T, N)`, invoked as `s1 == s2` | **broken C**, 1 marker |

So the generic-impl machinery, the const-generic length binding and the
method-call cast path are all fine. It is the operator-dispatch route that
hands codegen a parameter type still carrying `length_var = "N"`.

## Root cause

The cast text comes from `get_type_string`'s `.Array` arm,
`src/codegen/utils/index.yo:1208-1224`:

```rust
.Array(element, length, length_var) => cond(
  (length_var.len() == usize(0)) => { …register Array_<elem>_<len>… },
  true => {
    fallback := String.from("// Unknown type: ");
    fallback.push_string(type_to_string(t));
    fallback
  }
),
```

A non-empty `length_var` means the const-generic length was never bound to a
concrete value, and the arm returns a C *comment* as the "type".

It is reached through `_per_arg_cast`
(`src/codegen/exprs/other_fn_call.yo:669-700`, called at `:1933`), which spells
each cast from the callee's DECLARED parameter types:

```rust
base_str := match(
  param_types.get(i),
  .Some(t) => if(pref, get_type_string(t, context.base), get_storage_type_string(t, context.base)),
  .None => String.from("void*")
);
```

`param_types` is read straight off the call's recorded function type
(`:1790`, `match(function_type, .Func({ param_types : pt }) => pt, …)`). On the
`==` route that function type is the impl's declared one — `lhs : Self`,
`rhs : Self` with `Self = Array(T, N)` — and nothing has substituted `N` from
the concrete receiver, even though the specialization that produced the callee
name did exactly that.

This is a known class with an in-tree fix shape.
`src/evaluator/calls/function.yo:5682-5698` documents the identical situation
for a `comptime(Self)`-returning generic `Array` method ("the const-generic
length `U` is bound to no SomeT … Codegen then rejects it as 'Unknown type'")
and repairs it by resolving the length structurally against the concrete
receiver:

```rust
(resolved_ret_ct : TypeValue) = match(
  _static_dot_receiver_self_type(func_expr, ctx),
  .Some(recv_self) => _resolve_array_length_vars_from_self(ret_type, recv_self),
  .None => ret_type
);
```

`_resolve_array_length_vars_from_self` is at
`src/evaluator/calls/function.yo:559`.

## Fix

Two changes. Change 1 LANDED 2026-09-05; change 2 is still open.

1. **LANDED — but one level deeper than described here.** The operator-dispatch
   path is not the origin: `substitute` itself could not resolve a const-generic
   array LENGTH, because a length var is not a `SomeT` (`TypeValue.Array` stores
   it as the plain string `length_var`, `src/types/definitions.yo:155`), so the
   name/level map never reached it — and the `Self` binding could not either,
   since `_is_self_pattern` covers Struct/EnumT only. Every consumer of a
   generic-impl method type over `Array(T, N)` saw the malformed
   `Array(u16, length = 0, length_var = "N")`, the operator-argument cast being
   merely the loudest.

   `Substitution` now carries length bindings (`subst_add_len_var` /
   `subst_lookup_len_var`, `src/types/substitution.yo`) which the `.Array` arm
   applies, and `find_methods_from_generic_impls`
   (`src/evaluator/values/impl.yo`) registers each value binder's `IntLit` from
   the match's `g_last_match_binding_vals` side channel before substituting.

   One rule matters: `_without_len_vars` STOPS the resolution at a NOMINAL
   boundary (Struct / EnumT / TraitT). A nominal type's field types are part of
   its identity — `type_key` hashes them and the ctfe instantiation memo
   canonicalizes a def-era instance to its concrete twin by that key — so
   rewriting `_ArrayIter(T, N)._arr` minted a key no memo entry matched: one Yo
   struct id became two C typedefs and `into_iter` returned the wrong one
   ("returning '__yo_t18' from a function with incompatible result type
   '__yo_t38'", measured on tests/array.test.yo).

2. **Stop emitting a `//` comment as a type.** `get_type_string`'s two fallback
   sites (`src/codegen/utils/index.yo:1220-1224` and `:1355-1359`) turn "I
   cannot render this type" into a syntax error twenty lines away. Emit a
   marker that fails loudly and locally instead — a bare identifier such as
   `__yo_MISSING_TYPE_Array_u16_N`, which produces `unknown type name
   '__yo_MISSING_TYPE_Array_u16_N'` on the exact line — or, better, call
   `codegen_fatal` with the type spelling and the enclosing function name.
   `src/types/guards.yo:616-622` already classifies an unresolved-length Array
   as having no valid C rendering, so the condition is available before the
   string is built.

## Breaking change

No — the impl above does not compile today, so nothing depends on the current
output.

## Regression test

- `tests/array.test.yo` (LANDED): the prelude's own `impl(generic(T, U),
  where(T <: Eq(T)), Array(T, U), Eq(Self)(…))` compared with `==` at two
  different lengths in one file (two lengths matters — it is what forces two
  specializations of the same impl), plus `Ord`, `cmp`, `Clone` and a
  `HashMap(Array(u8, 4), i32)` round-trip. Red before the fix (C compiler
  failure / "Expected bool, Given unit").
- `tests/generic_impl_trait_default_ne.test.yo` or a sibling: the same impl
  reached through the defaulted `!=`, so the trait-default route is covered too.
- A codegen guard test for change 2: any construct that still reaches the
  fallback must fail the build with a message naming the type, never emit a
  comment into an expression.
