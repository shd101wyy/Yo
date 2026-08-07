# yo-self: method-call inline path skipped `ref`-param address-of on the receiver

## Status: FIXED (pending corpus validation) — yo-self-only port bug; TS reference is correct

## Symptom

A derived clone of a value struct with a PRIMITIVE field failed to compile under
the self-hosted compiler:

```c
return (__yo_struct_..._T){
  .kind  = fn_..._clone((&((*self).kind))),    // enum  field — & present, ok
  .value = yo_id_..._clone((&((*self).value))),// String field — & present, ok
  .row   = (*((*self).row))                    // usize field — NO &, C error:
};                                             // "indirection requires pointer operand"
```

A primitive's clone is `clone : ((self) -> __yo_return_self(self))` with a
`ref(self)` param; `__yo_return_self` codegen emits `(*arg)`, so its arg must be a
pointer. `self.row.clone()` passed the field VALUE `(*self).row` instead of its
address `&((*self).row)`, so `(*((*self).row))` dereferenced a `size_t`.

Repro: `tests/codegen-bootstrap/derive_clone_multifield.yo` (a `struct` with a
`usize` field + `derive(Clone)`); the enum/String fields work, only the primitive
field failed.

## Root cause

yo-self has THREE codegen sites that inline a function whose body is a single
builtin yo-inline call (`is_function_value_with_only_builtin_yo_inline_function_call`):

1. registered named call — `other_fn_call.yo:~1301` — uses `args2` (ref-amped).
2. method-call (`obj.m()`) inline — `other_fn_call.yo:~952` — built `inline_args`
   from `dm_runtime` via plain `_call_generate_expr`, **no ref-amp**. ← bug
3. `_generate_inline_call` (operator/macro) — `generation.yo`.

Site 2 was the odd one out: it never applied the per-param `&` that a `ref`
parameter requires. Non-primitive field clones go through the registered-call
path (site 1, ref-amped → correct `&`); only a primitive field's clone, whose
body IS a single `__yo_return_self`, hit site 2 and lost the `&`. Confirmed by
instrumentation: neither site 1 nor site 3 fired for `self.row.clone()`, yet
`(*((*self).row))` was emitted — isolating site 2.

## Fix

`yo-self/codegen/exprs/other_fn_call.yo` (method-call inline path) — apply the
method's per-param ref-amp to the inline args, exactly as the registered-call
path does:

```rust
m_fid_amp := match(mfv, .FuncVal(_,_,_,_,_,_,_,_, f) => f, _ => String.from(""));
m_pir := match(get_func_type(m_fid_amp), .Func({ param_is_ref : pr }) => pr, _ => ArrayList(bool).new());
inline_args_amped := _apply_ref_amp(inline_args, m_pir, dm_runtime, indent.clone(), context);
return(Option(String).Some(generate_yo_inline_function_call(op, inline_args_amped, ...)));
```

`get_func_type(method_fid).param_is_ref` is `[true]` for a `ref(self)` method, so
`_apply_ref_amp` wraps the (addressable) receiver `(*self).row` to
`(&((*self).row))`, yielding the correct `(*(&((*self).row)))`. Mirrors TS, whose
main arg loop applies the `param.isRef` `&` before the inline dispatch reuses
those args (other-fn-call.ts:807 + :1004).

This is the 4th and final layer of the derive(Clone) value-struct chain — see
`yo-self-derive-clone-typename-quote.md` for the full overview.
