# yo-self: root-cause map for all 26 HOLLOW test files (2026-07-29)

Measured with a **swallow-diagnostic s1** — a build carrying `eprintln` probes at the three
definition-time swallow sites — swept over every hollow file, then **noise-subtracted against
GREEN files**. Tooling: `scratchpad/swallow_sweep.sh` (+ `scratchpad/capture_markers.sh` for the
REDs). This replaces guesswork: a hollow file's single `Failed to transpile` marker IS the whole
batch dispatch expression, so the marker text says nothing about which arm failed — the swallowed
error does.

## Why this measurement was needed

Batch dispatch is all-or-nothing: any one arm whose definition-time evaluation throws empties the
whole `__yo_user_main`, so every test in the file "passes" vacuously. One bad arm hollows a file
with 100 good tests. The swallowed error names that arm's actual failure.

Probe sites (the three swallows):

| Probe     | Site                                                                         |
| --------- | ---------------------------------------------------------------------------- |
| `__DBG_W` | `yo-self/evaluator/exprs/_expr.yo` catch-all (`note_def_time_swallow`)       |
| `__DBG_F` | `yo-self/evaluator/calls/function_type.yo` `_trial_eval_fn_body` `inner_exn` |
| `__DBG_A` | `yo-self/evaluator/values/anonymous_function.yo` `inner_exn` (two sites)     |

## NOISE — confirmed present in GREEN files, must be subtracted

Do **not** chase these. Baseline taken on `arc`, `imm_string`, `iso`, `iso_api_surface`,
`module_struct_unification` (all GREEN):

| Swallowed message                                                            | Seen in GREEN         |
| ---------------------------------------------------------------------------- | --------------------- |
| `__DBG_A Expected expression value for "__yo_expr_to_string" argument`       | **all 5** — universal |
| `__DBG_F Incompatible types:`                                                | `imm_string` (×2)     |
| `__DBG_F Failed to evaluate right-hand side of assignment: (reversed._head)` | `imm_string`          |
| `__DBG_W use of moved value: \`x\``                                          | `iso`                 |

Two consequences:

- A bare `Incompatible types:` is **not** evidence of a defect on its own — it needs the full
  message body and a per-file check.
- `imm_map` / `imm_set` import `imm_string`, so their `Incompatible types:` and `reversed._head`
  swallows are inherited noise, not their own failure.

Also benign: `__DBG_F` fires for expected errors during a `comptime_expect_error` argument
evaluation (propagate mode). A **quoted** message (e.g. `"Cannot use \`a\` from outer scope"`) is
usually the error a `cee`*wanted*. The unambiguous defect signal in that family is instead`Expected compile error, but the expression was evaluated successfully`—`cee` saw no error.

## Real root causes, grouped by multiplicity

### Shared roots (one fix, several files) — best value

| Root                                                                                                                                                               | Files                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `Expected a label for function parameter, got requires(y != i32(0))` — yo-self does not accept contract clauses in a function parameter list                       | `spec/contracts_phase0`, `spec/pragma_no_contracts`, `spec/pragma_verify` (**3**) |
| `Type mismatch for type member "_f":`                                                                                                                              | `iterator_combinators`, `where_clause_fn_inference` (**2**)                       |
| `Expected compile error, but the expression was evaluated successfully` — a validation TS performs and yo-self does not (one distinct missing validation per file) | `basic`, `closure`, `fn` (×2), `inherent_first_resolution` (**4**)                |

### Unported features (each an explicit yo-self stub)

| File                  | Swallowed error                                                          |
| --------------------- | ------------------------------------------------------------------------ |
| `asm`                 | `evaluate_asm: not yet implemented (Phase 3)`                            |
| `iter_filter_closure` | `evaluate_function_call: TypeVal SomeT callee without FnTrait (Phase 4)` |
| `type_reflection`     | `__yo_type_get_info: unsupported type variant`                           |

### Singletons

| File                        | Swallowed error                                                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collections/linked_list`   | `Type mismatch for type member "value":` + `Expected enum type or primitive type (integer, bool) for match expression, got unit`                                                  |
| `comptime`                  | `Return type mismatch. Expected type "f32", but got "Output".`                                                                                                                    |
| `comptime_option_result`    | `Enum variant "unwrap" not found in enum`                                                                                                                                         |
| `higher_kinded_types`       | `Argument count mismatch: expected 1, got 2`                                                                                                                                      |
| `impl`                      | `All return statements must return the same concrete type for Impl(...)` (×3) + `Type mismatch for parameter "self":`                                                             |
| `option_result_combinators` | `Last expression in "begin" is not evaluated correctly:`                                                                                                                          |
| `imm_map` / `imm_set`       | after noise subtraction: `Cannot unify incompatible types:` (`__DBG_W` ×4 / ×8), `___drop: failed to evaluate the argument expression.`, `Type mismatch for type member "value":` |

### Needs the full message body before it can be classified

`async_await`, `gadts`, `string/string`, `sys/file` (`Incompatible types:`) and `env`, `prelude`
(`Cannot unify incompatible types:`) — the truncated head matches known noise. Re-read the full
multi-line message out of `/tmp/swal/<mangled>.log` before treating any of these as a defect.

## UPDATE 2026-07-29 (later) — measured after five fixes landed

Re-measured with a FRESH probe build (`/tmp/s1_swal3`, built from the tree at
commit `2b70886da`). Landed since the table above: the `___dispose` deep-SomeT
filter, the `comptime_str`->`*(u8)` coercion, `open()` declared-type lookup,
generic-impl methods on enum receivers, the `return(<owned RC local>)`
double-drop fix, the anonymous-fn no-expected-type throw, and the ComptimeIndex
custom-type dispatch port. Score **150 GREEN / 23 HOLLOW / 10 RED**.

### `tests/index.test.yo` has THREE independent roots, not one

This file is the clearest case of "error shape != root cause" in the whole
campaign. Each fix removed exactly one layer and revealed the next:

1. **`call to undeclared function 'yo_id_NNNN'`** (RED) — the shallow-vs-deep
   `type_contains_some_type` on the `___dispose` path. FIXED (`e798f7ff4`);
   the file went RED -> HOLLOW, _not_ GREEN, while the four sibling files with
   the identical clang error did flip.
2. **`comptime_expect_error` saw no error** — `ComptimeIndex` custom-type
   dispatch was an explicit unported stub, so `p(usize(2))` fell through to the
   RUNTIME `Index` impl whose out-of-bounds arm is a runtime panic rather than a
   compile error. FIXED (`2b70886da`), verified on an isolated repro (markers
   1 -> 0). The file stayed HOLLOW.
3. **STILL OPEN — `ComptimeList` indexing with a `comptime_int` literal.**
   Batch test #29:

   ```rust
   l :: ComptimeList(i32)(10, 20, 30);
   comptime_assert(l(0) == 10, "l(0) should be 10");
   l(0) = 99;
   ```

   Swallowed error (`__DBG_F`, the fatal one):
   `Type does not implement Index for the given argument type.`
   accompanied by 8x `__DBG_W Cannot unify incompatible types: "comptime_int"
