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

## Validation

- The `HashMap(String, String).new()` repro must pass under `yo-self-bin check`.
- `yo-self-bin check std/encoding/html.yo` must pass.
