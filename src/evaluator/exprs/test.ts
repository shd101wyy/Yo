import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  cloneExpr,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { isUnitType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import { VUnit } from "../../unit-value";
import { isComptimeStringValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "./expr";

/**
 * Evaluate a test declaration.
 *
 * During normal compilation, test declarations are skipped (no-op, returns unit).
 * The test runner will extract these declarations and compile/run them separately.
 *
 * Syntax:
 *   test "test_name", { body };
 *   test "test_name", using(io : IO), { body };
 *
 * @param expr The test expression
 * @param env The current environment
 * @param context The evaluator context
 * @returns The expression with unit type (no-op)
 */
export function evaluateTest({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.test)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected test, got ${expr.tag}`,
    });
  }

  // Validate the test expression has correct number of arguments
  // 2 args: test "name", { body }
  // 3 args: test "name", using(...), { body }
  if (expr.args.length !== 2 && expr.args.length !== 3) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `test expects 2 or 3 arguments (name, [using clause], body), got ${expr.args.length}`,
    });
  }

  const hasUsingClause = expr.args.length === 3;
  const testNameExpr = expr.args[0]!;
  const testUsingExpr = hasUsingClause ? expr.args[1]! : undefined;
  const testBodyExpr = hasUsingClause ? expr.args[2]! : expr.args[1]!;

  // Validate using clause is a using(...) call if present
  if (
    testUsingExpr &&
    !exprIsFunctionCallOf(testUsingExpr, BuiltinKeywords.using)
  ) {
    throw formatErrorMessage({
      token: testUsingExpr.token,
      errorMessage: `Expected using(...) clause as second argument, got: ${exprToString(testUsingExpr)}`,
    });
  }

  // Evaluate test name to ensure it's a comptime_string
  const evaluatedTestNameExpr = evaluateExpression({
    expr: testNameExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedTestNameExpr.$ || !evaluatedTestNameExpr.$.value) {
    throw formatErrorMessage({
      token: testNameExpr.token,
      errorMessage: `Failed to evaluate test name: ${exprToString(testNameExpr)}`,
    });
  }

  env = evaluatedTestNameExpr.$.env;

  if (!isComptimeStringValue(evaluatedTestNameExpr.$.value)) {
    throw formatErrorMessage({
      token: testNameExpr.token,
      errorMessage: `Expected string for test name, got ${exprToString(testNameExpr)}`,
    });
  }

  if (hasUsingClause) {
    // When a using clause is present, store the original expressions but
    // don't evaluate the body — it depends on the using parameters which
    // aren't in scope here. The test runner will compile each test
    // independently with proper main :: (fn(using(...)) -> unit) signature.
    const originalTestUsingExpr = cloneExpr(testUsingExpr!);
    testUsingExpr!.$ = {
      env,
      type: VUnit.type,
      value: VUnit,
      pathCollection: [],
      originalExpr: originalTestUsingExpr,
    };

    const originalTestBodyExpr = cloneExpr(testBodyExpr);
    testBodyExpr.$ = {
      env,
      type: VUnit.type,
      value: VUnit,
      pathCollection: [],
      originalExpr: originalTestBodyExpr,
    };
  } else {
    const originalTestBodyExpr = cloneExpr(testBodyExpr);

    // Evaluate the test body to catch any compile-time errors
    // We evaluate it but don't execute it during normal compilation
    const evaluatedTestBodyExpr = evaluateExpression({
      expr: testBodyExpr,
      env,
      context: {
        ...context,
        isEvaluatingFunctionBodyOrAsyncBlock: {
          kind: "test-block",
          evaluationEnv: env,
        },
      },
    });

    if (!evaluatedTestBodyExpr.$) {
      throw formatErrorMessage({
        token: testBodyExpr.token,
        errorMessage: `Failed to evaluate test body: ${exprToString(testBodyExpr)}`,
      });
    }
    if (!isUnitType(evaluatedTestBodyExpr.$.type)) {
      throw formatErrorMessage({
        token: testBodyExpr.token,
        errorMessage: `Test body must have 'unit' type, got ${typeToString(evaluatedTestBodyExpr.$.type)}`,
      });
    }
    evaluatedTestBodyExpr.$.originalExpr = originalTestBodyExpr;
  }

  // NOTE: Don't propagate env.
  // env = evaluatedTestBodyExpr.$.env;

  // Return unit value (no-op) - the test doesn't produce a runtime value
  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };

  return expr;
}
