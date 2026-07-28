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

## UPDATE (same session, later): mint-side re-registration WORKS — one residual

Implemented in /tmp/yb helper.yo (create_specialized's closure-arg block,
after `get_closure_capture_info`): when the closure's registered type still
has SomeT params/result and the DECLARED param F is a SomeT whose
required-traits carry the Fn trait, substitute the trait's param/result
occurrences by NAME + OCCURRENCE-LEVEL from `forall_names`/
`arg_values.forall_args` (measured: `A := i32` IS there; env NAME resolution
via evaluate_function_parameter_type_again CANNOT see the trait's `A` copy —
Gap-6 lineage), and `register_func_type` the concrete signature rebuilt from
the EXISTING registration's Func fields (meta preserved).

RESULT on /tmp/wcf.yo: `closure_yo_id_5050(void* ctx, int32_t x)` — concrete
(was `void* x`); apply_each's spec emits and is called correctly; the
int-to-pointer error is GONE.

RESIDUAL (still rc=1): inside apply*each's spec body, the nested
`items.get(i)` call references `yo_id_3122*..._rtparam1_1964_...`(an
ArrayList(i32).get spec keyed on UNRESOLVED SomeT 1964) which is never
emitted → undeclared-function. Same family as the c03 "registered spec kept
a generic type" class but for a nested method spec inside the outer spec's
body eval. NEXT: probe that spec's registered type / why 1964 stays
unresolved (likely the`?(T)`Option return or the index param of`get`
minted during the spec body eval with A-era copies).

Probes still in /tmp/yb helper.yo: `__YCW` (forall dump) — strip before
landing. TIER 1 NOT yet run on this batch.

## UPDATE 2: fn-route SOLVED (9ea932e72); method route still open

The landed mint-side re-typing fixes the FN route
(`apply_each(src, closure)` — corpus test closure_where_clause_param.yo).
The METHOD route (`src.into_iter().for_each(closure)`, repro /tmp/wcf2.yo)
still emits `void* x`: at ITS mint, `A` is recoverable from NEITHER
`arg_values.forall_args` (entries are non-TypeVal — `A:=<nonty>
F:=<nonty>`, probed) NOR a flat `get_variables_from_env(callee_env, "A")`
name lookup. Resolving the occurrence via
evaluate_function_parameter_type_again SIGSEGVs deterministically (the
SomeT's constraint graph is cyclic: `Iterator(Item := A)` references A —
the substitute-cycle class; do NOT retry that).

On the method route `for_each` is a TRAIT-DEFAULT method: `A` binds via
`where(Self <: Iterator(Item := A))` matched against the receiver's
Iterator impl (Item = i32) — the assoc-type/where machinery, not env names.
NEXT candidates:

1. Find where the method-route spec resolves `Item := A` (where-clause
   registration / assoc bindings) and harvest A from there.
2. Alternative: hook the re-typing at the `f(v)` CALL inside the spec body
   eval (the closure FuncVal call path) where `v : i32` is concrete —
   route-agnostic.
   The flat-lookup fallback stays in /tmp/yb (fires nowhere yet, harmless);
   workspace has only the landed fn-route fix.

## UPDATE 3: call-site half placed on the WRONG call path

Added the call-site re-typing to helper.yo try_to_call (post-Step-7, before
Step 8) via shared `_retype_closure_and_reeval` — it never fires for the
method route (`__YCS` probe silent for ALL closures): the `f(item)` call
during for_each's spec body eval routes through **function.yo's FuncVal arm**
(the SECOND call path — the yo-self default-args side-table lesson: "TWO call
paths need it"). At the mint, `cc_ae.arg_type` and `.parameter_type` are both
the unresolved `F : (Fn(A) -> unit)` wrapper (probed) — no concrete source
there on the method route.

NEXT: mirror the call-site block onto function.yo's FuncVal arm (args are
evaluated there as `evaled_arg_infos` with concrete `.ty`; the callee FuncVal
is `cv`). Guards as in helper.yo: get_closure_capture_info(fid).is_some() +
registered params SomeT-bearing + ret concrete + all arg infos concrete →
`_retype_closure_and_reeval` (export it from helper.yo or move it to a shared
module). Probes to strip in /tmp/yb: **YAT (mint), **YCS (helper call site).

## UPDATE 4 — method route BLOCKED on the associatedTypeConstraints port

Both call-site re-typing attempts measured NON-FIRING for the method route
(probes silent on helper try_to_call AND function.yo's FuncVal arm): during
for_each's spec body eval, `f(item)` never reaches either call path with the
closure FuncVal as callee (f is bound per the runtime-param convention, and
the body's f-call is typed without a FuncVal dispatch). The only remaining
`A` source at the mint is the where-clause `Self <: Iterator(Item := A)`
matched against the receiver's Iterator impl — and yo-self DISCARDS
`Item := X` bindings at trait specialization (trait_type.yo:49-51:
"constraint validated but NOT stored in TraitT — associatedTypeConstraints
deferred to Phase 3"). The linkage needed to recover `A := i32` does not
exist as data.

CONCLUSION: the method-route shape (into_iter().for_each and the rest of
closure_capture_rc_leak) requires porting TS's associatedTypeConstraints
(store `Item := A` on the trait app; unify against the receiver impl's
assoc bindings at the mint) — a subsystem port, not a patch. The landed
fn-route fix (9ea932e72) stands on its own. All experimental call-site
blocks REVERTED from /tmp/yb (both measured non-firing; no speculative
code kept).
