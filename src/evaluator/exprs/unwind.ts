import { type Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { controlFlowOf, type Expr, type FnCallExpr } from "../../expr";
import { areTypesCompatible } from "../../types/compatibility";
import { isSomeType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import { VUnit } from "../../unit-value";
import type { EvaluatorContext } from "../context";
import { _evaluateExpression } from "./_expr";

export function evaluateUnwind({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  // unwind(value) — returns from the enclosing function with the given
  // value. Only valid inside a `ctl(...) -> ret` body; that constraint
  // is enforced at the FunctionValue-creation sites
  // (anonymous-function.ts, function-type.ts) via the
  // `evaluatedBodyContainsEscape` + `FunctionType.isControl` check.
  // Here we only verify there *is* an enclosing function to unwind to.
  const enclosingReturnType = context.enclosingFunctionReturnType;
  if (!enclosingReturnType) {
    throw formatErrorMessage({
      token: expr.func.token,
      errorMessage: `\`unwind\` can only be used inside a function that has an enclosing function.`,
    });
  }

  if (expr.args.length > 1) {
    throw formatErrorMessage({
      token: expr.func.token,
      errorMessage: `\`unwind\` accepts at most one argument.`,
    });
  }

  // Evaluate the argument (the value to return from the enclosing function)
  const arg = expr.args[0];
  if (!arg) {
    if (
      !isSomeType(enclosingReturnType) &&
      !areTypesCompatible(
        { type: enclosingReturnType, env },
        { type: VUnit.type, env }
      )
    ) {
      throw formatErrorMessage({
        token: expr.func.token,
        errorMessage: `Incompatible type for \`unwind\` argument:
- Expected (enclosing function return type): ${typeToString(enclosingReturnType)}
- Got: ${typeToString(VUnit.type)}`,
      });
    }

    expr.$ = {
      ...expr.$,
      env,
      type: VUnit.type,
      value: undefined,
      pathCollection: [],
      controlFlow: controlFlowOf("unwind"),
    };
    return expr;
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
      errorMessage: `Failed to evaluate the argument of \`unwind\`.`,
    });
  }

  // Type-check: the argument type must be compatible with enclosingFunctionReturnType.
  // Skip when enclosingFunctionReturnType is SomeType (unresolved generic param like T),
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
      errorMessage: `Incompatible type for \`unwind\` argument:
- Expected (enclosing function return type): ${typeToString(enclosingReturnType)}
- Got: ${typeToString(evaluatedArg.$.type)}`,
    });
  }

  // unwind(value) is control flow — it doesn't produce a value.
  // Its type is the enclosing function's return type, and it's marked as
  // controlFlow: "unwind" so that the begin block and codegen know how to handle it.
  expr.args[0] = evaluatedArg;
  expr.$ = {
    ...expr.$,
    env,
    type: evaluatedArg.$.type,
    value: undefined,
    pathCollection: [],
    controlFlow: controlFlowOf("unwind"),
  };
  return expr;
}
