# Stage-2 fixpoint — full family breakdown (133 clang errors)

**Date:** 2026-07-04
**Baseline:** HEAD (`8ac5ca44e`), yo-self-bin self-compiling `yo-self/main.yo` → C → clang.
**Measurement:** `clang -std=c11 -fno-strict-aliasing -fwrapv -w -O0 -ferror-limit=0 -c stage2.c`

## Divergence is confirmed and one-sided

Same `yo-self/main.yo` source, both compilers:

| Compiler        | stage output | clang errors |
| --------------- | ------------ | ------------ |
| TS (`src/*.ts`) | stage-1 C    | **0**        |
| yo-self-bin     | stage-2 C    | **133**      |

Identical input → the 133 errors are entirely **yo-self port divergence**, not shared
bugs and not inherent limitations. TS emits clean C for every construct here; yo-self
emits _different_ (broken) C. The divergence is the _incompleteness_ kind — the ported
machinery exists but does not fire for certain shapes — not an unfaithful shortcut.

## Top-level split (by enclosing C function)

| Bucket                    | errors | %   |
| ------------------------- | ------ | --- |
| **Async / effect family** | **92** | 69% |
| Non-async                 | 41     | 31% |

The async family is the dominant lever by a wide margin. It is **one root** with several
downstream symptoms (below), not 92 independent bugs.

---

## Family A — async / effect (92 errors)

**Root:** the `io.async` closure's await metadata does not reach the codegen-read closure.
`register_closure_await_analysis` is keyed by a `func_id`, but the closure is evaluated
more than once (def-time body eval + codegen-prep) and each eval mints a **fresh** func*id;
the codegen-read closure is a \_clone* evaluated without `is_inside_io_async_call`. When the
analysis lands under a func_id the codegen closure does not share, codegen sees
`io_async_await_analysis == None` and takes the **sync path instead of the FSM path TS takes**
— and on that sync path the `result := io.await(...)` statement is dropped (the LHS binding
types as `unit`, and codegen's init-assignment skips a unit-typed statement, discarding the
RHS with it).

Concrete proof (same `is_file`/statx closure, TS vs yo-self):

```c
// TS: state machine — await is a suspension point
sm->var_...buf_size = __yo_statx_buf_size();
__yo_io_future_t* _temp = fn_...statx((int32_t)(-2), (uint8_t*)cstr, ...);
if (__yo_effect_escaped) { sm->state = -2; ... }

// yo-self: flat sync body — await DROPPED, result never assigned
size_t buf_size = __yo_statx_buf_size();
uint8_t* buf = ...;
if ((() < ())) {            // was `result < i32(0)` — result resolved to unit
  ...
}
```

### Downstream symptoms of the single root

| Sub-family                                           | errors | example                                                                                 |
| ---------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| A1 dropped-await → `(() < ())` unit operand          | 12     | `if ((() < ())) {` (file.yo `is_file`/`exists`)                                         |
| A3 `__sync_future_N->field` member-ref on non-struct | 12     | `int __pre_await_state = __sync_future_38216->state` (`yo_id_400566`)                   |
| A2 `sm->result = closure_...()` return-type mismatch | 5      | `sm->result = closure_yo_id_7340(&sm->__capture, ...)`                                  |
| A4 other async-closure body cascade                  | 63     | `closure_yo_id_7629` (18), `yo_id_400971` (5), `yo_id_246193` (4), `yo_id_257430` (3) … |

Worst single function: `closure_yo_id_7629` — **18 errors** (an await-in-`while` closure:
dropped await → undefined `result`/`buf` → missing-type-specifier on the loop label,
double `__yo_free`, then a structural brace error as the malformed body unwinds).

### CONFIRMED ROOT (2026-07-04, decisive probe)

It is **not** a func_id side-table keying problem. Instrumenting the analyzer and the eval
stamping site proved:

- `analyze_await_points` **detects all 33** awaits structurally (`is_io_await_call` matches).
- But `get_info(await_arg)` returns **None for all 33** → the future arg's `ExprInfo` was
  never stamped → no typed suspension point → `has_awaits=false` → sync path → dropped.
- The io.await **stamping** branch (`evaluate_function_call`, the `.Some` callee-value arm)
  fires **0 times** for any fs/process closure (17 hits, all in main.yo with a concrete `io`).

**Why:** inside `io.async((io) => { … io.await(fut, io) … })`, the closure's `io` parameter
is the async **bundle SomeT param — it has a TYPE but no runtime VALUE at def-time**. So the
`io.await` callee (property-access `io.await`, resolved from the `Io` struct's
`await : __yo_io_await` field) resolves to **no value**, and `evaluate_function_call` takes
the **`.None` (no-callee-value) arm**, which has no io.await handling — it soft-falls, never
evaluating/stamping the future arg. TS avoids this entirely: it resolves `.await` from the
field's `ioBuiltin` **type** marker (no value needed), so the arg is always typed.