and "usize"`. That pairing is the lead: `ComptimeList(T)`'s impl is
   **generic** — `impl(generic(T : Type), where(T <: Comptime), ComptimeList(T),
ComptimeIndex(usize)(...))` (std/prelude.yo:5819-5829) — and the argument `0`
   is `comptime_int`, so the `ComptimeIndex(usize)` trait-argument match appears
   to be strict where it must widen. TS accepts it: `are_types_compatible`
   widens `comptime_int` -> `usize` (`findComptimeIndexMethod`,
   index-trait.ts:404-408).

   Minimal differential (`/tmp/clist.yo`, 8 lines — the three statements above
   in a `main`): TS emits **0** `Failed to transpile`, s1 emits **2**. Use this
   rather than the whole test file.

   **RESOLVED (see below). Root: argument order.** The two obvious hypotheses
   were both wrong; keeping them recorded because each cost a probe:

   - `are_types_compatible(usize, comptime_int)` is **not** the problem. The
     ComptimeInt widening arm (`types/compatibility.yo:124-146`) explicitly
     lists `.Usize => true`, so the parameter check in `_find_index_method`
     passes. (It is gated on `require_exact` being false — worth confirming the
     index path does not set it, but the arm exists.)
   - The `Cannot unify incompatible types` throw site is a **faithful port**.
     yo-self's synthesizer fallback (`evaluator/types/synthesizer.yo:1979-1994`)
     compares raw type TAGS and throws; TS's `synthesizeTypes`
     (`src/evaluator/types/synthesizer.ts:1076-1088`) does _exactly_ the same.
     So the bug is NOT in the comparison.

   Therefore the divergence is **upstream**: TS never reaches that fallback with
   `(usize, comptime_int)`, and yo-self does. The next probe should find out WHY
   — either TS's caller widens/coerces the argument type before synthesizing the
   trait argument, or an earlier `synthesizeTypes` case intercepts the pair. Walk
   the generic-impl match path (`get_receiver_methods_by_name_from_env` ->
   the `find_methods_from_generic_impls` callback -> `try_match_generic_impl`)
   and compare against TS's equivalent, rather than touching either of the two
   sites above.

#### Root of #3 FOUND: `are_types_compatible` argument order

`_find_index_method` and `_find_comptime_index_method`
(yo-self/evaluator/calls/index_trait.yo:304, :840) called

    are_types_compatible(p1, arg_type)      // p1 = the PARAMETER's declared type

but yo-self's signature is `are_types_compatible(actual, expected)`
(types/compatibility.yo:934) — so the _parameter_ type was passed as the
"actual". Every comptime widening arm keys off `actual`
(`is_comptime_int_type(actual)` at :124, `is_comptime_string_type(actual)` at
:171), so with `actual = usize` none of them fired and the check fell through to
the tag comparison: `usize != comptime_int` -> reject -> "Type does not implement
Index for the given argument type".

TS spells the same check `areTypesCompatible({type: idxParam.type}, {type: argType})`
(index-trait.ts:404-406) — but **TS's first position is `expected` and its second
is `given`**, the opposite of yo-self's. So the faithful port must SWAP the
arguments, not copy the order. Fixed to `are_types_compatible(arg_type, p1)`.

The discriminator that found it, in three cheap compiles (no probe build needed):

| probe                                                                                                | result    | conclusion                         |
| ---------------------------------------------------------------------------------------------------- | --------- | ---------------------------------- |
| `l.len()` / `l.get(usize(0))` — same generic impl, same `where(T <: Comptime)`, NOT Index-dispatched | 0 markers | the impl and where-clause are fine |
| `l(usize(0))` — Index dispatch, argument already `usize`                                             | 0 markers | the Index path itself is fine      |
| `l(0)` — Index dispatch, argument `comptime_int`                                                     | 2 markers | **only the argument TYPE matters** |

Effect on `tests/index.test.yo`: **hollow=1 markers=1 -> hollow=0 markers=0**.
The evaluator side of that file is now complete for the first time. It is still
RED, on a FOURTH root:

4. **RESOLVED — comptime index-assignment emitted the folded value as an lvalue.**
   Was: 5 clang errors of the shape `0 = 42;`, `10 = 99;` — codegen emitted the
   LHS's folded comptime VALUE on the left of an assignment, because
   `comptime_ref` never reached the outer `l(0)` / `arr(i)` expression.
   The consuming machinery (assignment.yo Step 6, :680-708) was indeed fine;
   the producer chain had TWO independent breaks, both found by following the
   recommendation above (start from what PRODUCES the ref in TS):

   a. **`ComptimeFnCallResult` had no `comptime_ref` field** (a documented
   Phase-3a skip, calls/comptime_fn.yo header). TS propagates
   `evaluatedFunctionBody.$.comptimeRef` out of every CTFE call
   (comptime-fn.ts:297) and the ComptimeIndex dispatch forwards it in the
   non-PtrValue branch (index-trait.ts:615). The builtin
   `__yo_comptime_list_index` DOES set the ref (comptime_index_fns.yo:356)
   and begin DOES carry it to the body info (begin.yo:2139) — it died at the
   call-result boundary. Fixed: field added (context.yo), populated from
   `body_info.comptime_ref` at the final return + explicit `.None` on the
   four early paths (faithful — TS's early returns omit it), and forwarded
   in index_trait.yo's non-PtrVal arm. This fixed `l(0) = 99` on
   ComptimeList: minimal repro 2 markers -> 0, runs rc=0.

   b. **`_try_comptime_element_access`'s ArrayVal arm returned
   `comptime_ref : .None`** where TS builds
   `comptimeRef: { kind: "array", arrayValue, index }` (index-trait.ts:870).
   This is the plain comptime-ARRAY path (`arr :: [1,2,3]; arr(i) = v`),
   which never goes near ComptimeIndex dispatch. Fixed: build
   `ComptimeRef.ArrayRef(elements, idx_usize)` over the SHARED destructured
   handle (same pattern as builtins/comptime_index_fns.yo:643).
   Differential `/tmp/carr.yo`: TS lvalue=0, s1 lvalue=1 -> 0.

### Other still-open items re-confirmed

- `tests/algebraic_effects.test.yo` — now **hollow=0** (71 tests genuinely pass)
  with ONE real failure, "Test zero-arg unwind exits unit function". Its
  remaining FTT'd arms are `ctl` handler assignments
  (`(raise : Raise) = (() -> { unwind(); })`), which are a SEPARATE pre-existing
  gap: verified by running the pre-change and post-change s1 on that shape
  standalone — identical 1 marker, while TS compiles and runs it. The
  ctl-handler assignment path does not set `ctx.expected_type`.
- `tests/prelude.test.yo` — a design exists but is deliberately NOT applied: its
  own author found a second independent blocker (`try_into` fails with a SINGLE
  impl and no overloading involved), so the patch would touch a hot dispatch
  path without flipping the file.

## RED files, for completeness (from `scratchpad/capture_markers.sh`)

| Family (first clang error)                                                                                                                                                      | Files                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `call to undeclared function 'yo_id_NNNN'` (inside `__yo_dispose_dispatch`) — shallow-vs-deep `type_contains_some_type`; **fixed** in `yo-self/codegen/functions/collection.yo` | `collections/btree_map`, `collections/ordered_map`, `collections/priority_queue`, `index`, `sync/channel` (**5**)                |
| `passing '__yo_tNN' to parameter of incompatible type`                                                                                                                          | `imm_sorted_map`, `imm_sorted_set`, `imm_threading` (**3**)                                                                      |
| a type lowering to C `void`                                                                                                                                                     | `derive_clone_complex` (`argument may not have 'void' type`), `thread`, `worker` (`variable has incomplete type 'void'`) (**3**) |
| `incompatible integer to pointer conversion`                                                                                                                                    | `closure_capture_rc_leak` (argument), `sync/mutex` (return) (**2**)                                                              |
| `use of undeclared identifier 'fn_yo_id_NNNN'` — `->` with no expected type synthesizes an all-SomeT Func type where TS throws `Expected a function type`                       | `algebraic_effects` (**1**)                                                                                                      |
| `initializing 'void *' with an expression of incompatible type '__yo_tNN'`                                                                                                      | `impl_fn_field_rejection` (**1**)                                                                                                |
| no clang error at all (evaluator/runtime failure)                                                                                                                               | `fs/dir` (**1**)                                                                                                                 |

## Reproducing this measurement

```bash
# 1. diagnostic build (~4 min): copy yo-self, add the three probes, compile
cp -R yo-self /tmp/ydiag2   # then add eprintln at the three sites above
./yo-cli compile /tmp/ydiag2/main.yo --release -o /tmp/s1_swal

