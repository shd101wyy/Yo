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

## iter_filter_closure — hollowing error LOCATED (sh79 probe)

The batch-main def trial dies at `match(result, ...)` with "Expected enum
type or primitive type for match expression, got unit" where
`result := filtered.next()` and `filtered := iter.filter(x => ...)`.
I.e. the def-time call of prelude's `filter` (Iterator trait default →
IterFilter(Self, F)) produces a value on which `.next()` resolves to UNIT.
Same F-era instantiation-identity class as where_clause_fn_inference —
the value's IterFilter type is an era clone whose method resolution/
specialization misses. Routed through the **DBG_F swallow (fn-def trial of
the batch main), NOT **DBG_A/\_\_DBG_W. iterator_combinators presumably
shares this exactly (same IterFilter/IterMap defaults).

Fix direction: the convergent creation-side design recorded in the
where_clause_fn_inference rejection above (era-instance HIT inside the
CTFE memo lookup itself, resolve-through-channels in \_ctfe_args_equal's
bucket scan) — one dedicated round, expected to cover iter_filter_closure

- iterator_combinators + re-fix where_clause_fn_inference without the
  signature-patching regressions.

### F-era attempts 3 & 4 — REJECTED (sh80/sh81, reverted; family PARKED)

Attempt 3 (sh80): substitution-LEVEL canonicalization — `_subst_canon` hook
in substitution.yo's Struct arm (installed by comptime_fn.yo), mapping a
fully-concrete substituted clone (cell→registry-resolved type_arguments,
ctor-fid bucket scan) to the memo instance. Measured: array.test.yo rc=1
with the SAME canary (`returning '__yo_t19' ... incompatible result type
'__yo_t18'`) + for_macro_borrow rc=1 + where_clause rc=1; hollows
unchanged. Root: the BODY's ctor call still MINTS its own era instance (its
era'd args miss the memo), so mapping clones at creation converges only
the routes that go through `substitute`.

