# yo-self: closures against where-clause-constrained `F` params emit `void*` C params

**Status:** OPEN — diagnosed 2026-07-28 (probe-verified). The
`closure_capture_rc_leak` RED + part of the iterator-combinator hollow class.

## Shape

```rust
apply_each :: (fn(generic(A : Type, F : Type), items : ArrayList(A), f : F,
  where(F <: (Fn(item : A) -> unit))) -> unit)({ ... });
apply_each(src, (x) => { out.push(x); });
```

TS ok; yo-self emits the closure as `closure_yo_id_N(void* ctx, void* x)` and
calls it with `int32_t` → clang int-to-pointer error (or SIGSEGV at -O2).
Minimal repro: `/tmp/wcf.yo`. Same class: `src.into_iter().for_each(...)`
(prelude for_each, tests/closure_capture_rc_leak.test.yo).

## Probe-established mechanism (diag build, `__YCLO`/`__YSBS`)

1. The closure DOES reach anonymous_function.yo's SomeT arm with
   `expected = F` and `extract_fn_trait_from_type` DOES find the Fn trait in
   F's own required_trait_types (`extract=true`) — the where-clause-extract
   gap I first hypothesized is NOT the blocker (an env-aware
   `extract_fn_trait_from_type_with_env` was added in /tmp/yb anyway —
   faithful TS:927-938, harmless, keep or drop on landing).
2. The extracted trait carries the GENERIC param: `fn(item : A) -> unit`.
   TS substitutes `A := i32` via anonymous-function.ts:249
   `substituteSomeTypesFromEnv(functionType, expectedTypeEnv)`.
3. A NARROWED port of that substitution (bare-SomeT positions only,
   concrete-binding-only, self-binding guard — /tmp/yb
   `_subst_bare_somet_from_env`) does NOT fire: `__YSBS nm=A found=0` —
   **`A` has no binding in expected_type_env at closure-creation time.**
   THE EVAL-ORDER WALL (same root as cluster-B's c03): yo-self's FuncVal arm
   evaluates ALL args first and binds foralls AFTER
   (function.yo:3373 "Evaluate all arguments" → :3875 \_funcval_bind_foralls);
   TS interleaves per-arg (checkIfFunctionParameterMatchesArgument), so its
   closure sees `A := i32` already bound.

## Fix direction (next session)

Creation-time substitution CANNOT work under the current arg-eval order. Two
candidates, in preference order:

1. **Mint-side re-registration** (the c03-batch pattern): in
   create_specialized_function_inline, when an ARG is a closure FuncVal whose
   registered func type has placeholder params (`fn(x : x) -> _ret` — param
   SomeT named after the param), look up the DECLARED param's where-clause Fn
   trait (`get_where_clause_constraints_for_some_type` on F in callee_env),
   substitute its param/result types from the mint env (A := i32 IS bound
   there — the zb loop / callee_env carry it), and `register_func_type` the
   concrete `fn(item : i32) -> unit` under the closure's fid. This is the
   variant of the removed batch-piece that never fired for c03 (dyn-shape) —
   HERE it has the data. CAUTION: t_func_simple drops meta flags — rebuild
   meta from the closure's existing registration instead.
2. Reorder closure-arg evaluation after forall inference (TS-faithful
   interleaving) — correct but a wide-blast-radius surgery; defer.

## State

- Experiments live in /tmp/yb ONLY (anonymous_function.yo: env-aware extract
  wiring + `_subst_bare_somet_from_env` + `__YCLO`/`__YSBS` probes;
  trait_checking.yo: `extract_fn_trait_from_type_with_env` after the base fn
  — NOTE Yo has no forward refs, helper must follow its callee).
- Workspace is CLEAN of this front (nothing landed).
- The sweep with the ptr-comparison fix is at /tmp/hs_pcmp (check
  /tmp/hs_pcmp_done).