# 2. sweep the hollow files, then a GREEN baseline to subtract
BIN=/tmp/s1_swal OUT=/tmp/swal     LIST=/tmp/hollow.txt    scratchpad/swallow_sweep.sh
BIN=/tmp/s1_swal OUT=/tmp/swalbase LIST=/tmp/greenbase.txt scratchpad/swallow_sweep.sh
```

Both sweeps write batch artifacts into each test file's own directory, so they must run
**serially** — never two `test` invocations against one directory.

## UPDATE 2026-07-30 (call-site where-clause round) — `_f` root PARTIALLY closed

`iterator_combinators` / `where_clause_fn_inference` (`Type mismatch for type
member "_f"`): the TS mechanism is commit `c85db1dcd` — validateConcreteTypeConstraints
must THREAD the env returned by typeImplementsTrait (bindings from synthesizing
`Fn(a : A) -> B` against the concrete `fn(x : i32) -> i32`). Two faithful
sub-ports LANDED (gated green):

- `trait_checking.yo` step 3 (Fn-trait satisfaction) now runs
  `synthesize_types` on the trait's call type vs the target fn and returns the
  binding env (was a "Phase 3 TODO" returning env unchanged).
- `types/function.yo` `validate_concrete_type_constraints` now uses the FULL
  `type_implements_trait` and threads `tc_res.env.frames` back into `env_mut`
  (was the Bool wrapper, discarding bindings).

Measured on the module-level repro (`local_map_to` + annotation): the
validator IS reached with `concrete=fn(x : i32) -> i32` vs `Fn(a : A) -> B`
(probe `__DBG_VC`), the synthesis SUCCEEDS (`__DBG_S3 syn_ok=true`) — and the
"\_f" mismatch STILL occurs: `Expected: fn(x : i32) -> i32, Got: F : (Fn(A) ->
B)`. The instantiated `LocalMapIter(Self, A, B, F)` member type resolves while
the ARGUMENT `f`'s SomeT `F` stays bare — a per-call SomeT identity split (the
Gap-6 class), i.e. the binding lands on one SomeT instance/cell and the struct
member check reads another. Next step is on the SPECIALIZATION side (which
F instance the body's struct-literal check reads), not in the validators.

## 2026-07-30 — fmt.test.yo hollow bisected: `(1 + 2).to_string()` in a `:=` binding

fmt.test.yo (markers=1) hollows on arm 2 ("Test template strings") alone.
Sub-bisected: literal (`${123}`) and variable (`${n}`) interpolations are
CLEAN; only the parenthesized-EXPRESSION interpolation `${(1 + 2)}` FTTs —
and the desugared form reproduces WITHOUT templates:

    s := (1 + 2).to_string();   // 5-line repro, TS green, self FTTs
    (issues/repros/comptime-expr-to-string-runtime-binding.yo)

`check` on the repro is CLEAN (evaluator OK) — the failure only occurs in
COMPILE mode (executing def-eval of main), and the swallow prints nothing.
Pre-existing (same on s30/s31). Next probe: print the caught error at the
def-eval swallow (\_expr.yo:1017 wrapper) for this compile — one build
answers what throws. Suspect family: `.to_string()` method resolution on a
FOLDED comptime_int expression result (not a literal token, not a
variable) — the comptime-receiver retry may mis-route for expression
receivers in executing mode.

### Probe result (format_error_message probe, one build)

The swallowed error for `s := (1 + 2).to_string()` is:

    Cannot unify incompatible types: Expected "comptime_int", Given "i32"

thrown from calls/function.yo's unconditional arg-type check (~line 1619).
Note the ORDER: the PARAM type is comptime_int and the ARG is i32 — the
method resolution selected the COMPTIME_INT `to_string` overload while the
receiver argument had already been lowered comptime_int → i32 (the runtime
`:=` binding context). TS resolves i32's runtime to_string here. Two
candidate fixes for the next round: (a) the receiver-method comptime-retry
should not pick the comptime_int overload when the receiver is being
lowered for a runtime binding — check what TS's getReceiverMethods does
with the comptime→runtime conversion ORDER; (b) the arg-check's comptime
exemption tests the ARG only — TS's convertComptimeTypeToRuntimeType
lowering happens before the check on BOTH sides. Verify against
issues/repros/comptime-expr-to-string-runtime-binding.yo; the same face
plausibly covers several of the 19 hollows (template-heavy files:
prelude, basic, fn — all use `${(expr)}` shapes).

### Two fix attempts REJECTED (measured) — the unify throw is LOAD-BEARING

1. helper.yo Step-10 skip for comptime-primitive returns: the yo-self
   build itself broke with "Variable ToString not found" at error.yo's
   derive — the prelude's own evaluation depends on that throw somewhere
   (a trial that must FAIL to drive the correct binding/overload path).
2. synthesizer tag-fallback tolerance (accept comptime-primitive vs
   runtime-counterpart pairs): SAME failure, even narrowed to NUMERIC
   pairs only. The comptime-vs-runtime unify failure is load-bearing in
   prelude trials; suppressing it anywhere central diverges overload
   selection.

Open question for the next round: how does TS survive the IDENTICAL
Step-10 synthesis (helper.ts:1573 synthesizeTypes(comptime_int-return,
expected i32) has no try/catch and TS's tag fallback throws for distinct
tags)? Leading hypothesis: in TS the winning comptime candidate's call is
EXECUTED via the CTFE path and returns its concrete result BEFORE the
Step-10 return synthesis runs (yo-self types the call through
try_to_call's Step 10 first). Verify by tracing where TS's
evaluateFunctionCall short-circuits for comptime executions — if so, the
yo-self fix is to skip Step 10 only when the call has ALREADY produced a
concrete comptime VALUE (result known, nothing to synthesize) — a
value-presence gate, not a type-shape gate.

### CORRECTION + FIX LANDED (2026-07-31) — fmt.test.yo GREEN

The "two fix attempts REJECTED / unify throw is load-bearing" conclusion
above was WRONG: all three attempts were tested against a locally-damaged
tree (a probe cleanup had deleted error.yo's ORIGINAL `open(import(
"std/fmt"))`, and a `git add -A` docs commit landed the broken file — every
subsequent build failed with "Variable ToString not found", misattributed
to the attempts; see the probe-cleanup-import-hazard memory). A clean-
worktree bisect isolated the one-line diff; error.yo restored.

On the repaired tree, the NUMERIC synthesizer tolerance works cleanly:
comptime_int/comptime_float vs a runtime Int/Float in the tag fallback is
accepted (nothing to bind; the folded value lowers at the consuming
boundary). fmt.test.yo HOLLOW -> GREEN (3/3 = TS parity, markers=0), sweep
162/18/5 with exactly one flip, TIER 1 clean, TIER 2 FIXPOINT_HOLDS. The
comptime_str-vs-String pair deliberately keeps throwing (untested).

basic/fn/prelude/closure remain hollow with their own markers (4/3/1/1) —
different roots (the missing-validation family, task list #2).

## 2026-07-31 — prelude.test.yo bisected: TWO faces (arms 1 and 3 of 4)

- Arm 1 "TryFrom/TryInto traits": minimal repro
  `issues/repros/tryfrom-two-impls-static-dispatch.yo` (TS green, self 3
  FTTs) — a struct with TWO parameterized-trait impls `TryFrom(i32)` +
  `TryFrom(i64)`; the static call `EvenNumber.try_from(i64(10))` FTTs.
  FE-probe signal: SIX repeated "Cannot unify incompatible enum types:
  <enum:2403> vs <enum:3135>" — two Result-INSTANTIATION eras split
  between the two impls (each impl's `Result(Self, Error)` instantiated
  separately; the call site unifies against the wrong era). Same identity
  class as the imm-family; likely fixable via the trait-method Result
  memo/canonicalization rather than dispatch.
- Arm 3 "MaybeUninit": contains `comptime_expect_error(arr2 :=
uninit_arr.assume_init())` — consume-after-use validation the port
  doesn't throw yet (the missing-validation family, task #2).

## 2026-07-31 — §2.3 survey: full arm-bisection map of the 18 hollows (s34)

Bisected with subset_arms.py; each line = the hollowing arms only.

| file                      | hollow arms                                    | family                                                                   |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| fmt                       | FIXED (comptime-numeric synthesizer tolerance) |
| prelude                   | 1, 3                                           | TryFrom Result-era split; MaybeUninit consume-validation                 |
| closure                   | 2                                              | missing-validation (cee: capture-outlives)                               |
| gadts                     | 1-9 (ALL but 0)                                | broad GADT gap                                                           |
| higher_kinded_types       | 0,4,7,8,10,14,16-19                            | broad HKT gap                                                            |
| collections/linked_list   | 63-68 (contiguous)                             | into_iter + for() — closure-combinator family                            |
| where_clause_fn_inference | 0, 1 (both)                                    | assoc-type inference from Fn signature — the parked wcf `_f` SomeT split |
| option_result_combinators | 3-6, 33-37, 53                                 | and_then/combinator closures — same family                               |

The CLOSURE-COMBINATOR family (linked_list + wcfi + orc + the earlier
iter_filter_closure/iterator_combinators) is the biggest single cluster.
7-line repro: `issues/repros/option-and-then-closure-arg.yo` —
`some_val.and_then((x) => Option(i32).Some(x * 2))` FTTs (TS green).
This is the parked "wcf `_f` specialization-side SomeT split" work item.

Still unbisected: asm (own family, 829-line port parked), async_await,
basic(4), fn(3), impl(4), imm_map/imm_set (param-model family),
iter_filter_closure(2), iterator_combinators(2), contracts_phase0(1),
type_reflection(24).

### 2026-07-31 — the closure-combinator cluster REDUCES to the era-split root

FE-probe on issues/repros/option-and-then-closure-arg.yo: the final
swallowed error is `Last expression in "begin" is not evaluated correctly:
(Option(B).None)` preceded by `Cannot unify incompatible enum types:
<enum:2573> vs <enum:4262>` — B DOES bind (the \_synthesize_fn_traits path
recurses into the Fn carrier result and the assoc-constraints port is
landed); the failure is that and_then's signature/body `Option(B)` resolves
by SUBSTITUTION into the DEF-era nocache Option mint while the call-era
`Option(i32)` is a different instantiation — the SAME root as the
imm_sorted_map family (ROOT CAUSE 2026-07-30 in
issues/yo-self-69-red-list-map.md: substitution keeps def-era ids; TS
re-evaluates type exprs through the ctor memo).

CONSOLIDATION: the param/return type-expr re-evaluation work (slice 2+3,
attempted and reverted with leads in the red-list map) now blocks BOTH:

- 4 of the 5 REDs (imm_sorted_map/set, imm_threading, sync/mutex), and
- the biggest hollow cluster (linked_list into_iter block,
  where_clause_fn_inference, option_result_combinators' and_then arms,
  iter_filter_closure, iterator_combinators — ~5 files).
  It is the single highest-leverage remaining item; give it a dedicated
  round starting from the slice-2 revert leads (era agreement: re-evaluate
  params BEFORE the rebind loop so body/registered/caller eras converge, and
  exclude Fn-trait-carrying params from the overwrite — the
  closure_where_clause_param corpus DIFF).

### SLICE LANDED (2026-07-31): enum-synthesis structural fallback widened

The synthesizer's Enum+Enum id guard now runs the variant-name structural
fallback whenever the ids differ AND the cfids don't match (was: only when
either cfid was EMPTY) — two ERA INSTANCES of the same generic enum carry
different cfids and were rejected before the per-variant field unification
could bind the generic (`Option(B)`-def-era vs `Option(i32)`-call-era).
Result: issues/repros/option-and-then-closure-arg.yo compiles AND runs.
Gates: TIER 1 clean, TIER 2 FIXPOINT_HOLDS, sweep 162/18/5 stable.

REMAINING for the cluster: the BATCH-shape arms still hollow (orc arms
3/33/53 re-bisected hollow under s36 — another context layer, like the
arm-26 batch residue), and the TryFrom repro moved to a NEW face
(`fn_yo_id_4764(10)` call to an unemitted fn — the callee resolved but its
emission is skipped; likely the specialization-collection side). The
era-agreement work (slice 2/3 leads) remains the root item.

## iter_filter_closure / iterator_combinators — two layers peeled (2026-07-31, markers 2→1)

Layer-by-layer via the **DBG_F recipe (un-silence `_trial_eval_fn_body`'s
swallow) on the batch `**yo_user_main`, which has NO retry (a plain `main`
recovers at specialization time — the same asymmetry recorded for
closure_capture_rc_leak):

1. **"TypeVal SomeT callee without FnTrait"** at prelude `filter`'s
   `IterFilter(Self, F)(...)`: with `F` bound to a Step-6 UnknownVal, the
   ctor CTFE short-circuits (`any_arg_unknown`) to a `ctfe_result_*` SomeT,
   and CALLING that placeholder throws. TS never enters this state — its
   foralls are `TypeVal(SomeType)`, so the ctor body EXECUTES and mints a
   generic-era struct (a real callable ctor). LANDED: Step-6 binds a
   Type-kinded forall whose SomeT occurs in the signature as
   `TypeVal(sig-marker SomeT)` (helper.yo; labels with no sig occurrence
   keep UnknownVal). A ported permissive-ctor arm (TS function.ts:1427
   unresolved-recursiveTypeRef) was tried first and REJECTED — it deferred
   the missing type into `filtered.next()` → `match` on unit (rc 0→1).
2. **"Type CountIter does not implement required trait Iterator"** from the
   `filter` where-clause: `_check_associated_type_constraints` resolved the
   target's `Item` ONLY through the generic-impl registry, so a CONCRETE
   impl's assoc type (CountIter's `Item : i32`) was unfindable. LANDED: TS
   step 1 (targetType.trait.fields assignedValue) maps to the type-trait-
   methods registry — same source property_access's assoc-type fallback (b)
   reads.
3. **Remaining (markers=1)**: `Type mismatch for type member "_f": Expected
<struct:capture_yo_id_NNNN> Got: F : (Fn(*(A)) -> bool + Fn(*(i32)) ->
bool + ...)` — the minted IterFilter's `_f` is the closure CAPTURE STRUCT
   while the arg still carries the SomeT F; note the DUPLICATED accumulated
   required-traits on F (the shared registry SomeT instance collects a
   constraint per early-apply — cross-call pollution worth its own look).
   Same expected/got member-era family as the imm\_\* REDs.

## imm_map hollow (2026-07-31, post-RED-list) — four era-equal extensions measured-inert, REVERTED

The batch-dispatch marker's swallowed error (\_\_DBG*F): "Cannot unify
incompatible types: Expected *(struct*yo_id_5382) Given *(struct_yo_id_8060)"
at std/imm/map.yo:133 (`children.add(usize(i))` inside `_drop_children`),
thrown by function.yo's conservative arg-type check. Probe facts:

- BOTH sides carry the SAME constructor_func_id (yo_id_4807) — the pair is
  two era instances of one ctor.
- Attempted, each measured-inert against the file (still markers=1), all
  REVERTED: (a) era-tolerance in the arg check (pointer-unwrapped
  \_ctfe_types_era_equal before throwing); (b) instance-field cfid preference
  in era-equal; (c) field-types fallback when type_arguments are empty;
  (d) Pointer arm + same-cfid depth-cap heuristic. After ALL FOUR the pair
  STILL rejected — the sides likely differ structurally beyond eras (a
  def-era instance with SomeT-carrying fields vs the concrete one — the
  SomeT-vs-concrete leaf has no era arm and exact-compat is false), i.e.
  the same generic-vs-concrete distinction era-equality is DESIGNED to
  preserve. The correct fix is upstream: `.add`'s declared `self : *(T)`
  param type reaching this call as the def-era Pair mint — the same
  declared-param-era class as the fixed imm family, but on a plain
  variable arg where the dot-form gate doesn't (and shouldn't blindly)
  apply. Next lens: WHY the `.add` receiver's expected/declared param is
  the def-era instance in this spec — likely wants the param-type-expr
  re-eval (slice 2) coverage for pointer-receiver METHODS.

## closure-combinator trio (2026-07-31, post-RED work) — member-check SomeT resolution attempted, net-negative, REVERTED

The trio's shared face: `Type mismatch for type member "_f"` at the
combinator struct mints (`IterFilter(Self, F)(_f : f)` etc.) — the arg
carries the raw constrained SomeT `F : (Fn(A) -> B + Fn(i32) -> B ...)`
(note the ACCUMULATED duplicate constraints — cross-call pollution of the
shared registry SomeT instance) while the minted member is concrete.

ATTEMPTED (reverted): resolving the ARG-side SomeT through its
resolved_concrete cell / g_some_resolved_concrete registry before the
member compat check (TS compares resolvedConcreteType). Measured:

- iter_filter_closure: `_f` error GONE, next layer surfaced ("match on
  unit" — `filtered.next()` typed unit at validation: filter's RESULT era
  unresolved, the with_lock-class symptom);
- iterator_combinators: UNCHANGED — its F has NO registered resolution at
  all (the map/for_each closure's capture registration never fires for
  this route);
- where_clause_fn_inference: hollow -> RED rc=1 — accepting the previously
  thrown case surfaces struct-era init/return mismatches in C
  (t14-vs-t28), i.e. the throw was MASKING an era split downstream.

CONCLUSION: the trio's root is F RESOLUTION (binding + era), not the
member check; fixing the check alone converts hidden def-time throws into
C-level era faces. The fix must make F resolve to ONE canonical era at
binding time (the same family as the landed dot-arg override, but for
closure-typed args of the blanket combinators). Entry point for next
round: WHERE the combinator call binds F from the closure arg (the
capture-registration path that fires for `filter` but evidently not for
`map`), plus the constraint-accumulation hygiene on the shared registry
SomeT (each early-where apply appends to the SAME instance's
required_trait_types).

## missing-validation family (closure/basic/fn) — merge-check port landed-inert, REVERTED (2026-07-31)

The family's root: TS expr.ts:2009-2094 (cross-branch type compatibility in
mergeAndCheckEnvs — BOTH the Impl(...) resolvedConcreteType static-dispatch
rule and the general initialized-types check) is UNPORTED — yo-self's
merge_and_check_envs collects `case_types` and never reads it. Ported the
check + the assignment-side resolvedConcreteType stamp (assignment.ts:520,
also unported); measured INERT because the inputs never materialize:

1. The merge matrix rows for `closure : Impl(Fn(...))` show the IDENTICAL
   bare declared SomeT for both cond arms (probe: `case-ty=Impl :
