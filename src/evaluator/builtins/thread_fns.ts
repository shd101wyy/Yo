import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  Expr,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { createThreadType } from "../../types/creators";
import { isThreadType } from "../../types/guards";
import { VUnit } from "../../unit-value";
import { EvaluatorContext } from "../context";
import { addARCFunctionsToThreadType } from "../types/utils";

/**
 * Evaluates the spawn builtin function.
 *
 * spawn takes a function call expression and executes it in a separate thread,
 * returning a Thread(T) where T is the return type of the spawned function.
 *
 * Examples:
 * - spawn say("hello") -> Thread(unit)
 * - spawn compute(42) -> Thread(i32)
 *
 * @param params - The evaluation parameters
 * @returns The function call expression with Thread type annotation
 */
export function evaluateSpawn({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.spawn, 1);

  const functionCallExpr = expr.args[0]!;

  // Evaluate the function call expression to get its return type
  // We need to evaluate this to determine what Thread(T) type to return
  const evaluatedExpr = context.evaluateExpression({
    expr: functionCallExpr,
    env,
    context: { ...context },
  });

  if (!evaluatedExpr.$) {
    throw formatErrorMessage({
      token: functionCallExpr.token,
      errorMessage: `Failed to evaluate expression.`,
    });
  }

  env = evaluatedExpr.$.env;

  // Create Thread type based on the result type
  const threadType = createThreadType(evaluatedExpr.$.type, env);

  // Add ARC functions to the thread type
  env = addARCFunctionsToThreadType({
    threadType,
    env,
    context: { ...context },
  });

  // Set the evaluation result - spawn returns a Thread(T)
  // The actual thread spawning will be handled in the C code generation phase
  expr.$ = {
    env,
    type: threadType,
    value: undefined, // Runtime value, not compile-time
    pathCollection: [],
  };

  attachTempVariableToExpr(expr, true);

  return expr;
}

/**
 * Evaluates the __yo_thread_wait builtin function.
 *
 * __yo_thread_wait takes a Thread(T) and blocks until the thread completes,
 * then returns the result of type T.
 *
 * Examples:
 * - __yo_thread_wait(thread) -> T (where thread is Thread(T))
 *
 * @param params - The evaluation parameters
 * @returns The expression with the return type of the thread
 */
export function evaluateThreadWait({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_thread_wait, 1);

  const threadExpr = expr.args[0]!;

  // Evaluate the thread expression
  const evaluatedExpr = context.evaluateExpression({
    expr: threadExpr,
    env,
    context: { ...context },
  });

  if (!evaluatedExpr.$) {
    throw formatErrorMessage({
      token: threadExpr.token,
      errorMessage: `Failed to evaluate expression.`,
    });
  }

  env = evaluatedExpr.$.env;

  // Verify it's a Thread type and extract the return type
  if (!isThreadType(evaluatedExpr.$.type)) {
    throw formatErrorMessage({
      token: threadExpr.token,
      errorMessage: `Expected Thread type, got ${evaluatedExpr.$.type.tag}`,
    });
  }

  // For Thread(T), __yo_thread_wait should return type T
  const threadType = evaluatedExpr.$.type;
  const returnType = threadType.returnType;

  // Set the evaluation result - __yo_thread_wait returns T where the input is Thread(T)
  // The actual thread waiting will be handled in the C code generation phase
  expr.$ = {
    env,
    type: returnType,
    value: undefined, // Runtime value, not compile-time
    pathCollection: [],
  };

  attachTempVariableToExpr(expr, true);

  return expr;
}

/**
 * Evaluates __yo_thread_drop builtin function.
 * Just evaluates the argument and returns unit.
 */
export function evaluateYoThreadDrop({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, [BuiltinFunctions.__yo_thread_drop[0]!]);

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = context.evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_thread_drop[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

/**
 * Evaluates __yo_thread_dup builtin function.
 * Just evaluates the argument and returns unit.
 */
export function evaluateYoThreadDup({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, [BuiltinFunctions.__yo_thread_dup[0]!]);

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = context.evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_thread_dup[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}
