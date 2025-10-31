import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  Expr,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { generateExprFromCode } from "../../parser";
import { BuiltinModules } from "../../types/builtin_modules";
import { isComptStringValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateYoEvalBuiltinModule({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_eval_builtin_module,
    1
  );

  const argExpr = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: {
      ...context,
    },
  });

  if (!argExpr.$ || !isComptStringValue(argExpr.$.value)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected compt_string type for "__yo_eval_builtin_module" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }
  const builtinModule: string | undefined =
    BuiltinModules[argExpr.$.value.value];
  if (!builtinModule) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Unknown builtin module name "${argExpr.$.value.value}"`,
    });
  }

  // Evaluate the builtin module code
  return evaluateExpression({
    expr: generateExprFromCode(builtinModule.trim().replace(/;$/, "")),
    env,
    context: {
      ...context,
    },
  });
}
