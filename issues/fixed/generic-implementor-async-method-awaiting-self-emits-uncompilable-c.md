# A GENERIC implementor whose async method awaits `Self.<async method>` emits C that does not compile

**Status: FIXED 2026-08-26** (branch `fix/c23-generic-impl-async-self`).
Found 2026-08-26 while reviewing the C16 fix; **pre-existing**, reproduced
identically on develop tip (`732d52b8e`). This was the C23 row of
`plans/STD_API_AUDIT.md` §2 and the remaining blocker for D5's
`BufReader(R)`/`BufWriter(W)`.

## Symptom

```rust
Wrap :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T));
impl(
  generic(T : Type),
  Wrap(T),
  AR(
    read  : (fn(self : Self, io : Io) -> Impl(Future(usize, IoExn)))(io.async((e) => usize(5))),
    twice : (fn(self : Self, io : Io) -> Impl(Future(usize, IoExn)))(
      io.async((e) => {
        a := e.io.await(Self.read(self, io), e);
        b := e.io.await(Self.read(self, io), e);
        a + b
      })
    )
  )
);
```

clang rejected the emitted C with 4 errors:

```
error: returning '_file____priv_temp_8413_sync_fut_t *' from a function with
       incompatible result type '__yo_t0'
error: initializing '__yo_t23 *' with an expression of incompatible type '__yo_t0'
error: initializing 'void *' with an expression of incompatible type '__yo_t11'
```

It happened with the body **provided explicitly** *and* with a trait `?=`
default of the same shape; the NON-generic implementor of the same trait was
fine (that non-generic case is what
`issues/fixed/trait-default-awaiting-self-async-method-emits-hollow-fn.md`
fixed).

## Root cause — TWO distinct defects, both only reachable through a generic implementor

Only a generic implementor's methods take the per-receiver specialization arm
in `_evaluate_funcval_runtime_call` (`src/evaluator/calls/function.yo`) — the
non-generic implementor's method type has no SomeTs, so the arm is skipped.
That is why the concrete implementor was immune to both.

### 1. The static-dot `-> Self` resolution clobbered EVERY SomeT return (the `__yo_t0` errors)

`Self.read(self, io)` is a **static dot call**, and the specialization arm's
receiver handling did:

```rust
if(is_some_type(resolved_ret), { resolved_ret = spec_st.clone(); }, { … })
```

— a gate written for `-> Self` returns (`Thread.spawn -> Self`, whose SomeT is
NAMED "Self"), but keyed on *any* SomeT. `read`'s declared return
`Impl(Future(usize, IoExn))` is a SomeT named "Impl", so `resolved_ret`
became the RECEIVER (`Wrap(usize)`), and the spec re-registration
(`register_func_type(spec_fid, spec_ty_candidate)`) baked that in — its
regression guard passes because the receiver struct looks "more resolved"
than the SomeT. The emitted C then declared the specialized `read` as
returning `__yo_t0` (= `Wrap(usize)`) while its body built the
`_sync_fut_t*`, and the awaiting state machine's slot fell back to the
generic Future interface (`__yo_t22*`).

Instrumented evidence: the mint (`create_specialized_function_inline`)
registered the CORRECT `Impl : (Future…(usize) IoExn)` return; a
`[dot-rereg]` probe then showed the dot-route overwriting it with
`<struct:struct_yo_id_6865>` (= `Wrap(usize)`), `regress=false`.

**Fix**: gate the static-receiver resolution on the SomeT being **named
"Self"** (`ret_some_is_self` in `src/evaluator/calls/function.yo` ~2246). Any
other SomeT return (reserved "Impl" wrappers, a foreign generic) keeps its own
resolution channel. With the SomeT kept, codegen's
`_async_override_return_type` resolves the declaration to the returned async
block's SM struct and registers `type_key(ret)` → that C name, exactly as the
non-generic path does.

### 2. `substitute` was not capture-avoiding — a nested Func's own binders got rewritten (the two-`Io` error)

`find_methods_from_generic_impls` (`src/evaluator/values/impl.yo`)
specializes the matched method TYPE by substituting the impl's `T := usize`
at **every same-named occurrence's own frame level**. `substitute`
(`src/types/substitution.yo`) recursed into a param struct's FIELD types with
no notion of shadowing, so the **unrelated `T` binder of `Io.async :
fn(generic(T, E), …)`** inside the method's `io : Io` param was rewritten to
`usize`. The corrupted `Io` then keyed a SECOND C type for one nominal struct
(`type_key` embeds struct field types structurally): the `twice` spec's own
`io` param (arg-era, pristine `Io` = `__yo_t11`) vs its capture struct's `io`
field (declared-era, corrupted `Io` = `__yo_t14`) — clang rejected the capture
literal.

TS is immune natively: it "substitutes" by re-evaluating the type EXPRESSION
in an env, and a nested `fn(generic(T, E), …)` type expr re-binds its own
`T`/`E` fresh, shadowing any outer binding of the same name.

**Fix**: capture-avoiding substitution. `substitute` now masks entries whose
NAME is one of a **nested** Func's own `meta.forall_labels` while recursing
into that Func (`_mask_func_own_binders`). A NAME mask, not (name, level):
`Func.forall_types` stores declared KINDS, and occurrence levels vary per
instantiation era. The **root** node is exempt (`_substitute_at(s, ty,
is_root)`): callers that substitute a Func's own binders on purpose —
`_freshen_io_builtin_callee`'s per-call `T`/`E` re-mint for io builtins —
target the root directly and must keep working.

## Fix

- `src/evaluator/calls/function.yo` — `ret_some_is_self` gate on the
  static-dot receiver resolution in `_evaluate_funcval_runtime_call`.
- `src/types/substitution.yo` — `_mask_func_own_binders` +
  `_substitute_at(s, ty, is_root)`; public `substitute` wraps with
  `is_root = true`.

## Verification

Reproducer: `issues/repros/generic-implementor-async-await-self.yo` — compiles
clean and prints `10`.

Regression test: `tests/generic_impl_async_self.test.yo` (4 arms: explicit
async body awaiting `Self.read` twice; the same via a trait `?=` default; the
non-generic implementor control; a two-type-argument implementor
`Pair2(A, B)`). RED-FIRST on develop: rc=1 with 9 clang errors (the spec's C
return type equal to its `self` param's type; `Pair2` return `__yo_t17`).
GREEN after the fix: 4 passed.

Tree-built binary (`yo build`, `YO_STD=$PWD/std`): `check ./src` 262/262,
`check ./std` 154/154, `compile src/main.yo --skip-c-compiler` rc=0 with
`0 real` transpile-failure markers; `tests/async_await` 184/184,
`tests/async_trait_default_await` 4/4, `tests/algebraic_effects` 74/74,
`tests/thread` 7/7 (the original `Thread.spawn -> Self` case of the clobber),
`tests/arc` 15/15, `tests/iterator_combinators` 49/49, `tests/impl` 10/10,
`tests/iter_filter_closure` 3/3.

## Relationship to the siblings

- C16 (`issues/fixed/trait-default-awaiting-self-async-method-emits-hollow-fn.md`)
  fixed the default-body materialization context; this bug was in the
  per-receiver specialization of the (materialized or explicit) method.
- C21 (`issues/async-trait-default-shares-one-impl-future-concrete-type.md`),
  C17 (dyn vtable splice) and C22 (nested closure in io.async) are separate
  and remain OPEN.