(Fn(i32) -> i32)` twice, no resolved cells) — consistent with yo-self's
   SHARED mutable Variable across arm envs (the second arm's write
   overwrites the first; per-branch types cannot be recovered from the
   shared object). TS's persistent envs snapshot per-branch state.
2. The assignment-side stamp never fired: the closure assignment's
   `rhs_info.ty` is NOT the declared SomeT (the .SomeT gate missed —
   the RHS carries the closure's own type shape), so there is nothing to
   stamp the capture onto at that point.

To land this family the port needs per-branch TYPE snapshots: either
(a) merge_and_check_envs collecting each arm's variable TY from the arm's
recorded ExprInfo env SNAPSHOT frames (if those deep-copy Variables — they
do not today), or (b) a side-channel recording (var id, branch, assigned
ty+capture) during arm evaluation, consumed by the merge. (b) fits the
established side-table pattern. The check code itself (both rules) is in
this commit's history — reusable once the snapshot channel exists.

## missing-validation family — branch-init side-channel LANDED (2026-07-31); closure arms 1-2 of 5 now validate

The design-(b) side-channel from the previous entry, implemented and
gate-clean (TIER 1 corpus 149/0 + std 153/153, TIER 2 FIXPOINT_HOLDS,
sweep 169/16/0 with zero composition changes):

- expr_info.yo: `BranchInitRecord` log (var id, assigned ty, RHS closure
  capture) + per-arm [start, end) windows keyed by arm-body expr id.
- assignment.yo: EVERY assignment records (not just first-inits — the
  shared Variable is stamped initialized by the FIRST arm, so sibling
  arms' first-per-branch assignments read as reassignments).
- cond.yo: both arm-eval sites register windows.
- utils.yo merge_and_check_envs: consumes windows — last record per (arm,
  var); Impl(...) static-dispatch rule compares CAPTURE STRUCT IDS
  (nominal per closure — structural compat wrongly accepts two one-i32
  captures) + the general cross-case initialized-type check (TS
  expr.ts:2009-2094).

MEASURED: tests/closure's expect-error arms 1-2 ("Test multiple expected
errors" Impl different-capture conds) now produce the required error; the
FILE stays hollow (markers=1) on arm 3 — `(c : Impl(F)) = cond(a =>
closureA, b => closureB)` (the RESULT-position form). A cond-result rule
comparing arm bodies' ExprInfo.capture_type was added but is INERT: a
`begin(...)` arm body's ExprInfo does not carry the tail closure's
capture_type. NEXT: propagate capture_type through begin's tail-expr
ExprInfo merge (begin.yo), or read the arm's last-expr info directly in
the cond-result rule. match.yo arms also need the window registration
(only cond.yo instrumented so far) for the same checks on match arms.

basic/fn hollows: same family; their specific missing validations
("Cannot use `a` from outer scope" for generic fns; Array(i32,\_) length
conflict — the latter should ALREADY fire via the new general check once
its per-branch types differ; re-probe after arm-3 lands).

### closure arm 3 (2026-07-31 cont.) — result-position rule still inert

The cond-result Impl rule (cond.yo, landed with the side-channel) plus a
begin tail-capture_type propagation (TRIED, REVERTED — zero wins) did not
fire for `(c : Impl(F)) = cond(a => begin(..., closureA), ...)`. Facts:
arms 1-2 (assignment-position) DO produce the error via the merge rule, so
the multi-arm path runs for these conds; arm 3's arms contain NO
assignments (log empty — merge rule correctly inert) and the RESULT rule's
per-arm capture read came back empty even after propagating
last_info.capture_type through begin's out_info. Next lens: whether the
analysis-mode arm eval (cond.yo site 2, is_executing=false) registers
closure captures at all (the lambda take-on may be gated on executing), or
whether this cond flows through initialization_assignment.yo with a
different arm-eval entry entirely. The begin propagation change is likely
still CORRECT (TS carries captureType on the block's result) — re-land it
together with whatever makes the captures visible.

## UPDATE 2026-07-31 — closure GREEN; basic/fn sub-arm bisect (post batch-2 fixes)

Score after `ac78c38c3` (+ the in-flight batch-2): **170 GREEN / 15 HOLLOW**
(sweep `/tmp/sweep_h17`; `tests/tmp_ifc/` stray fixture deleted).

**closure.test.yo → TRUE GREEN 9/9** — Impl(...) reassignment rule + branch-group
windows (`ac78c38c3`).

**Batch-2 fixes (this round)**: `:=`/`x : T` no-shadowing rule; runtime-var strip
in `_build_def_time_body_env` (TS keepTopLevelFrameAndComptimeVariablesFromEnv —
fixed fn's outer-capture arm AND basic's outside-fn-init arm via "Variable not
found" parity); while-loop init gate with `entry_frame_count` SNAPSHOT (the live
frame-count read was why the first port was reverted); ctfe-body guard now reads
Func meta `result_is_comptime_only` (was type-based, never fired); tuple compat
label-free (TS structural rule) + assignment keeps DECLARED tuple type;
comptime_expect_error restores per-frame VARIABLE COUNTS (a cee-thrown
`(z : Point1) := (3,4)` stranded `z`); deferred-generic-return check ported for
DIRECT `(fn(...))(body)` definitions (calls/function_type.yo) with throwaway
trial FuncVal id + trial-abstract skip.

**fn.test.yo — 1 root left**: anon-path deferred return check parked on the
parameter-aliasing gap — see `issues/yo-self-fn-param-aliasing.md`.

**basic.test.yo — 4 PRE-EXISTING single-arm roots left** (baseline-hollow too;
masked by the all-or-nothing batch; bisected via subset_arms.py on /tmp/s2h25):

| arm | test                   | swallowed error                                                          |
| --- | ---------------------- | ------------------------------------------------------------------------ |
| 12  | Test 'struct'          | `Cannot unify incompatible types: bool / unit` (assert on member access) |
| 14  | Test 'union'           | `Failed to evaluate, got (v3.x)` — member access on impl-`new()` union   |
| 18  | Test 'cond'            | `if(c, then : {...}, else : {...})` labeled-block macro form rejected    |
| 24  | Test type availability | `y := Point2(6, 8)` should error (scope availability validation missing) |

## UPDATE 2026-07-31 (later) — contracts_phase0 TRUE GREEN via the INERT-THROW class

**spec/contracts_phase0.test.yo → TRUE GREEN 31/31 at TS parity** (arm 8,
invariant-in-cond-branch). Root was NOT a missing validation: the placement
walker (`_walk_for_misplaced_invariant`, while.yo) was a faithful port and its
`exn.throw` was REACHED — and measured INERT (probe showed execution continuing
past the throw to sibling nodes; the escaped-flag early-return is not honored
in that recursive-helper call shape). Fix: the walker/enforcer RETURN the
offending node (`Option(InvariantViolation)`) and `evaluate_while` throws from
its own frame.

**LEVER for the remaining cee-saw-no-error hollows**: when a validation
"exists but never fires", probe for the inert throw FIRST (eprintln after the
throw — if it prints, restructure to return-then-throw-at-top). Candidates:
basic arm 24 (type availability), fn arm 9's remaining route, gadts/impl arms.

## UPDATE 2026-07-31 (later still) — env-aware comptime-only gate landed

basic arm 24's Point2 SUB-ARM fixed: `y := Point2(6, 8)` for a struct of
comptime_int fields now errors. Root: `type_requires_comptime_modifier`
(types/utils.yo) is TAG-ONLY — compound comptime-only types never matched. The
`:=` / `x : T` gates now fall back to the env-aware derivation
(`type_implements_comptime && !type_implements_runtime_full`,
trait_checking.yo), matching TS isComptimeOnlyType. Verified: minimal cee test
markers 1 -> 0 (sh31 vs sh32). basic arm 24 stays hollow via ANOTHER sub-arm
(the test has Point3 mixed-context, enum, and union sections) — re-probe with a
\_\_DBG_F build for the next sub-root.

## Census 2026-07-31 EOD — all 14 remaining hollows probed on sh33 (current tree + \_\_DBG_F)

| file                                                                 | swallowed root (noise-filtered)                                                                                                                        | class                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| basic                                                                | 1× Cannot unify (arm 12 struct; arms 14 union `v3.x`, 18 `if(then:/else:)` macro, 24-rest also open)                                                   | per-arm singletons                                |
| gadts                                                                | 6× `Incompatible types:` (match arms i32 vs bool — GADT refinement)                                                                                    | arm-type unification                              |
| impl                                                                 | 3× `All return statements must return the same concrete type for Impl(...)` + 1× `Type mismatch for parameter "self"`                                  | yo-self check FALSE-FIRES (TS accepts these arms) |
| higher_kinded_types                                                  | match on `TypeApp(fn(T : Type) -> Type, [i32])` not supported                                                                                          | match-on-TypeApp gap                              |
| option_result_combinators                                            | Cannot unify bool/unit at `and_then` result                                                                                                            | combinator result typing                          |
| prelude                                                              | Cannot unify i32/i64 (TryFrom(i32)/TryFrom(i64) overload dispatch)                                                                                     | trait-overload selection                          |
| imm_map                                                              | 8× Incompatible + 3× unify + rhs-eval fail                                                                                                             | era/pointer-receiver (existing notes)             |
| iterator_combinators, where_clause_fn_inference, iter_filter_closure | NO **DBG_F output — the hollowing error routes through a DIFFERENT swallow (**DBG_A anonymous_function or \_\_DBG_W catch-all); probe those sites next | `_f` member F-era trio                            |
| asm                                                                  | `evaluate_asm: not yet implemented (Phase 3)`                                                                                                          | unported feature                                  |
| type_reflection                                                      | `__yo_type_get_info: unsupported type variant` (markers=24)                                                                                            | unported variants                                 |
| async_await                                                          | 1× Incompatible types (Ctx/E bundle, existing notes)                                                                                                   | needs full message                                |
| fn                                                                   | 1× Cannot unify (arms 9/11-14; arm 9 = anon-check routing, issues/yo-self-fn-param-aliasing.md)                                                        | mixed                                             |

Probe binary recipe: current tree + the \_\_DBG_F un-silencing in
calls/function_type.yo `_trial_eval_fn_body` (+ `open(import("std/fmt"))`).
Remember the INERT-THROW lever for any "check exists but never fires" case.

### impl.test.yo — analysis (2026-07-31 EOD)

The 3× "All return statements must return the same concrete type" \_\_DBG_F
lines are BENIGN (cee-expected errors made visible by propagate mode). The
REAL root is test 2: `b := ret_boolean_i32(); b.return_i32()` throws
`Type mismatch for parameter "self": Expected *(bool), Got Impl : (RetI32)`
at helper.yo Step 8. The fn's return SomeT IS resolved (the dts-stamping
block ran at def time: resolution = bool), but the METHOD-CALL receiver arg
reaches the self-param check as the UNRESOLVED `Impl : (RetI32)` value type,
not the auto-ref'd `*(bool)`. TS passes because its receiver arg at this
point is pointer-shaped and its compat unwraps given-SomeType via
resolvedConcreteType (compatibility.ts:900-916). Fix candidates, in order:

1. the method-call receiver preparation (where self is auto-ref'd) should
   deref the receiver's SomeT to its resolution (cell or
   lookup_some_resolved_concrete) BEFORE building the self arg type;
2. port compatibility.ts:900-916 (given-SomeT resolution unwrap) — needed
   anyway but insufficient alone here (bool vs \*(bool) still fails without
   the auto-ref).

### impl.test.yo — deeper (2026-07-31 EOD, uncommitted WIP in tree)

The compatibility.ts:900-916 given-SomeT resolution unwrap IS now written
(types/compatibility.yo, + `set_compat_lookup_some_resolved_fn` hook installed
from expr_info.yo's init — trait_checking.yo could NOT wire it: it has no
expr_info import and adding one cycles). Measured: impl STILL throws
`Type mismatch for parameter "self": Expected *(bool), Got Impl : (RetI32)`.
Diagnosis: the receiver's `Impl(RetI32)` at the CALL SITE is a FRESH per-call
SomeT instance (the ctl-throw hazard: per-call resolutions seed fresh SomeTs)
whose id differs from the def-time-stamped declaration SomeT — so neither the
lineage cell nor the id-keyed registry answers. NEXT: find where the call
result type for `ret_boolean_i32()` rebuilds the return SomeT (function.yo
resolved_ret / helper.yo return re-eval) and COPY the declaration SomeT's
resolution (cell or registry) into the fresh instance's cell there — then the
compat unwrap completes the chain. Tree state: compat unwrap + hook are IN THE
TREE UNCOMMITTED along with the \_\_DBG_F probe (function_type.yo) — gate before
landing; revert if the id-copy layer doesn't flip impl.
