# yo-self: `_(...)` literal ignored expected type — fresh struct id per literal (fs/walker 0-entries)

**Status: FIX IN GATES 2026-07-23** — `yo-self/evaluator/exprs/_expr.yo`
BK_ANON_STRUCT arm now mirrors TS function.ts:418-439, **gated to UNNAMED
expected structs** (see "Scope narrowing" below).

## Symptom

`s2 test tests/fs/walker.test.yo`: 1/6 — every walk returns **0 entries**, and
walk-on-nonexistent returns no error. Flag-independent (pre- and post-FSM-flip).

Minimal repro (`/tmp/walkmin7_main.yo` shape): an `io.async((e) => ...)`
closure whose body pushes an anonymous-struct literal into an
`ArrayList(struct(path : String, depth : u32))` stack and awaits inside the
drain loop — TS prints `results = 1`, yo-self-s1 printed `results = 0`.

Plain-fn variant (no closure, no await): same shape FAILS TO C-COMPILE under
s1 (`use of undeclared identifier 'n'`) — the bug is general, not FSM-specific.

## Root cause (probe-verified)

Two struct identities were minted for one declaration + literal pair:

1. `stack := ArrayList(struct(path, depth))` — the decl struct evaluates to
   the decl-stable id (`struct_decl_96081_...`, ctfe_depth 0), memoized into
   the `ArrayList` instantiation; `push`'s param type resolves CONCRETELY to
   it via `evaluate_function_parameter_type_again`.
2. `stack.push({ path : ..., depth : ... })` — the literal routed to
   `evaluate_anonymous_struct_value`, minting a FRESH id
   (`struct_yo_id_6287`).
3. `_synthesize_call`'s struct-struct case: ids differ, both cfids empty →
   `Cannot unify incompatible struct types` — thrown INSIDE the io.async
   closure's def-time trial eval, **swallowed** by `_trial_eval_anon_body`
   (`APROBE eval fid=closure_yo_id_6276 BODY-EVAL-THREW`), so
   `analyze_await_points` never ran, no await analysis was registered, and
   codegen routed the closure to the sync-future path: awaits dropped,
   `results` empty, no error surfaced. In a plain fn the same swallowed throw
   left partial ExprInfo state and codegen emitted a broken body (undeclared
   identifier).

## The TS mechanism yo-self missed

TS `evaluateFunctionCall` (function.ts:418-439): a `_(...)` callee with a
CONCRETE `context.expectedType` is dispatched as a **constructor call of the
expected type** (`functions = [{type: typeOfType(expected), value:
createTypeValue(expected)}]`) — no fresh anonymous struct type exists, so
nothing needs unifying and the emitted C uses ONE struct typedef.
`evaluateAnonymousStructValue` (fresh id) runs only when there is no expected
type or it is a SomeT. yo-self's `_expr.yo` dispatch routed BK_ANON_STRUCT to
`evaluate_anonymous_struct_value` unconditionally.

yo-self sets `ctx.expected_type` to the resolved param type before each arg
eval (calls/helper.yo:489), so the expected type IS available at the literal.

## Fix

`yo-self/evaluator/exprs/_expr.yo` BK_ANON_STRUCT arm: when
`ctx.expected_type` is `.Some(et)` and `et.ty` is not a SomeT, route to
`evaluate_function_call(expr, env, type_of_type(et_ty),
.Some(EvalValue.TypeVal(et_ty)), ctx, exn)` — the `given_value` shortcut (the
same one `evaluate_recur` uses) lands in the `.Struct` callee arm's struct
construction. Otherwise fall back to `evaluate_anonymous_struct_value` as
before.

## Verification

- Plain probe: compiles + runs (was C error).
- walkmin7 repro: `results = 1` (was 0); walkreal: `entries = 1` (was 0);
  zero `BODY-EVAL-THREW` probes.
- `fs/walker.test.yo` with fixed s1: **6/6** (was 1/6).
- Full gate battery + STRICT_FIXPOINT: recorded in the commit message.

## Scope narrowing: the broad (TS-faithful) rule breaks stage-2 self-emission

The first fix attempt rerouted for EVERY concrete expected type (exactly TS).
First-order gates were ALL green (battery incl. walker 6/6 + temp 7/7 +
module_struct_unification 10 + ref_struct 3 + fn 24; corpus PASS 140/DIFF 0;
check ./std 153/153; stage2 emit + clang OK) — but the resulting **s2 binary
SIGSEGVs at prelude eval** (EXC_BAD_ACCESS NULL+0x40, consistent across runs
and under lldb — NOT the phantom-kill pattern). Backtrace: the dup/drop
optimizer chain (`_optimize_dup_drop_pairs` → `_contains_return_for_opt` →
contains-return predicate) walking a corrupted AstExpr while
`_trial_eval_anon_body` def-evals a prelude closure. The broad rule changes
the emitted construction of every NAMED-struct literal site in yo-self itself
(e.g. types/utils.yo IntRange `{min,max}` → now ctor-of-ref-struct), and
fix_s1's self-emission of that path miscompiles somewhere — a second-order
codegen gap not covered by the corpus.

Probes that ruled out the obvious suspects (all CORRECT under the broad-rule
s1, and notably BROKEN under the round-7 committed s1): enum-variant payload
literal (`TV.St({...})`), variant struct-payload destructuring
(`.St({ payload : p })`), ref-struct Option payload (`.Some({min,max})`
against `ref(struct(...))` — r7 emitted the t1-vs-t3 incompatible-type C
errors on this). The broad rule is strictly better first-order; the
regression is only in the self-application.

**Current scope:** reroute only when the expected type is a `.Struct` with
`name == ""` and not a source namespace — the anonymous inline-struct class
(the broken one). Named expecteds keep the anonymous-struct path. Revisit the
broad rule when the stage-2 miscompile is hunted down (start from the
crashing predicate chain above and diff its emission r7 vs broad-f8; binaries
/tmp/f8_s2 + C at /tmp/f8_stage2.c reproduce it on `check /tmp/tiny.yo`).

## Relation to Gap-6

Same family (spec-identity divergence across evaluation passes), different
creation site: here the fresh identity came from the anon-LITERAL evaluator,
not the ctor memo. The imm\_\*/collections core (attempt #8,
issues/yo-self-gap6-ctor-memo-reconciliation-attempt7.md) remains open —
its List(T) split involves ctor-stamped instances, which this fix does not
touch.
