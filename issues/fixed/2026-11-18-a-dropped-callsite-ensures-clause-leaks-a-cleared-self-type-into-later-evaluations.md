# A dropped callsite-ensures clause leaks a cleared `ctx.self_type` into every later evaluation of the file

**Severity:** S2 — `yo verify <file>` failed the whole file's evaluation ("1 file(s) failed evaluation") on valid
source after the 3d retype; the develop battery's "Self-verification sweep (front end, ratcheted)" job was red on
`./src/parser.yo`. `check`/`compile`/`test` were unaffected (the callsite-ensures pass runs only for `yo verify`
targets), so the blast radius is `yo verify` on a file with the trigger shape.

**Status:** FIXED on `v0279/verify-self`. Found red on develop `c83d4bf70` (#1992, V5 part B 3d — `AstExpr` is
`Rc(AstExprNode)`); every tip since was red. The 3c retype (#1986, `Token` is `Rc(TokenData)`) stayed green because
`TokenData` derives `Eq(TokenData)` and `AstExprNode` deliberately does not.

## Reproducer

```text
$ yo verify ./src/parser.yo
error: (3) Failed to evaluate type expression: Self
    --> ./src/parser.yo:535:20
    |
535 |     fn(self : &mut Self, part : &AstExpr, d_tok : &Token, append_tok : &Token, borrow_tok : &Token, name_tok : &Token, outer_tok : &Token) -> AstExpr
    |                    ^^^^
yo: error: verify: 1 file(s) failed evaluation
```

The minimized trigger (`tests/internal/verifier_callsite_self_drop.test.yo` writes and loads it):

```yo
pragma(Pragma.Verify);
{ ArrayList } :: import("std/collections/array_list");

ElemNode :: enum(
  Leaf(n : i32)
);
Elem :: Rc(ElemNode);

Builder :: struct(
  items : ArrayList(Elem)
);

impl(
  Builder,
  first : (fn(self : &mut Self) -> unit)({
    self.items.push(Rc.new(ElemNode.Leaf(i32(1))));
  }),
  second : (fn(self : &mut Self, more : i32) -> unit)({
    self.items.push(Rc.new(ElemNode.Leaf(more)));
  })
);
```

Three ingredients: an `Rc` handle over a payload type WITHOUT `Eq` (`ElemNode` here; `AstExprNode` in the real file —
deep `==` on AST nodes whose fresh-id clones differ by construction would be wrong, so 3d derived nothing), an impl
member whose body PUSHES that element into an `ArrayList` (the push callsite's ensures element clause
`self(k) == value` needs `==` on the element type), and a LATER sibling member whose SIGNATURE resolves `Self`
(`self : &mut Self`) — `_template_append_call` after `_template_method_call` in `src/parser.yo`.

## Root cause

The chain, each link probed (`YO_DEBUG_SWALLOW=1`, `YO_DEBUG_WARM=1`):

1. `run_verify_cmd` arms the mode override and target paths, so for every fn body in the target file
   `src/evaluator/calls/function_type.yo` runs `prepare_callsite_contracts` after the def-time body trial
   (`function_type.yo:2053`).
2. For `prop_args.push(recv)` inside `_template_method_call`'s body, `_stash_callsite_contracts` evaluates
   `ArrayList.push`'s ensures element clause at the callsite's concrete types
   (`evaluator/builtins/contracts.yo:2246`).
3. The clause's `self(k) == value` dispatches `Rc`'s `Eq` member
   (`(==) : ((lhs, rhs) -> unsafe(lhs._cell.* == rhs._cell.*))`, `std/prelude.yo:9922`). Evaluating that operator
   body SPECIALIZES it: `create_specialized_function_inline`'s b1 branch — the operator lambda has no `self`
   parameter but its FuncVal carries the matched receiver as a `Self` capture — CLEARS `ctx.self_type`
   (`src/evaluator/calls/helper.yo`, `[specself] src=b1-self-capture self=<none> prev=<Parser>`), saving the
   previous value (`Some(Parser)`, the ambient of the impl member loop) for a restore that sits AFTER the body
   evaluation.
4. The body's `lhs._cell.* == rhs._cell.*` raises E0610 (`AstExprNode` has no `==`). The catch is
   `_callsite_ensures_or_drop`'s handler, installed FAR ABOVE (`contracts.yo:2292`): it `unwind`s, and the unwind
   skips every restore between it and the throw. TWO restores were skipped, in two layers:
   - **Layer 1** — the specialization's own context restore (`create_specialized_function_inline`,
     `src/evaluator/calls/helper.yo`): `ctx.self_type` stayed `None`. The `Parser` impl member loop then reached
     `_template_append_call`, whose fn-type evaluation resolved `self : &mut Self` with `ctx.self_type` `None`
     and no `Self` binding in the signature env (`[selfatom] path=env-lookup self_vars=0` at `parser.yo:534:19`),
     `_eval_and_update_env` returned `.None`, and the load failed with
     `(3) Failed to evaluate type expression: Self`.
   - **Layer 2** — the operator DISPATCH's save/restore (`src/evaluator/calls/function.yo`, the
     `saved_op_self`/`ctx.self_type = Some(receiver_ty)` pair around `try_to_call_function_with_arguments`):
     `ctx.self_type` stayed `Some(Rc(AstExprNode))` (the receiver of the matched `==`). Fixing layer 1 alone let
     the signature resolve — to `&mut Rc(AstExprNode)` — and the failure moved one step deeper: the member's
     body trial failed with `error[E0610]: No method "alloc_id" on Rc(Self) ... its payload AstExprNode`
     at `parser.yo:538`.

