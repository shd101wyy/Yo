# `sizeof(GenericStruct(K, V))` not comptime inside a generic method → `HashMap(String,String).new()` fails

## Status

**FIXED** — the impl-level `forall(K,V)` are now bound into the matched
method's closure captures during generic-impl dispatch
(`yo-self/evaluator/values/impl.yo`: `try_match_generic_impl` now returns the
per-forall concrete bindings; `find_methods_from_generic_impls` injects them via
`_inject_forall_captures`). `sizeof(Bucket(K,V))` inside
`HashMap(String,String)._alloc_with_capacity` now resolves to a comptime value.
Regression-neutral: `yo-self-bin check ./std` stays 150/151 (html.yo was already
the lone failure), and the `bucket_size` error is gone.

**FIXED (enum-variant inference):** the FN-REG-BODY call path now propagates the
declared return type as the body's `ctx.expected_type` (function.yo, around the
`evaluate_begin_expression(body_box.*, ...)` call). `begin` forwards the hint to
its tail expression and `match` forwards it to its arms, so a tail
`match(..., .None => .Err(.AllocError(...)))` now infers `.Err` against
`Result(Self, HashMapError)`. Verified by a minimal repro
(`mk :: (fn(c:bool) -> E)(match(c, true => .A(x:1), false => .B)); _v := mk(true)`
now passes) and regression-neutral on `check ./std` (still 150/151).

**Next html.yo blocker (separate):** html.yo now progresses past the enum-variant
error and hits `Error: Cannot unify incompatible types: "usize" and "unit"`
(synthetic location — somewhere in the CTFE'd `_alloc_with_capacity` body, which
performs `malloc`, pointer writes, a `while` loop, and `Self(...)` construction).
This is the next gap in fully CTFE-evaluating a runtime-returning method body
during a module-level `:=`. NOTE: `./tests` and `./yo-self` SIGSEGV on
`tests/circular_deps/` style preload limitations (pre-existing, unrelated).

### ATTEMPTED + REVERTED: `param_is_comptime` (the over-eager-CTFE root)

Root cause of the cascade: yo-self's `Func` type dropped TS's per-parameter
`FunctionParameter.isCompileTimeOnly`, so `function.yo` FN-REG-BODY binds a param
compile-time-only via `is_ct := arg_info.value.is_some()` — i.e. ANY param whose
argument carries a compile-time value becomes a comptime variable. So
`_alloc_with_capacity(DEFAULT_CAPACITY)` binds the runtime param `capacity`
comptime → the body is over-CTFE'd (comptime-unrolling the `while`, executing
`malloc` at comptime, …).

I implemented the faithful fix: added `param_is_comptime : ArrayList(bool)` to
`Func` (populated from `FuncParam.is_compile_time_only`, threaded through
`substitution.yo` + all constructions), made `::` set
`force_compile_time_bindings` for its RHS, and changed FN-REG-BODY to bind a
param comptime only when `param_declared_comptime || force_compile_time_bindings
|| omitted`, dropping the comptime value (→ `UnknownVal`) otherwise.

