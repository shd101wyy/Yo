import { type Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { type Expr, type FnCallExpr } from "../../expr";
import { areTypesCompatible } from "../../types/compatibility";
import { isSomeType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import type { EvaluatorContext } from "../context";
import { _evaluateExpression } from "./_expr";

export function evaluateAbort({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  // abort(value) — returns from the enclosing function with the given value.
  // Only valid inside a function that has an enclosing function available.
  const enclosingReturnType = context.enclosingFunctionReturnType;
  if (!enclosingReturnType) {
    throw formatErrorMessage({
      token: expr.func.token,
      errorMessage: `\`abort\` can only be used inside a function that has an enclosing function.`,
    });
  }

  if (!context.isInsideGivenHandler) {
    throw formatErrorMessage({
      token: expr.func.token,
      errorMessage: `\`abort\` can only be used inside a \`given\` handler definition.`,
    });
  }

  // Evaluate the argument (the value to return from the enclosing function)
  const arg = expr.args[0];
  if (!arg) {
    throw formatErrorMessage({
      token: expr.func.token,
      errorMessage: `\`abort\` requires exactly one argument.`,
    });
  }

  const evaluatedArg = _evaluateExpression({
    expr: arg,
    env,
    context: {
      ...context,
      expectedType: {
        type: enclosingReturnType,
        env,
      },
    },
  });
  if (!evaluatedArg.$) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Failed to evaluate the argument of \`abort\`.`,
    });
  }

  // Type-check: the argument type must be compatible with enclosingFunctionReturnType.
  // Skip when enclosingFunctionReturnType is SomeType (unresolved forall param like T),
  // because T will be resolved to the concrete type at each call site.
  if (
    !isSomeType(enclosingReturnType) &&
    !areTypesCompatible(
      { type: enclosingReturnType, env },
      { type: evaluatedArg.$.type, env }
    )
  ) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Incompatible type for \`abort\` argument:
- Expected (enclosing function return type): ${typeToString(enclosingReturnType)}
- Got: ${typeToString(evaluatedArg.$.type)}`,
    });
  }

  // abort(value) is control flow — it doesn't produce a value.
  // Its type is the enclosing function's return type, and it's marked as
  // controlFlow: "abort" so that the begin block and codegen know how to handle it.
  expr.args[0] = evaluatedArg;
  expr.$ = {
    ...expr.$,
    env,
    type: evaluatedArg.$.type,
    value: undefined,
    pathCollection: [],
    controlFlow: "abort",
  };
  return expr;
}