`check ./src` stayed 273/273 because the callsite-ensures pass is gated on `_is_verify_target` + a verify mode, so
the E0610 never happens there. The drop itself is sound and by design ("Assuming less about the callee's effect
is sound"); the defect is that neither the specialization's nor the operator dispatch's context restores were
exception-safe against a handler that catches above them.

## Fix

Both leaking restore pairs now run on every exit, using the trap-and-re-raise idiom the evaluator already uses
(`_create_specialization_trapped`): the throwing call runs under a local trap exception whose handler unwinds
out of a small helper CARRYING the error; the caller runs its restores; only then does it re-raise through the
real `exn`. The same `AnyError` object reaches the same handler as before — after the restores, not before them.

- `src/evaluator/calls/helper.yo`: the specialized body evaluation and its result-type checks (E0604) moved into
  `_eval_and_check_specialized_body`, so `create_specialized_function_inline` restores `ctx.self_type`,
  `expected_type`, `captured_variables`, the where-trait stack and `currently_specializing_*` on every exit
  (layer 1).
- `src/evaluator/calls/function.yo` + `_try_call_fn_with_args_trapped` (helper.yo): the operator dispatch's
  `try_to_call_function_with_arguments` call runs trapped, so its `saved_op_self`/`saved_op_et` restores run
  before the re-raise (layer 2).

Other save/restore pairs of the same shape exist in the evaluator (method dispatch, HKT specialization); none of
them is on this unwind path, and they keep their current behavior — noted here so a future instance of the class
has a map.

## Verification

- `tests/internal/verifier_callsite_self_drop.test.yo` — with the two fixed files reverted to develop, the run
  fails with exactly the battery error (`verify-mode load failed: error: (3) Failed to evaluate type expression:
  Self` at the fixture's `second : (fn(self : &mut Self, ...))` member); with the fix it passes (1/1). Solver-free.
- `yo verify ./src/{lexer,token,parser,expr,formatter}.yo` (the sweep's list, one per invocation) — all rc=0
  with a tree-built stage-1 (`yo build --std-path ./std` on this branch); `./src/parser.yo` was the red one.
- `bash scripts/verify-src-sweep.sh --path ./src/lexer.yo --path ./src/token.yo --path ./src/parser.yo --path
  ./src/expr.yo --path ./src/formatter.yo` (the CI job's exact command) — `ratchet OK (0 proved; baseline 0)`,
  270 functions swept, nothing refuted.
- `yo check ./src --std-path ./std` — 273/273. `yo check ./std --std-path ./std` — 171/171.
- `yo verify ./tests/spec/verify_straight_line.test.yo --format json` — harness_ok, 7/7 ok (the verifier's own
  proving is unaffected).
