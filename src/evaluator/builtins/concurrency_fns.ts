import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  ExprTag,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { PlaceholderToken } from "../../token";
import { VUnit } from "../../unit-value";
import { EvaluatorContext } from "../context";

/**
 * Evaluates the async builtin function.
 *
 * async takes any expression and wraps it in an anonymous closure that runs asynchronously.
 * The expression is wrapped as: (fn() => unit) { expr; }()
 *
 * Examples:
 * - async say("hello", 18, ch);
 * - async { x := compute(42); process(x); };
 * - async x.method();
 *
 * @param params - The evaluation parameters
 * @returns The expression with unit type, containing the wrapped closure
 */
export function evaluateAsync({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.async, 1);

  const bodyExpr = expr.args[0]!;

  // Create an anonymous closure that wraps the expression:
  // (fn() => unit) { bodyExpr; }()

  // Step 1: Create the function signature: fn()
  const fnSignature: FuncCallExpr = {
    tag: ExprTag.FuncCall,
    token: PlaceholderToken,
    func: {
      tag: ExprTag.Atom,
      token: { ...PlaceholderToken, value: "fn" },
    },
    args: [], // No parameters
  };

  // Step 2: Create the closure type signature: fn() => unit
  const closureTypeSignature: FuncCallExpr = {
    tag: ExprTag.FuncCall,
    token: PlaceholderToken,
    func: {
      tag: ExprTag.Atom,
      token: { ...PlaceholderToken, value: "=>" },
    },
    args: [
      fnSignature,
      {
        tag: ExprTag.Atom,
        token: { ...PlaceholderToken, value: "unit" },
      },
    ],
  };

  // Step 3: Wrap bodyExpr in a begin block that returns unit: begin(bodyExpr, ())
  const beginBlock: FuncCallExpr = {
    tag: ExprTag.FuncCall,
    token: PlaceholderToken,
    func: {
      tag: ExprTag.Atom,
      token: { ...PlaceholderToken, value: "begin" },
    },
    args: [
      bodyExpr, // The expression to execute asynchronously
      {
        tag: ExprTag.FuncCall,
        token: PlaceholderToken,
        func: {
          tag: ExprTag.Atom,
          token: { ...PlaceholderToken, value: "tuple" },
        },
        args: [], // Empty tuple = unit
      },
    ],
  };

  // Step 4: Create the closure implementation by calling the closure type with the body
  // (fn() => unit)(begin(bodyExpr, ()))
  const closureImpl: FuncCallExpr = {
    tag: ExprTag.FuncCall,
    token: PlaceholderToken,
    func: closureTypeSignature, // Call the closure type
    args: [beginBlock], // Pass the begin block as the closure body
  };

  // Step 5: Evaluate the closure implementation to create the closure value
  const evaluatedClosure = context.evaluateExpression({
    expr: closureImpl,
    env,
    context: { ...context },
  });

  if (!evaluatedClosure.$) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Failed to evaluate closure for async.`,
    });
  }

  // DEBUG: Check if capturedVariableDupExpressions is set
  console.log(
    "DEBUG: evaluatedClosure has capturedVariableDupExpressions:",
    evaluatedClosure.$.capturedVariableDupExpressions ? "YES" : "NO"
  );
  if (evaluatedClosure.$.capturedVariableDupExpressions) {
    console.log(
      "DEBUG: capturedVariableDupExpressions count:",
      evaluatedClosure.$.capturedVariableDupExpressions.length
    );
    evaluatedClosure.$.capturedVariableDupExpressions.forEach((dupExpr, i) => {
      console.log(`DEBUG: dupExpr[${i}]:`, exprToString(dupExpr));
    });
  }

  // DO NOT update env here!
  // The deferred drop logic needs to see box1 and box2 in the environment
  // so it can generate drop calls for them in the capture struct's drop function.
  // If we use evaluatedClosure.$.env, those variables are already marked as consumed
  // and won't be included in the deferred drops.

  expr.$ = {
    env, // Use original env, NOT evaluatedClosure.$.env or evaluatedCall.$.env
    type: VUnit.type,
    value: undefined, // Runtime value, not compile-time
    pathCollection: [],
    // Store the UNevaluated closure call for codegen to use (it has the dup expressions)
    evaluatedClosure: evaluatedClosure,
  };

  return expr;
}

/**
 * Evaluates the __yo_concurrency_set_maximum_threads builtin function.
 *
 * __yo_concurrency_set_maximum_threads takes a usize argument specifying the maximum
 * number of threads that should be used to run tasks.
 *
 * Examples:
 * - __yo_concurrency_set_maximum_threads(1) -> unit
 * - __yo_concurrency_set_maximum_threads(4) -> unit
 *
 * @param params - The evaluation parameters
 * @returns The expression with unit type
 */
export function evaluateTaskSetMaximumThreads({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_concurrency_set_maximum_threads,
    1
  );

  const argExpr = expr.args[0]!;

  // Evaluate the argument expression
  const evaluatedExpr = context.evaluateExpression({
    expr: argExpr,
    env,
    context: { ...context },
  });

  if (!evaluatedExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate expression.`,
    });
  }

  env = evaluatedExpr.$.env;

  // Return unit type
  expr.$ = {
    env,
    type: VUnit.type,
    value: undefined, // Runtime value, not compile-time
    pathCollection: [],
  };

  return expr;
}
