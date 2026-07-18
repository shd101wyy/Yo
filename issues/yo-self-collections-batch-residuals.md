# yo-self: collections batch residuals after the 2026-07-18 fixes (round-7)

Carriers of the two remaining array_list-batch signatures — see the tail of
issues/fixed/yo-self-void-param-logicalnot-spec.md for the full analysis:

1. `call to undeclared function 'yo_id_XXXX'` (skip-vs-callsite mismatch)
2. `called object type 'int32_t *' is not a function` (Index-trait call
   lowering under the batch shape)

Round-7 logs: /tmp/s2*sweep_r7/tests_collections*\*.done. Both are
pre-existing (masked until now by the void-param + multibyte batch
breakers).

## Signature 3 (round-7 imm_set/imm_map): spec minted with UNRESOLVED SomeTs → skipped but consumed

```
call to undeclared function 'yo_id_5777_rtparam0_gs_yo_id_5128_i32_bool_rtparam1_i32_rtparam2_bool_ret_gs_yo_id_5128_2243_2244'
```

The call-site specialization minted a spec whose registered RETURN type
still contains SomeTs (`2243`/`2244` in the gs\_-render — likely
SortedMap.insert's K/V at some nesting level). should_skip_function_codegen
correctly drops it (has_generic_return), but the CALL SITE was already
stamped with the spec fid → "call to undeclared function".

Fix direction: at the call-site swap (calls/function.yo, after
`spec_ty_fixed`), verify the spec's registered type is CONCRETE before
stamping it onto the callee info (mirror TS hasUnresolvedTypeParams —
refuse the swap, fall back to the original dispatch, and let the
resolution improve). Or fix the binding gap so K/V resolve (the spec's
forall bindings came from a receiver whose type_arguments were shells /
SomeTs — same identity family as everything else).

Also seen: `call to undeclared function 'yo_id_5621'` (bare fid — the
original was skipped as hard-generic while a call site still references
it).

## 2026-07-18 (night): signature 1 ROOT-CAUSED AND FIXED — recursion guard vs impl instantiations

`call to undeclared function 'yo_id_3230'` (ArrayList `==`): the call-site
specialization guard compared BARE func_ids, so while specializing
`Eq(ArrayList(ArrayList(i32))).==` its element compare — a call to the SAME
generic method at the SMALLER instantiation `Eq(ArrayList(i32)).==` — was
misread as direct self-recursion, skipped specialization, and emitted the
bare generic fid. TS never hits this: each generic-impl method instantiation
gets a UNIQUE funcId embedding its substitutions (impl.ts:1551); yo-self
keeps one shared func_id and injects the bindings as `TypeVal` captures
(`_inject_forall_captures`). FIX: `SpecializingFunctionInfo.impl_bindings_sig`
(rendered from those captures) compared by BOTH recursion guards (direct +
mutual) alongside the func_id. Plain generic functions carry an empty sig →
bare-fid behavior preserved (TS-faithful, incl. polymorphic recursion).
15-line repro (nested `ArrayList(ArrayList(i32))` equality): s1 previously
"call to undeclared 'yo_id_3230'", now prints `true`.

## 2026-07-18 (night): the REMAINING array_list residual — wrong-spec pick (Box(T) vs T)

With the guard fixed, tests/collections/array_list.test.yo now fails 3
type-mismatch errors: `passing __yo_t32 to parameter of type __yo_t25` where
BOTH are `<enum:enum_yo_id_3135>` (Option) — `pop()` on
`ArrayList(Box(i32))` returns `Option(Box(i32))` (t32) but the `is_some`
callee chosen is the `Option(i32)` spec (`yo_id_2458_rtparam0_enum_yo_id_3135_i32`).
NOT a Box-unwrap fallthrough — the second site shows `Option(String).is_some()`
ALSO picking the `Option(i32)` spec (`yo_id_2458_rtparam0_enum_yo_id_3135_i32`),
and t9 is `Option(String)` (struct_yo_id_3273 = String), not Result. EVERY
`popped.is_some()` in the batch collapses onto the FIRST-minted Option(i32)
spec regardless of payload.

**ROOT-CAUSED AND FIXED (2026-07-18 night):** probe at the spec-cache HIT
site showed `rt=[Option(String)] cached=[Option(i32)]` — HIT anyway:
`are_types_compatible_exact(Option(i32), Option(String))` returned TRUE. The
enum exact arm had an `aid == eid → true` fast-ACCEPT, and yo-self
generic-enum INSTANTIATIONS share the declaration's eval id (both render
`enum_yo_id_3135_...`), so same-declaration instantiations compared
exact-equal with no payload check. TS only uses ids as an early REJECT;
acceptance always structurally compares variant field types
(compatibility.ts:354-389). FIX: drop the fast-accept — equal ids fall
through to the structural compare (shells are pre-resolved by
resolve_enum_shell, and the vkey cycle guard protects recursion).
tests/collections/array_list.test.yo flips WHOLE-FILE GREEN (87 passed).
Corpus regression: tests/codegen-bootstrap/option_spec_per_payload.yo.

