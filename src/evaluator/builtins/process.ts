import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  exprIsFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import { createComptimeStringType } from "../../types/creators";
import { createComptimeStringValue } from "../../value";
import type { EvaluatorContext } from "../context";

/**
 * Evaluate process-related builtin functions
 */
export function evaluateYoProcessFunctions({
  expr,
  env,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  // __yo_process_platform - returns process.platform
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_process_platform)) {
    if (expr.args.length !== 0) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_process_platform expects 0 arguments, got ${expr.args.length}`,
      });
    }

    // In compile-time evaluation, return the actual platform value
    const platform = process.platform; // 'darwin', 'linux', 'win32', etc.
    const value = createComptimeStringValue(platform);

    expr.$ = {
      env,
      type: createComptimeStringType(),
      value,
      pathCollection: [],
    };

    return expr;
  }

  // __yo_process_arch - returns process.arch
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_process_arch)) {
    if (expr.args.length !== 0) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_process_arch expects 0 arguments, got ${expr.args.length}`,
      });
    }

    // In compile-time evaluation, return the actual architecture value
    const arch = process.arch; // 'x64', 'arm64', 'ia32', etc.
    const value = createComptimeStringValue(arch);

    expr.$ = {
      env,
      type: createComptimeStringType(),
      value,
      pathCollection: [],
    };

    return expr;
  }

  throw formatErrorMessage({
    token: expr.token,
    errorMessage: `Unknown process function: ${expr.func.token.value}`,
  });
}
