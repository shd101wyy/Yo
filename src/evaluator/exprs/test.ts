import type { Environment, Variable } from "../../env";
import { addVariableToEnv, getVariablesFromEnv, pushEnvFrame } from "../../env";
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
import {
  isComptimeStringValue,
  createUnknownValue,
  isTypeValue,
} from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "./expr";

/**
 * Evaluate a test declaration.
 *
 * During normal compilation, test declarations are skipped (no-op, returns unit).
 * The test runner will extract these declarations and compile/run them separately.
 *
 * All tests implicitly have `using(io : IO)` — the IO effect is always available.
 *
 * Syntax:
 *   test "test_name", { body };
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

  // Validate the test expression has exactly 2 arguments: test "name", { body }
  if (expr.args.length !== 2) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `test expects 2 arguments (name, body), got ${expr.args.length}. IO is implicitly available via "io" — no using clause needed.`,
    });
  }

  const testNameExpr = expr.args[0]!;
  const testBodyExpr = expr.args[1]!;

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

  // Inject `io : IO` as an implicit variable so test bodies can reference it.
  // At runtime, main has `using(io : IO)` and the body is inlined into main.
  // The variable `IO` in the env is the module type definition:
  //   IO :: module(async: ..., await: ..., spawn: ...)
  // Its type is the metatype (Type), and its value is TypeValue(ModuleType).
  // We need the actual ModuleType for the `io` parameter.
  const ioVariables = getVariablesFromEnv(env, "IO");
  const ioModuleVar = ioVariables[ioVariables.length - 1];
  if (!ioModuleVar) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `IO module not found in environment. Is the prelude loaded?`,
    });
  }

  // Extract the actual ModuleType from IO's TypeValue.
  // IO :: module(...) means ioModuleVar.value is TypeValue(ModuleType(...)).
  const ioRawValue = Array.isArray(ioModuleVar.value)
    ? ioModuleVar.value[0]
    : ioModuleVar.value;
  const ioModuleType =
    ioRawValue && isTypeValue(ioRawValue) ? ioRawValue.value : ioModuleVar.type;

  // Push a frame for the implicit io parameter
  let bodyEnv = pushEnvFrame(env);

  // Create an UnknownValue for io — the actual value is provided at runtime.
  // Using parameters use [value] array format for given-variable resolution.
  const ioUnknownValue = createUnknownValue(ioModuleType, {
    variableName: "io",
    env: bodyEnv,
    context,
  });

  const ioVar: Omit<Variable, "id" | "frameLevel"> = {
    name: "io",
    type: ioModuleType,
    value: [ioUnknownValue],
    isCompileTimeOnly: true,
    isOwningTheRcValue: false,
    isImplicit: true,
    isReassignable: false,
    initializedAtToken: expr.token,
    consumedAtToken: undefined,
    token: expr.token,
  };
  const addResult = addVariableToEnv({
    env: bodyEnv,
    variable: ioVar,
    allowVariableShadowing: true,
  });
  bodyEnv = addResult.env;

  const originalTestBodyExpr = cloneExpr(testBodyExpr);

  // Evaluate the test body to catch any compile-time errors
  const evaluatedTestBodyExpr = evaluateExpression({
    expr: testBodyExpr,
    env: bodyEnv,
    context: {
      ...context,
      isEvaluatingFunctionBodyOrAsyncBlock: {
        kind: "test-block",
        evaluationEnv: bodyEnv,
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
