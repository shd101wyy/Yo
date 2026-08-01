#!/usr/bin/env python3
"""Port TS helper.ts:1515-1530 into yo-self's SECOND return-type computation.

    python3 scratchpad/apply_reapply_where_in_spec.py
    ./yo-cli fmt yo-self/evaluator/calls/helper.yo
    ./yo-cli check ./yo-self | tail -1        # expect 295/305

TS computes a call's return type exactly once, in
`_tryToCallFunctionWithArgumentsImpl` (src/evaluator/calls/helper.ts:845), and
immediately BEFORE it re-applies the function's where-clause constraint
expressions in the now-parameter-bound callee env:

    // Re-apply where-clause constraints for this function call now that
    // parameters are bound in calleeEnv (needed for return type resolution).
    if (functionType.whereClauseExprs?.length) { ... calleeEnv = result.env; }   // :1515-1529
    ...
    } = evaluateFunctionReturnTypeAgain({ ... });                                 // :1538

yo-self splits that TS function in two. `try_to_call_function_with_arguments`
(helper.yo:3967) already carries the port — `reapply_where_clause_exprs_for_call`
at :5140. `create_specialized_function_inline` (helper.yo:1504) computes the SAME
return type via `evaluate_function_return_type_again` and never re-applied.

Consequence, measured on a standalone repro (`it1.local_map_to(double)` with
`where(Self <: Iterator(Item := A), F <: (Fn(a : A) -> B))`):
  TS      -> LocalMapIter(ArrayListIter(i32), i32, i32, fn(x : i32) -> i32)
  yo-self -> gs_<ctor>_<ArrayListIter(i32)>_1499_1500_<fn…>   (A, B raw SomeT ids)
A and B are bindable ONLY by satisfying the where clause, so without the
re-apply they stay SomeTs, the specialized return type is a SECOND instantiation
of the constructor, and C sees two incompatible structs with identical layout
("initializing '__yo_t9' with an expression of incompatible type '__yo_t24'").

Yo has no forward references, so step 1 MOVES `reapply_where_clause_exprs_for_call`
(with its doc block) above `create_specialized_function_inline`. Its only local
dependency, `_h_get_fn_call_args`, is defined at helper.yo:421; everything else it
uses is imported at the top of the file.
"""
import re
import sys

P = "yo-self/evaluator/calls/helper.yo"
DOC_START = "/// Re-apply the function's where-clause constraint EXPRESSIONS in the bound"
DEF_START = "reapply_where_clause_exprs_for_call :: ("
SPEC_DOC = "/// Mirrors the core (pre-effects) of `createSpecializedFunctionInline` in"
RET_ANCHOR = """          (spec_ret_ty : TypeValue) = evaluate_function_return_type_again(
            match(func_type,.Func({ result : r }) => r, _ => t_unit()),
            callee_env,
            ctx
          );"""

CALL = """          // Re-apply this call's where-clause constraint EXPRESSIONS now that
          // the parameters are bound in `callee_env`. TS does exactly this
          // immediately before its own return-type re-evaluation
          // (helper.ts:1515-1529, whose comment is "needed for return type
          // resolution", then :1538 `evaluateFunctionReturnTypeAgain`).
          // yo-self splits TS's `_tryToCallFunctionWithArgumentsImpl` into
          // `try_to_call_function_with_arguments` — which already re-applies
          // — and THIS specialization path, which recomputes the same return
          // type below and was missing it. A forall that ONLY a where clause
          // can bind (`A` in `where(Self <: Iterator(Item := A),
          // F <: (Fn(a : A) -> B))`) therefore stayed a SomeT in the
          // specialized return type, minting a SECOND instantiation of the
          // type constructor keyed on raw SomeT ids instead of `i32` — two C
          // structs with identical layout that do not typecheck against each
          // other (tests/where_clause_fn_inference).
          reapply_where_clause_exprs_for_call(func_id.clone(), callee_env, ctx, exn);
"""

src = open(P).read()
lines = src.split("\n")

# --- Step 1: cut the function (doc block through its closing `});`).
try:
    i_doc = next(i for i, l in enumerate(lines) if l.startswith(DOC_START))
    i_def = next(i for i, l in enumerate(lines) if l.startswith(DEF_START))
except StopIteration:
    sys.exit("reapply_where_clause_exprs_for_call not found")
if i_def < i_doc:
    sys.exit("doc block is not above the definition")
i_end = next(i for i in range(i_def, len(lines)) if lines[i] == "});")
block = lines[i_doc:i_end + 1]
rest = lines[:i_doc] + lines[i_end + 1:]

# --- Step 2: paste it above create_specialized_function_inline's doc tail.
try:
    i_spec = next(i for i, l in enumerate(rest) if l.startswith(SPEC_DOC))
except StopIteration:
    sys.exit("create_specialized_function_inline doc anchor not found")
if i_spec < 421:
    sys.exit("insertion point is above _h_get_fn_call_args (helper.yo:421)")
moved = rest[:i_spec] + block + rest[i_spec:]
out = "\n".join(moved)

# --- Step 3: call it right before the specialization's return-type re-eval.
if out.count(RET_ANCHOR) != 1:
    sys.exit(f"spec_ret_ty anchor count = {out.count(RET_ANCHOR)}, expected 1")
out = out.replace(RET_ANCHOR, CALL + RET_ANCHOR, 1)

open(P, "w").write(out)
print(f"moved {len(block)} lines of reapply_where_clause_exprs_for_call above "
      f"create_specialized_function_inline, and inserted the call")
print("Now run: ./yo-cli fmt", P, "&& ./yo-cli check ./yo-self | tail -1")