### FINAL ROOT (2026-07-04, corrected — the real one)

The Phase-5 io.async/io.await machinery in `evaluate_function_call` lives entirely inside the
**`.Some(callee_value)` FuncVal arm** (the `is_io_async_call` guard that sets
`is_inside_io_async_call`, and the `is_io_await_call` result-refinement/stamping). Instrumenting
that guard proved it fires **0 times** for any std/fs/process function.

**Why:** in `io.async((io) => { … io.await(fut, io) … })` inside e.g.
`is_file :: (fn(path, io : Io) -> Impl(Future(bool, Io)))(io.async(…))`, the **outer** `io`
is `is_file`'s own **value-less `io : Io` param** at definition time. Property-access `io.async`
(and inside the closure, `io.await`) is resolved by property_access.yo:821 (field-on-struct on a
value-less receiver) to an **`UnknownVal` of the builtin's fn type — NOT a `FuncVal`**. So in
`evaluate_function_call` the callee value is not a `FuncVal`; the `.Some`-FuncVal arm is skipped,
and the entire structural io.async/io.await handling (T/E forall binding, `is_inside_io_async_call`,
await stamping) **never runs** for these functions. The closure body is still def-evaluated (so
`analyze_await_points` runs — `AWREG` fired), but with no T/E context and no await stamping, so
`get_info(await_arg)=None` → `has_awaits=false` → sync path → await dropped.

TS never hits this: `io.async`/`io.await` dispatch on the field type's **`ioBuiltin` marker**
(no runtime value needed), so a value-less `io` param is fine.

**Fix direction (final):** hoist yo-self's io.async / io.await handling so it fires
**structurally** (`is_io_async_call(expr)` / `is_io_await_call(expr)`) in `evaluate_function_call`
**regardless of whether the callee resolved to a `FuncVal` or an `UnknownVal`** — i.e. run the
T/E forall pre-binding + `is_inside_io_async_call` + closure-arg eval + await result
refinement/stamping in the unknown-callee case too. This is the faithful equivalent of TS's
type-marker dispatch (which is value-independent).

**Attempt 3 (structural prebind — fires correctly but insufficient):** hoisted a structural
`_prebind_io_async_forall` to the TOP of `evaluate_function_call` (fires regardless of callee-value
kind). Verified it now **fires for is_file/exists with the correct `T=bool, E=Io`** (30 hits,
fs/process included). But stage-2 stayed at ~133 and awaits still dropped, because it binds `T`/`E`
as **env VARIABLES** (a faithful port of TS helper.ts:1314's `addVariableToEnv`) — and yo-self's
closure param type is **inferred from the expected FnTrait as a SomeType OBJECT**, not an atom that
looks up `env`. So the env var binding never reaches the closure's `io : E` param.

**Remaining piece (the actual mechanism yo-self needs):** resolve the closure's E **SomeType** to
concrete via `register_some_resolved_concrete(E_someType_id, Io)` — the yo-self-native equivalent of
TS setting `eSomeType.resolvedConcreteType = bundleType` (function.ts:2181). Requires extracting the
E SomeType id from the io.async callee's 2nd param type (`Impl(Fn(e : E) -> T)`) and confirming the
closure-param inference path consults `lookup_some_resolved_concrete`. The env var-binding (attempt 3)
is a real missing port but is NOT the operative mechanism for these closures; it was reverted (neutral).

**Attempt 5 (bind into body-eval env + resolve param SomeType by name — the decisive one):**
Confirmed via `[PARAMTY]` probe that the closure param is a **SomeType uniformly named `"E"`**
(id per-closure, e.g. 1739). Re-applied the structural call-site prebind of `E→concrete` AND
added a param-loop resolution (`get_value_of_some_type_from_env(env, rp_ty)` before binding) in
`anonymous_function.yo`. Still 136, no awaits recovered. The `[PARAMRES]` probe showed why:

```
19×  pname=e  rp_ty=E  resolved=E      E_in_env=1
 8×  pname=e  rp_ty=E  resolved=IoExn  E_in_env=1
 3×  pname=io rp_ty=E  resolved=E      E_in_env=1   ← the is_file/statx cases
```

`E_in_env=1` is the **original forall-E binding, NOT the call-site prebind** — the closure's
param-loop `env` is a **different env instance** than `evaluate_function_call`'s `env` where the
prebind ran, so the concrete `E→Io` binding never reaches it. The 8 `IoExn` successes resolve on
their own (normal specialization), independent of the prebind. **Conclusion: binding `E` at the
io.async call site fundamentally cannot reach the closure body's type-inference env in yo-self's
architecture.** The concrete effect (from the io.async expected `Impl(Future(T,E))`) and the
closure's param-inference env are only connected in TS via calleeEnv threading + a shared forall-E
SomeType object; yo-self separates them (the closure param is a _fresh_ SomeType named `E`, not the
signature's E object). This is a **structural/design-level gap**, not a localized patch: the fix
must thread the io.async forall-E concretization into the closure's param-type inference (e.g. make
`resolve_param_types_from_expected` substitute E into the closure param type in BOTH the FuncVal and
value-less callee paths, or register the closure's own fresh-E id → concrete and have param binding
consult `lookup_some_resolved_concrete`). All 5 localized attempts reverted; baseline clean at 133.

**Attempt 6 (BREAKTHROUGH on layer 1 — the eval fix works):** bind concrete `T`/`E` into the
closure's **`body_eval_env`** (not the call-site env) in `evaluate_anonymous_function`, sourced from
the **enclosing fn's return `Impl(Future(T,E))`** (which `anonymous_function` already reads for
`register_definition_site_return`), + resolve a SomeType value-receiver via
`get_value_of_some_type_from_env` in property_access before field access. This is the env-threading
connection all prior attempts lacked: `anonymous_function` has BOTH the concrete effect (from the
enclosing return) AND the exact env the closure body evaluates in. **Result: awaits RESOLVE** —
empty-ops 6→3, sync_future 148→**224** (+76 closures now take the async path instead of dropping).