## 2026-07-19: the "void must be first and only parameter" family (4 files) — SCOPED

env/async*await/sync_mutex/prelude batches emit
`static inline void yo_id_5002*...\_str_id_str_rtparam1_comptime_str_ret_unit(void flag, \_\_yo_str msg)`— an assert spec whose param0 (flag : bool) TYPED AS VOID, its rtparam0
segment MISSING from the spec name, and its body containing an EMPTY`if () {`. The spec has ZERO call sites in the batch (a good spec handles
the real calls) — an analysis-pass mint with a unit-typed condition arg
that still gets EMITTED. Producer shape: `assert(x.is_none())` with the msg
OMITTED (tests/env.test.yo:14 — the omitted-default machinery 9100cc135 is
implicated: the DEFAULT msg keeps rtparam1 while the SUPPLIED flag's entry
degenerates). MINIMAL BARE REPRO IS GREEN — the batch context (batched
YO_TEST_INDEX program / analysis re-eval) is required. BISECT RECIPE: the
failing batch SOURCE is saved at /tmp/env_batch_r12.yo — compile it directly
with the current s1 (`s1 compile /tmp/env_batch_r12.yo --release -o /dev/null`),
then delete test fns until the `void flag` spec disappears; the surviving
test is the producer. Fix angles: (a) skip EMISSION of a spec with a
unit-typed runtime param (nothing calls it; TS never creates it), and/or
(b) type spec C params from the RESOLVED DECLARED param type (bool) instead
of the arg's degenerate type — check TS's spec param typing first.

**MINIMIZED (2026-07-19, 8 lines — issues/repros/void-param-assert-open-env.yo):**
arm-deletion + keep-only + feature-whittle bisects over the saved batch pinned
the trigger to `open(import("std/env"))`: with env OPENED (vs `{ env } ::`
destructured — GREEN), `env.get(...)` + `assert(x.is_none())` emits the
void-param assert spec (decl+def, zero call sites). TS compiles AND runs the
same 8 lines clean. Mechanism: an analysis pass where the open-resolved
`env.get` soft-fails (UnknownVal -> unit-typed result -> unit-typed is_none)
mints an assert spec whose REGISTERED param type comes from the degenerate
ARG type; TS's createSpecializedFunctionInline types spec params from the
DECLARED/substituted parameter types (assert's flag is declared bool, not
generic), so a degenerate TS pass cannot produce a void param. FIX: in
create_specialized_function_inline's registered-spec-type construction
(helper.yo), take param types from the resolved DECLARED params (arg types
remain the CACHE KEY only); optionally also gate emission on
no-unit-runtime-params as a backstop. Bisect artifacts: /tmp/bw_only1.yo,
/tmp/wv_nomatch.yo, /tmp/w2_no_openenv.yo.

**FIX LANDED (2026-07-19): degenerate-mint refusal + declared-param preference.**
create_specialized_function_inline now (1) REFUSES to mint when a runtime
arg's type collapsed to unit against a concrete non-unit declared param
(returns the original value; the non-degenerate pass mints the good spec
and re-stamps the call site), and (2) prefers the resolved DECLARED param
type over a unit-degenerate arg type when building the registered spec type.
tests/env.test.yo FLIPS GREEN (13 passed). RESIDUAL (still open): shapes
where the degenerate pass IS the only/executed pass (the 8-line repro and
the standalone 20-line batch-wrapper shape) still emit a void local + a
bare `yo_id_5002` call — the ROOT is the open-module member resolution
under analysis: `(env.get)(...)` with `open(import("std/env"))` resolves
through try_to_call's non-Func SOFT FALLBACK (helper.yo ~3456, returns
t_unit) instead of the member FuncVal. Fix locus: the identifier/member
resolution through `open`s (why the member's type isn't Func in that pass);
TS resolves the same member fine. async_await/sync_mutex/prelude remain
red on OTHER families in their batches.