Attempt 4 (sh81): attempt 3 PLUS resolve-through-channels inside
`_ctfe_args_equal` (both sides through the lineage-cell → id-registry
chase before comparison, so era'd ctor calls memo-HIT). Measured: WORSE —
array.test.yo rc=139 (SIGSEGV), for_macro_borrow/where_clause rc=1,
hollows unchanged. Root: the GLOBAL resolution registry is context-
poisoned (the documented IoExn hazard in \_resolve_some_types_deep) — a
SomeT id resolved in one specialization context leaks into unrelated memo
comparisons, collapsing instantiations that must stay distinct.

VERDICT: the resolution-channel family of fixes is exhausted (4 rejected
attempts, each measured against the array/for_macro_borrow canaries). The
next attempt must NOT use the global registry as a comparison channel.
Candidate direction: make the SPEC-body ctor call and the substituted
return share identity by construction — e.g. thread the specialization's
OWN Substitution map into the return-type computation so both routes call
the ctor through the SAME memo key (TS: the return type IS re-evaluated
through the ctor in the SAME env as the body — yo-self's
evaluate_function_return_type_again exists but its instances era-split
from the body's because the DEF-era instance is memoized under the
def-trial's SomeT args; investigate why the body's call and the re-eval's
call produce DIFFERENT keys in the same env first: probe the memo args of
BOTH calls in one run).

## asm — scoped (next dedicated round)

Two-part bounded feature port, no design risk:

1. Evaluator: port src/evaluator/builtins/asm.ts (829 lines) over the
   55-line stub in yo-self/evaluator/builtins/asm.yo (evaluate_asm +
   evaluate_global_asm — operand forms out/in/ref/const_val, named
   operands, clobber, asm_options(volatile/intel_syntax), tuple multi-out,
   arch gating, comptime_expect_error arm 6).
2. Codegen: yo-self/codegen/exprs/generation.yo:453 emits
   `/* TODO[codegen-port]: asm not yet ported */` for BF_ASM — port the
   TS inline-asm C emitter (find it via `grep -rn asm src/codegen/`).
   Test: tests/asm.test.yo (13 arms, arch-conditional bodies; the batch main
   is hollow solely from the evaluate_asm stub throw at def time).

## asm — FIXED (TRUE GREEN 13/13 = TS): full two-part port

1. `yo-self/evaluator/builtins/asm.yo`: full port of asm.ts (829 lines) over
   the stub — operand parsing (in/out/lateout/inout/inlateout/ref alias/
   const_val/sym, named + explicit-register + raw() constraints, discard,
   variable-target incl. UNINITIALIZED vars manually annotated), clobber
   validation, asm_options, return-type inference (noreturn → enclosing fn
   return; multi-out → positional-label Tuple), duplicate-name + placeholder
   validation (hand-rolled scanner replacing the TS regex).
2. `yo-self/codegen/exprs/asm.yo` (new, 1:1 with codegen/exprs/asm.ts):
   constraint resolution tables, {N}/{name}/{name:mod} → %N/%[name]/%<mod>
   template transform, const_val inline substitution, out/inout/discard temp
   emission, GCC **asm** statement assembly, noreturn \_\_builtin_unreachable,
   tuple return literal; clobber_abi expansion per arch. Wired into
   generation.yo (replacing the TODO markers) + `-masm=intel` plumbed
   through a codegen-utils global into main.yo's cc invocation
   (mirrors codegen/index.ts:580-583).

Port lessons (recorded in the syntax cheatsheet too):

- **StrLit.raw keeps the quote delimiters**: every comptime-string read must
  decode_str_lit_escapes + strip delimiters, or operand names/"templates"
  silently mismatch ({result} vs "result" — the arm-4 hollow).
- **A backtick literal WITHOUT interpolation is a `str`**: String.from()
  on it fails the def-time check with a misleading location.
- FnCall pattern is `(id, func, args, is_infix, token)` — `.FnCall(f, ...)`
  grabs the ID.

Gates: TIER 1 clean, FIXPOINT_HOLDS (stage2 hollow=0), sweep
**174 GREEN / 10 HOLLOW / 1 RED** — asm GREEN 13 passed = TS exactly,
zero regressions.

## type_reflection — root LOCATED + scoped (markers 24 → 1 under the asm-port binary)

Under sh86 the file is down to ONE hollow marker: the batch-main def trial
dies at prelude:6260 `__yo_type_get_info(self)` with
"**yo_type_get_info: unsupported type variant" (probe **DBG_F). yo-self's
`evaluator/builtins/type_fns.yo` variant switch covers everything EXCEPT
the four TS arms **Function / Trait / Dyn / SomeType**
(type-fns.ts:849-928; the def-trial `self` is a SomeT, so the SomeType arm
is what unblocks the batch main).

Port infrastructure already exists (\_ti_bind_type, \_ti_eval_code,
\_ti_bind_comptime_list, \_ti_bind_type_field_list). Needed helpers
(type-fns.ts:965-1360): bindTempTraitInfoList (req/neg lists → TraitInfo),
bindTempFunctionInfo (+ ParamInfo/ForallParamInfo/ImplicitParamInfo
lists), bindTempTraitFieldInfoList, bindTempTraitKind (Normal/Fn/Future).

HAZARD for the Function arm: the test asserts per-param `is_comptime` and
`is_variadic` (arms at test:202-223), but yo-self's FuncMeta carries
NEITHER — they live in expr-id-keyed side tables (get_func_param_comptime,
get_func_variadic_param, evaluator/types/function.yo), unreachable from a
bare TypeValue.Func. Same side-table-vs-type-carried divergence class as
the F-era family. The SomeType/Dyn/Trait arms have no such gap — land
those first (they may alone flip the file if the test's Function arms
were among the 24 pre-shrunk markers — re-measure per arm after).

### type_reflection — 4 TypeInfo arms LANDED (no flip yet); variadic gap is the blocker

Ported into evaluator/builtins/type_fns.yo (gated TIER 1 clean +
FIXPOINT_HOLDS + sweep 174/10/1 zero-regression):

- SomeType(name, req, neg, resolved) — resolved via the lineage cell.
- Dyn(req, neg); Trait(fields, kind) across yo-self's THREE trait variants
  (TraitT → Normal with TraitFieldInfo list, is_assoc = label ∈
  assoc_type_names; FnTraitT → Fn(FunctionInfo) from the flattened call
  signature; FutureTraitT → Future(output, effects)).
- Function(FunctionInfo) with ParamInfo/ForallParamInfo/ImplicitParamInfo
  lists + helpers (\_ti_bind_trait_info_list, \_ti_build_param_info,
  \_ti_bind_function_info, \_ti_bind_trait_field_info_list).

Remaining def-trial failure (probe sh89): "ComptimeList index out of
bounds in \_\_yo_comptime_list_get" at prelude:5816 — the test reads
`fi.params.get(usize(1))` (the VARIADIC param), but yo-self's
TypeValue.Func does NOT carry the variadic parameter (label/type live in
the get_func_variadic_param side table keyed by fn-type EXPR ID). TS
carries variadicParameter ON FunctionType and appends it to params
(type-fns.ts:1134). FIX (own round, wide but mechanical): extend FuncMeta
with `variadic_label : Option(String)` + Func with the variadic type (or
a meta pair), populate at fn-type creation from the side table, append in
\_ti_bind_function_info with is_comptime=true/is_variadic=true. Also
re-measure the OTHER 23 markers after (they may be downstream of the same
def-trial abort).

### type_reflection — FIXED (TRUE GREEN 35/35 = TS): Func-variant variadic extension

The FuncMeta/Func extension landed (the recorded "own round, wide but
mechanical" step): `FuncMeta.variadic_label : Option(String)` +
`variadic_comptime : bool` (FuncMeta cannot reference TypeValue — declared
first, no forward refs — so the TYPE rides in a new trailing
`Func.variadic_types : ArrayList(Self)`, 0-or-1). 27 TypeValue.Func
constructor sites + 3 positional patterns + 21 FuncMeta constructions
updated mechanically; substitute() recurses into variadic_types; the
intern key renders them + the two meta fields; the fn-type mint
(evaluator/types/function.yo) populates all three from params_result
(HOISTED locals — a cond() inside a struct-literal argument trips
"Frame level N has different number of values for different cases").
\_ti_bind_function_info appends the variadic ParamInfo exactly as TS
(type-fns.ts:1134). Batch main real; 24 residual markers sit in
UNREFERENCED emitted fns (same GREEN-with-markers class as
algebraic_effects).

Gates: TIER 1 clean, stage2 markers 0, FIXPOINT_HOLDS, sweep
**175 GREEN / 9 HOLLOW / 1 RED** — zero regressions.

## CONVERGENCE (2026-08-01, post-175/9/1): the remaining hollows are ONE family

Probed under sh91 (\_\_DBG_F): prelude arm 1 dies at `assert(x.is_ok())` with
"Expected bool / Given unit" where `x := EvenNumber.try_from(i32(4))`;
option_result_combinators arm 3 dies at `assert(result.is_some(), ...)`
where `result := some_val.and_then(x => ...)`. Both are the SAME symptom
as iter_filter_closure's `filtered.next() → unit`: **a def-trial method
call on the RESULT of a generic/trait-method call returns unit** — the
result's stamped type is an era clone / unresolved instance on which the
next method dispatch silently misses. That is the SAME
instantiation-era-identity root as the parked F-era trio and the
where_clause RED. Likely also covers imm_map ("era pairs") and
higher_kinded_types. The remaining independent hollows are only
basic/fn/async_await's bisected arms.

NEXT PROBE (the family's decisive round): instrument the METHOD-DISPATCH
MISS — find where a `x.method()` call falls through to a unit stamp when
the receiver type has no method entry (property_access.yo / calls
dispatch), and print the receiver's type + id there. Run on
option_result_combinators arm 3 (the smallest: Option(i32).and_then). The
receiver's actual type tells whether the fix is (a) resolve the era clone
to the memo instance at the CALL-RESULT stamp, or (b) make method lookup
follow the ctor-fid channel (get_type_trait_methods keyed by definition
identity, like the enum-cfid fix in the synthesizer). Then re-check ALL
of: prelude, option_result_combinators, iter_filter_closure,
iterator_combinators, imm_map, higher_kinded_types, where_clause RED with
the one fix.

### Family probe CONFIRMED (sh92): method registry misses the era-clone id

`__DBG_MD miss method=is_some recv=<enum:enum_yo_id_2446> id=enum_yo_id_2446`
at option_result_combinators arm 3: the result of `some_val.and_then(...)`
is stamped with a def/spec-era Option instance id that has NO entries in
the type-trait-methods registry (methods were registered under the memo
instance's id). `_try_find_receiver_method` returns None → the call
degrades to unit → `assert(unit)` kills the batch main.

FIX DESIGN (the family's decisive round — execute in
`get_receiver_methods_by_name_from_env` / env.yo, the central lookup):
on a zero-hit lookup for an EnumT/Struct receiver, translate by
DEFINITION identity + era-equality:

1. cfid := lookup_enum_cfid(recv_id) (enums) / lookup_struct_ctor_fid
   (structs); bail if empty.
2. Candidate sibling ids: scan g_enum_cfids (value.yo) for ids with the
   same cfid (add a small reverse-scan helper; the table is append-only).
3. For each candidate: resolve id → TypeValue via the enum-final registry
   (resolve_enum_shell / register_enum_final channel) and require
   ERA-EQUALITY with the receiver (the \_ctfe_types_era_equal enum arm:
   same cfid + pairwise era-equal variant FIELD lists) — this is what
   keeps Option(i32) from borrowing Option(String)'s methods.
4. On the first era-equal sibling with method entries, use them.
   NOTE: this does NOT use the global SomeT resolution registry (the channel
   that poisoned F-era attempts 3-4) — identity comes from cfid + structural
   era-equality only. Probe stays: \_\_DBG_MD in calls/function.yo (strip
   before landing). Re-measure after the fix: option_result_combinators,
   prelude, iter_filter_closure, iterator_combinators, imm_map,
   higher_kinded_types, where_clause_fn_inference — the whole family.

### Family probe COMPLETE (sh92-sh96): the defect layer is the CALL-RESULT STAMP

Probe chain on option_result_combinators arm 3 (`result :=
some_val.and_then(...)`; `result.is_some()` → unit):

1. `is_some` dispatch misses: receiver `<enum:enum_yo_id_2446>` has no
   registry entries — and NONE of the 77 sibling Option instantiations
   have any either (`sibs=77`, all `methods=0`): Option's methods live in
   the GENERIC-IMPL registry only, never per-instantiation. (The
   era-sibling registry fallback built this round was therefore INERT —
   reverted per zero-wins.)
2. The generic-impl lookup IS reached; the prelude Option impl's entry has
   receiver pattern `<enum:enum_yo_id_2430>` (its own def-era instance);
   `try_match_generic_impl(2446, 2430)` MISSES with NO synthesis error —
   the miss is the ALL-BOUND check after synthesis: the receiver is
   `Option(B-SomeT)` — the and_then SPEC's return type stamped with B
   still abstract — so `T := B-SomeT` "stays abstract" and
   `_bind_forall_from_type_args` cannot help (EnumT carries no
   type_arguments).

CONCLUSION: every layer downstream behaves correctly; the defect is that
the CALL SITE stamps the spec's era/abstract return type instead of the
resolved (memo-instance) type. TS stamps the SUBSTITUTED return
(Option(i32)). This is the same core as the where_clause RED (whose
canonicalization fix DID work at that layer but was rejected for the
two-site partial-application regressions). The decisive round must fix
the ONE place the call result type is stamped after specialization
(calls/helper.yo's call-result stamp — where spec_ret_ty flows to the
call expr's ExprInfo), resolving B via the spec's OWN forall bindings
(arg unification), NOT the global channels. Then rerun the family:
option_result_combinators, prelude, iter_filter_closure,
iterator_combinators, imm_map, higher_kinded_types, where_clause RED —
with array.test.yo + for_macro_borrow.test.yo as the regression canaries.

### Family probe FINAL datapoint (sh97): the receiver is literally `Option(B)`

`__DBG_GI lookup recv=<enum:enum_yo_id_2446> somefield=B` /
`MISS pattern=<enum:enum_yo_id_2430> psome=T` — the and_then call result
was stamped with the DECLARED return `Option(B)` with B never bound. So
the defect is UPSTREAM of the stamp: **B-inference from the
`Impl(Fn(a : T) -> Option(B))` closure argument never ran (or failed
silently) during the call's param unification** — TS binds B in
callee_env by synthesizing the closure's actual type
`fn(x:i32) -> Option(i32)` against the Fn-trait constraint carried by the
Impl-SomeT wrapper, then the return re-eval reads B. Fix site: the
param-vs-arg unification step in calls/helper.yo where an Impl-wrapped
FnTraitT param meets a FuncVal/closure arg — the arg's RESULT type must
synthesize against the trait's `call_result` (FnTraitT.call_result =
Option(B)) in callee_env so `evaluate_function_return_type_again` resolves
B. Verify with: option_result_combinators arm 3 (Option(B)), prelude arm 1
(TryFrom — same shape via trait-method return), then the family + the
array/for_macro canaries. All probes reverted; tree clean at this commit.

### Family attempt (sh99): callee_env-by-NAME fallback in zs_ret — REJECTED (zero wins, zero regressions)

Adding a callee_env NAME lookup as a binding source in the zs_ret
occurrence-substitution did NOT resolve B (all six family files stay
hollow; array/for_macro canaries stay green — the change is SAFE, just
inert). Combined with the sh98 datapoint (param-side synthesis DID
resolve `f` to `Impl(Fn(i32) -> <enum:2444>)`), the B binding must live
in the env RETURNED by Step-6 synthesis (`synth.expected_env` →
`callee_env_r`) which does NOT alias the `callee_env` the zs_ret block
reads — OR B's binding is carried as a resolved-SomeT cell rather than a
TypeVal variable. NEXT PROBE (one build): at the zs_ret site, print
`get_variables_from_env(callee_env, "B").len()` AND the same against the
env used by evaluate_function_return_type_again; then thread whichever
env actually holds B into the zs fallback. The sh98 probe line to reuse:
`__DBG_S6 param=... arg=...` at Step 6 in helper.yo (param_label == "f").

### Family attempt (sh100): closure-body-type substitution in \_funcval_bind_foralls' structural fallback — REJECTED (inert, safe)

Porting helper.yo Step 5.5's recorded-body-type substitution into the
sp scratch-synthesis loop (function.yo ~1385) did not flip anything
(canaries stay green). Three inert attempts now bracket the failure:
B is not recoverable at (1) zs_ret via callee_env name lookup,
(2) the sp structural synthesis even with the body type substituted.
Combined with sh98 (param-side `f` resolves fully to
`Impl(Fn(i32) -> enum:2444)` at helper's Step 6), the divergence is that
the and_then call likely routes through the FuncVal-arm dispatch
(function.yo) whose spec call passes `fresh_env` — NOT through helper's
check_if_function_parameter_matches_argument path that bound B. The sh98
\_\_DBG_S6 line may have come from a DIFFERENT call site (its enum id 2444
differs from the stamped 2446!).

NEXT PROBE (must be INSIDE \_funcval_bind_foralls, gated fa_name=="B"):
print, per stage — pre-forall / name-match / structural fallback — whether
fa_bound flipped, plus `sp_ty_for_synth` (is the closure arg's ExprInfo
even a Func with a body type recorded?) and the se_vars lookup result.
Suspect (a): the name-match loop `ptn == fa_name` binds B WRONGLY from a
param-type-name coincidence before the structural stage runs; suspect
(b): get_closure_body_type is empty at def-trial (the closure body wasn't
def-time evaluated yet when and_then's args were checked — an ORDERING
issue, in which case the fix is to trial-eval the closure arg's body
before the forall binding, as TS does contextual typing at check time).

### Family probe (sh101): \_funcval_bind_foralls NEVER RUNS for B — wrong path entirely

Staged probes inside \_funcval_bind_foralls (fa_name=="B") produced ZERO
output on the orc3 subset: the def-trial `some_val.and_then(...)` call
does not route through the FuncVal-arm forall binding at all. Combined
with sh98 (a \_\_DBG_S6 "f" synthesis that fully resolved — evidently a
DIFFERENT call/arm, its enum id 2444 ≠ the stamped 2446), the call is
being typed by some path that stamps the DECLARED return directly
(candidates: the def-trial non-executing method-call arm in
calls/function.yo around `_call_result_unknown(call_result_m.return_type,
...)`, or a trait-default dispatch in property_access/helper that skips
specialization when is_executing=false).

NEXT PROBE: at the method-call stamp (function.yo ~5460-5495, the out_m
block), print — gated on the method name being "and_then" — which
call_result_m.return_type arrives AND which internal path produced
call_result_m (tag the FuncCallResult construction sites). Then make THAT
path run the forall inference (or route it through the FuncVal arm).
Every prior fix attempt patched paths the call never takes — this probe
finally identifies the real one.

### Family ROOT CAUSE FOUND (sh104–sh107 probe ladder): two unported TS mechanisms

The probe chain ended at `try_to_call_function_with_arguments` Step 9 and then
walked BACKWARDS to the actual cause. Measured facts, in order:

| probe            | output                                                                                             | reading                                                                                                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sh104 `__DBG_S9` | `unresolved-ret fid=yo_id_2447 ty=<enum:2446> rte=y`                                               | the return-type EXPR side-table IS populated; the rescue re-eval is not the gap                                                                                                                                                                                                                     |
| sh105 `__DBG_SA` | `st nm=B id=1000 fl=3 cell=0 res=B nvars=2`                                                        | `B` is UNBOUND in `callee_env_m`, and its shared `resolved_concrete` cell is EMPTY                                                                                                                                                                                                                  |
| sh105 `__DBG_SB` | `rte-eval produced ty=<enum:5942> somes=1`                                                         | the rte re-eval mints a FRESH instance that still carries `B` — consistent with "B unbound", not with "wrong expr"                                                                                                                                                                                  |
| sh107 `__DBG_SC` | `var[0] fl=1 slot=B slot_id=1000` / `var[1] fl=1 slot=B slot_id=1000`                              | both `B` bindings are the SELF-BOUND markers in the call's own top frame; nothing ever rebound them                                                                                                                                                                                                 |
| sh107 `__DBG_S6` | `f pt_some=y ntraits=1 t0=Fn(i32) -> <enum:2444> as_fn=n argsynth=Impl : (Fn(i32) -> <enum:2444>)` | **the discriminator**: the closure argument TOOK ON the expected `Impl(Fn(a : T) -> Option(B))` wrapper, so the given side is a SomeT — not a `Func` — and synthesizer.yo:1349's `is_fn_trait_type(exp_trait) && is_function_type(given_ty)` guard skips the Fn-trait recursion that would bind `B` |

TS has the SAME take-on behaviour (anonymous-function.ts:1183-1252) and the SAME
id-equality skip (synthesizer.ts:386) — it binds `B` somewhere else entirely,
in two steps yo-self had never ported:

1. **anonymous-function.ts:992-1015** — after the closure body is evaluated,
   when the declared return CONTAINS type variables but is not itself one
   (the comment there literally names `Option(B)`) and the body type is fully
   concrete: `synthesizeTypes(declaredReturn, bodyType, [], {setResolvedConcreteType: true})`,
   then `functionType.return.type = newFunctionType.return.type = bodyType`.
   The synthesis exists purely for its side effect — stamping
   `B.resolvedConcreteType = i32` on the SHARED SomeType object.
   `anonymous_function.yo` did not call `synthesize_types` AT ALL.
2. **helper.ts:1464-1494** — after the argument loop, for every forall label
   whose calleeEnv binding is still a SomeT that now carries a
   `resolvedConcreteType` (and has NO trait constraints), REPLACE the binding
   (`updateExistingVariable`, value `[concreteTypeValue]`). TS's own comment:
   "Without this, evaluateFunctionReturnTypeAgain would re-evaluate the return
   type and still see T as SomeType instead of i32." yo-self had ported only
   the _extraction_ half of this (into `forall_arg_vals`), never the env
   write-back.

Independently corroborated by an instrumented TS run (probes at helper.ts:385/
392/621/1470/1486/1538, anonymous-function.ts:758/1004, synthesizer.ts:244/457/
727/746, then reverted): counterfactually disabling synthesizer.ts:463 makes TS
report `returnType=Option(B)` — i.e. TS reproduces yo-self's bug exactly.

Why `Option.map` works and `Option.and_then` does not: `map`'s parameter is
`Impl(Fn(a : T) -> B)` whose Fn-trait RESULT is a bare SomeT, so yo-self's
take-on gate (`w_has_concrete_fn`, anonymous_function.yo) declines and the
closure keeps its `Func` type → the Fn-trait recursion runs. `and_then`'s
result `Option(B)` is an EnumT, which the shallow gate reads as concrete.

**Port landed (yo-self side):** `_synth_nested_return_somes` +
the return rewrite in `anonymous_function.yo`, and the cell-sourced env
write-back at helper.yo Step 8 (restricted to the CELL channel — never the
global id registry — and to a binding in the call's OWN top frame, so it pops
with the frame instead of becoming a durable write-through).

sh108 (parts 1+2 only) measured: `__DBG_BB bind B src_id=1000 ty=i32` — B is
bound, `__DBG_S9` stops firing, and the specialization key becomes
`…rtparam0_enum_yo_id_4475_i32…ret_enum_yo_id_4475_i32` (the canonical
`Option(i32)` memo instance). It then aborted in yo-self's own codegen:
`get_type_string: no C type name found for <enum:enum_yo_id_2444> (key=enum_yo_id_2444_1000)`
— resolving `B` by SUBSTITUTION keeps the def-era enum id, so the closure's
left-in-place `Option(B)` reached lowering uncollected. That is exactly what
TS's third statement (`functionType.return.type = bodyType`) prevents, so it
was ported too (sh109).

### Family layer 2 (sh115–sh119): the port is FOUR statements, not two

The two unported mechanisms above are necessary but not sufficient. Each extra
layer was pinned by turning yo-self's own codegen panic into a locatable
marker — `_lookup_named_c_type` returning `"__yo_MISSING_TYPE"` instead of
`__yo_panic` (probe only, reverted), which put the defect on ONE C line:

```
__yo_MISSING_TYPE _file____User_temp_6631 = closure_yo_id_5937(&(f), value);
```

so every later step measured a specific type rather than guessing. The four
statements TS executes, and where yo-self needed each:

1. **anonymous-function.ts:1004** — synthesize declared-return-vs-body for the
   nested type variables. yo-self: `_synth_nested_return_somes`, bound in the
   call's own callee env (`ctx.expected_type.env`) rather than through
   `set_resolved_concrete_type`. **The identity channels are WRONG here**: a
   prelude signature's `B` is ONE instance shared by every call (TS mints a
   fresh `B` per call at helper.ts:1047), so stamping the lineage cell / id
   registry made arm 6 (`and_then(x => Option(String).Some(…))`) inherit arm 3's
   `B := i32` — measured as a specialized `and_then` declared `-> Option(i32)`
   whose closure returned `Option(String)` (C: `initializing '__yo_t13' with an
expression of incompatible type '__yo_t8'`). Routing through the env is
   per-call by construction and needs no write-back at Step 8.
2. **anonymous-function.ts:1012** — `functionType.return.type = bodyType`.
   Load-bearing for codegen, not tidiness: resolving `B` by SUBSTITUTION keeps
   the def-era enum id, so a left-in-place `Option(B)` reaches lowering as an
   instance that was never collected. The body type is the CANONICAL memo
   instance.
3. **the same statement, seen through the PARAMETER type** — TS's
   `functionType` IS the parameter type's `isFn.callType` object, so the write
   also updates `f`'s declared type (TS's own trace: "this is why helper.ts's
   parameterType itself prints Option(i32) after the arg evaluation"). yo-self
   values can't alias, so `_refine_wrapper_fn_result` re-applies it to
   `resolved_pt`, `arg_type`, and `arg_info.ty` (the last is what codegen reads).
4. **the specialization's closure-param rebind** (helper.yo, mint): it rebuilt
   the wrapper SomeT from `func_type`'s PRISTINE declared param type, undoing
   (3) inside the spec body — `f` measured as `Impl(Fn(i32) -> <enum:2444>)` at
   the body eval. Now prefers the call's `ArgEntry.parameter_type`.

**Measured with all four (probe-free /tmp/s1fam2):** the arm-level scan of
tests/option_result_combinators (`scratchpad/arm_scan.sh` over per-arm subsets)
goes to **52/54 arms clean**; `tests/array` + `tests/for_macro_borrow` (the
era-identity canaries) stay green; `check ./yo-self` stays 295/305 (identical to
HEAD — the 10 are the known-heavy files).

**Still blocked — the next layer:** arms 4 and 53, the only two that fail, are
both a closure whose BODY IS A `cond` returning the generic type
(`x => cond(x > 100 => Option(i32).Some(x*2), true => Option(i32).None)`). There
the closure's body type measures as the DECLARED `Option(B)` (probe:
`__DBG_NR fid=closure_yo_id_5937 ret=<enum:2444> body=<enum:2444> bconc=false`),
so layer 1's gate correctly declines and `B` is never bound. Probes placed at
ALL THREE `result_ty` sites in `evaluator/exprs/cond.yo`, and at the
`adopt_receiver_struct_instance` exit in `evaluate_function_return_type_again`,
produced NOTHING for this shape — so the generic type is NOT coming from the
cond's own typing nor from receiver adoption. **NEXT PROBE:** print the body
node's kind + `ast_expr_to_string` alongside `nrs_body_ty` at the
`_synth_nested_return_somes` gate, to identify which node in
`begin(cond(...))` carries `<enum:2444>` — the begin takes `last_info.ty`
verbatim (begin.yo:1953/2247, no coercion), so one of the two must be recording
it, and the cond probes rule the cond out only for the paths that record a
SomeT-CONTAINING `result_ty`.

The other family files do NOT share this root: an arm-level scan shows
tests/prelude blocked by arms 1 (TryFrom/TryInto) and 3 (MaybeUninit), and
tests/iter_filter_closure blocked in ALL THREE arms — separate roots, to be
scoped individually.

### Family layer 3 (arms 4 & 53) — SCOPED, root NOT yet located

The two remaining orc arms are a closure whose body is a `cond` returning the
generic type. Measured: the closure's body type equals the DECLARED return
EXACTLY (`ret=<enum:2444> body=<enum:2444> bconc=false`), so layer 1's
concrete-body gate correctly declines and `B` stays unbound for this shape.

Ruled OUT by probes (all negative — do not re-investigate):

- the three value-path `result_ty` sites in `evaluator/exprs/cond.yo`
  (:362/:397/:678) — a probe gated on `type_contains_some_type(result_ty)`
  printed NOTHING for this shape;
- `adopt_receiver_struct_instance` at the exit of
  `evaluate_function_return_type_again` — a probe gated on "adoption introduced
  SomeTs" printed NOTHING;
- the all-arms-control-flow branch (cond.yo:713) — its return-bodies-first
  precedence IS faithfully ported (TS cond.ts:502-503), and arm 4's arms carry
  no `return` anyway.

`begin` is a pass-through here (`return_type := last_info.ty`, no coercion —
begin.yo:1953/2247; and for a single-expression body the begin SHARES the inner
node's id and re-records that same type, begin.yo:2264-2284). So the generic type
is recorded by whichever node `anon_eb` resolves to, through a path none of the
above covers.

**NEXT PROBE:** at the `_synth_nested_return_somes` gate
(`values/anonymous_function.yo`), print `ast_expr_to_string(anon_eb)` (truncated)
plus `ast_expr_id(anon_eb)`, and — when `anon_eb` is a `begin` FnCall — the id
and ExprInfo type of its LAST arg. That distinguishes "the cond really is typed
`Option(B)` by a fourth path" from "`anon_eb` is not the node I assume".

### Family layer 3 SOLVED: `type_contains_some_type` was never made recursive

Arms 4 and 53 (a closure whose body is a `cond` returning the generic type) were
NOT a cond-typing bug and NOT a receiver-adoption bug — the seven
`expr_info_table_set` sites in `evaluator/exprs/cond.yo` and the
`adopt_receiver_struct_instance` exit all probed NEGATIVE. The probes were
VACUOUS, and that was the clue: they were gated on
`type_contains_some_type(...)`, which is exactly the predicate the cond's own
expected-type adoption is gated on.

`yo-self/types/utils.yo`'s `type_contains_some_type` is **TOP-LEVEL ONLY** — it
answers for a bare `SomeT` / `TypeAppT` and returns `false` for every composite.
TS's `typeContainsSomeType` (src/types/utils.ts:477-566) recurses through Array,
Tuple, Struct, **Enum variant fields**, Union, Function and Ptr. So for
`Option(B)` yo-self answered "no SomeTypes here", and the cond's guard
`!type_contains_some_type(expected)` — a direct port of TS cond.ts:225-227 /
263-265, which calls the RECURSIVE one — let the cond ADOPT the generic expected
type. The closure's body type then came out as its own declared `Option(B)`,
layer 1's concrete-body gate declined, and `B` was never bound.

yo-self already carries the faithful predicate: `type_contains_some_type_deep`
(same file, reuses `get_all_some_types` for the recursion and
`type_contains_some_type` for TS's extern / resolved-concrete / Impl(Fn) /
Impl(Future) carve-outs). Its doc says it is deliberately NOT swapped in
everywhere — but the three cond adoption guards are precisely the sites where TS
uses the recursive semantics, so they are now `_deep`.

**Measured:** tests/option_result_combinators goes to **54/54 arms clean** and
the file is back to `rc=0` (the C-level failure introduced by making the earlier
layers work is gone).

### option_result_combinators — remaining hollow is a DIFFERENT, PRE-EXISTING root

With every arm individually clean the FILE is still hollow. Bisected to a
minimal pair: **arms 17 + 18** — two `map_or_else` calls (the only two-closure-
parameter method in the file), on `Some` and on `None`. Either arm ALONE is
clean; together they hollow. Verified pre-existing: the same pair hollows under
the PRE-FIX binary (/tmp/sh104), so this is not a regression from the family
work.

**Characterized (probe: un-silenced `_trial_eval_fn_body`'s swallow in
`evaluator/calls/function_type.yo`, reverted).** The batch main's def-time eval
dies on:

```
Cannot unify incompatible types:
Expected: "bool"
Given: "unit"
  … (result == i32(0)) …   ← the SECOND map_or_else call's result
```

i.e. the second call's RESULT TYPE is `unit` — the "method dispatch found
nothing, so the call degrades to unit" signature this campaign has hit before
(`_try_find_receiver_method` returning None). Two further measurements pin it:

- **It is always the SECOND call, whichever it is.** Swapping the two arms
  (None first) moves the failure to the other arm — the `Some`/`None` receiver
  shape is irrelevant.
- Either arm ALONE is clean, and the pair hollows under the pre-fix binary
  (/tmp/sh104) too — so it is order-in-the-file, not the family work.

So a per-call artifact of the FIRST `map_or_else` call is being reused by the
second and makes its dispatch (or its result stamp) fail. Candidates, in the
order worth probing: the specialization cache entry (both calls share receiver
`Option(i32)`, `B := i32` and two same-shaped closure params — only the closure
IDS differ, so check whether the key collapses them), the generic-impl match
memo, and the mint's `register_some_resolved_concrete(closure_some_id, cap_ty)`
on the SHARED declared SomeT id (the code's own comment documents "the LAST
specialization wins globally" for the single-closure case — the arc/prelude
capture-split repro). Probe recipe: in `_try_find_receiver_method`, print the
receiver type key + `hits.len()` gated on the method name being `map_or_else`,
for BOTH calls.

Minimal repro kept at `/tmp/pair1718.test.yo` (regenerate with
`python3 scratchpad/subset_arms.py tests/option_result_combinators.test.yo 17,18 <out>.test.yo`).

### map_or_else pair — attempt 1 REJECTED (bare-SomeT return binding; zero wins, reverted)

Probes (both reverted) narrowed the second-call failure precisely:

- `_try_find_receiver_method` prints `hits=1` for BOTH calls with the same
  receiver key `enum_yo_id_4475_i32` — **dispatch is fine**, the method is found
  each time. (Earlier theories about registry/dispatch poisoning are dead.)
- The specialization-cache probe shows the two calls arrive with DIFFERENT
  runtime param types for the FIRST closure parameter (`default_fn`):
  - call 1 `rts=|enum_yo_id_4475_i32|fn() -> B|1017`
  - call 2 `rts=|enum_yo_id_4475_i32|1016|1017`
    i.e. call 1's `() => i32(0)` still types as a plain **`Func` with an
    unresolved `B` return**, while call 2's TAKES ON the `Impl(Fn() -> B)` wrapper
    (`1016`). Both calls are cache MISSES, so it is not spec reuse.

That asymmetry is the whole phenomenon: with a plain `Func` the call's Step-5.5
closure-body-type substitution fires and binds `B`; with the wrapper it does
not. The take-on gate flips between the two calls because the wrapper's Fn-trait
result is resolved by then (`_resolve_some_types_deep` registers each resolution
into the GLOBAL `g_some_resolved_concrete` on the way).

**Attempt 1 (rejected):** extend the closure-return synthesis
(anonymous_function.yo) to the BARE type-variable shape — TS
anonymous-function.ts:965-988, which is genuinely unported — so `-> B` binds
like `-> Option(B)` does. Built and measured: the pair STILL hollows, unchanged.
Reverted per the zero-wins rule. So the missing binding for call 2 is NOT the
closure's own return unification; look instead at what the take-on path does to
`default_fn`'s ARG type before Step 6 (the wrapper's own Fn-trait result is
already `-> i32` by then, so synthesis has nothing left to bind `B` FROM — the
binding must come from the wrapper's resolved result, i.e. a
`synthesize(Impl(Fn() -> B)declared, Impl(Fn() -> i32)arg)` that yo-self skips
because both sides are SomeTs with the SAME id, synthesizer.yo:1290's
id-equality branch).

**NEXT:** print, for call 2's `default_fn` param, the DECLARED param type and
the ARG type side by side at Step 6 (helper.yo). If declared is
`Impl(Fn() -> B)` and arg is `Impl(Fn() -> i32)` with the same wrapper id, the
fix is to let the same-id branch still recurse through the Fn-trait when the two
carriers' results DIFFER (TS's `expected.type.id !== given.type.id` guard exists
only to skip a pure self-match; a resolved-vs-unresolved pair is not one).

## option_result_combinators — TRUE GREEN (54/54 = TS); score 175 -> 176 GREEN

Root (attempt 2, LANDED `bd04feafe`): `g_some_resolved_concrete` is a DURABLE
global keyed by SomeT id, but a function's own `generic(B : Type)` binder is not
durable — TS mints a fresh SomeType for it on every call (helper.ts:1047-1053).
yo-self reuses the one signature instance, so call 1's `B := i32` survived into
call 2, whose parameter `Impl(Fn() -> B)` then pre-resolved to
`Impl(Fn() -> i32)` via `_resolve_some_types_deep`'s registry fallback. A
concrete Fn-trait result flips the closure argument onto the TAKE-ON path, which
skips the Step-5.5 closure-body-type substitution that binds `B` — so the second
call's return stayed unbound and the statement typed `unit`.

Fix: `unregister_some_resolved_concrete(id)` (expr_info.yo), called from the
Step-6 forall-placeholder loop in helper.yo for each signature SomeT whose name
is the binder being installed. The call that installs the placeholder OWNS that
binder.

Sweep after: **176 GREEN / 8 HOLLOW / 1 RED**, exactly one file changed class.

**Generalizable lesson for the remaining hollows:** any durable id-keyed side
table that mirrors a TS field which TS re-creates per call is a cross-call
poisoning channel. Before blaming dispatch or the spec cache again, check
whether the SECOND occurrence of a construct behaves differently from the FIRST
(run the arms individually AND in pairs — that asymmetry is the cheapest
signal in this whole campaign).

## iter_filter_closure — root LOCATED (all 3 arms, one root): `.next()` on the returned IterFilter finds ZERO methods

Swallowed def-time error (probe: un-silenced `_trial_eval_fn_body`, reverted):

```
Expected enum type or primitive type (integer, bool) for match expression, got unit
  … match(result, .Some(v) => …)   ← `result := filtered.next()` typed UNIT
```

Dispatch probe at `_try_find_receiver_method` (reverted) gives the whole chain:

```
__DBG_IH filter recv=CountIter                 hits=1
__DBG_IF filter ret=<struct:struct_yo_id_2933> out=<struct:struct_yo_id_2933>
__DBG_IH next   recv=<struct:struct_yo_id_2933> hits=0      ← the defect
```

So `iter.filter(x => …)` is fine and returns the `IterFilter` instance 2933;
`.next()` on THAT instance resolves to **no method at all**, so the call
degrades to `unit` and the enclosing `match` throws. `next` for
`IterFilter(I, F)` comes only from the blanket `impl(IterFilter(I,F),
Iterator(...))`, so the failure is in the generic-impl fallback of
`get_receiver_methods_by_name_from_env` (env.yo) → `try_match_generic_impl`
(values/impl.yo) for that receiver.

**Probe attempt 1 was VACUOUS — do not repeat the gate.** Probes were placed at
all three failure exits of `try_match_generic_impl` (the `_root_shapes_could_match`
prefilter, the synthesis-failure handler, and `all_bound = false`) gated on the
receiver PATTERN being a struct NAMED "IterFilter". They printed NOTHING, which
looked like "try_match is never reached" — but `IterFilter` is a comptime
function returning an ANONYMOUS `struct(_inner : I, _f : F)` (std/prelude.yo:7829),
so the pattern's struct name is empty and the gate could never fire. (Consistent
with the dispatch probe printing the receiver as a bare
`<struct:struct_yo_id_2933>` with no name.) Nothing was learned about whether the
impl is reached; the earlier "never called" reading is withdrawn.

**NEXT PROBE (corrected gate):** gate on the receiver pattern's
`constructor_func_id` matching the `IterFilter` comptime fn, or structurally on
its field labels being exactly `_inner` + `_f` — NOT on the struct name. Then
print, at each of the three exits, which one fires; and in the `all_bound` loop
print each forall (`I`, `A`, `F`) with whether `_resolve_one_forall_binding` or
`_bind_forall_from_type_args` supplied it.

Also worth checking in the same run, since it is upstream of try_match: the
`has_field_with_name` pre-filter in `find_methods_from_generic_impls`
(values/impl.yo) skips any entry whose `field_names` lack the method name — print
the field_names of the entry whose pattern is the IterFilter struct to confirm
`next` is actually there. And note this impl carries TWO where-clauses
(`I <: Iterator(Item := A)`, `F <: Fn(item : *(A)) -> bool`) while its receiver
pattern is a STRUCT, so the where-clause enforcement block in
`try_match_generic_impl` (gated on `is_some_type(pattern)`, i.e. blanket impls
only) deliberately does NOT run for it — that gate is a documented yo-self
adaptation, worth re-reading before suspecting it.

### iter_filter_closure — ROOT PINNED: the forall `A` is where-clause-only and never bound

With a WORKING structural gate (the pattern is an anonymous `struct(_inner, _f)`,
so match on the field labels, never the name) the chain is fully measured:

```
__DBG_IG  entry pattern=IF hasfield=true fields=,Item,next recv=<struct:2933>
__DBG_IG    try_match=false
__DBG_IG2 UNBOUND forall=A some=A
__DBG_IG2 after-bindings all_bound=false nbind=1
```

The prelude impl (std/prelude.yo:7832) is

```rust
impl(
  generic(I : Type, A : Type, F : Type),
  where(I <: Iterator(Item := A), F <: (Fn(item : *(A)) -> bool)),
  IterFilter(I, F),                      // = struct(_inner : I, _f : F)
  Iterator(Item : A, next : …)
)
```

`A` appears NOWHERE in the receiver pattern — it is determined ONLY by the
where-clauses. So both binding sources yo-self has fail by construction:
`_resolve_one_forall_binding` (nothing structural to unify) and
`_bind_forall_from_type_args` (the instance's type_arguments are `[I, F]`). The
all-bound check then rejects the impl, `.next()` finds zero methods, and the call
degrades to `unit`.

**TS's mechanism, verbatim (src/evaluator/values/impl.ts:2418-2435), and its
comment names this exact case:**

```ts
// Use the full typeImplementsTrait (not Bool) so that bindings produced
// during trait satisfaction (e.g. synthesizing `A=i32` from
// `F <: Fn(item:A)->B` against `fn(item:i32)->i32`) are propagated back
// into expectedEnv.  This is necessary for generic params that are only
// constrained through where-clauses (not struct fields) to appear in the
// final substitutions map …
const { implemented, env: afterConstraintEnv } = typeImplementsTrait({
  targetType: boundType,
  traitType: actualConstraintTrait,
  env: expectedEnv,
});
if (!implemented) return noMatch;
expectedEnv = afterConstraintEnv; // ← this is what binds A
```

TS runs the where-constraint check for EVERY impl, threads `expectedEnv` through
`typeImplementsTrait`, and takes the RETURNED env — so satisfying
`I <: Iterator(Item := A)` against `CountIter` binds `A := i32`. It also
re-evaluates the constraint's trait EXPRESSION in that env first (impl.ts:2355-
2377), which is how `Iterator(Item := A)` becomes `Iterator(Item := i32)`.

**Two yo-self gaps to close (next round, in this order):**

1. `try_match_generic_impl`'s where-clause block is gated on
   `is_some_type(entry.receiver_type_pattern)` — BLANKET impls only (a
   deliberate, documented adaptation because yo-self's trait-implements
   predicate is incomplete). `IterFilter(I, F)` is a struct pattern, so the
   block never runs and no constraint can ever contribute a binding.
2. yo-self's hook is `g_type_implements_trait_fn`, a BOOL predicate — it has no
   env to propagate. Porting TS faithfully needs an env-returning variant (or a
   narrower first step: for a where-constraint whose trait carries an
   associated-type binding `Item := <forall SomeT>`, read that associated type
   off the bound receiver's impl and bind the forall from it).

Order the work as: add the binding source (2) as a THIRD fallback in the
all-bound loop — leaving the existing where-ENFORCEMENT gating untouched, so no
impl newly starts being rejected — then re-measure. That keeps the change purely
additive, which is what the sweep can validate cheaply.

### iter_filter_closure — attempt 1 REJECTED (where-clause binding source; zero wins, reverted)

Implemented exactly the port sketched above and measured: all three arms STILL
hollow, so it was reverted per the zero-wins rule. What was built (recoverable
from this description — it is ~70 lines):

- `impl.yo`: a second hook slot `TypeImplementsTraitEnvFn = (t, trait, env) ->
Option(Environment)` (`Some(env)` = implemented, env carrying the bindings;
  `Option(Environment)` rather than trait_checking's `TraitCheckResult` because
  impl.yo cannot import that module), plus `set_type_implements_trait_env_fn`.
- `trait_checking.yo`: `_implements_env_adapter` wrapping the EXISTING
  env-returning `type_implements_trait` (`TraitCheckResult{implemented, env}`),
  wired in `_trait_checking_init`.
- `try_match_generic_impl`: a THIRD binding source in the all-bound loop, tried
  only after both structural sources fail, and only for a where-constraint whose
  trait carries THIS forall in `assoc_constraint_types` (`Item := A`): resolve the
  constraint's LHS (`I`) in `synth_result.expected_env`, call the env hook, then
  re-run `_resolve_one_forall_binding` in the RETURNED env.

Since the arms did not change at all, the next question is WHICH of the four
steps is the no-op. **NEXT PROBE (one build, four prints, all inside the new
`.None` branch):** (1) did the branch run — print `fa_name2` + the
where-constraint count; (2) for each constraint, whether
`assoc_constraint_types` mentions `fa_some2` (print both ids — the forall SomeT
in the ENTRY may be a different lineage copy than the one in the constraint
trait, which would make `_same_some_type_id` always false and is the most likely
culprit); (3) whether the LHS (`I`) resolved, and to what; (4) whether the hook
was set and what it returned. Note `_check_associated_type_constraints`
(trait_checking.yo:494) already does the real work and its doc comment even names
`tests/iter_filter_closure` — so the machinery exists and this is a plumbing
question, not a missing mechanism.

Also worth trying instead of id-matching: match the assoc-constraint type to the
forall by NAME (`A`), which sidesteps any lineage-copy mismatch.

**Yo syntax hazard hit while doing this** (cost one build): a python-inserted
helper whose text ended with the anchor line duplicated it —
`try_match_generic_impl :: (try_match_generic_impl :: (` — and the parser failed
with `undefined is not an object (evaluating 'tokens[index].type')`, i.e. an
unbalanced-delimiter run-off, NOT a message pointing at the duplication. `yo-cli
fmt <file>` reproduces it instantly and `check` reports a collapsed file count
(205/305) — run fmt on every python-patched file BEFORE a 9-minute build.

### iter_filter_closure — attempt 2 REJECTED, but it MEASURED the real root: the where-constraint is registered UNPARAMETERIZED

Re-applied the third binding source with NAME matching (the recorded suspicion
about lineage-copy ids) plus four diagnostics. All three arms unchanged, so
reverted again — but the diagnostics identify the actual defect, one level
upstream, and explain why NO binding source could ever have worked:

```
__DBG_W1 unbound forall=A nwc=1
__DBG_W1   wc[0] lhs=I natc=0 mentions=false
```

Two facts, both from registration, not from matching:

1. **`natc=0`** — the recorded constraint trait for `I <: Iterator(Item := A)`
   carries an EMPTY `assoc_constraint_types`. The `Item := A` argument is gone,
   so nothing links the constraint to the binder `A`.
2. **`nwc=1`** — only ONE where-constraint was recorded, though the impl declares
   TWO (`I <: Iterator(Item := A)` and `F <: (Fn(item : *(A)) -> bool)`). The
   `Fn(...)` one is dropped entirely.

Cause: `_collect_impl_where_constraints` resolves each constraint trait through
`_try_lookup_trait_type` (values/impl.yo), whose FAST PATH walks the expression to
its LEFTMOST ATOM (`Iterator`) and looks that bare name up in the env — returning
the UNPARAMETERIZED `Iterator` TraitT and discarding the `Item := A` argument.
The same path finds nothing for `Fn(item : *(A)) -> bool` (no atom-bound TraitT),
which is why that constraint vanishes.

TS does not have this problem because `whereConstraints` keeps the constraint
EXPRESSION (`traitExpr`) and re-evaluates it in the unify env
(src/evaluator/values/impl.ts:2355-2377), so `Iterator(Item := A)` becomes a
SPECIALIZED trait whose associated-type constraint is `A`; satisfying it then
binds `A` (impl.ts:2418-2435, the mechanism attempt 1/2 ported).

**NEXT ROUND — fix registration first, then re-apply the (already-written) third
source:**

1. In `_try_lookup_trait_type`, do NOT take the atom fast path when the trait
   expression is a CALL with arguments — evaluate the full expression in
   `forall_env` (where each forall name is bound to its SomeT) and record the
   resulting specialized `TraitT`. Keep the fast path for a bare atom.
2. Verify with the same diagnostics that `natc` becomes 1 and `nwc` becomes 2 for
   the IterFilter entry.
3. Re-apply attempt 2's third binding source verbatim (env-propagating hook slot
   in impl.yo + `_implements_env_adapter` over the existing
   `type_implements_trait`, which already returns `TraitCheckResult{implemented,
env}` + the `.None` fallback keyed on the constraint trait's
   assoc-constraint NAME). It is correct by construction; it simply had no data.
4. Gate: the arm scan, then the full sweep (this touches how EVERY generic impl's
   where-constraints are recorded, so a regression would be broad — measure
   before believing).

### iter_filter_closure — attempt 3: the REGISTRATION FIX WORKS (hollowing GONE); next blocker is closure-call emission

Applied both recorded steps together and measured. **The hollowing is
eliminated** — all three arms go `hollow=1` → **`hollow=0`**: the batch main's
def-time eval now succeeds, which means the blanket `Iterator` impl for
`IterFilter(I, F)` finally MATCHES and `.next()` resolves to a real method.

The two changes (reverted for now — see below, but they are RIGHT and should be
re-applied first thing next round):

1. **`_try_lookup_trait_type` (values/impl.yo) — the root.** Gate the atom fast
   path on the TRAIT EXPRESSION itself being an atom:
   `if(ast_expr_is_atom(trait_expr) && ast_expr_is_atom(head_expr), …)`.
   Previously any parameterized trait expr (`Iterator(Item := A)`) walked to its
   leftmost atom and returned the UNPARAMETERIZED `Iterator` TraitT, discarding
   the arguments. The slow path right below it already evaluates the full
   expression (that is yo-self's equivalent of TS keeping `traitExpr`) — the fix
   is simply to stop short-circuiting past it.
2. **The third binding source** in `try_match_generic_impl`'s all-bound loop,
   plus the env-propagating hook (`TypeImplementsTraitEnvFn` slot +
   `set_type_implements_trait_env_fn` in impl.yo, `_implements_env_adapter` over
   the existing `type_implements_trait` in trait_checking.yo), keyed on the
   constraint trait's assoc-constraint NAME matching the binder.

**Why it was reverted:** with the impl matching, emission proceeds and hits TWO
NEW failures downstream (arm0 `rc=1`, arms 1-2 SIGSEGV in the C compiler stage):

- `// Failed to transpile (self._f)(&(item))` — the CLOSURE-PARAM CALL inside the
  specialized blanket-impl body does not emit. This is precisely what this test
  file's own header describes ("closure-call dispatch through
  `implClosureCallMap` … both sides must walk the SomeType→concrete chain to its
  end so the same key is used in setter and lookup"), so start there.
- C type mismatches of the era-identity kind (`initializing '__yo_t21' with an
expression of incompatible type '__yo_t15'`) around the same body.

So the file's remaining distance is entirely in CODEGEN for the specialized
blanket-impl body, not in the evaluator's impl matching. Sequence for the next
round: re-apply (1) + (2), then fix the `implClosureCallMap` key/registration for
a closure param bound inside a SPECIALIZED generic-impl method, then re-measure
the arms, then gate with the full sweep (step (1) changes how EVERY generic impl's
where-constraints are recorded — a regression there would be broad).

#### iter_filter — codegen layer scoped (read-only, no build)

The closure-call lookup side is NOT the bug. `other_fn_call.yo:1687` keys
`impl_closure_call_map` off `resolve_some_type_to_concrete(callee_expr_info.ty)`,
and that helper (closures.yo) already walks the SomeT chain to its END — per-object
`resolved_concrete` cell first, then the id registry — so setter and lookup do use
the same capture-struct key whenever the type HAS a resolution.

Therefore `// Failed to transpile (self._f)(&(item))` means the field type reaching
codegen (`self._f`, i.e. the impl's forall `F` on the specialized receiver) carries
NO resolution in the specialized body: neither its cell nor the registry maps it to
the capture struct, so `cc_id` stays the bare SomeT id, the map misses, and the
emitter falls through to the fn-ptr cast (which cannot cast a capture struct).

**So the remaining fix is on the SPECIALIZATION side, not the lookup side:** when
`try_match_generic_impl` binds `F` (to the closure wrapper / capture struct) and the
method is specialized for `IterFilter(I, F)`, that binding must reach the receiver
instance's `_f` FIELD type — either by substituting the field types with the match
bindings when minting the specialized receiver, or by stamping the field SomeT's
`resolved_concrete` cell from the binding. Note the mint already does exactly this
kind of stamp for a closure PARAMETER (helper.yo's per-spec `…_capbind_…` rebuild,
which seeds a fresh cell with the capture struct) — the same treatment is what a
closure-typed FIELD of the specialized receiver needs.

Order for the next round is unchanged: re-apply the two evaluator changes
(attempt 3), then this field-type stamp, then arms → sweep.

#### Measured: the registration fix ALONE is inert (and safe)

Applying step 1 (the `_try_lookup_trait_type` fast-path gate) WITHOUT step 2 (the
third binding source) leaves all 8 remaining hollow files hollow, the RED red, and
both era canaries green — `check ./yo-self` unchanged at 295/305. Expected: a
correctly-parameterized constraint still has no consumer until the all-bound loop
can bind from it. The two changes are only effective TOGETHER (attempt 3, which
measured `hollow=0` on all three iter_filter arms), so do not try to land step 1
on its own. Reverted again; the pair plus the field-type stamp is the next round's
single unit of work.

Also recorded for reuse: `scratchpad/hollow8.sh` measures the 8 hollow + the RED +
the two canaries in one pass (~12 min) — the right cheap gate for any change aimed
at this set, before paying for the full 186-file sweep.

## ALL 8 remaining hollows — swallowed error captured for each (zero builds)

Harvested by re-running the already-built un-silenced-swallow binary (the
`_trial_eval_fn_body` probe binary from this session) over each file and taking the
LAST `__DBG_F` line, which is the batch main's own failure. This converts the
remaining set from "8 unexplained" into a queue with named roots:

| file                   | swallowed error                                                                                                               | reading                                                                                                                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prelude` arm 1        | `Cannot unify: Expected "bool", Given "unit"` at the `assert((x.is_ok)())` region, where `x := (EvenNumber.try_from)(i32(4))` | the STATIC trait-method call degraded to `unit`. The type has TWO `TryFrom` impls (`TryFrom(i32)`, `TryFrom(i64)`) — overload selection among impls of the same trait for a static method.                                                                         |
| `prelude` arm 3        | `Expected compile error, but the expression was evaluated successfully: arr2 := (uninit_arr.assume_init)()`                   | a MISSING VALIDATION (the older missing-validation family): a second `assume_init` on an already-consumed `MaybeUninit` must be rejected. Self-contained.                                                                                                          |
| `iterator_combinators` | `Type mismatch for type member "_f": Expected fn(item : i32) -> i32, Got F : (Fn(A) -> B + Fn(i32) -> B)`                     | the closure FIELD of a map/filter iterator keeps the impl's constrained `F` (two accumulated Fn constraints) instead of the concrete closure fn type — same `_f`-field-vs-forall shape as iter_filter's codegen layer, one level earlier (evaluator, not codegen). |
| `imm_map`              | `Cannot unify: Expected "*(<struct:struct_yo_id_5595>)", Given "*(<struct:struct_yo_id_9595>)"`                               | pure ERA IDENTITY: two instantiations of the same struct behind a pointer. The struct structural-dedup in `types/type_key.yo` is codegen-only; this one throws in the EVALUATOR.                                                                                   |
| `higher_kinded_types`  | `Expected enum type or primitive type for match expression, got TypeApp(fn(T : Type) -> Type, [i32])`                         | a `TypeApplication` reached `match` unreduced — `identity(generic(Option, i32), x)`'s result type is `TypeApp(Option, [i32])` where it must be the applied `Option(i32)`. Needs the TypeApp reduction at the match scrutinee (or at the call's return stamp).      |
| `basic`, `fn`          | `Cannot unify: Expected "bool", Given "unit"`                                                                                 | the same "call degraded to unit" signature as prelude arm 1 — bisect each to its arm before assuming a shared root (task #2's missing-validation family notes may already cover them).                                                                             |
| `iter_filter_closure`  | (root already pinned above — evaluator half fixed and measured; codegen field-type stamp remains)                             |                                                                                                                                                                                                                                                                    |

**Cheapest next targets, in order:** `higher_kinded_types` (one unreduced
TypeApplication — a single well-defined reduction point), `prelude` arm 3 (a
missing validation, no type machinery), then `prelude` arm 1 / `basic` / `fn` (the
shared unit-degradation signature — bisect first, they may be one root).

Reuse `scratchpad/hollow8.sh` (the 9-file ~12-minute gate) for any of them, and
note the harvest trick itself: keep one un-silenced-swallow binary around, because
every hollow file's root cause is one `grep __DBG_F | tail -1` away with no rebuild.

### higher_kinded_types — root SCOPED (read-only): substitution keeps `TypeApp` symbolic instead of APPLYING it

Hollowing error: `Expected enum type or primitive type (integer, bool) for match
expression, got TypeApp(fn(T : Type) -> Type, [i32])` at
`match(result, .Some(v) => …)` where `result := identity(generic(Option, i32), x)`.

Read-only survey of BOTH compilers (no builds):

- yo-self has **no TypeApp reduction anywhere**. Every `TypeAppT` site is
  construction, structural traversal (`get_all_some_types`, the occurs check,
  `type_contains_some_type`'s `=> true`), or a boolean test. In particular
  `types/substitution.yo:347-355` substitutes INTO a `TypeAppT` and rebuilds
  `TypeAppT(recur(constructor), new_args)` — it stays symbolic even when the
  constructor has just become concrete.
- TS does not reduce it _at the receiver_ either: `src/env.ts:1719` keeps
  `TypeApplication` symbolic and finds METHODS through
  `getWhereClauseConstraintsForTypeApplication`. And
  `plans/HIGHER_KINDED_TYPES.md:223` states the intended equivalence rule
  explicitly: **`TypeApp(F, [A]) ≡ ConcreteType` — only if the constructor is
  resolved and the application yields ConcreteType.**

So the missing mechanism is that equivalence/reduction: once `F` is bound to a
real type constructor (here `Option`), `TypeApp(F, [A])` must APPLY it and become
`Option(i32)`. The natural place is the `TypeAppT` arm of `substitute()` — when the
substituted constructor is a concrete comptime type constructor, CALL it with the
substituted args and return the result instead of a rebuilt `TypeAppT`.

Constraint to plan around: `types/substitution.yo` cannot import the evaluator, so
applying a comptime constructor needs the same hook pattern already used for
`_g_find_methods_from_generic_impls_fn` / `g_type_implements_trait_fn` — a slot set
from `evaluator/calls/comptime_fn.yo`'s init. Fall back to the current symbolic
rebuild whenever the constructor is still a SomeT or the hook is unset, so nothing
that works today changes. Gate with `scratchpad/hollow8.sh`, then the full sweep
(substitution is used everywhere).

### prelude arm 3 — root REFRAMED: it is use-after-move on an `own(self)` RECEIVER, not MaybeUninit logic

`assume_init` is declared `(fn(own(self) : Self) -> BaseType)` (std/prelude.yo:7569),
so `comptime_expect_error(arr2 := (uninit_arr.assume_init)())` must be rejected by
the MOVE checker — there is no MaybeUninit-specific validation to write. yo-self
already has the machinery (`set_expr_as_consumed` in evaluator/utils.yo throws
`use of moved value` when the variable has a `consumed_at_token` and
`allow_consume_again` is false).

**A one-flag theory was CHECKED AND IS WRONG — do not try it.** yo-self's
owned-parameter consume (helper.yo:799/802) passes `allow_consume_again = true`,
and it looked like the culprit — but TS passes `true` at BOTH of its corresponding
sites (src/evaluator/calls/helper.ts:432/445), each with the explicit comment
"Allow to consume again here is necessary." So yo-self is FAITHFUL there and
flipping the flag would diverge from TS (and would likely break every legitimate
move-into-call).

The live hypothesis is the RECEIVER path instead: `own(self)` is the method
receiver (argIndex 0), and TS's `setExprAsConsumed` DEFAULTS
`allowConsumeAgain = false` (src/expr.ts:2377, checked at :2423). So in TS the
receiver's consume presumably goes through a call that takes the default and
therefore rejects the second `assume_init`, whereas yo-self funnels the receiver
through the same owned-ARG block that deliberately allows re-consumption.

**NEXT STEP (cheap, read-only first):** find which TS call site consumes a dot-call
RECEIVER for an `own(self)` method and what flag it passes; then find yo-self's
corresponding receiver handling (the method-call arm in evaluator/calls/function.yo
that builds args from `receiver_expr`) and check whether the receiver is consumed at
all, and with which flag. Only then change anything — and gate with
`scratchpad/hollow8.sh` plus the full sweep, since every move-into-call in the
corpus exercises this path.

#### prelude arm 3 — dead ends eliminated (read-only); the open question is precise

Ruled OUT this round, all by grep, no builds:

- **No MaybeUninit logic in TS's evaluator at all.** `grep -rn maybe_uninit src/evaluator/`
  returns NOTHING; the builtins are declared in `src/expr.ts:1277` and are IDENTITY
  at codegen (`src/codegen/exprs/inline-fns.ts:226`). So there is no
  initialization-state tracking to port — the rejection must come from a GENERIC
  check.
- **TS's only consumed-value check is at CONSUME time**, in `src/expr.ts:2423`
  (`if (variableToConsume.consumedAtToken && !allowConsumeAgain)`), with the flag
  defaulting to `false` at `:2377`.
- **But both of TS's call-path consume sites pass `true`** (helper.ts:432/445,
  "Allow to consume again here is necessary"), and helper.ts has NO other
  `setExprAsConsumed` call. The remaining TS callers are `iso.ts`, `drop.ts`,
  `consume.ts` — none on a plain `own(self)` method-call path.
- yo-self DOES have a `use of moved value` diagnostic (evaluator/utils.yo:419), but
  it sits on a path parameterised by `rhs` — i.e. a binding-RHS read, not a general
  variable read.

So the open question is now sharp: **which TS check rejects the second
`uninit_arr.assume_init()`?** Candidates, in the order worth grepping: (a) a
read-side check somewhere other than the evaluator (the flow/ownership pass —
`requireValidRefArgumentPlaces` / the `own`-capture tracking), (b) the `inout`
borrow of the earlier `p := uninit_arr.as_ptr()` conflicting with the later move,
or (c) `comptime_expect_error` catching an error the test does not actually care
about (in which case the yo-self gap is that NOTHING at all errors there).

Confirm by instrumenting the TS side once (`YO_TRACE=1`-style print at every throw
in the ownership pass while compiling just that arm), which costs one TS run and no
yo-self build — the same counterfactual technique that settled the closure-return
mechanism earlier in this file.

### imm_map — root SCOPED (read-only): the synthesizer's STRUCT arm lacks the structural fallback its ENUM arm has

Hollowing error: `Cannot unify incompatible types: "*(<struct:struct_yo_id_5595>)"
and "*(<struct:struct_yo_id_9595>)"`. "Cannot unify" is the SYNTHESIZER's message
(`evaluator/types/synthesizer.yo`), not `are_types_compatible`'s — so this is the
struct-vs-struct arm rejecting two instantiations of the same generic struct.

The two arms are ASYMMETRIC today:

- **Struct arm** (synthesizer.yo, `same_constructor3`): accepts only when
  `exp_id == giv_id` OR the two effective `constructor_func_id`s are equal (with the
  `lookup_struct_ctor_fid` recovery for a pre-stamp empty cfid). If both sides carry
  cfids that DIFFER — which happens when the ctor reference was cloned per
  evaluation era and stamped a different fid — it THROWS.
- **Enum arm**: has exactly the missing case. Its comment says it outright — "Run
  the structural fallback whenever the id guard would otherwise reject — including
  when BOTH sides carry cfids that DIFFER. Two ERA INSTANCES of the same generic
  enum can carry different cfids … and the id guard then threw 'Cannot unify
  incompatible enum types' for Option(B)-def-era vs Option(i32)-call-era" — and it
  falls back to comparing variant-name lists, then lets the per-variant FIELD
  unification do the real checking.

So the candidate fix is a symmetry fix with an in-tree precedent: give the struct
arm the same guarded structural fallback — identical `field_labels` (same length,
same names in order) → proceed to the existing per-field unification instead of
throwing. The field recursion still rejects genuine mismatches, so this cannot make
two differently-shaped structs unify; it only stops rejecting on era-stamped
identity, exactly as the enum arm already does.

Why this is the most attractive remaining item: one site, an existing pattern to
copy, and it plausibly also covers other era-identity failures (the same class the
`array` / `for_macro_borrow` canaries guard). Gate it with those two canaries FIRST
(they are the era-identity tripwires), then `scratchpad/hollow8.sh`, then the full
sweep.

#### imm_map — struct-arm fallback attempt REJECTED (zero wins), and the message identifies the REAL throw site

Applied the symmetric structural fallback to the synthesizer's struct arm and
measured: `imm_map` still hollow, the other 7 unchanged, both era canaries green,
`check` 295/305. Reverted per the zero-wins rule.

The reason is in the message shape, which I mis-read before: the struct arm throws
`"Cannot unify incompatible **struct** types"` and the enum arm `"… incompatible
**enum** types"`, but the observed error is the GENERIC

```
Cannot unify incompatible types:
Expected: "*(<struct:struct_yo_id_5595>)"
Given: "*(<struct:struct_yo_id_9595>)"
```

which is the FINAL fallthrough throw at `evaluator/types/synthesizer.yo:2104` —
reached only after every typed arm declined. So the two `*(...)` pointer types never
reach the struct arm at all: the POINTER-vs-POINTER arm either does not exist for
this shape or declines before recursing into the pointees.

**NEXT STEP:** at synthesizer.yo:2104, print the two type TAGS (not just
`type_to_string`) plus whether a Pointer-vs-Pointer arm exists earlier in the
`recur` chain. If there is no `Pointer` arm that recurses into pointees, that is the
whole defect and it is a small addition (recurse `pointee` vs `pointee`, mirroring
TS `synthesizer.ts`'s `TypeTag.Ptr` case). If the arm exists, the pointees are
reaching it and the struct-level rejection is happening one level down — in which
case re-try the struct fallback but confirm FIRST (with the same print) that the
labels really are identical, since that is what made this attempt inert.

#### imm_map — one more dead end closed: the Pointer arm EXISTS and is in the SAME function as the throw

Checked (read-only): `_synthesize_types_impl` (synthesizer.yo:1160) contains BOTH the
Pointer-vs-Pointer arm (:1758, which recurses into the pointees via
`_synthesize_call`) AND the generic fallthrough throw (:2104). Same function, arm
first. So the pointer case is not missing and it is not an unreachable-arm ordering
bug.

That leaves exactly one reading: when the throw fires with two `*(struct …)` types,
`is_pointer_type` returned FALSE for at least one of them — the arm's own guard
declined. Most likely the type is not a plain `.Pointer` at that moment (a
`SomeT`/`IsoT`/`TypeAppT` wrapper that renders as `*(…)` via `type_to_string`, or a
Pointer whose pointee is behind a wrapper), so the tag test fails while the printed
form looks like a pointer.

**NEXT STEP (one print, decisive):** at synthesizer.yo:2104 print
`type_value_tag(expected_ty)` and `type_value_tag(given_ty)` (the tag helper is
already imported in that module as `type_value_tag`) alongside the existing
`type_to_string`s. The tags say immediately whether these are `Pointer`s that the
guard rejected or something else wearing a pointer's rendering — and that determines
whether the fix is in the guard, in an unwrap before the arm, or in whatever produced
the wrapped type upstream. Do NOT attempt another fix before that print: two attempts
here have now been inert because the printed form was trusted over the tag.

#### imm_map — the tag print RUNS CLEAN: the recorded pointer-pair root is WITHDRAWN

Instrumented the generic fallthrough throw (synthesizer.yo:2104) to print the two
guard booleans (`is_pointer_type` / `is_some_type`) for both sides, built, and ran
`tests/imm_map.test.yo`. Result:

- 3147 mismatches reach that throw, and their shapes are ordinary tag mismatches —
  2450 neither-pointer, 445 `eptr=y gptr=n`, 252 `eptr=n gptr=y`.
- **`eptr=y gptr=y` count is ZERO**, and the string `Cannot unify incompatible
types` does not appear in that run's output at all.

So the `*(<struct:5595>)` vs `*(<struct:9595>)` pair I attributed to imm_map is NOT
what fails it under the current tree. The earlier harvest took the LAST `__DBG_F`
line from a run of the OLDER probe binary (`/tmp/sh129`, built before the last
landed fixes), and that attribution does not survive re-measurement. **The
"imm_map = era identity behind a pointer" root recorded above is WITHDRAWN.**

Two lessons for the next round, both cheap to honour:

1. **Re-harvest with a CURRENT probe binary.** The harvest trick is still right, but
   a probe binary built before subsequent landed fixes reports stale roots. Rebuild
   the un-silenced-swallow binary from HEAD before trusting any of the eight roots
   in the table above that have not been independently re-measured — the ones
   confirmed against the current tree are `iter_filter_closure` (measured to
   `hollow=0`) and `higher_kinded_types` (the TypeApp message, cross-checked against
   both compilers' source).
2. **`__DBG_F` last-line ≠ the batch main's error when other errors follow.** Pin it
   by matching the printed source location to `.yo_selftest_batch_*.yo`, not by
   position in the log.

## HONEST RE-HARVEST (2026-08-01, probe binary /tmp/sh141 built from HEAD)

Rebuilt the un-silenced-swallow binary from HEAD (the previous harvest used the
stale `/tmp/sh129`) and pinned each file's error by MODULE PATH, not by log
position — `scratchpad/harvest_roots.py` splits the log into swallow records and
reports the one whose token location is in `.yo_selftest_batch_*.yo`;
`scratchpad/caret_window.py` slices the giant one-line batch arm around the
caret so the failing sub-expression is readable. Every file had exactly ONE
in-batch record, so attribution is unambiguous this time.

| file                        | throw location             | error                                                                                                     | failing sub-expression                                                                                                   |
| --------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `where_clause_fn_inference` | batch arm (the `map` decl) | `Variable "A" not found.`                                                                                 | `LocalMapIter(Self, A, B, F)` in the return type of `map` — `A` occurs ONLY in `where(Self <: Iterator(Item := A))`      |
| `iter_filter_closure`       | batch arm 0                | `Expected enum type or primitive type for match expression, got unit`                                     | `(filtered.next)()` → unit: the blanket `Iterator` impl for `IterFilter(I, F)` does not match                            |
| `iterator_combinators`      | `std/prelude.yo:8015`      | `Type mismatch for type member "_f": Expected fn(item : i32) -> i32, Got F : (Fn(A) -> B + Fn(i32) -> B)` | `IterMap(Self, B, F)(_inner : self, _f : f)` — same `where(Self <: Iterator(Item := A), F <: Fn(a : A) -> B)` shape      |
| `higher_kinded_types`       | batch arm 0                | `... got TypeApp(fn(T : Type) -> Type, [i32])`                                                            | `match(result, …)` where `result := identity(generic(Option, i32), x)`                                                   |
| `async_await`               | batch arm 65               | `Expected Impl(Future(i32) Ctx : Ctx), Given Impl(Future(T) E : E)`                                       | `(task : Impl(Future(i32, Ctx))) = (io.async)((ctx : Ctx) => …)` — `T`/`E` never bound from the closure                  |
| `prelude`                   | batch arm 1                | `Cannot unify: Expected "bool", Given "unit"`                                                             | `assert((x.is_ok)())` where `x := (EvenNumber.try_from)(i32(4))` — two `TryFrom` impls                                   |
| `basic`                     | batch arm 12               | `Cannot unify: Expected "bool", Given "unit"`                                                             | `assert((y.x) == 5)` where `(y : Point2) = _(5, 6)` (underscore struct literal), after `(z : Point2) = y`                |
| `fn`                        | batch arm 9                | `Cannot unify: Expected "bool", Given "unit"`                                                             | `assert(x == true)` where `comptime(id) : (fn(comptime(T) : Type, x : T) -> T); id = ((T, a) -> a); x := id(bool, true)` |
| `imm_map`                   | `std/imm/map.yo:300`       | `Cannot unify: "*(<struct:5595>)" vs "*(<struct:9595>)"`                                                  | `_copy_pairs(K, V, new_ptr, coll._pairs_ptr, …)`                                                                         |

**The single biggest finding: `where_clause_fn_inference` (the only RED),
`iter_filter_closure` and `iterator_combinators` are ONE root — a forall that
appears only in a `where` clause is never bound.** That is exactly what the
recorded iter_filter "attempt 3" evaluator pair fixes
(`scratchpad/apply_iterfilter_evaluator_half.py`), so that pair is worth up to
three verdicts, not one.

Corrections to the earlier (stale-binary) table, which must not be trusted:

- `prelude`'s blocker is **arm 1** (the two-`TryFrom`-impls static call), not the
  arm-3 `assume_init` move check. Arm 3 may surface only after arm 1 is fixed.
- `basic` and `fn` share the _message_ but not the shape: `basic` is a field read
  on an underscore-literal-initialised struct after an assignment, `fn` is a call
  through a `comptime`-typed `fn(comptime(T) : Type, …)` variable. Bisect
  separately; do not assume one root.
- `imm_map` and `iterator_combinators` have NO in-batch swallow at all — their
  last swallow is inside `std/`. Their `.yo_selftest_batch_` substring came from
  C-compiler warnings appended to the record, not from the throw location. The
  std-side def-time failure is still the root (it makes the method unusable, so
  the call site in main emits the FTT marker), but the batch main itself is not
  where the throw happens.

### higher_kinded_types — TRUE GREEN (20/20 = TS), and it named the family root

Landed fix: `yo-self/evaluator/calls/function.yo`, in the inline FuncVal call arm
(`_evaluate_funcval_runtime_call`), right after
`resolved_ret = evaluate_function_return_type_again(...)` — re-evaluate the
declared return-type EXPRESSION in the bound callee env whenever the DECLARED
return mentions a kind-annotated (HKT) binder. Script:
`scratchpad/apply_hkt_ret_reeval.py`.

Why that is the faithful port, and why the recorded root was wrong:

- The failing type is `TypeApp(fn(T : Type) -> Type, [i32])`. A bare `SomeT`
  prints as its own name, so the constructor slot is not an unresolved `F` left
  symbolic by `types/substitution.yo` — it was OVERWRITTEN with the HKT binder's
  FuncVal _type_ by the call-site substitution. `substitution.yo` is a bystander;
  the previously-recorded "add a TypeApp reduction rule to substitute()" plan is
  **withdrawn**.
- There is no TypeApp reduction function anywhere in `src/`. TS reduces `F(A)` as
  a SIDE EFFECT of re-evaluating the return-type EXPRESSION
  (`src/evaluator/calls/helper.ts:1533-1546` →
  `src/evaluator/types/function.ts:2822-2836`): with `Option` bound to `F`, the
  expression is an ordinary comptime call and yields `Option(i32)`. TS builds a
  TypeApplication only while the callee is still an abstract SomeT with
  `kindFunctionType` (`src/evaluator/calls/function.ts:1345-1394`).
- Reducing at the match scrutinee would be wrong — the variable would still carry
  a TypeApplication into codegen, which `plans/HIGHER_KINDED_TYPES.md:98` forbids.
- No hook slot is needed: `get_func_return_type_expr` +
  `_trial_eval_ret_type_expr` are already in-tree and the MINT path already uses
  them (helper.yo's rte block). Only the inline FuncVal arm was missing the step.

Note for the next round: `types/substitution.yo` rebuilds an unsubstituted `SomeT`
with `is_effects_row = false` and `kind_function_type = None` hardcoded, silently
erasing both. The patch sidesteps it by reading the flag off the PRE-substitution
`ret_type`, but that erasure is a latent defect worth its own issue.

**The generalization this proves** (and the reason four files share a root):
wherever yo-self resolves a call's return type by SUBSTITUTION instead of by
RE-EVALUATING the return-type expression through the memoized constructor, it
mints a second, def-era instance. TS has exactly one route. Confirmed instances:
`higher_kinded_types` (fixed), `where_clause_fn_inference` (the C split
`__yo_t16`/`__yo_t34` — same layout, different ctor-key), `iter_filter_closure`
(`__yo_t21` vs `__yo_t15`), and the `_f`-member mismatch in
`iterator_combinators`.

#### where_clause_fn_inference — standalone repro + what the remaining gap IS

`src/tests/fixme.yo` with lines 13-43 of the test plus
`iter := it1.local_map_to(double)` (NO annotation) reproduces in SECONDS via
`<yo-self-bin> compile src/tests/fixme.yo --emit-c --skip-c-compiler --release`:

- TS → `LocalMapIter(ArrayListIter(i32), i32, i32, fn(x : i32) -> i32)`, ONE C struct.
- yo-self → key `gs_<ctor>_gs_<ArrayListIter(i32)>_1499_1500_fn_x___i32_____i32_cl1_…`

i.e. **A and B remain raw SomeT ids**. Both compilers emit `void* _f`, so the
field lowering is NOT the problem — the two C structs differ only because the
type ARGUMENTS differ.

Measured and REJECTED this round (kept only because it is a faithful port that
removes a real error, pending the full sweep): adding
`reapply_where_clause_exprs_for_call` to `create_specialized_function_inline`
before its `evaluate_function_return_type_again`
(`scratchpad/apply_reapply_where_in_spec.py`, a port of TS helper.ts:1515-1529,
which yo-self had on only one of its two call paths). It does NOT bind A/B —
the repro's key is byte-identical before and after.

That narrows the remaining gap sharply: the mint's rte block ALREADY re-evaluates
the return-type expression and its gate (`spec_ret_ty still has SomeTs`) IS
satisfied here, so either `A`/`B` are not bound BY NAME in `callee_env` at all,
or the re-evaluated result still carries them. The next probe should print, in
one build: (1) `validate_concrete_type_constraints` entry — concrete type, trait,
`implemented`; (2) `_assoc_synth_env`'s label/constraint/resolved and whether it
bound; (3) the mint rte block's `expr found?` and `type_to_string(rte_ty)`.

#### The iter_filter evaluator half REGRESSES `closure_capture_rc_leak` — do not land it

Full-sweep pass over the tree (iter_filter evaluator half +
`reapply_where_clause_exprs_for_call` in the spec path + the HKT fix) caught
`tests/closure_capture_rc_leak.test.yo` going **GREEN → HOLLOW**. That file was
green in the 176/8/1 baseline and is not one of the eight. The prime suspect is
step 1 of `scratchpad/apply_iterfilter_evaluator_half.py` — the
`_try_lookup_trait_type` atom-fast-path gate — which changes how EVERY generic
impl records a parameterized where-constraint; `trait_checking.yo`'s own comment
names `closure_capture_rc_leak`'s `any` where clause as a case that path already
had to be tuned for. Both changes were reverted; only the HKT fix was kept.
Lesson re-confirmed: the ~12-minute `hollow8.sh` gate cannot see this class —
only the full 186-file sweep can, because the regression lands on a file that was
already green.

#### Probe result (sh145): the where-clause bindings ARE produced; the RETURN TYPE is the gap

Three prints (`scratchpad/probe_where_ab.py`) on the standalone repro:

```
__DBG_VC  concrete=<struct:…3233>        trait=Iterator        impl=y
__DBG_VC  concrete=fn(x : i32) -> i32    trait=Fn(i32) -> i32  impl=y     <-- A,B already i32
__DBG_ATC label=Item constraint=A    resolved=i32                          <-- A := i32 synthesized
__DBG_ATC label=Item constraint=i32  resolved=i32
n_wce distribution: 2183x 0, 216x 1, 2x 2                                  <-- the 2 IS local_map_to
__DBG_RTE ... (exactly ONE line in the whole run, for Box(V) — never LocalMapIter)
```

So: the where-clause validation runs, `_check_associated_type_constraints` +
`_assoc_synth_env` DO bind `A := i32` (and the trait then prints as the fully
concrete `Fn(i32) -> i32`, so `B` binds too), and
`reapply_where_clause_exprs_for_call` DOES see both constraints. Nothing is
missing on the binding side — the recorded "A is never bound" reading is
**superseded**.

The gap is one step later: `local_map_to` is called through the inline FuncVal
arm (`_evaluate_funcval_runtime_call`, evaluator/calls/function.yo), which
resolves the return type by SUBSTITUTION only. Substitution rewrites the DECLARED
return's own SomeT copies, a different lineage from the ones the where clause
bound, so `LocalMapIter(Self, A, B, F)` keeps raw ids. The MINT path's
return-type-EXPRESSION re-evaluation (helper.yo's rte block) — which would
resolve A and B by NAME and route the instantiation through the ctor memo —
never runs for this function.

Fix under test: generalize the HKT re-evaluation gate in that same arm from
"declared return mentions a kind-annotated binder" to the mint's own gate,
"substitution left SomeTs behind". Same adoption condition (SomeT-free,
non-unit result only).

## Method upgrade: bisect ARMS with subset_arms.py, not by extracting to `main`

Three files (`basic`, `fn`, `prelude`) looked like cross-arm state poisoning because
their failing arm, extracted into `main :: (fn() -> unit)({ … })` and run through
`check`, PASSES in both compilers. That reading was wrong. Rebuilding the file with
`python3 scratchpad/subset_arms.py <file> <arm-index> <out>` — which keeps the arm
inside its `test("…", { … })` wrapper — reproduces every one of them as a
single-arm file in ~20-40 s:

| file      | arm | single-arm verdict |
| --------- | --- | ------------------ |
| `prelude` | 1   | rc=0 hollow=1      |
| `prelude` | 3   | rc=0 hollow=1      |
| `basic`   | 12  | rc=0 hollow=1      |
| `fn`      | 9   | rc=0 hollow=1      |

So none of these needs the batch context — only the `test(...)` wrapper. Prefer this
loop over any rebuild: it is ~1000x cheaper than a 10-minute yo-self build, and
`/tmp/sh141` (the un-silenced-swallow probe) plus `scratchpad/caret_window.py` reads
the real error straight out of the run. Confirms `prelude` needs BOTH arm 1 and
arm 3 fixed, not one.

### basic arm 12 — MINIMISED to three lines

```rust
{ assert } :: import("std/assert");
test("v", {
  Point2 :: struct(x : i32, y : i32);
  (y : Point2) = _(5, 6);
  assert((y.x) == 5);
});
```

yo-self: `rc=0 hollow=1`, swallowed error `Cannot unify incompatible types:
Expected "bool", Given "unit"` with the caret on the `assert` — i.e. `(y.x)`
evaluated to `unit`. TS: passes.

Discriminating variants (all measured):

- `y := Point2(5, 6)` instead of the underscore literal → **GREEN**. The plain
  constructor path is fine; the `_` implicit-constructor path is not.
- `(y : Point2) = _(5, 6); assert(true);` (no field read) → **GREEN**. The literal
  alone is fine; the FIELD READ on the resulting variable is what degrades.
- `struct(a : i32, b : i32)` + `y.a` → still hollow, so it is not name-specific.
- `(y : Point2) = _(x : 5, y : 6)` (NAMED fields) → **rc=1, a HARD error** rather than
  a hollow — likely the same root, louder.

### basic arm 12 — ROOT FOUND and FIXED, but the fix turns the file RED; reverted

Root (`yo-self/evaluator/exprs/_expr.yo`, the `_(...)` dispatch arm): TS reroutes
`_` to a CONSTRUCTOR CALL of the expected type for EVERY concrete expected type —
the anonymous-struct fallback runs only when there is no expected type or it is a
SomeT (`src/evaluator/calls/function.ts:446-476`, guard `!expectedType ||
isSomeType(expectedType.type)`). yo-self's guard carries an extra conjunct with no
TS counterpart, `expected_is_anon_struct && !is_some_type(et_ty)`, so a NAMED
expected struct falls through to `evaluate_anonymous_struct_value`, which mints a
fresh struct whose positional fields are labelled `__field_<rand>`
(`src/evaluator/values/anonymous-struct.ts:174` is where TS loses the name in
_its_ fallback — the point is that TS never takes that fallback here). `y.x` then
resolves to nothing and evaluates to `unit`.

That narrowing is deliberate and documented —
`issues/yo-self-anon-struct-literal-expected-type-ctor.md`, landed in `832fc672f`:
the TS-faithful rule broke stage-2 self-emission (s2 SIGSEGV in the dup/drop
optimizer at prelude eval, traced to the `ref(struct(min, max))` `IntRange`
literal in `yo-self/types/utils.yo`).

Measured with the guard restored to exactly TS's (`!(is_some_type(et_ty))`):

- the 3-line repro flips `hollow=1` → `hollow=0`, 1 passed;
- `check ./yo-self` unchanged at 295/305; all three canaries green; the other
  seven files unchanged;
- but **`tests/basic.test.yo` goes HOLLOW → RED** (`rc=1 markers=2`). Un-hollowing
  the batch main exposes a SECOND, unrelated codegen gap that the hollow main had
  been hiding:

```c
static inline __yo_t94 yo_id_6842() {
  return // Failed to transpile Self(x : 0);
}
```

i.e. `Self(x : 0)` — a named-argument constructor call on `Self` — does not emit.

Reverted, because it leaves a file failing hard rather than merely vacuous. The
change itself is correct and should be re-applied the moment `Self(x : 0)`
emission is fixed; that is now the blocking item for `basic`, not the `_` guard.
Do NOT re-apply it without also running the stage-2 fixpoint gate, which is the
reason the narrowing exists at all.

### fn arm 9 — ROOT FOUND: the anonymous-function path re-keys NONE of the func-id side tables

Minimal repro (7 lines, `rc=0 hollow=1` under yo-self, GREEN under TS):

```rust
{ assert } :: import("std/assert");
test("min", {
  comptime(id) : (fn(comptime(T) : Type, x : T) -> T);
  id = ((T, a) -> a);
  x := id(i32, 12);
  assert(x == 12);
});
```

The single axis that flips it: writing the function with `::`
(`id :: (fn(comptime(T) : Type, x : T) -> T)(x)`) is GREEN; the anonymous-function
form is HOLLOW. `generic(T : Type)` instead of `comptime(T) : Type` is also GREEN.
The symptom is NOT "returns unit" — the call's return type is left as the UNBOUND
SomeT `T`, so `x == 12` finds no operator impl, types `unit`, and `assert(unit)`
throws.

Root: TS keeps `isCompileTimeOnly` and the param/return type EXPRESSIONS on the
FunctionType itself, and its anonymous-function evaluator builds the new type by
SPREADING the expected one (`anonymous-function.ts:597-638`), so they are
inherited verbatim. yo-self keeps all of that in func-id-keyed SIDE TABLES
registered under the `fn(...)` TYPE-EXPRESSION id
(`evaluator/types/function.yo:4120-4132`). The `::` path re-keys them onto the
FuncVal id (`evaluator/calls/function_type.yo:713-722`, nine `copy_func_*` calls);
**`values/anonymous_function.yo` re-keys nothing** — it mints a fresh
`fn_<random>` id and calls only `register_func_type`. So for an anonymous
function `get_func_return_type_expr` and `get_func_param_comptime` are both
empty.

Second, independently visible face of the same gap, in emitted C:
`comptime(f) : (fn(x : i32, comptime(y) : i32) -> i32); f = ((x, y) -> (x + y))`
emits `fn(int32_t x, int32_t y)` — **the `comptime(y)` modifier is gone and `y` is
a runtime C parameter** — while TS folds `y` into the specialization and the
yo-self `::` form is correct.

Attempted and REVERTED (zero verdict wins): a faithful port of TS's post-re-eval
name fallback — `if (isSomeType(returnType)) getValueOfSomeTypeFromEnv(calleeEnv,
returnType)` (`types/function.ts:2846`) — added to `_evaluate_funcval_runtime_call`
after the return-type-expression re-eval. It DOES fix the evaluator half (the
minimal repro goes `hollow=1` → `hollow=0`), but emission then hits the
comptime-parameter face above and the repro turns `rc=1`; `tests/fn.test.yo`
itself stays HOLLOW, and the three canaries stay green. Reverted.

**The complete fix is structural and is the right next step:** re-key the side
tables in `anonymous_function.yo` next to its `register_func_type`, exactly as
`function_type.yo:713-722` does. It is blocked on a missing channel — the
`from_id` is `ast_expr_id(<the fn(...) type expr>)` and nothing reachable there
carries it (`ExpectedTypeCtx` is `{ ty, env }`; `FuncMeta` and `Variable` have no
origin id; there is no reverse type→expr-id registry). Supplying it means adding
an `origin_id : Option(String)` to `FuncMeta`, set in `evaluate_function_type`,
and updating the ~9 `FuncMeta(...)` construction sites. That IS the faithful
place — TS keeps `isCompileTimeOnly` / `exprs.typeExpr` on the type object right
next to `isRef` / `isOwningTheRcValue`, both of which yo-self already mirrors on
`FuncMeta`. Do not substitute a structural or `type_to_string`-based key for it.

### basic arm 14 — union support: CONSTRUCTION ported (fixes real cases); METHODS are a structural gap

`tests/basic.test.yo` has a SECOND independent broken arm besides arm 12: arm 14
("Test 'union'"). Isolated with `subset_arms.py`, it is `rc=1` on its own under
the pre-fix binary, so it is not downstream of arm 12.

**Part 1 — union CONSTRUCTION did not emit at all. Ported and measured.**
yo-self emits union DECLARATIONS (`codegen/types/generation.yo`
`generate_union_declaration`) but `generate_other_function_call` had no arm for a
union-typed callee, so `SomeUnion(x : 12)` fell through to the generic fallback
and emitted `// Failed to transpile SomeUnion(x : 12)` — invalid C. Ported TS's
arm (`src/codegen/exprs/other-fn-call.ts:2468-2521`,
`(cName){ .label = value }` for the single named member, with the temp-variable
declaration) next to the existing value-struct arm.
Script: `scratchpad/apply_union_construction.py`. Measured:

| repro                                              | before | after     |
| -------------------------------------------------- | ------ | --------- |
| `SomeUnion(x : 12); (v1.x)`                        | `rc=1` | **GREEN** |
| `SomeUnion(x : 12); _(x : xx) := v1` (destructure) | `rc=1` | **GREEN** |

Field naming uses `sanitize_for_c_identifier(label, false)` to match
`generate_union_declaration`; TS uses `getVariableNameForCodegen` there, but the
compound literal must agree with yo-self's own declaration.

**Part 2 — ANY method on a union is unresolvable. Structural, not ported.**
Every one of these is still hollow after Part 1, and a struct with the identical
shape is GREEN:

```rust
impl(SomeUnion, new : (fn() -> Self)(Self(x : 0)));       SomeUnion.new()      -> hollow
impl(SomeUnion, new : (fn() -> SomeUnion)(SomeUnion(x:0))); SomeUnion.new()    -> hollow   (not a `Self` problem)
impl(SomeUnion, get_five : (fn() -> i32)(i32(5)));        SomeUnion.get_five() -> hollow
impl(SomeUnion, get_x : (fn(self : *(Self)) -> i32)(self.x)); u.get_x()        -> hollow
impl(SomeStruct, new : (fn() -> Self)(Self(x : 0, y : true))); SomeStruct.new() -> GREEN
```

Root: `TypeValue.Union` is `Union(name, field_labels, field_types)`
(`yo-self/types/definitions.yo:231`) — it carries **no `id` and no trait**. TS's
`UnionType extends Type` so it has `id` (`src/types/definitions.ts:11-20`) AND a
`trait : TraitType` "which contains the compile-time methods, properties, etc."
(`:786-789`). Every impl-registration and method-lookup channel in yo-self is
keyed by a type id, so an `impl(<union>, …)` has nowhere to register.

Closing this needs `id` (and a methods channel) added to the `Union` variant plus
every construction site updated, then impl registration and method lookup wired —
the same class of multi-site change as the `origin_id : Option(String)` on
`FuncMeta` that `fn` arm 9 needs. Both are the right faithful fix; neither is a
one-anchor patch.

**Consequence for `basic`:** it needs THREE things — the arm-12 `_` reroute, the
arm-14 union construction (done), and union method resolution. It stays HOLLOW
until all three land.

### fn arm 9 — the STRUCTURAL fix landed the minimal repro; three unrelated blocks remain

Implemented the `origin_id` channel described above, and it is cheaper than
feared because Yo struct fields take defaults:

1. `yo-self/types/definitions.yo` — `(origin_id : Option(String)) ?= Option(String).None`
   appended to `FuncMeta`. **Defaulted, so none of the 22 existing
   `FuncMeta(...)` construction sites needed touching.**
2. `yo-self/evaluator/types/function.yo` — `evaluate_function_type` sets it to
   `ast_expr_id(expr).to_string()`, the very key it has just registered every
   side table under.
3. `yo-self/evaluator/values/anonymous_function.yo` — reads it off the type it
   was checked against and performs the same nine `copy_func_*` calls the `::`
   path does. It rides along for free through the existing `_l3m.*.clone()`,
   which is precisely TS's "spread the expected FunctionType".

Measured: the 7-line minimal repro goes from `hollow=1` to **fully GREEN**
(`rc=0 hollow=0 markers=0, 1 passed`) — the structural fix closes BOTH halves,
unlike the earlier surgical name-lookup patch, which fixed only the evaluator and
left emission at `rc=1`.

`tests/fn.test.yo` itself stays HOLLOW: splitting arm 9 into its 13 blocks shows
three MORE independent defects, all of which reproduce identically on the
pre-change binary (so none is a regression):

| block | source                                                                                 | verdict    |
| ----- | -------------------------------------------------------------------------------------- | ---------- |
| blk10 | `tuple_func :: (fn(generic(T, Y), x : Tuple(T, Y), a : T, b : Y) -> Tuple(T, Y))`      | `hollow=1` |
| blk5  | `comptime_add :: (fn(x : i32, comptime(y) : i32) -> i32)(x + y)`                       | `rc=1`     |
| blk12 | `generic_fn :: (fn(generic(T), x : T, callback : (fn(v : T) -> T)) -> T)(callback(x))` | `rc=1`     |

Per-block files are reproducible in ~20 s each; the splitter that made them is
worth reusing for any multi-block arm.

### Union METHODS — FIXED by one line; `type_id_or_empty` had no `.Union` arm

The "structural gap" recorded above was wrong in its cost estimate, though right
about the cause. A union does NOT need a new id field: `evaluate_union_type`
already mints `union_${random_id(module_path)}` and passes it as the union's
**`name`** (`yo-self/evaluator/types/union.yo:65`), so the unique id was there all
along. What was missing is that `type_id_or_empty`
(`yo-self/evaluator/values/type_trait_methods.yo:58`) — the function every
impl-registration and method-lookup channel keys off — has arms for Struct,
EnumT, TraitT, SomeT and the primitives but **none for Union**, so it returned
the empty string and `impl(<union>, …)` registered nothing.

Adding `.Union({ name : un_id }) => un_id` fixes it. Measured under a build that
also has the union-construction port:

| repro                                                                       | before | after        |
| --------------------------------------------------------------------------- | ------ | ------------ |
| `impl(SomeUnion, get_five : (fn() -> i32)(i32(5)))`; `SomeUnion.get_five()` | hollow | **GREEN**    |
| `impl(SomeUnion, new : (fn() -> Self)(Self(x : 0)))`; `SomeUnion.new()`     | hollow | **GREEN**    |
| `impl(SomeUnion, new : (fn() -> SomeUnion)(...))`; `SomeUnion.new()`        | hollow | **GREEN**    |
| **`tests/basic.test.yo` arm 14 in full**                                    | hollow | **GREEN**    |
| `impl(SomeUnion, get_x : (fn(self : *(Self)) -> i32)(self.x))`; `u.get_x()` | hollow | still hollow |

So static union methods and `Self(...)` construction inside them work; the
INSTANCE-method receiver path (`self : *(Self)` on a union) is still open and is
the one remaining union item.

### basic arm 12 — the `_` reroute REJECTED a third time; it keeps unmasking the next gap

With union construction AND union methods landed, the `Self(x : 0)` blocker
recorded earlier is gone — so the TS-faithful `_` reroute was retried. It still
turns arm 12 from HOLLOW into RED, now on a THIRD, different gap: a struct with
DEFAULTED fields emits the C TYPE NAME in place of each default value.

```c
__yo_t21 p  = (__yo_t21){ .x = 2,  .y = 1 };            // Point(y : 1, x : 2)  — correct
__yo_t21 p2 = (__yo_t21){ .x = __yo_t21, .y = __yo_t21 };  // Point()           — WRONG
__yo_t21 p3 = (__yo_t21){ .x = 13, .y = __yo_t21 };        // Point(13)         — WRONG
```

That is the `runtime_arg_exprs_in_order` / omitted-default misalignment the
value-struct arm's own comment already warns about, and it is pre-existing — it
was simply unreachable while the arm hollowed earlier. Sequence for arm 12 is
therefore: fix omitted-default emission FIRST, then re-apply the reroute.

**Measurement hazard hit this round, worth stating loudly:** a `measure_one.sh`
run against `tests/` while a full sweep was ALSO running over `tests/` produced a
false `hollow=0 markers=0 33 passed` for `basic` — the two runs collide over the
shared `.yo_selftest_batch_*` artifacts, exactly as `measure_one.sh`'s own header
warns. The file was re-measured three times in isolation, all `hollow=1`. Never
measure and sweep the same directory concurrently, and treat any single
surprising green as suspect until repeated with nothing else running.