But stage-2 rose 123→**237**: layer 1 exposed **layer 2**. The newly-async closures call OTHER async
fns and await them via the sync-await path, but those callees' **state-machine struct definitions are
never emitted** — 77 `incomplete definition of type 'io_async_block_..._state_t'` + 37 `member
reference base ... is not a structure` (reading `->state` on the incomplete SM struct). The SM structs
were never collected because these closures were previously sync-dropped, so the nested-async codegen
path was never exercised for them. **Layer-2 fix = collect + emit SM struct definitions for
nested-async calls reachable from the un-dropped closures** (codegen collection, substantial). The
attempt-6 eval fix is CORRECT and should be re-applied together with the layer-2 fix (they must land
together — the eval fix alone regresses 123→237). Reverted to keep the green baseline; exact edits are
in the git reflog / this doc (anonymous_function.yo body_eval_env T/E bind + property_access base_ty
SomeType resolve).

**Attempt 7 (layer-2 codegen fallback — partial, exposes layer 3):** with attempt-6's layer-1 eval
fix re-applied, added a fallback in `generate_async_block`'s body extraction (async.yo): when the
closure arg's `closure_function_value` is None, fall back to `cei.value` if it's a FuncVal (mirroring
the fallback already in `io_async_await_analysis`) — because `evaluate_anonymous_function` sets only
`info.value`, not `closure_function_value`. This cleared MOST `async requires exactly 1 argument`
errors (many → 4). But stage-2 stayed 237 and the 77 `incomplete definition of type
'io_async_block_..._state_t'` persist: the ~4 remaining failing async fns are **SPECIALIZED instances**
(e.g. `yo_id_7125` = `exists`) whose CLONED body's io.async closure arg has **no ExprInfo at all** —
neither `closure_function_value` nor a FuncVal `value` — so even the fallback finds nothing, the body
degrades to the error string, and the fn's SM struct is never emitted (each missing SM struct is
referenced ~11× → the 77-error cascade). **Layer 3 = specialized-async-fn cloned-body closure-arg
ExprInfo**: when a generic/effectful async fn is specialized for codegen, its cloned body's inner
io.async closure is not (re)evaluated/stamped, so codegen has no closure FuncVal to extract the body
from. This is the deepest layer and the true remaining blocker for the async family.

**Family A = 3 layers, all mapped:** (1) closure param `E` resolution — eval fix in
anonymous_function body_eval_env, WORKS; (2) generate_async_block body-extraction fallback to
`cei.value`, WORKS for non-specialized; (3) specialized-async-fn cloned-body closure-arg ExprInfo —
UNSOLVED, the true blocker. All three must land together (1 alone regresses 123→237; 1+2 still 237
due to 3). All reverted to keep green 123.

**Regression traps (all verified this session):**

- An unguarded `.None`-arm io.await result synth (guarded only on `is_io_await_call && args>=1`)
  → **314 errors** (`awaits: 279` vs 148): over-fired and drove a malformed sync-await emission.
- Pre-binding `forall(T,E)` inside the `.Some`-FuncVal arm → **no effect** (that arm never runs
  for these functions; `IOG`/`IOASYNC` probes = 0 hits).
  Any real fix must be the structural hoist above AND must confirm the FSM path emits valid C for
  these specific closures (the earlier malformed statx call had a truncated operand list).

