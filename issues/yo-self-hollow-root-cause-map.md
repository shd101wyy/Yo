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

### impl.test.yo — probe round 2 (sh37): instrument the SYMMETRIC arm next

sh37 (tree + **DBG_CU probe on the ACTUAL-side unwrap, filtered to
Pointer/bool expected): ZERO hits during tests/impl.test.yo — the
actual-is-SomeT unwrap never runs for this failure. The failing compat is
helper.yo Step 8 `are_types_compatible(final_pt = *(bool), arg_type =
Impl(RetI32))` = (actual=\*(bool), expected=SomeT) — only the SYMMETRIC
(expected-side) unwrap applies, and it still did not flip impl (markers=1),
so its resolution lookup (cell + registry by expected SomeT id) missed too.
NEXT: move the probe to the symmetric arm (print e_res_id, cell len,
lookup hit) and compare the id against what the dts-stamping block
registered (add a matching eprintln there). Tree WIP: both unwrap arms +
hook (compatibility.yo, expr_info.yo init) + **DBG_F (function_type.yo) +
\_\_DBG_CU (compatibility.yo) are UNCOMMITTED — gate before landing anything.

### impl.test.yo — probe round 3 (sh38): the full chain is now pinned

- The dts-stamping fires: `__DBG_CU stamp id=1487/1488/1489` (all three ret\_\*
  fns' return SomeTs registered + cell-stamped).
- The SYMMETRIC unwrap at helper.yo Step 8 RUNS and FINDS the resolution
  (`expected-somet id=1487 cell=1 res_found=true`) — but
  `recur(actual = *(bool), resolution = bool)` is a tag mismatch: the self
  param is the POINTER and the receiver arg was never auto-ref'd.
- Zero arm-1 hits proves `_filter_receiver_methods` (env.yo:2630, the pass
  that sets `needs_pointer_conversion` via compat(receiver, pointee)) NEVER
  runs for a SomeT receiver: the SomeT-receiver method lookup in
  get_receiver_methods_by_name_from_env resolves methods through the TRAIT
  walk (sets self_type, never the ptr flag).

**THE FIX**: in the SomeT-receiver branch of the method lookup (env.yo), when
the matched method's first param is `*(T)` and the receiver's RESOLUTION is
compatible with T (the arm-1 unwrap makes this true), materialise the entry
with `needs_pointer_conversion : true` — mirroring the concrete-receiver
filter at env.yo:2677-2708. Then function.yo wraps `&(b)`, Step 8 compares
`*(bool)` vs `*(Impl-resolved)` and the pointer-children exact recursion
completes via the unwrap arms already in the tree.

### impl — probe round 3b addendum

All lookup results DO flow through `_filter_receiver_methods` (env.yo:3522),
yet the sh37 arm-1 probe (compat actual-SomeT vs Pointer/bool expected) got
ZERO hits — so the `*(bool)`-self method entry that reaches Step 8 was NOT
annotated by the filter's Rule-3 pass. Most likely the SomeT trait-walk
entry's `ty` at FILTER time is the TRAIT-generic signature (`self : *(Self)`,
pointee = SomeT ⇒ arm-1 guard `!is_some_type(expected)` skips, and compat
SomeT-vs-SomeT likely returns true WITHOUT the flag being set... or Rule 3
took the incompatible branch silently), and the \*(bool) concrete type is
substituted LATER (self_type specialization in function.yo/helper.yo) — after
the flag decision. NEXT PROBE: in function.yo's dot-dispatch (where
method_info is taken), print method_info.method_ty + needs_pointer_conversion
for method_name == "return_i32"; that says whether the flag was lost or never
set, and which lookup branch produced the hit.

### impl — probe round 4 (sh40): Self-pointee npc rule LANDS a layer; synthesizer unify is next

