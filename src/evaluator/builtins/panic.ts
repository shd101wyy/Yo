import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import type { FnCallExpr } from "../../expr";
import { createPtrType } from "../../types/creators";
import {
  isComptimeStringType,
  isPtrType,
  isStrType as isStrTypeGuard,
  isU8Type,
} from "../../types/guards";
import { VUnit } from "../../unit-value";
import { isComptimeStringValue, isUnknownValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluatePanic({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  // Check if panic is being called inside a function context
  if (
    context.isEvaluatingFunctionBodyOrAsyncBlock?.kind !== "function-body" &&
    context.isEvaluatingFunctionBodyOrAsyncBlock?.kind !== "test-block"
  ) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `__yo_panic() can only be called inside a function body or test block`,
    });
  }

  // During CTFE capability analysis, `panic` should fail the analysis
  // This ensures functions containing `panic` cannot be evaluated at compile time
  if (context.isAnalyzingCtfeCapability) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Cannot use "__yo_panic" during compile-time function evaluation analysis. Functions containing "__yo_panic" cannot be evaluated at compile time.`,
    });
  }

  // Panic is divergent — it slots into any expression position. To keep
  // the surrounding type-checker happy, we type it as whatever the local
  // context expects:
  //
  //   1. If the caller propagated an `expectedType` (e.g. a `match` arm's
  //      sibling-arm type, a `cond` arm, an assignment RHS), use that. The
  //      match unifier walks arms in order, so by the time it reaches the
  //      panic-bearing arm it has already inferred the result type — and
  //      forcing panic into that shape lets the unifier succeed instead of
  //      mismatching against the function's overall return type.
  //
  //   2. Otherwise, fall back to the function's return type (the original
  //      Phase B/C `*(T)` rule from plans/archive/ITERATOR_REDESIGN.md — needed
  //      because panic in tail position of an `-> ref(T)` body must
  //      produce `*(T)` to match the body's expected C-ABI return).
  //
  //   3. At module level or outside any function body, fall back to unit.
  const functionReturnType =
    context.expectedType?.type ??
    (context.isEvaluatingFunctionBodyOrAsyncBlock.kind === "function-body"
      ? context.isEvaluatingFunctionBodyOrAsyncBlock.type.return.isRef
        ? createPtrType(
            context.isEvaluatingFunctionBodyOrAsyncBlock.type.return.type
          )
        : context.isEvaluatingFunctionBodyOrAsyncBlock.type.return.type
      : VUnit.type);

  // If there's an argument, evaluate it and use as the panic message
  if (expr.args.length > 0) {
    const messageExpr = expr.args[0]!;
    const evaluatedMessageExpr = evaluateExpression({
      expr: messageExpr,
      env,
      context: {
        ...context,
      },
    });
    // Let's require it to be a comptime_str or str
    if (!evaluatedMessageExpr.$) {
      throw formatErrorMessage({
        token: messageExpr.token,
        errorMessage: `Failed to evaluate panic message`,
      });
    }

    const msgType = evaluatedMessageExpr.$.type;
    const msgValue = evaluatedMessageExpr.$.value;
    const msgIsStr = msgType && isStrTypeGuard(msgType);
    const isComptimeStr =
      msgValue &&
      (isComptimeStringValue(msgValue) ||
        (isUnknownValue(msgValue) && isComptimeStringType(msgValue.type)));
    const msgIsCStr =
      msgType && isPtrType(msgType) && isU8Type(msgType.childType);

    if (!msgIsStr && !isComptimeStr && !msgIsCStr) {
      throw formatErrorMessage({
        token: messageExpr.token,
        errorMessage: `__yo_panic message must be comptime_str, str, or *(u8)`,
      });
    }
  }

  // Set the expression's type to match the function's return type
  expr.$ = {
    env,
    type: functionReturnType,
    value: undefined, // panic never returns a value
    pathCollection: [],
  };

  return expr;
}