---

## Family B — Error.source trait-default fn not emitted (10 errors) — ✅ RESOLVED (2026-07-04)

**Fixed.** Stage-2 **133 → 123** (−10), corpus 97→98 (PASS 98 DIFF 0), std 152/152, zero regressions.
Root: `_resolve_dyn_trait_values` (evaluator/values/dyn.yo) only monomorphized the `source`
trait-default when it fell through to the `get_trait_default` branch — but impl.yo's default-fill
(dd7b0a78b) registers the RAW generic default in the type-trait-method registry, so it was found
first via `exact`/`by_label` and used un-specialized (the shared generic func*id → hard-generic →
codegen skips its body → dyn wrapper `\_\_yo_wrap*..._source`references an undeclared`fn_...\_source`).
Fix: extracted `\_monomorphize_default_fv(fv, default_fid, value_type, …)`and applied it to the
resolved field from ALL THREE sources (exact/by_label/default) — it specializes via`create_specialized_function_inline`with`ctx.self_type = value_type`iff the value's func_id equals
the trait default's (so real overrides are untouched). Regression test:`tests/codegen-bootstrap/dyn_error_source_default.yo`.

---

### (original analysis)

## Family B — Error.source trait-default fn not emitted (10 errors)

**Root:** the dyn-wrapper functions for the `Error` trait's `source()` method all call
`fn_yo_id_5802`, which is **never emitted**. The sibling `to_string()` wrappers resolve to
real specialized fns (`yo_id_227016`, `yo_id_5589`), so only the `source` trait-**default**
body is missing its specialization.

```c
static __yo_t67 __yo_wrap___yo_t378___yo_t65_source(void* self_ptr) {
  __yo_t378* concrete_value = (__yo_t378*)self_ptr;
  return fn_yo_id_5802(&concrete_value);   // fn_yo_id_5802 never defined
}
```

5 wrapper functions × 2 errors each (undeclared-fn + incompatible-return `int` vs `__yo_t67`).
**Fix direction:** the trait-default `source()` (returns `Option(Dyn(Error))`, default `.None`)
must be specialized and emitted for each impl that inherits it — same shape as the earlier
trait-`?=`-default fill fix (`dd7b0a78b`), but this default is consumed through the **dyn
vtable wrapper** path, which apparently doesn't request the specialization.

---

## Family C — generic-instantiation struct/enum identity mismatch (~11 errors)

**Root:** same-fielded generic instantiations get distinct struct/enum type ids, so a value
of `__yo_t549`/`__yo_t601`/`__yo_t218`/`__yo_t321`/… is initialized/passed where a
structurally-identical but differently-id'd type is expected. This is the classic layer-2
struct-identity family (task #30) surfacing in generic-heavy call paths.

Representative functions (all `yo_id_13321_*` / `yo_id_13332_*` = generic instantiations,
plus `yo_id_251116/252395/346587/357219` passing `__yo_t601` = `<enum:enum_yo_id_251312>`):

```
L40028  initializing '__yo_t549' with incompatible type ...
L202910 passing '__yo_t601' to parameter of incompatible type ...
L79623  initializing '__yo_t218' with incompatible type ...
```

**Fix direction:** extend the codegen stable-type-identity keying (the same-fielded
instantiation collapse) to these enum/struct instantiations. Needs per-case confirmation
that the two ids really are structurally identical (vs a genuine eval type divergence).

---

## Family D — `__yo_cond_create` pointer/int mismatch (5 errors)

```
L12698 assigning to '__yo_t371 *' ... incompatible integer to pointer conversion
```

`sm->result = closure_...()` inside a cond-lowering — the cond-result temp's C type
(pointer vs the closure's int/bool return) disagrees. Likely coupled to Family A (the
closure return type is the FSM `result` slot); may resolve once A lands. **Verify after A.**

---

## Remaining scattered (≤2 each, ~8 errors)

`expected expression` / misc in `yo_id_264520`, `yo_id_306050`, `yo_id_400958`,
`yo_id_360511`, `yo_id_289175`. Individually small; triage after the big families drain.

---

## Priority order

1. **Family A (92, 69%)** — async await-analysis dispatch to the codegen-read closure. One
   root, unblocks the entire majority. Highest value by far.
2. **Family B (10)** — Error.source trait-default specialization through the dyn wrapper.
   Self-contained, well-understood shape.
3. **Family C (~11)** — generic-instantiation type-id collapse. Per-case verification needed.
4. **Family D (5)** — likely falls out of A; recheck afterward.
5. Scattered (~8) — triage last.

Fixing A + B alone would take 133 → ~31 (a 77% cut) if each root resolves cleanly.