Result: html.yo advanced well past `usize`/`unit` (to "Cannot create a pointer
to a value"), and `x :: add(1,2)` / the enum-variant repro still passed — BUT
`check ./std` regressed **151→71**: 76 files failed with
`Cannot create a pointer to a value. Use "&" ...`. **Binding runtime params to
their comptime argument values is load-bearing FAR beyond `::`** — pointer
creation/casts, type-level computation, and much of std's comptime machinery
rely on it. The `::`-only force was nowhere near enough; replicating TS's full
comptime-evaluation-CONTEXT propagation (every context that requires a
comptime result, not just `::`) is a large, separate effort, not a localized
fix. **Reverted in full** (back to the two good session fixes; `./std` 150/151).
Re-attempting this needs a proper comptime-context model, not the `is_ct` tweak.

---

_(historical) Open — **this is the REAL `std/encoding/html.yo` blocker** (the previous
"generic-instantiation re-call" theory was a phantom; see
`issues/generic-instantiation-object-arg-recall-unknown.md`). Minimal repro
isolated; root cause narrowed but not yet pinned to a line._

## Symptom

`yo-self-bin check std/encoding/html.yo` →

```
check: error in: Error: Expected compile-time value for "bucket_size".
```

html.yo line 21 has a module-level binding `_entity_map := HashMap(String, String).new();`.
Evaluating it calls `.new()` → `Self._alloc_with_capacity(DEFAULT_CAPACITY)`
(`std/collections/hash_map.yo:58`), whose body opens with:

```rust
bucket_size :: sizeof(Bucket(K, V));   // hash_map.yo:59
```

The `::` requires a **compile-time** value. `sizeof(...)` returns _no_ comptime
value (a runtime `usize`), so the `::` binding is rejected.

## Minimal reproducer

```rust
open(import("std/string"));
{ HashMap } :: import("std/collections/hash_map");
_m := HashMap(String, String).new();      // FAIL: Expected compile-time value for "bucket_size"
```

## What is NOT the cause

`get_size_of_type` works fine on concrete (even RC-containing) types — all of
these pass under `yo-self-bin check`:

```rust
open(import("std/string"));
B  :: (fn(comptime(K) : Type) -> comptime(Type))(struct(g : K));
sz :: sizeof(B(String));   // OK — comptime value computed
```

```rust
open(import("std/string"));
sz :: sizeof(String);      // OK
```

```rust
B  :: (fn(comptime(K) : Type) -> comptime(Type))(struct(g : K));
sz :: sizeof(B(i32));      // OK
```

So `sizeof` / `get_size_of_type` correctly compute a comptime size for a
concrete generic struct, including `B(String)`.

## Root cause (CONFIRMED by instrumentation)

Instrumenting `evaluate_size_of` (`sizeof.yo`) and the regular-path forall
binding (`function.yo`) while checking `HashMap(String,String).new()` shows:

```
DBG FORALL-RT func=(HashMap(String, String).new)   n_forall=0 recv_type_args=2 static_self=true
DBG FORALL-RT func=(Self._alloc_with_capacity)      n_forall=0 recv_type_args=2 static_self=true
DBG SIZEOF arg=Bucket(K, V) type=<struct:struct_yo_id_2370> has_size=false
```

The decisive number is **`n_forall=0`**. `K`/`V` are the **impl-level**
`forall(K, V)` from `impl(forall(K, V), where(...), HashMap(K, V), …)` — NOT the
method's own `forall`. The methods `new`/`_alloc_with_capacity` have **zero**
forall params of their own.

`function.yo`'s regular (FN-REG-BODY) call path binds forall params by iterating
**the method's own `forall_names`** (and, as a fallback, pulls the i-th from
`recv_type_args`). With `n_forall=0` that loop never runs — so even though
`recv_type_args=2` correctly carries `[String, String]` from the receiver, `K`
and `V` are **never bound into the method body's env**. `Bucket(K, V)` then
evaluates to a struct whose field types are still abstract `K`/`V` (the struct
gets a concrete id but abstract fields), and `get_size_of_type` can't size an
abstract field → `.None` → the `::` rejects the runtime value.

### Why no minimal repro reproduced

Every minimal `M(String,String).new()` repro **passes** because its methods
return a comptime `usize`, so the call is treated as a comptime/CTFE
constructor and the body is **never actually evaluated** (`comptime_fn.yo`
short-circuits via `is_analyzing_ctfe_capability` → returns `UnknownVal`). No
`DBG SIZEOF` line is emitted for those repros — `sizeof` is never reached. The
real `HashMap` case differs because `_alloc_with_capacity` returns a **runtime**
`Result(Self, HashMapError)`, forcing real body evaluation down the FN-REG-BODY
path where the impl-forall binding is missing. The runtime-vs-comptime return
type — not the `where` clause or arity — is the true discriminator.

## The fix (matches TS `function.ts:267`)

In TS, an impl method's expr/value carries its instantiation **env**
(`func.$.env`), and dispatch does `env = func.$.env` — restoring an environment
where the impl's `forall(K, V)` are already bound to the receiver's concrete
type args. yo-self's `FuncVal` doesn't carry that env; the `recv_type_args`
stand-in only covers a method's **own** foralls.

Fix direction: in `function.yo`'s FN-REG-BODY path (and any other method-dispatch
path), bind the **impl-level** type parameters into `fresh_env` from the
receiver's `type_arguments`, independent of the method's own `forall_names`.
This requires the impl's forall **names** (`K`, `V`) at dispatch — thread them
through method registration (`get_type_trait_methods_by_name_from_env` /
the trait-method registry) so the dispatcher can `add_variable_to_env(fresh_env,
implForallName[i], TypeVal(recv_type_args[i]))` before evaluating the body.

## Over-CTFE root + the faithful TS fix (attempted, reverted — has a prerequisite)

The deeper cause of the `String.from`/`HashMap.new`/`x::add` family is
**over-eager CTFE**: yo-self's `function.yo` FN-REG-BODY _executes_ a called
function's body at check time. TS does **not** — `helper.ts:1729-1801` only
executes a body when `functionType.return.isCompileTimeOnly` (routed through
`evaluateComptimeFunctionCall`); for a **runtime-return** call, `returnValue`
stays `undefined` → the call yields an `UnknownValue(returnType)`, body never
run. (Confirmed by `helper.ts` read + behaviour: TS `_s := String.from("hi")`
→ OK; TS `x :: add(1,2)` → "Expected compile-time value for x".)