**REMAINING (deque/hash_map/imm_map — the identity-SPLIT family):** with the
enum fix in, deque fails `passing __yo_t33 to parameter of __yo_t30` where
t30 = struct_yo_id_7146 and t33 = struct_yo_id_7237 — DIFFERENT sids for the
SAME logical type (both render `gs_yo_id_5031_i32`, Deque(i32)-internal):
one Yo type minted TWICE (a CTFE/instantiation cache false-MISS), spec
emitted against one sid while call sites hold the other. This is the
declaration-stable-id direction (plans/YO_SELF_STAGE2_HANDOFF.md) — the
inverse failure of the enum fast-accept (false HIT). hash_map shows the same
shape (t65/t69/t72/t75 vs t65). Batch: kept per YO_KEEP_BATCH=1 runs of
deque under /tmp/s1g-era binaries.

**DDMIN RESULT (2026-07-19): the deque split needs EXACTLY 2 arms** —
`into_iter` + `iter`-with-ref-mutation (batch arms 34+37). 19-line
deterministic repro: issues/repros/deque-identity-split-2arm.yo (s1 rc=1
`passing __yo_t32 to __yo_t28`, TS rc=0). A hand-translated NON-batch
version of the same two bodies is GREEN — the batch dispatch shape
(analysis-mode `{ begin(...) }` arms under the runtime `cond`) is required,
i.e. the two ITERATOR instantiation chains (DequeIter via into_iter vs iter)
each materialize the Deque(i32)-internal struct under a different sid ONLY
when both arms are analysis-evaluated in one pass. Next: statement-level
ddmin inside the two arms (drop push_backs/asserts) to find the minimal
statement pair, then probe the two sid mints (struct creation in
evaluator/types/struct.yo) for their creation contexts.

**DECODED (2026-07-19, from the 19-line repro's C):** the failing call is
`yo_id_2928_rtparam0_gs_yo_id_5031_i32_ret_gs_yo_id_5031_i32(iter_tmp)` — the
for-loop's iterator-adapter fn. Its SPEC NAME is sid-FREE
(`gs_yo_id_5031_i32` = declaration 5031 + payload i32) so the second arm
CACHE-HITS the first arm's spec — but the C TYPES are SID-KEYED: arm 34's
Wrapper(i32) mint got sid 6174 (t28, baked into the spec's param), arm 37's
OWN mint of the SAME logical type got sid 6209 (t32, at the call site) →
`passing __yo_t32 to __yo_t28`. So the spec/cache layer already treats the
two mints as one type; only the C-type registry splits them. FIX LOCUS: the
gs-key alias machinery (`register_struct_cfid_key_hint(sid, cfid,
type_args)`, types/type*key.yo) — the SECOND mint (analysis-arm context,
`iter`-chain) isn't getting the hint that would alias sid 6209 onto the same
gs*-key/C name as 6174. Find the instantiation path that skips the hint
stamp (ctfe vs non-ctfe struct materialization in the for-loop lowering),
or make type_key for generic-struct instantiations sid-free directly.

WORKING HYPOTHESIS (next session's entry point): `is_some`'s declared return
is `bool` (concrete), so the resolved-return cache-key segment
(helper.yo:~1195 ret_sig_ty gate, added for the HashMap.with_capacity class)
does not fire; and the receiver's `arg_type` recorded in
`runtime_param_tys` at the CALL SITE is the UNRESOLVED `Option(T)` (the
SomeT-parameterized method self type — identical shape at every call site),
so `_find_specialization_cache`'s `are_types_compatible_exact(cached,
current)` compares Option(T-SomeT) against Option(T-SomeT) and HITS the
first entry, while the SIGNATURE at mint time resolved T=i32 via the
callee_env forall lookup. Probe: print cached_ty/current_ty type_keys at
helper.yo:921 for fid yo_id_2458 in the array_list batch. Fix direction:
resolve the receiver/self arg_type before the cache compare (mirror however
TS's per-instantiation FunctionValue objects keep these caches separate —
TS caches hang off EACH instantiation's own object, cf. the helper.yo:1185
comment). Saved batch: /tmp/al_batch_s1f.c (11413/12535/13241).
