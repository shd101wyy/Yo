# ArrayList(u8).push() body — emitter gaps (post return-body-spec fix)

**Status:** RESOLVED (2026-06-16). `std_arraylist_push.yo` now passes the
differential harness (TS and yo-self-bin both print `2`), and all 48
codegen-bootstrap tests pass (0 DIFF / 0 SELF-FAIL). The last piece was the
`begin.yo` single-expression-block fix below (carry `runtime_arg_exprs_in_order`
onto the begin's result node for a runtime call result); the
`GlobalAllocator.{malloc,realloc}` namespace-dispatch gap was closed by the
generic-method-dispatch work that landed alongside it. Kept for the trace
history.

**Original status:** OPEN. Surfaced after the return-body specialization fix
(f2cf25e79) made `ArrayList(u8).push()` *specialize* correctly (T→u8). The call
site and specialization are now correct; the remaining failures are all inside
the specialized push **body**.

## Repro

`/tmp/push1.yo`:
```rust
pragma(Pragma.AllowUnsafe);
{ ArrayList } :: import("std/collections/array_list");
{ putchar } :: import("std/libc/stdio");
main :: (fn() -> unit)({
  al := ArrayList(u8).new();
  al.push(u8(65));
  al.push(u8(66));
  n := al.len();
  unsafe(putchar(int(i32(usize(48) + n))));
});
export(main);
```
TS prints `2`. self-bin: `main` body is CORRECT
(`yo_id_3753(al,65)`, `yo_id_3739(al)`), but the C fails to compile — the push
body (`yo_id_3753`) contains these `// Failed to transpile` forms:

1. `(GlobalAllocator.realloc)(.Some(*(void)(old_ptr)), sizeof(T)*new_capacity)`
   and `(GlobalAllocator.malloc)(...)` — **comptime-namespace method dispatch**
   (`GlobalAllocator` is a comptime value bundling malloc/realloc/free).
2. `*(T)(new_ptr)` — **raw-pointer cast** `*(T)(ptr)` (deref-cast to typed ptr).
3. `.Some(typed_ptr)` — **enum constructor in value position** assigned to a
   `?*(T)` field (runtime pointer payload).
4. `typed_ptr &+ (self._length)` — **pointer arithmetic operator `&+`**.

Each is a separate emitter gap. Also note `sizeof(T)` appears unsubstituted in
the realloc/malloc args (T should be u8 in the specialized body) — verify
whether the spec body substitutes T into `sizeof(T)`.

## Re-confirmed 2026-06-16 (after return-body + match-arm fixes — both unrelated)

Current `push1.yo` push-body failures (verbatim):
```
_tmp = // Failed to transpile (GlobalAllocator.realloc)(.Some(*(void)(old_ptr)), sizeof(T) * new_capacity);
_tmp = // Failed to transpile (GlobalAllocator.malloc)(sizeof(T) * new_capacity);
uint8_t* typed_ptr = // Failed to transpile *(T)(new_ptr);
self->_ptr = // Failed to transpile .Some(typed_ptr);
uint8_t* target_ptr = // Failed to transpile typed_ptr &+ (self._length);
```

### CORRECTION 2026-06-16: there is NO T-substitution gap
An earlier note here claimed `T` was unsubstituted in the specialized push body
(from `sizeof(T)`/`*(T)` in the "Failed to transpile" lines). That was a MISREAD:
those strings are the **source-text echo** (`ast_expr_to_string` of the
un-transpiled expr in the `// Failed to transpile <src>` comment), NOT the lowered
type. The TRANSPILED lines prove T is correctly substituted to `u8`:
`uint8_t* old_ptr`, `uint8_t* typed_ptr`, `uint8_t* target_ptr`, and `self->_ptr`
typed `uint8_t*`. So the blockers are PURELY the emitters below (a `*(T)` cast
would correctly emit `(uint8_t*)`), not generic substitution.

### ✅ `*(T)(ptr)` pointer cast — FIXED 2026-06-16 (commit d8a23ab2a)
Resolved together with runtime numeric casts: both `*(T)(ptr)` and `i32(runtime)`
were rewritten to `__yo_as` by the eval but the rewrite never reached codegen
(returned new node, codegen walks the original). Fixed via the original node's
`macro_expansion` → fresh-id `__yo_as` node. The `*(T)(new_ptr)` line is gone from
push1's failures.

### Progress 2026-06-16 — 3 of 4 push-body gaps FIXED
- ✅ `*(T)(new_ptr)` pointer cast — fixed (d8a23ab2a, runtime casts).
- ✅ `.Some(typed_ptr)` nullable-pointer enum ctor — fixed (93f1cc91c).
- ✅ `typed_ptr &+ (self._length)` pointer arithmetic — fixed (59f147cf3,
  `&`-prefixed ptr operators lower to ptr-builtin inlines).
- ✅ `GlobalAllocator.malloc/realloc` DISPATCH itself — CONFIRMED WORKING in
  isolation (`/tmp/galloc.yo`, `/tmp/grealloc.yo`: `__yo_malloc(8ULL)` /
  `__yo_realloc(m, 16ULL)` emit + run correctly, even with a parenthesized callee).

REMAINING (1 gap, deep): push's `(GlobalAllocator.malloc)(sizeof(T) * new_capacity)`
and the realloc line still emit "Failed to transpile" — NOT the allocator dispatch
(works isolated) but the `sizeof(T) * new_capacity` ARG in the SPECIALIZED push
body. `sizeof(<concrete struct>)` emits fine elsewhere in the same C; only
`sizeof(T)` (the type-param) in the spec-method-body arg position fails the outer
call. Isolation is tricky: a `forall(T)` free fn can't be called with an explicit
`u8` (malformed for TS too); a generic-struct method `grow` calling
`malloc(sizeof(T)*cap)` (`/tmp/gsz2.yo`) surfaced a DISTINCT sub-issue — the
generic unit-returning method CALL `b.grow(...)` itself isn't dispatched (becomes
a no-op), so it doesn't cleanly reproduce push (whose `push` body IS emitted, with
only the malloc/realloc arg lines failing). Next: probe generate_other_function_call
for the push malloc call — is the `sizeof(T) * new_capacity` arg generation
returning empty (sizeof's type-arg T unresolved in the spec body), or is the call
dispatch itself bailing? Tie this to the generic unit-method-call-dispatch gap
gsz2 surfaced.

### Isolation note (2026-06-16): entangled, multiple facets — needs a fresh probe session
Attempts to isolate the push `sizeof(T)*cap` gap each surfaced a DIFFERENT facet:
- `/tmp/gsz2.yo` (generic `grow(self,cap)->unit` with `malloc(sizeof(T)*cap)`):
  the CALL `b.grow(..)` isn't dispatched (no-op) — generic UNIT-returning method
  with a runtime-op body.
- `/tmp/szof.yo` (generic `szof(self)->usize` returning bare `sizeof(T)`):
  `sizeof(u8)` is COMPTIME-folded (u8 concrete) → `n := b.szof()` then
  `putchar(48+n)` "Failed to transpile" — a comptime-method-result-usage path,
  NOT push's runtime `sizeof(T)*cap`.
So the push remainder is entangled with (a) generic-method dispatch for
unit/comptime-result methods, (b) comptime-folded-method-result usage, and (c)
the runtime `sizeof(T)*cap` arg in a spec body. Tackle with dedicated probe builds
(instrument the method-call spec path: does the spec FuncVal get recorded in
g_method_callee_values for these methods? does the spec body eval throw?), not
one-fixture-at-a-time guessing.

### ROOT CONFIRMED 2026-06-16 (multi-layer trace, -O0 probes) — find_methods_from_generic_impls misses Buf(u8).szof
Definitive path for `b.szof()`/`b.grow()` (2-point eval probe, gated on szof/grow):
`PROBE_NONE METHOD_NONE` — the call takes evaluate_function_call's `.None` arm
(callee_value=None) and `_try_find_receiver_method` returns **None** because
`get_receiver_methods_by_name_from_env(env, "szof", Buf(u8))` finds **0 hits**.
Inside that lookup (env.yo:2369): the direct/deref registry lookups miss (szof is
registered under the generic `Buf(T)` id, not the concrete `Buf(u8)`), and the
generic-impl fallback (`_g_find_methods_from_generic_impls_fn`) was only invoked in
the comptime-receiver branch. FIX ATTEMPT (reverted, INERT): added the generic-impl
fallback for the MAIN (non-comptime) receiver — `b.grow()` STILL "Failed to
transpile". The callback IS registered (impl.yo:2107), so the inertness means
**`find_methods_from_generic_impls(env, "szof", Buf(u8))` itself returns empty**.
Contrast: `MyBox(i32).get` (gc2, WORKS) is found by the DIRECT registry lookup
(concretely registered) — so gc2 never needs the generic-impl path. So the real
next layer is `find_methods_from_generic_impls` (generic_impl_registry.yo): why it
finds nothing for `Buf(u8).szof` (is Buf's impl registered in the generic-impl
registry? does the Buf(u8)~Buf(T) match fire?), OR why `Buf(u8)`'s impl methods
aren't concretely registered the way `MyBox(i32)`'s `get` is. NEXT PROBE (one -O0
build): instrument `find_methods_from_generic_impls` entry+result for szof/Buf(u8)
— does it see the Buf impl, and does the type match succeed? (Separately: szof's
`sizeof` result is comptime → even once dispatched, `putchar(n)` needs the
comptime-result-usage gap fixed; grow/push need the malloc-body lines.)
BUILD POLICY (confirmed): iterate probes on `-O0` (~6 min); only the std-sweep
validation needs `--release` (~25-30 min).

### DISPATCH STRUCTURE LOCATED (2026-06-16, read-only) — exact trace points for next session
`evaluate_function_call` (function.yo:617): evaluates the callee →
`callee_value := match(callee_value_raw, .Some(cv) => match(cv, .FuncVal(...) =>
[FuncVal arm, ~1616], .TypeVal(...) => [conversion], ...), .None => [.None
receiver-method arm, ~2557])`. Established:
- probe 1: szof bypasses the `.None` arm (2557) → so `b.szof` RESOLVES to a value
  → it takes the `.Some(cv)` branch → almost certainly the **FuncVal arm (1616)**.
- but the FuncVal-arm runtime-return spec (2365, gated `if forall_names.len()>0`)
  was NOT reached (my record fix at 2410 was inert) → so szof's resolved FuncVal
  likely has **EMPTY forall_names** (the generic-impl forall wasn't stamped onto
  the FuncVal that `b.szof` resolves to), so the spec sub-branch is skipped and
  the method is emitted/dispatched as a plain (unspecialized, SomeT-bearing) fn.
EXACT NEXT TRACE (one build): instrument the FuncVal arm entry (1616) gated on
szof/bump — print `forall_names.len()` and `func_id`. If forall=0, the bug is
UPSTREAM: `b.szof` (property-access resolution of a generic-impl method) returns a
FuncVal WITHOUT the impl forall stamped (so no spec runs). Fix there = stamp the
impl forall when property-access resolves a generic-impl method to its FuncVal
(mirror _stamp_impl_forall_on_method / the keystone), so the FuncVal arm's
forall>0 spec runs and records the specialized method. Compare with gc2/b.get
(works) — which takes the `.None` arm (stamped + recorded there).

### FIX ATTEMPT FALSIFIED (2026-06-16) — FuncVal-arm-spec record is NOT the dispatch path
After the co-trace (below) pinned `MCNAME=NONE` in codegen's concrete-method branch,
I hypothesized the eval FuncVal-call arm (function.yo:2410 runtime-return spec) should
`record_method_callee_value(call_id, spec_fv)` for method calls (mirroring the `.None`
arm). Implemented + `--release` built: corpus 44/44, std 94/58 UNCHANGED, gc2 still "A"
— i.e. INERT (no regression, no improvement). `b.bump()` (generic method, runtime body
`x + i32(1)`) STILL doesn't dispatch (no `bump` fn emitted); `b.szof()` still fails
(comptime-`sizeof` result → `putchar(n)` can't use the folded value). So `bump`/`szof`
do NOT reach the FuncVal-arm runtime-return spec at 2410 either. REVERTED (unvalidated
dead code). CONCLUSION: these generic-method calls take an eval dispatch arm I have NOT
located — NOT the `.None` receiver arm (probe 1), NOT the FuncVal-arm runtime-return
spec (this attempt). NEXT (dedicated session): instrument the TOP-LEVEL dispatch of
evaluate_function_call (every arm entry: the inline-FuncVal arm 1616, the
property-access path, the `.None` arm 2557, comptime-fn path, etc.) gated on
bump/szof, to find which arm each enters and where its spec/side-table recording
should go. This is a systematic eval-dispatch trace — point-fixes at guessed sites
keep coming back inert.

### THREE PROBE BUILDS (2026-06-16) — narrowed to codegen, but a model contradiction remains
- PROBE 1 (eval function.yo:2677 record site, gated szof/grow): ZERO hits — szof/grow
  do NOT reach the `.None` receiver-method arm that records the codegen side-table.
- PROBE 2 (codegen other_fn_call.yo:874 func_ei, gated szof/grow/.get): ZERO hits —
  these calls do NOT reach the func_ei computation.
- PROBE 3 (codegen generate_func_call entry, gated szof/grow): `(b.szof)()`,
  `(b.grow)(usize(4))` → **HAS_INFO**. So the CALL has ExprInfo; the failure is
  generation.yo:**371** (`generate_other_function_call` returns None) — a CODEGEN
  bail, NOT missing ExprInfo (:248) and NOT the eval side.
CONTRADICTION (model incomplete): the concrete-method dispatch branch
(other_fn_call.yo:788, gated `method_atom_ok && !recv_is_dyn`, inside
`func_expr is BF_DOT/2`) — for szof the registry (793) misses generic-impl methods
and the side-table (819) is empty, so `mc_name` is None → it SHOULD fall through to
874. But PROBE 2 says szof never reaches 874. So either (a) `func_expr` for
`(b.szof)()` is NOT recognized as `BF_DOT/2` (parenthesized/FuncVal-resolved callee
→ the whole dyn+concrete-method block is skipped), or (b) szof returns None from an
earlier branch (comptime-value short-circuit? — szof's `sizeof` result may be a
comptime value), or (c) szof IS handled and the "Failed" is from a different
sub-expr. NEXT: a CO-TRACE in one build — instrument the ENTRY of every
generate_other_function_call branch (comptime short-circuit, runtime-enum,
BF_DOT-block gate, concrete-method gate, func_ei) with a one-line tag, gated on
szof/grow, to see exactly which branch szof enters and where it returns None.
Reconcile the contradiction FIRST; only then fix. This is a dedicated co-trace
session — point-probes keep relocating the target.

### (earlier) DISPATCH PATH TRACED (2026-06-16, read-only) — superseded by probe 2/3 above
`record_method_callee_value` (the codegen side-table read at other_fn_call.yo:819)
is called ONLY at function.yo:2679/2682 (the `.None` receiver-method arm), which
the probe proved is NOT reached for `b.szof()`/`b.grow()`/`b.get()`. So these
generic instance-method calls dispatch via the **callee's func_ei.value** (the
property-access `b.<m>` resolves to the method FuncVal; codegen reads it at
other_fn_call.yo:726). The working `b.get()` (gc2) must therefore carry the
**SPECIALIZED** FuncVal on its `b.get` callee ExprInfo, while `b.szof()` carries
the **UNSPECIALIZED generic** (forall present → should_skip_function_codegen skips
it → "Failed to transpile"). So the fix target is: ensure the FuncVal-call-arm
specialization (function.yo:1616 + the runtime-return spec ~2355) PROPAGATES the
specialized FuncVal onto the callee (`b.szof`) ExprInfo — OR that szof's spec runs
at all (gc2's simple `self.value` body specs fine; szof's `sizeof(T)` / grow's
`malloc` body may not). NEXT PROBE (single build): at codegen other_fn_call.yo:726,
print `func_ei.value`'s FuncVal forall-len for `b.szof` vs `b.get` — if szof's has
forall>0 (generic) and get's is 0 (specialized), the spec isn't reaching szof's
callee ExprInfo; fix in the FuncVal arm.

### (earlier) PROBE RESULT (2026-06-16): the method-record site is NOT reached
Instrumented function.yo:2677 (the `.None` receiver-method-dispatch arm where
`record_method_callee_value` + the spec live), gated on the call source containing
"szof"/"grow". A `--release` build + run on `szof.yo`/`gsz2.yo`/`gc2.yo` printed
**ZERO** PROBE_METH lines — even for the WORKING `gc2` (MyBox.get). So generic
instance-method calls (`b.szof()`, `b.grow()`, and even the working `b.get()`) do
NOT dispatch through that arm; they take a DIFFERENT method-eval path (consistent
with the old memory note that `s.len()`/`v.to_string()` bypass function.yo:2535).
=> The "spec produces NOSPEC" hypothesis below is UNCONFIRMED at that site; the
real fix requires first TRACING which eval arm actually resolves+dispatches
`b.<method>()` for a generic instantiation (candidates: inline-FuncVal arm at
function.yo:1616, property-access-resolves-to-FuncVal, or the runtime-return spec
at ~2355). Probe the TOP of evaluate_function_call to see which branch `b.szof()`
enters, THEN locate where (if anywhere) its spec runs / its callee value is
recorded for codegen. This is a deep, multi-facet generic-method-dispatch trace
(every probe so far has relocated the target) — a dedicated systematic-trace
session, not one-fixture probing.

### REFINED COMMON-ROOT HYPOTHESIS (2026-06-16, UNCONFIRMED — see probe result above)
Both `szof` (value-return, `sizeof(T)` body) and `grow` (unit-return, `malloc`
body) fail to DISPATCH (`b.szof()`/`b.grow()` → "Failed to transpile"), while
`gc2`/MyBox.get (`self.value` body) dispatches fine. The differentiator is the
method BODY content: methods whose body uses `sizeof(T)` / runtime allocator ops
don't get dispatched. Likely mechanism: the generic-impl method's spec-body eval
(create_specialized_function_inline) fails/throws on the `sizeof(T)`/malloc body,
so `spec_func_val` is None and `record_method_callee_value` never stores a usable
FuncVal → codegen's concrete/generic method dispatch can't resolve the call →
bails. This ALSO explains why push (ArrayList.push) shows its body emitted with
only the malloc/realloc arg lines failing — push gets dispatched via a different
path (heavily used, collected) but its spec body's `sizeof(T)*cap` arg still fails.
NEXT PROBE (single build): instrument function.yo's method path —
`record_method_callee_value` site + the create_specialized_function_inline call —
to print, for `szof`/`grow`, whether spec_func_val is Some and whether the spec
body eval threw. Then fix the spec-body-eval failure for sizeof(T) bodies.

### (historical) Remaining emitter gaps (isolate each)
- comptime-namespace method dispatch: `GlobalAllocator.realloc/malloc` (callee is
  a comptime value bundling fns — resolve to the bundled fn + emit a normal call).
- `*(T)(ptr)` raw-pointer cast (deref-cast); note `.Some(*(void)(old_ptr))` shows
  `*(void)` too — the void-ptr deref-cast form.
- `&+` pointer arithmetic — NOT a direct `__yo_ptr_add` inline (corrected): in TS
  (`_expr.ts:1222`) `&+` is only unsafe-gated then dispatched as a NORMAL call;
  `&+` is a pointer OPERATOR-METHOD whose body calls `__yo_ptr_add`. So codegen
  must dispatch the `&+` operator method (then the inner `__yo_ptr_add` lowers via
  the inline path). Same operator/method-dispatch complexity class as the others —
  NOT a one-liner.
- `.Some(ptr)` runtime enum-ctor into a `?*(T)` field — NOT a cascade (still fails
  after the `*(T)` fix). Finding: the nullable-pointer `Option(*(u8))` lowers to a
  bare `uint8_t*` (nullable-pointer optimization, `can_optimize_as_nullable_pointer`),
  so `.Some(ptr)` for that representation should emit just `ptr` (and `.None` →
  `NULL`). The enum-construction codegen is missing the nullable-pointer-optimized
  `.Some`/`.None` case. Port the TS branch that emits the bare pointer. (Isolating a
  standalone repro needs care — `&(x)` address-of type vs `?*(u8)` annotation
  mismatched in a quick attempt; use a fixture that mirrors the std `_ptr` field
  shape, or test via push1 once GlobalAllocator dispatch lands.)

Build isolated corpus fixtures per gap. Each needs `unsafe`/raw-ptr scaffolding.

---

## ✅ DISPATCH ROOT RESOLVED 2026-06-16 — `try_match_generic_impl` phantom-type-arg fallback

The "find_methods_from_generic_impls misses Buf(u8).szof" root (above) is FIXED.
`find_methods_from_generic_impls` returned empty because `try_match_generic_impl`
(impl.yo) could not bind the impl's `forall(T)` param: the receiver pattern
`Buf(T)` evaluates to `object(_n : usize)`, in which **T never appears
structurally**, so synthesizing `Buf(T)` against `Buf(u8)` binds nothing →
`all_bound=false` → NOMATCH. (Confirmed by `-O0` probe: `PROBE_GIMPL NOMATCH`,
registry populated `n_keys=15`, entry present.)

TS handles this with the env-fallback at `impl.ts:2290-2331`: when field
synthesis leaves a `forall` param abstract, it reads the binding from
`concreteType.env` (the instantiation env). yo-self's faithful stand-in for
`StructType.env` is `Struct.type_arguments`. **Fix:** new helper
`_bind_forall_from_type_args(pattern, concrete, fa_some)` — locate the param's
`SomeT` by name+frame-level inside the PATTERN's `type_arguments`, read the same
position from the CONCRETE's `type_arguments`. Wired into `try_match_generic_impl`'s
binding loop as the `.None` fallback.

**Validated:** `szof.yo` → `1` (was blank; `b.szof()` now resolves to
`sizeof(u8)=1`), `gsz2.yo` → `Y` (grow body compiles+runs). Both added to the
corpus as `generic_impl_phantom_typearg_{sizeof,alloc}.yo`. Corpus 46/46, 0
regressions. `push1.yo` advanced past method resolution into emitting std
`ArrayList.grow`'s body.

## ✅ FULLY RESOLVED 2026-06-16 — `ArrayList(u8).push()` compiles + runs (output `2`)

The remaining gap was NOT `GlobalAllocator` dispatch (that works) and NOT a runtime
`sizeof(T)` arg. ROOT: **a runtime function call as a match-arm value (or any
single-expression begin body) lost its `runtime_arg_exprs_in_order`**, so codegen
bailed at `other_fn_call.yo:1021` → "Failed to transpile". push's allocate/realloc
are match-arm values (`new_some_ptr := match(self._ptr, .None => malloc(...),
.Some => realloc(...))`), so they hit this.

Isolation chain (gsz2→gsz13, all on `-O0`): each hand-written near-clone of push
WORKED until gsz13 — `match(k, 0 => side(i32(10)), _ => side(i32(20)))` in plain
`main` (no generics, no unsafe, no modules) — reproduced "Failed to transpile
side(...)". 5-point probe (codegen `generate_func_call` + `generate_other_function_call`
+ eval `match.yo` + `function.yo` branch) showed: the call has ExprInfo, reaches
the runtime branch (function.yo:2343, sets `runtime_arg_exprs`), but at codegen
`has_runtime_args=false`. The clobber site: `evaluate_begin_expression`
(begin.yo:723) builds a fresh `out_info` and sets it on `ast_expr_id(expr)` — and
for a single-expression begin, `expr` IS the inner call node (yo-self wraps in a
1-element list rather than clone+mutate-into-begin like TS begin.ts:1016-1045), so
the fresh `out_info` (lacking `runtime_arg_exprs_in_order`) overwrote the call's
own ExprInfo. FIX: carry `runtime_arg_exprs_in_order` from the inner expr when
`expr.id == last_expr.id`, gated to RUNTIME results (UnknownVal/UnitVal/None) so a
comptime-folded `.None`/`.Some(7)`/`i32(0)` (EnumVal/literal value, emitted via the
comptime path) does NOT trip the runtime enum/struct-construction codegen — that
gate was required (unguarded carry regressed match_arm_folded_fncall +
runtime_enum_construct). Corpus 46→48 (+std_arraylist_push output `2`,
+match_arm_runtime_call). std sweep held 94/58.

## (HISTORICAL) earlier theory: `GlobalAllocator.{malloc,realloc}` namespace-dispatch in a SPECIALIZED body
After the dispatch fix, `push1.c` has exactly TWO `// Failed to transpile` lines —
both `(GlobalAllocator.realloc)(.Some(*(void)(old_ptr)), sizeof(T) * new_capacity)`
and `(GlobalAllocator.malloc)(sizeof(T) * new_capacity)`. NOTE: the prior theory
("`sizeof(T)` arg unresolved") is likely WRONG — `gsz2.yo`'s `grow` body calls the
SAME `GlobalAllocator.malloc(sizeof(T) * cap)` and transpiles fine because it is a
TOP-LEVEL impl body (normal eval records the property-access callee). push1's
`grow` comes from **std ArrayList, specialized via the new dispatch path** — the
property-access call's callee value isn't recorded into the method-callee
side-table for codegen during specialization. Next: instrument the specialized-body
eval (`create_specialized_function_inline`) — does the `GlobalAllocator.realloc`
property-access FnCall get an ExprInfo.value / g_method_callee_values entry in the
spec body? Compare against the same call in gsz2's top-level body.
