import { addVariableToEnv, Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, FuncCallExpr } from "../../expr";
import { VUnit } from "../../unit-value";
import { isModuleValue } from "../../value";
import { EvaluatorContext } from "../context";

/**
 *
 * Import everything from a module
 *
 */
export function evaluateOpen({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  const moduleArg = expr.args[0];
  if (!moduleArg) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "using" with 1 argument, got:\n${exprToString(expr)}`,
    });
  }

  // Evaluate the module
  const evaluatedModuleArg = context.evaluateExpression({
    expr: moduleArg,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedModuleArg.$) {
    throw formatErrorMessage({
      token: moduleArg.token,
      errorMessage: `Failed to evaluate the module argument:\n${exprToString(moduleArg)}`,
    });
  }

  const moduleValue = evaluatedModuleArg.$.value;
  if (!isModuleValue(moduleValue)) {
    throw formatErrorMessage({
      token: moduleArg.token,
      errorMessage: `Expected module value for "using", got:\n${exprToString(moduleArg)}`,
    });
  }

  const moduleType = moduleValue.type;

  // Import everything from the module
  for (let i = 0; i < moduleType.elements.length; i++) {
    const value = moduleValue.elements[i]!;
    const element = moduleType.elements[i]!;
    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: element.label,
        type: element.type,
        isMutable: false,
        isCompileTimeOnly: element.isCompileTimeOnly,
        isImplicit: element.isImplicit,
        token: element.exprs.labelExpr?.token ?? element.exprs.expr.token,
        isUndefined: false,
        value: value,
      },
    });
    env = nextEnv;
  }

  expr.$ = {
    env,
    value: VUnit,
    type: VUnit.type,
    isMutable: false,
    pathCollection: [],
  };

  return expr;
}
