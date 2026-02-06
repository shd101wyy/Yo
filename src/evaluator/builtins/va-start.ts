import {
  type Environment,
  getVariablesFromEnv,
  updateExistingVariable,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprIsAtom,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { VUnit } from "../../unit-value";
import type { EvaluatorContext } from "../context";
import { isValidVariableName } from "../utils";

/**
 * va_start is a built-in function that is used to start processing variadic arguments.
 * It can accept two arguments:
 * 1. The va_list argument
 * 2. The last parameter name
 * @returns
 */
export function evaluateVaStart({
  expr,
  env,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.va_start);

  // Require all the args to be atom of identifier
  for (let i = 0; i < expr.args.length; i++) {
    const arg = expr.args[i]!;
    if (!exprIsAtom(arg) || !isValidVariableName(arg)) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Invalid argument for va_start. Expected identifier, got:\n${exprToString(arg)}`,
      });
    }

    // If it's the first argument, then we set it as initialized
    if (i === 0) {
      const varName = arg.token.value;
      const variables = getVariablesFromEnv(env, varName);
      if (variables.length === 0) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Variable '${varName}' not found in the environment.`,
        });
      }
      const variable = variables[variables.length - 1]!;
      // Update the environment to mark the variable as initialized
      env = updateExistingVariable(env, variable, {
        ...variable,
        initializedAtToken: arg.token,
      });
    }

    // If it's the second argument, we check if it's a variable existing in the env
    // In theory, it should be the last parameter name of the function
    // but let's simplify it to just checking if it's a variable for now
    if (i === 1) {
      const varName = arg.token.value;
      const variables = getVariablesFromEnv(env, varName);
      if (variables.length === 0) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Variable '${varName}' not found in the environment.`,
        });
      }
      // We don't need to update the variable here, just ensure it exists
    }
  }

  expr.$ = {
    type: VUnit.type,
    value: VUnit,
    env,
    pathCollection: [],
  };
  return expr;
}
