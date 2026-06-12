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
 * All tests implicitly have `using(io : Io)` — the Io effect is always available.
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
      errorMessage: `test expects 2 arguments (name, body), got ${expr.args.length}. Io is implicitly available via "io" — no using clause needed.`,
    });
  }

  const testNameExpr = expr.args[0]!;
  const testBodyExpr = expr.args[1]!;

  // Evaluate test name to ensure it's a comptime_str
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

  // Inject `io : Io` as an implicit variable so test bodies can reference it.
  // At runtime, main has `using(io : Io)` and the body is inlined into main.
  // The variable `Io` in the env is the effect record type definition:
  //   Io :: struct(async: ..., await: ..., spawn: ...)
  // Its type is the metatype (Type), and its value is TypeValue(StructType).
  // We need the actual StructType for the `io` parameter.
  const ioVariables = getVariablesFromEnv(env, "Io");
  const ioTypeVar = ioVariables[ioVariables.length - 1];
  if (!ioTypeVar) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Io module not found in environment. Is the prelude loaded?`,
    });
  }

  // Extract the actual StructType from Io's TypeValue.
  const ioRawValue = Array.isArray(ioTypeVar.value)
    ? ioTypeVar.value[0]
    : ioTypeVar.value;
  const ioStructType =
    ioRawValue && isTypeValue(ioRawValue) ? ioRawValue.value : ioTypeVar.type;

  // Push a frame for the implicit io parameter
  let bodyEnv = pushEnvFrame(env);

  // Create an UnknownValue for io — the actual value is provided at runtime.
  // Using parameters use [value] array format for given-variable resolution.
  const ioUnknownValue = createUnknownValue(ioStructType, {
    variableName: "io",
    env: bodyEnv,
    context,
  });

  const ioVar: Omit<Variable, "id" | "frameLevel"> = {
    name: "io",
    type: ioStructType,
    value: [ioUnknownValue],
    isCompileTimeOnly: true,
    isOwningTheRcValue: false,
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

  // Trial-evaluate the test body in a synthetic function-body context.
  //
  // Under explicit effects, the test runner generates
  //   main :: (fn(io : Io, exn : Exception) -> unit)({ ...test body... })
  // and inlines test bodies into it; that's where the *authoritative*
  // type check happens at build time. The trial evaluation here just
  // surfaces obvious mistakes earlier — but it operates from a test-block
  // context that takes a different generic-inference path than a real
  // function body, and some valid patterns (notably `io.async(closure)`
  // where T binds from the closure's return type) fail in the trial
  // even though they compile fine in the real main wrapper. Swallow
  // trial errors so test extraction proceeds; the test-runner's compile
  // step will surface any genuine problems.
  try {
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

    if (evaluatedTestBodyExpr.$ && isUnitType(evaluatedTestBodyExpr.$.type)) {
      evaluatedTestBodyExpr.$.originalExpr = originalTestBodyExpr;
    }
  } catch {
    // Trial-eval errors are non-fatal — see comment above.
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