env.yo `_filter_receiver_methods` Rule 3 now sets `needs_pointer_conversion`
when the pointee is the trait's `Self` SomeT (a trait method's `*(Self)` self
matches its own receiver by construction) — probe confirms `npc=true` and the
`Expected *(bool), Got Impl` error is GONE. Next throw (arm 3,
`r := ret_boxi32_i32(); (&(r).return_i32)()`):
`Cannot unify incompatible types: "Box(i32)" and "*(Impl : (RetI32))"` —
synthesize_types unifying the self param against the receiver arg needs the
SAME SomeT-resolution unwrap the compat arms got (types/synthesizer.yo's
unify, plus possibly skip re-wrapping an already-&()'d receiver).

**Tree WIP (uncommitted, gate before landing)**: compat unwrap arms + hook
(compatibility.yo + expr_info.yo init), Self-pointee npc rule (env.yo),
probes: **DBG_F (function_type.yo), **DBG_CU (compatibility.yo + stamp in
function_type.yo), \_\_DBG_MI (function.yo — also a stray fmt open + helper).
Binary /tmp/sh40 = this exact tree.

### impl — round 4 addendum: the unify pair shape

The sh40 throw pairs expected="Box(i32)" (NO pointer) vs given="_(Impl :
(RetI32))" (pointer) at synthesizer.yo's tag fallback (~line 2029). The param
was `_(Self)`— either Self-substitution produced a bare`Box(i32)`(pointer
lost) or the &()-wrap doubled/shifted for the arm-3 receiver that was ALREADY`&(r)`in source. NEXT PROBE: print (resolved_pt, arg_type) at helper.yo
Step 6 for method_name return_i32 to see which side lost/gained the pointer;
then either fix the *(Self) substitution to keep the wrap or skip npc when
the receiver expr is already an`&(...)` call (function.yo:5139 wraps
unconditionally — TS checks the receiver's shape first, function.ts:332-358).

### impl — round 5 (sh43): eval FIXED (markers=0), codegen layer now RED

Landed in-tree (uncommitted): synthesizer.yo tag-fallback SomeT-resolution
unwrap (both sides, recur-retry before the "Cannot unify" throw — fixed arms
1/2), function.yo &-wrap guard (skip when the receiver ExprInfo ty is already
a Pointer — fixed arm 3's _(_(Impl)) double-wrap). Batch main markers=0 —
every impl.test.yo arm now EVALUATES. New blocker: the emitted C fails —
`.bin.c:3153: use of undeclared identifier '__yo_t16'` + "operand of type
**yo_t15 where arithmetic or pointer type is required" — the newly-reached
`(b.return_i32)()` emission (auto-&'d Impl receiver) references a typedef
that was never emitted. Fix lives in codegen (receiver lowering for
npc-wrapped SomeT receivers — likely the &() emission or the method-callee
self type). NEXT: compile the impl batch standalone, inspect .bin.c:3153's
expression and which type **yo_t16 should have been, then find the emitter
that skipped its typedef.

**Full impl-onion recap (all fixes this thread, IN TREE UNCOMMITTED)**:

1. compat: given/expected SomeT-resolution unwrap arms + registry hook
   (compatibility.yo, expr_info.yo init).
2. env.yo filter Rule 3: pointee-is-Self ⇒ needs_pointer_conversion=true —
   verified as the direct port of TS env.ts:2005-2020.
3. synthesizer.yo: resolution unwrap retry at the tag fallback.
4. function.yo: skip &-wrap for already-pointer receivers.
   Probes to strip before landing: **DBG_F (function_type.yo), **DBG_CU ×2
   (compatibility.yo, function_type.yo), **DBG_MI + helper + fmt open
   (function.yo), **DBG_S6 (helper.yo). Gate the batch with TIER 1 + sweep +
   fixpoint after the codegen layer is fixed; impl target = 6/6 at TS parity.

### impl — round 5 addendum: the RED C decoded

`.bin.c:3153` is `((int32_t (*)(void*))__yo_t16.get_number)((void*)(self))` —
a Dyn-VTABLE dispatch emitted with the receiver TYPE's typedef name
(`__yo_t16`, never even emitted) in the OBJECT slot. The enclosing fn is the
DisambigPoint arm (trait-method disambiguation test). So the newly-evaluating
disambiguation arm routes its trait-qualified method call into the dyn
dispatch emitter with a type where a value belongs — look at
codegen/exprs/dyn or other_fn_call's trait-qualified branch for how the
callee object expr is chosen (likely reads the method-callee side-table entry
stamped by the NEW eval path and mis-classifies it as Dyn).

### impl — WIP PARKED as a named git stash (end of 2026-07-31 session)

The four eval fixes + probes are saved as **`stash@{0}` — "impl-onion-WIP:
compat unwraps+hook, npc Self rule, synthesizer unwrap, wrap guard (sh43)"**.
`git stash pop` (or `git stash apply stash@{0}`) restores the exact tree that
built /tmp/sh43 (impl markers=0, RED at codegen). Do NOT land the bundle until
the codegen layer is fixed — landing now flips impl HOLLOW → RED.

Layer 6 (the codegen RED): the failing emission comes from
`use_trait_b_explicit`'s `(T <: TraitDisambigB).get_number(self)` — the
static-dispatch arm (function.yo:5239-5247) records the method-callee VALUE
from `call_result_m.specialized_function_value` / `method_val_opt`, but for
the trait-with-receiver static callee at SPEC time neither is a concrete
FuncVal, so codegen's other_fn_call falls back to expression-emitting the
callee → `__yo_t16.get_number` (the TypeVal's C type string) → clang error.
Fix: at spec-time re-eval of the static trait-qualified call, resolve the
CONCRETE impl's method FuncVal (T is bound by then —
`get_type_trait_methods_by_name` on the bound receiver with the trait id
filter) and record THAT; the plain `self.get_number()` sibling arm already
does this correctly (it emitted `fn_yo_id_4990(self)`).

### impl — layer 6 attempt 1 (sh44, in stash@{0} v2)

Added the trait-qualified concrete lookup to
`get_type_trait_methods_by_name_from_env` (env.yo): a TraitT callee with
`is_concrete : Some(R)` resolves R's methods filtered by source_trait_id.
Measured: the C error PERSISTS unchanged — at DEF time `is_concrete` is the
unresolved SomeT (lookup misses, falls through), and the SPEC-time call does
not re-resolve the method-callee VALUE for this shape (codegen still emits
the fallback `__yo_t16.get_number`). Next angle: find where the SPEC body
re-eval processes this call (does the static arm run again with T bound? if
so why is record_method_callee_value not overwriting?) — or fix at CODEGEN:
other_fn_call's method dispatch could resolve the concrete impl method from
the receiver arg's type + trait id at emission time. WIP now parked as
stash@{0} ("impl-onion-WIP-v2").

### impl — layer 6 SOLVED (sh46); layer 7 surfaced

The concrete-impl witness scan in property_access.yo's TraitT-with-receiver
arm (before the generic-impl scan, matching source_trait_id against BOTH the
trait's own id and get_base_trait_key) FIXED the DisambigPoint RED — the
`__yo_t16.get_number` clang error is GONE. This was exactly the gap the
code's own comment predicted ("TS also scans CONCRETE impls first
(ts:651-849) — add if a concrete-impl witness shape surfaces").

Layer 7 (sh46's remaining C error, .bin.c:3184): the heterogeneous-Eq arm's
trait `?=` DEFAULT for `!=` emits `return // Failed to transpile
not((Self.(==))(lhs, rhs));` — a Self-qualified OPERATOR member access inside
a trait default method body fails def-eval (Self=HeteroEqW at spec, `==` has
TWO overloads: Eq(str) + Eq(HeteroEqW); selection by arg types stamps
nothing). WIP parked as stash@{0} "impl-onion-WIP-v3" (includes all v1/v2
fixes + this one + probes **DBG_F/**DBG_CU/**DBG_MI/**DBG_S6/\_\_DBG_ST).

### impl — layer 7 probe note

The `!=`-default FTT's error does NOT appear in the **DBG_F census (sh46) —
the failing eval routes through a DIFFERENT swallow than \_trial_eval_fn_body.
The overload-defer machinery for `Self.(==)` (property_access.yo:216-231,
routes multi-overload Type.method to \_select_matching_overload) already
exists, so the break is further along: probe the **DBG_A sites
(values/anonymous_function.yo trial swallows) and the SPEC body-eval swallow
for the trait-default fn (fn_yo_id_2242's spec) next. WIP = stash@{0}
"impl-onion-WIP-v3" (unchanged from the previous parking).

### impl — layer 7 probe round 2 (sh48): NOT an eval throw

sh48 carried ALL THREE swallow probes (**DBG_F, **DBG_A, \_\_DBG_W). None
reports an error attributable to the `!=`-default arm — the census shows only
known noise (expr_to_string, tuple member \_0/\_1, usize/u8). Conclusion: the
`// Failed to transpile not((Self.(==))(lhs, rhs))` marker is NOT a swallowed
eval throw. The spec-time eval of the default body SUCCEEDS but codegen
cannot emit the node — the `(Self.(==))(lhs, rhs)` call's resolved callee
(picked by \_select_matching_overload after property_access's multi-overload
defer) is not recorded where codegen looks (record_method_callee_value under
the CALL expr id the EMITTER walks — original FuncVal body AST vs the
evaluated clone's ids, the classic original-vs-clone id mismatch that
\_bridge_expr_info exists for). NEXT: in codegen, find which lookup fails for
that node (other_fn_call's dot-callee dispatch); on the eval side, check
whether the overload-selected call path stamps the ORIGINAL node id or a
clone's. WIP = stash@{0} "impl-onion-WIP-v4" (binary /tmp/sh48 = this tree).

### impl — layer 8 pinned (sh48 C comparison): wrong specialization route

The two `!=`-default specs took DIFFERENT routes:

- homogeneous `a != c` → **fresh spec** `fn_yo_id_4997` (new func id, body
  clone evaluated, `(Self.(==))` stamped to the Eq(HeteroEqW) impl
  `yo_id_4998`) — emits perfectly;
- heterogeneous `a != "abcd"` → **rtcall-mangled emission of the BASE**
  (`fn_yo_id_2242_rtparam0_<struct>_rtparam1_str_ret_bool` — base trait-
  default FuncVal id 2242 + signature mangle, the record_fid_rtcall path)
  — the base body was emitted for the (HeteroEqW, str) signature WITHOUT a
  per-signature body eval, so `(Self.(==))` has no stamped callee for the
  Eq(str) overload → `// Failed to transpile`.

FIX DIRECTION: the heterogeneous operator call site must produce a TRUE
specialization (create_specialized_function_inline) like the homogeneous one,
instead of registering a runtime call of the base. Find where the `!=`
operator dispatch decides spec-vs-rtcall (calls/function.yo operator arm →
\_select_matching_overload → the call/registration that follows) and why the
(receiver, str) arg pair skips specialization — likely keyed on "params
contain no generics" (rhs str is concrete, Self already bound → looks
non-generic → rtcall) while the homogeneous pair triggered spec for a
different reason. WIP parked again as stash@{0} (v4, tree unchanged).

### impl — layer 8 attempt 1 (sh49): spec-trigger broadening measured-ineffective

Broadened ou_spec_soft_generic to TS's bare guard (generic && !ctl, with a
concrete-args condition replacing the closure-param narrowing) — the
heterogeneous `!=` FTT is UNCHANGED. Conclusion: the `a != "abcd"` call does
NOT route through the generic-call spec site (function.yo:~1848) at all — the
OPERATOR dispatch arm (function.yo:2192+, get_receiver_methods_by_name for op
"!=" → \_select_matching_overload) must have its own call/registration step
that took the rtcall path. NEXT: trace that arm — find where the selected
overload (the Eq(str) default) is CALLED/registered after selection, and why
no fresh spec is minted there for a SomeT-Self default; compare with how the
homogeneous case minted fn_yo_id_4997 (probe: print the taken branch + func id
for op != on a HeteroEqW receiver). WIP = stash@{0} "impl-onion-WIP-v5"
(binary /tmp/sh49).

### impl — layer 8 DECISIVE probe (sh50)

`__DBG_OP` at the operator-selection point:

- homogeneous `a != c` → `chosen=0 nty=fn(lhs : HeteroEqW, rhs : HeteroEqW)
generic=false fvid=fn_yo_id_4997` — the registered method VALUE is already
  a per-impl/specialized FuncVal (4997) whose body emits correctly;
- heterogeneous `a != "abcd"` → `chosen=1 nty=fn(lhs : HeteroEqW, rhs : str)
generic=false fvid=fn_yo_id_2242` — the registered value is the SHARED
  trait-default base whose body still references unresolved `Self`.

Both trait-default fill sites (values/impl.yo:2192 generic-impl fill with
forall stamping; :2840 concrete-impl fill) register the SHARED default
`get_trait_default(...)` value — so 4997 was minted LATER by some
call-time supersession for the Eq(HeteroEqW) entry that the Eq(str) entry
never received. NEXT: find what minted + re-registered 4997 (search
supersession/record_fid_spec/re-register paths for type_trait_methods
entries), then apply the same treatment to every filled default (or mint
per-impl body-clone FuncVals with fresh ids at BOTH fill sites). WIP =
stash@{0} "impl-onion-WIP-v6" (binary /tmp/sh50 matches; \_\_DBG_OP probe
included).

### impl — layer 8 SYNTHESIS (final): why 4997 works and 2242 does not

Both defaults ARE per-instantiation FuncVals (Eq is parametric — each
`Eq(HeteroEqW)` / `Eq(str)` instantiation evaluates its own `?=` lambda).
The asymmetry is EVALUATION ORDER vs the overload-defer:

- Eq(HeteroEqW)'s default body evaluated when HeteroEqW had ONE `==`
  overload → `Self.(==)` resolved and stamped (→ 4997 emits perfectly);
- Eq(str)'s default body evaluated when TWO `==` overloads existed →
  property_access's multi-overload DEFER (property_access.yo:216-231)
  returned unresolved, AND the fallback `_select_matching_overload` could
  not run because the receiver is the UNBOUND trait Self at trait-value
  creation → `Self.(==)` never stamped; with a non-generic registered ty no
  call-time spec ever re-evaluates the body → rtcall emission FTTs.

**THE FIX (bounded, at values/impl.yo:2838-2856 — the concrete-impl default
fill)**: instead of registering the SHARED d*val, mint a PER-IMPL clone:
fresh func_id, body = default body clone, evaluate the clone's body with
ctx.self_type = receiver_ty and params bound at the SELF-SUBSTITUTED types
(reuse create_function_body_evaluation_context + \_trial_eval_anon_body /
the \_eval_and_register_rc_method pattern in codegen/functions/collection.yo
which does EXACTLY this: eval a synthesized fn with Self bound, register
FuncVal + method entry). Then register the clone as the method value. At
that point Self=HeteroEqW and rhs : str are concrete, `\_select_matching*
overload` picks Eq(str).==, stamps land, and codegen emits a direct call —
identical to the 4997 path. Apply the same to the generic-impl fill
(:2192) if its forall-stamped path shows the same gap. This is TS parity:
TS materializes defaults per impl from defaultValueExpr (trait-type.ts:
418-489) in the impl's env where Self is concrete.

### impl — layer 8 implementation round 1 (sh51): materialization wires, stamping still short

The per-impl default materialization is IMPLEMENTED (values/impl.yo concrete
fill + `_materialize_default_body` helper): the emitted C now shows the
default under a FRESH id (`fn_yo_id_5025`, no rtparam mangle — the clone was
adopted, so its body eval returned non-empty). But the body STILL FTTs at
`not((Self.(==))(lhs, rhs))` — the materialization eval did not record a
usable callee for the inner call. Hypothesis for the NEXT probe: during the
clone's body eval, the deferred `Self.(==)` property access falls through to
a soft stamp (UnknownVal) instead of NO value, so the call dispatch takes the
.Some(value) arm (generic call path — no record_method_callee_value) instead
of the .None arm that runs \_try_find_receiver_method +
\_select_matching_overload. Probe: print which arm the inner call takes and
what the callee ExprInfo holds during materialization (gate on
ctx.self_type=HeteroEqW + method "=="). If confirmed, the fix is to make the
multi-overload defer leave NO value (or route the .Some(UnknownVal-fn) case
into receiver-method dispatch too — TS's `if (!functionToCall.$?.type)`
equivalent treats unknown-valued fn callees as unresolved).
WIP = stash@{0} "impl-onion-WIP-v7" (binary /tmp/sh51).

### impl — layer 8 round 1 confirmation (read-only trace)

Confirmed structurally: function.yo's callee-value match has a catch-all
`_ =>` arm at :4982 for "non-TypeValue, non-FunctionValue shape (e.g.
UnknownValue)" — the generic RUNTIME-CALL path. A deferred multi-overload
`Self.(==)` access gets a SOFT UnknownVal stamp from a later
property_access fall-through arm, so the inner call dispatches into this
catch-all (no record_method_callee_value) instead of the `.None` arm
(:5151) that runs \_try_find_receiver_method + \_select_matching_overload.
Two candidate fixes for the NEXT round:

1. make the multi-overload defer leave NO ExprInfo value at all for
   fn-typed registry fields (find the fall-through arm that soft-stamps
   the UnknownVal for a TypeVal-receiver property access) — dispatch then
   takes the .None arm and the existing machinery completes;
2. OR at the head of the :4982 catch-all, when the callee expr is a
   BF_DOT property access, first try \_try_find_receiver_method + selection
   (mirror the .None arm) before falling to the runtime-call path.
   Option 1 is smaller and matches TS (TS stamps nothing for unresolved
   overloaded members; its dispatch key is `!functionToCall.$?.type`).
   WIP unchanged = stash@{0} "impl-onion-WIP-v7", binary /tmp/sh51.

### impl — layer 8 SOLVED (sh53); two runtime dispatch bugs remain (layers 9a/9b)

The struct-arm multi-overload defer (property_access.yo:~962 — the missing
twin of \_try_resolve_associated_type's rule; the arm committed to the FIRST
valued registry entry) unblocked the whole chain: **impl.test.yo now
COMPILES AND RUNS — 4 passed / 2 failed** (was 6 vacuous). The heterogeneous
Eq arm (layer 7/8 target) PASSES.

Remaining, both honest runtime dispatch bugs:

- **9a "Test function that returns Impl"**: `Expected true from
ret_boolean_i32` — `b.return_i32()` returns the wrong value for the
  Impl(RetI32)-resolved-bool receiver (likely calls the wrong impl's
  return_i32 or misroutes the receiver).
- **9b "Test trait method disambiguation"**: `use_trait_b should dispatch to
TraitDisambigB.get_number (returns y)` — at SPEC time the receiver is
  CONCRETE (DisambigPoint) so the registry has TWO get_number entries and
  first-wins picks TraitDisambigA's; the where(T <: TraitDisambigB)
  constraint must filter (TS keeps the DEF-time constrained method identity
  through specialization). Fix direction: preserve/thread the def-time
  resolved method's source_trait_id through the spec body re-eval, or filter
  the concrete lookup by the where-constraint trait when the receiver var is
  a bound generic param.

Cannot land yet: HOLLOW→RED in ledger terms until 9a/9b are fixed (target
6/6 at TS parity). WIP = stash@{0} "impl-onion-WIP-v8", binary /tmp/sh53.

### impl — 9b attempt 1 (sh54): where-preference channel wired, not reached

Implemented: g_active_where_trait_ids stack (expr_info.yo), push/pop around
create_specialized's body eval (helper.yo:~2405, ids from
get_func_where_constraints(func_id)), preference in \_select_matching_overload
(function.yo) picking a match whose source_trait_id is in the active set.
Measured: use_trait_b STILL dispatches A (4/2 unchanged). Either the spec
body's `self.get_number()` does not route through \_select_matching_overload
(def-time stamp reuse? a different lookup takes ONE hit?), or the pushed id
set was empty (verify get_func_where_constraints(FuncVal id) has the entries
— they are registered under the fn-TYPE expr id and copied via
copy_func_where_constraints). NEXT PROBE: eprintln in the preference block
(aw_ids len + matching len + sources) AND at the push site (ids pushed),
run impl test 4 isolated. 9a (`ret_boolean_i32` wrong value) untouched —
needs its own probe (which return_i32 impl the call binds at spec time).
WIP = stash@{0} "impl-onion-WIP-v9", binary /tmp/sh54.

### impl — 9b attempt 2 (sh55/sh56): key facts for the next round

- The disambiguation arm PASSES IN ISOLATION (subset arm: 1 passed) and
  fails only in the BATCH — the wrong-dispatch is ORDER/STATE-dependent
  (earlier tests' registry state changes the pick).
- \__DBG_WP probes: the SELECTOR runs with matches=2 aw=0 (37×) — the spec
  push NEVER fires: get_func_where_constraints(func_id) is EMPTY inside
  create_specialized_function_inline for these fns (the constraint copy to
  the FuncVal id may not cover this creation path), AND use_trait_\* are
  GENERIC (deferred) so the def-time FLOW push (wired in sh56) doesn't
  apply to them either — their bodies evaluate in the DEFERRED trial
  (function_type.yo dg block, no push) and via create_specialized.
- NEXT: (1) probe why get_func_where_constraints(FuncVal id) is empty at
  spec (registration key vs copy timing); (2) add the push to the dg
  deferred-trial block too; (3) investigate the batch-order dependence
  (which earlier test's registrations flip the pick — likely the
  provisional-method or where-walk cache).
  9a (`ret_boolean_i32` value bug) still untouched. WIP = stash@{0}
  "impl-onion-WIP-v10", binary /tmp/sh56.

### impl — 9b FIXED (sh59): impl at 5/6

The missing piece: `where(T <: Trait)` constraints live on the forall
SomeT's required_trait_types, NOT the side table — the spec push in
create_specialized now ALSO collects trait ids from
get_all_some_types(func_type)'s SomeTs, and the \_select_matching_overload
where-preference then picks TraitDisambigB's get_number.
**"Test trait method disambiguation" PASSES — impl.test.yo = 5 passed /
1 failed.**

Last failure (9a): `bool _t = // Failed to transpile (b.return_i32)() ==
(1);` — the assert's method call on the `Impl(RetI32)`-resolved-bool
receiver FTTs at EMISSION (an FTT comment spliced INTO an expression —
also yields invalid C locally but the file still runs the other tests).
The call's method-callee VALUE was never recorded: for the module-level
`b.return_i32()` call the receiver's SomeT resolution is registry-known
(bool), the method entry from the SomeT trait walk carries the trait DECL
(no value), and the concrete bool impl's return_i32 value must be
resolved either at the call (record_method_callee_value with the
resolution-deref'd receiver — same class as layers 3-5) or at emission.
NEXT: probe what method_info.method_val_opt / the recorded callee value is
for THIS call (gate on method name return_i32 + receiver Impl), then
resolve the concrete impl's method value via the receiver's
resolved_concrete before recording. WIP = stash@{0}
"impl-onion-WIP-v11", binary /tmp/sh59.

### impl — 9a attempt 1 (sh61): resolution-deref callee fallback insufficient

Implemented at function.yo's record site: when neither spec nor method value
exists, deref the receiver's SomeT resolution (cell/registry) and record the
CONCRETE impl's valued method entry. Measured: 9a persists (5/6). NEXT
probes (one build): print in the fallback (a) rm_res found?, (b) rm_rid +
rm_entries count + any valued?; if values exist and are recorded, the gap
moves to EMISSION (does other_fn_call's dot-callee route consult
lookup_method_callee_value for THIS shape? is the recorded FuncVal's C fn
ever emitted/registered with codegen?). WIP = stash@{0}
"impl-onion-WIP-v12", binary /tmp/sh61. impl stands at 5/6 in-WIP.

## 2026-07-31 EOD FINAL — impl.test.yo TRUE GREEN 6/6; bundle LANDED

The 12-layer onion is complete and landed. Final layers: 9b = where-trait
preference fed from the forall SomeT's required_trait_types; 9a = at the
method-callee record site, when neither spec nor method value exists,
unwrap the receiver's (possibly pointer-wrapped) SomeT resolution and
record the CONCRETE impl's valued method entry.

Bundle effects (sweep /tmp/sweep_impl): **172 GREEN / 12 HOLLOW / 1 RED.**

- impl.test.yo: HOLLOW -> TRUE GREEN 6/6 at TS parity (markers=0 in
  \_\_yo_user_main; 3 residual markers sit in never-called cee-rejected
  specialization bodies — cleanliness TODO, not hollowness).
- where_clause_fn_inference: HOLLOW -> RED (rc=138, hollow=0, markers=0 —
  it now EVALUATES FULLY and fails with 4 visible C type-identity errors:
  `__yo_t16 vs __yo_t34` / `__yo_t19 vs __yo_t27`, two typedefs per logical
  type — the known instantiation-split class). This is the honest form of
  its old hidden failure; it is now diagnosable by C error line.
  Gates: battery 20/20 unchanged, corpus 149/0, std 153/153, stage2
  hollow=0 + clang + stage3, STRICT_FIXPOINT HOLDS.

## where_clause_fn_inference RED — C-level evidence (2026-07-31 EOD, post-impl-landing)

The 4 type-identity errors decode to TWO struct-id splits with IDENTICAL
layouts `{ _inner : <iter>, _f : void* }`:

- `struct_yo_id_4982` emitted as BOTH `__yo_t34` and `__yo_t27`
- `struct_yo_id_5980` emitted as `__yo_t16` (the call site's temp type)
  i.e. the same logical `Filter/Map(It, F)` instantiation exists as ONE
  struct id per ERA (def-era 4982 vs call-era 5980) — the documented
  `_f`-member F-BINDING ERA family (same root as the iterator_combinators +
  iter_filter_closure hollows: one fix, three files). The C makes it
  concrete: the instantiation memo key for a struct parameterized by a
  CLOSURE FN TYPE (F) differs between the definition-time and call-time
  evaluations, so `it1.filter(f)`'s declared temp type and the spec'd
  callee's return type disagree.

NEXT (opening move of the next round): probe the struct-instantiation memo
— print the cache key when instantiating any struct whose fields contain
`_f` (or whose ctor fid matches the Filter/Map constructors) during
tests/where_clause_fn_inference.test.yo; compare the def-era and call-era
keys to see WHICH component of F's identity diverges (fresh SomeT id, fn
type param labels, or the closure's capture-struct id). Then canonicalize
that component at CREATION (the Gap-6 attempt-8 lesson: fix the creation
side, never post-hoc).

## F-era trio — attempt 1 REJECTED (sh65, reverted)

Added a Func arm to `_ctfe_types_era_equal` (era-equal Funcs = same arity +
pairwise era-equal params + era-equal result). Measured: the
where_clause_fn_inference C splits are BYTE-IDENTICAL before/after — the
`Filter(It, F)` type argument that splits the memo is NOT a bare Func type.
Refined hypothesis: F arrives as an Impl-SomeT wrapper (per-era fresh SomeT
id) or the closure's CAPTURE-STRUCT type — the era recur hits the SomeT/
capture case, which has no arm, and falls to exact (ids differ) → split.
The dedicated round MUST run the memo-key probe FIRST (print the actual
type_arguments of struct 4982 vs 5980 at instantiation) before writing any
arm — this rejection is the cost of skipping it. Change reverted
(zero-wins rule).

## F-era trio — memo-key probe result (sh66) + the real tension

The **DBG*MK probe on the CTFE cache's near-miss comparison got ZERO hits
during the RED file — the split never reaches that comparison (the two
instantiations either key under DIFFERENT constructor func ids, or the
divergence is in the TYPE-INTERN key, not the CTFE memo). Supporting
evidence: the C type name embeds the closure GENERATION id
(`...\_fn_x***i32**\_**i32_cl1_yo_id_4985`), and types/intern.yo's SomeT key
DELIBERATELY includes the SomeT id (the statx single-effect-closure
cluster fix at intern.yo:380-390 — id-only merging was wrong there, so
full-content keying was chosen). The F-era split is the OTHER side of the
same tension: per-era fresh SomeT/closure-generation ids in the F slot
split the intern/instantiation identity for what is ONE source
instantiation.

The dedicated round's design task: canonicalize CLOSURE-DERIVED identity
components by SOURCE POSITION (g*closure_fid_source exists precisely for
this — anonymous_function.yo:1089) inside the intern key and the
instantiation identity, WITHOUT reverting the statx fix (which needs the
required-trait CONTENT, not the generation id). I.e. replace the closure
GENERATION id components with the source key; keep everything else
content-keyed. Entry points: types/intern.yo SomeT/Func arms; wherever the
`cl1*...` name component is minted.

## gadts — attempt 1 REJECTED (sh67, reverted)

Ported TS match.ts:646-673's GADT bypass (skip cross-branch result
unification, result = unrefined expected type) into evaluate_match's two
unify blocks, gated on `get_gadt_variant_args(en_id).is_some() &&
expected.is_some()`. Measured: ALL 9 arms still hollow — the bypass never
fires. Root of the inertness: the gadt_registry keys by the enum
INSTANTIATION id captured at constructor-body creation
(types/enum.yo:574/634), but the def-time trial of `eval_value`'s body has
scrutinee `v : Value(T)` with T an unbound SomeT — that instance was never
created through the constructor body, so its en_id is not in the registry
(or the instantiation is an unresolved TypeApp). NEXT: probe what
`matched_type`/`en_id` IS at the match site during the eval_value def
trial, then key the GADT lookup by the enum's DEFINITION identity (ctor
fid via lookup_enum_cfid / struct_ctor_fid analog) instead of the instance
id — mirroring TS, where isGadt lives ON the EnumType and survives
substitution. Change reverted (zero-wins).

## gadts — attempt 2 (sh69): probe CORRECTED attempt 1's root-cause theory

Probe (`__DBG_GM` at the match site, `__DBG_GR` at registration) on a
standalone mini repro (scratchpad/gd/mini.yo) showed the registry-miss theory
was WRONG: at eval*value's def-trial match site all three TS preconditions
HOLD — `reg=HIT tca=Some(1) exp=T ty=<enum:enum_yo_id*...>`. The def trial
then dies at the CROSS-BRANCH result unification (`Incompatible types:

- Previous: i32 - Current : bool`at`.BoolVal(b) => b`) — i.e. the plain
  consistency check runs where TS's isGadtMatch bypass would have kicked in.
  (Attempt 1's bypass must have gated/patched the wrong spot; the batch-context
  probe also showed the def trial dying silently before any match — mini vs
  batch def-time behavior differs, worth remembering.)

Fix (faithful port, all five TS pieces):

1. `is_gadt_match_em` gate at match entry (match.ts:354-360), capturing the
   ENTRY expected type (arm loop overwrites ctx.expected_type).
2. `_gadt_refined_expected` helper (match.ts:93).
3. Skip-unreachable-GADT-branch in BOTH arm loops (match.ts:459/747) via the
   existing `_is_gadt_branch_reachable` — this is what lets the T=i32
   SPECIALIZATION pass (BoolVal arm is skipped, not type-mismatched).
4. GADT branch in BOTH result-consistency blocks (match.ts:646-676/1115-1140):
   refined-verify per branch + pin result to unrefined expected.
5. Final stamp prefers the gadt expected type (match.ts:1275-1279).

### gadts attempt 2 — RESULT: TRUE GREEN (sh71, pending gates)

Two more layers were needed beyond the five-piece match.yo port:

6. **tca resolve-at-read** (`_gadt_resolve_tca_entry` in match.yo): TS
   substitutes `EnumType.typeConstructorArgs` ON the type object at
   specialization; yo-self's registry keys by enum id, which `substitute`
   PRESERVES, so the specialized instance still maps to the def-time
   `[SomeT T]`. Reading each tca entry through the SomeT resolution channel
   (lineage cell → id-keyed registry) recovers `[i32]`. Applied at the
   match-entry fetch AND inside `_is_gadt_branch_reachable`.
7. **tca synthesis in the enum-vs-enum unify arm** (synthesizer.yo, port of
   synthesizer.ts:738-756): in a GADT the type parameter appears ONLY in
   `-> recur(...)` — variant fields are concrete — so the per-variant field
   unification binds nothing and the call's return type T stayed an
   UNRESOLVED SomeT (probe: `(rb : bool) = result` and `(r : i32) = result`
   BOTH passed; `result == i32(42)` yielded unit). Unifying the two
   instances' recorded tca lists binds `T := i32` exactly as TS does.

Probe lesson (mini2-mini6 ladder): an unresolved-SomeT call result is
INVISIBLE to assignment compat (SomeT wildcard) — probe with an OPERATOR
(`==`), which degrades to unit, or force the error message to print the
inferred type via `(x : bool) = result`.

Measured: mini repro 0 markers, compiled binary runs RC=0; full
tests/gadts.test.yo with sh71: rc=0, markers=0, batch main real, **10
passed = TS count exactly**.

## where_clause_fn_inference RED — FIXED (memo-canonicalization of substituted instantiations)

Probe ladder (sh72-sh77) that located it:

- \_\_DBG_LM at the ctor memo (gate on field label `_f`, NOT the struct name —
  names are EMPTY at mint, same trap as the gadts en_name gate): the ctor fid
  is STABLE (yo_id_4971 for every call) and the CONCRETE instantiation memo
  works (sid_5980 MINT once + HIT once per arm). The registry/bucket-split
  theory was wrong.
- The C split: **yo_t16 = memo instance 5980 (annotation route);
  **yo_t34/\_\_yo_t27 = the DEF-ERA instance 4982 substituted per-arm — the
  spec's return type. `substitute()` keeps the struct id, and the intern key
  leads with the id, so the clone interns as a SECOND C struct.
- TS has no such split because its specialized return type IS the memo object
  (re-evaluated through the memoized constructor).

Fix (creation-side canonicalization — the gap-6 attempt-#8 design realized):

- expr_info.yo: `canonicalize_instantiation(t, env)` hook (cycle-breaker,
  same pattern as the compat hook); comptime_fn.yo installs the impl.
- comptime_fn.yo `_canonicalize_instantiation_impl`: a fully-concrete Struct
  clone (ctor fid via lookup_struct_ctor_fid + type_arguments era-equal to a
  memo entry's args) maps to the memo instance; miss keeps the clone, never
  mints. type_arguments resolve through THREE channels in order: SomeT
  lineage cell → id-keyed registry → **spec-env NAME lookup**
  (get_value_of_some_type_from_env) — the where-inference binds B only in
  the env (A resolved via the registry, B needed the env fallback; measured
  one channel at a time).
- helper.yo: applied at BOTH return-type computations — spec_ret_ty (the
  body's expected type) AND spec_result (the REGISTERED C signature at
  register_func_type, recomputed independently ~line 3175). Fixing only the
  first left "returning '**yo_t16' from a function with incompatible result
  type '**yo_t34'".

Measured: where_clause_fn_inference RC=0, 0 markers, 2 passed (= TS).
iterator_combinators + iter_filter_closure remain HOLLOW — their hollowing
error routes through a different swallow (per the sh33 census); separate
probe round needed.

### where_clause_fn_inference attempt — REJECTED at the sweep gate (reverted)

The canonicalization above DID fix the RED (2 passed, 0 markers, TIER 1
clean, FIXPOINT_HOLDS) but the full honest sweep caught TWO regressions:

- tests/array.test.yo RED rc=1: `returning '__yo_t19' from a function with
incompatible result type '__yo_t18'` — the mirror image of the bug it
  fixed: for that spec the BODY's returned instantiation is a THIRD era
  that does NOT hit the ctor memo, so canonicalizing the SIGNATURE to the
  memo instance created a new signature-vs-body mismatch.
- tests/for_macro_borrow.test.yo RED rc=139 (SIGSEGV) — likely a
  struct-layout mismatch at runtime from the same partial convergence.
  (NOTE: the first sweep pass was killed mid-run and initially scored these
  two as kill artifacts — logs truncated at "prelude — evaluator OK". The
  re-sweep with clean logs proved them REAL. Never trust a RED from a killed
  sweep pass without a clean re-measure — but never DISMISS one either.)

Lesson for the dedicated round: canonicalizing only the two RETURN-type
sites is NOT convergent — the body's instantiation must land in the same
memo entry first. The complete design is creation-side: make the CTFE memo
lookup itself treat "fully-concrete era instance of an existing entry"
as a HIT (extend \_ctfe_args_equal / the bucket scan with the resolve-
through-channels logic from \_ci_resolve_arg), so EVERY route — annotation,
spec body, substituted return — receives the one memo instance and no
after-the-fact patching of signatures is needed. The reverted diff was
discarded (git checkout, never committed) — reconstruct from the design
above: hook `canonicalize_instantiation(t, env)` in expr_info.yo, impl
`_canonicalize_instantiation_impl` + `_ci_resolve_arg` (cell → registry →
env-name channels) in comptime_fn.yo, applied at helper.yo's spec_ret_ty
(~line 2049) and spec_result before register_func_type (~line 3175).
