# yo-self: Index-trait runtime codegen (`al(i)` value-call) — FIXED

## Symptom

A runtime Index-trait call `value(i)` on a custom type (e.g. `al(byte_index)`
where `al : ArrayList(u8)` in `std/string`'s `substring`) emitted
`// Failed to transpile al(i)` in the self-hosted compiler's C output. The
pattern is pervasive: every module importing `std` (→ `std/string`) reaches it.

TS reference compiles it to `(*index_specialized(&al, i))` — a deref of the
specialized `Index::index` method's `*(Output)` return.

## Root cause — a FIVE-layer gap

1. **No codegen dispatch.** `yo-self/codegen/exprs/generation.yo` had no
   equivalent of TS `generateIndexTraitCall`; the author folded index calls into
   `generate_other_function_call` via a method-callee side-table, but that path
   never fires for `al(i)` (the array_index corpus fixture only exercised
   *fixed-array* `a(i)`, a comptime-ref path — not the runtime ArrayList case).

2. **Evaluator dropped the method metadata.** `evaluate_function_call`'s index
   branch (function.yo) stamped only `index_trait_ptr_type` on the ExprInfo, not
   `index_method_type` / `index_method_value` (TS stamps all three,
   function.ts:2789-2791). Codegen had nothing to emit the call from.

3. **The method was generic (unemittable).** yo-self specializes impl methods
   LAZILY at the call site; `find_methods_from_generic_impls` returns the
   UNSPECIALIZED generic method (forall `T`, generic `func_id` whose registered
   `get_func_type` is hard-generic). `should_skip_function_codegen` then drops
   it, so the call referenced an unemitted C function. TS works because a
   concrete type there already carries specialized methods (eager). Fix: route
   the index method through `try_to_call_function_with_arguments` (args =
   `[receiver, idx]`) → `create_specialized_function_inline`, exactly as a normal
   `recv.m(i)` call, producing a concrete `func_id` with a registered concrete
   type that IS emitted.

4. **`expected_type` unification throw.** At `(b : u8) = al(i)` the ambient
   expected type is the auto-DEREFERENCED element type `u8`, but the index method
   returns `*(Output)` = `*(u8)` (deref happens at the index layer). Specializing
   under that expected type threw `Cannot unify *(u8) and u8`. Fix: clear
   `ctx.expected_type` around the specialization (saved/cleared/restored at the
   call site — a swallowing handler's `unwind` would skip an in-helper restore
   and leak `None`).

5. **`ref(self)`-of-object self not dereferenced.** The Index impl is
   `index : fn(ref(self) : Self, idx) -> *(Self.Output)`. For an RC object `Self`,
   the C param is `Self*` (pointer-to-handle). The specialized body emitted
   `self->_ptr` (single deref) instead of `(*self)->_ptr`. Cause:
   `create_specialized_function_inline` binds params via `add_variable_to_env`,
   which can't set `is_ref` — so the body's `self` wasn't marked a by-ref binding
   (the def-time body-eval path, `_build_def_time_body_env`, DOES set it). Fix:
   mark `ref`-parameter variables `is_ref = true` before the specialized body
   eval (scoped to specialization; the hot normal-call path is untouched).

## Fix (commit on feat/bootstrap-codegen)

- `yo-self/evaluator/calls/function.yo` — stamp `index_method_type` +
  `index_method_value` on the ExprInfo at both index-dispatch sites.
- `yo-self/evaluator/calls/index_trait.yo` — `_specialize_index_method`: route
  the generic index method through the normal call/specialization path to get an
  emittable concrete FuncVal; `expected_type` cleared/restored at the call site;
  swallow + `out`-param fallback to the generic value on any failure.
- `yo-self/evaluator/calls/helper.yo` — `create_specialized_function_inline`
  marks `ref`-param variables `is_ref` before body eval (object-`ref(self)`
  deref).
- `yo-self/codegen/exprs/generation.yo` — `_generate_index_trait_call` +
  `_index_method_call_by_name`: emit `(*index_fn(&recv, idx))`, auto-deref unless
  `is_index_trait_address_of`; dispatch when `index_trait_ptr_type` +
  `index_method_type` are present. Mirrors `generateIndexTraitCall`.

## Validation

- New regression fixture `tests/codegen-bootstrap/arraylist_index_call.yo`
  (runtime ArrayList index in a loop) → "YNS", matches TS.
- Full corpus differential: **PASS 79/79, 0 regressions** (`--parallel 1`).
  NOTE: under `--parallel 3` two unrelated fixtures showed flaky SIGTRAP
  (parallel-contention heap issue, not this change — they compile+run cleanly
  serially and 6/6 standalone).
- Per-module transpile-error drain: `error.yo` 5→2, `expr.yo` 5→3 (the `al(i)`
  family removed where reached).

## Remaining (separate family, now surfaced)

The specialized index method body contains `assert(idx < self._length, …)`,
which lowers to `cond(flag => (), true => panic(msg))`. yo-self codegen emits
`// Failed to transpile cond(flag => (), true => panic(msg))` for a unit-valued
`cond` with a `panic` (noreturn) arm in statement position — the assert becomes a
no-op (valid C, runs correctly, so the fixture passes by behavior). This is a
distinct, pre-existing codegen gap (also seen in `yo-self/error.yo`) tracked
separately as the next transpile-error family to drain.