**Attempted fix (reverted):** make FN-REG-BODY's runtime fall-through return
`UnknownVal(ret_type)` without executing the body. Results:

- ✅ `String.from("hi")` (was `i32`/`usize`), `HashMap(String,String).new()`
  (was `usize`/`unit`), and **`check ./std` 150 → 151** (html.yo's
  `_entity_map := HashMap(String,String).new()` now type-checks). Phase 3
  `check ./yo-self` 53 → 57.
- ❌ **`check ./tests` regressed 169 → 154** — 15 files
  (`ref_return`, `ref_flowability`, `ref_closure_capture`, `ref_return_labeled`,
  `ref_local_binding`, `slice_flowability`, `safe_code_structural_gates`,
  `comptime_ref`, `higher_kinded_types`, `gadts`, `algebraic_effects`,
  `thread_safety`, `negative_impl`, `extern_unsafe_wrap`, `circular_import`).
  **TS PASSES all of these** (sampled `ref_return`/`comptime_ref`/
  `higher_kinded_types` → TS exit 0). Gating the skip on
  `!force_compile_time_bindings` did NOT recover them (same 15).

**So the fix is correct-in-concept but blocked by a prerequisite.** Since TS
passes those 15 _without_ executing the body either, the regression is NOT
"these need execution" — it's that yo-self's `UnknownVal`-return path drops
metadata the downstream analyses read. The 15 cluster on **ref/flow analysis**
(`is_flowable_expr`) and a few comptime/HKT paths: executing the body currently
populates the body's `ExprInfo`/path-collection/`control_flow`, which the
ref-flow soundness check and others consume; skipping it leaves those empty.

**Next (the faithful path):** make the runtime fall-through yield
`UnknownVal(ret_type)` **with** the ExprInfo metadata TS attaches for a runtime
call (TS sets `expr.$ = { type: returnType, value: UnknownValue, pathCollection,
runtimeArgExprsInOrder, … }` — `helper.ts:~1860`), rather than just a bare
`UnknownVal`. Port that `expr.$` shape faithfully; then the body-skip should be
regression-free (matches TS on `./tests`, `./std`, and the over-CTFE family).
The diverse 15-file set is the validation target.

### CORRECTION (the `expr.$` hypothesis was WRONG — it all reduces to the knot)

Inspecting the 15 regressed-test errors directly (via the un-reverted fix
binary): they are dominated by **`comptime_expect_error` tests** failing with
"Expected compile error, but the expression was evaluated successfully"
(`ref_*`, `slice_flowability`, `safe_code_structural_gates`, `thread_safety`,
`extern_unsafe_wrap`, `negative_impl`, `algebraic_effects`) plus a few comptime
type-app failures (`higher_kinded_types`). So the body-skip did NOT drop
metadata — it **suppressed legitimate errors**. In yo-self, `check` does not
separately type-check `fn` bodies, so those expected errors surface **during the
call-time body evaluation**; skipping it removes yo-self's only error-surfacing
path for the body.

Crucially, the over-CTFE errors are **type-check errors, not execution errors**:
`Cannot unify "i32" and "usize"` (String.from) / `usize`/`unit` (HashMap.new)
come from `synthesize_types` while _type-checking_ the body, so they fire
whether or not `is_executing` is set — only outright skipping the body avoids
them, which is what suppresses the expected errors. And that `i32`/`usize` is
the SAME `struct_yo_id_2052` finding: type-checking `String.from`'s body builds
`String`'s representation and recurses into its **unstamped nested
`Option(ArrayList(u8))`** instantiation (see
`phase3-nested-generic-instantiation-identity.md`).

**Conclusion: `String.from`, `HashMap.new`, and the ~170 Phase-3 files all
reduce to the one nested-generic-instantiation identity knot.** The
"don't execute runtime bodies" / `expr.$` detour does NOT bypass it — it only
hides the symptom while suppressing real errors (net −15 on `./tests`). The
genuine faithful fix is per-instantiation type identity for nested
instantiations (the knot), NOT the body-execution change. Abandon the
body-skip approach.

## Validation

- The `HashMap(String, String).new()` repro must pass under `yo-self-bin check`.
- `yo-self-bin check std/encoding/html.yo` must pass.
- `check ./tests` must stay 169/170 and `check ./std` 151/151 (per-file diff).
