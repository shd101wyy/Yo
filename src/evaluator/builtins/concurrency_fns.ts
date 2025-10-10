import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  FuncCallExpr,
} from "../../expr";
import { PlaceholderToken } from "../../token";
import { VUnit } from "../../unit-value";
import { EvaluatorContext } from "../context";

/**
 * Evaluates the go builtin function (stackful coroutine spawning).
 *
 * go takes any expression and wraps it in an anonymous closure that runs asynchronously.
 * The expression is wrapped as: (fn() => unit) { expr; }()
 *
 * Optionally accepts a second argument for configuration (struct literal):
 * - go func_call(args), { stack_size: 1024 * 64 }
 * - go func_call(args), _( stack_size: 1024 * 64 )
 *
 * Examples:
 * - go say("hello", 18, ch);
 * - go say("hello", 18, ch), { stack_size: 1024 * 32 };
 * - go { x := compute(42); process(x); };
 * - go x.method();
 *
 * @param params - The evaluation parameters
 * @returns The expression with unit type, containing the wrapped closure
 */
export function evaluateGo({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  // go can take 1 or 2 arguments
  // - 1 arg: go func_call()
  // - 2 args: go func_call(), { stack_size: 1024 * 64 }
  if (expr.args.length !== 1 && expr.args.length !== 2) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `go expects 1 or 2 arguments, got ${expr.args.length}.`,
    });
  }

  const bodyExpr = expr.args[0]!;
  const configExpr = expr.args[1]; // Optional configuration struct

  // Parse optional configuration and extract stack_size expression
  let stackSizeExpr: Expr | undefined = undefined;
  if (configExpr) {
    // Check if configExpr is a struct literal: _(...) or {...}
    if (!exprIsFunctionCall(configExpr)) {
      throw formatErrorMessage({
        token: configExpr.token,
        errorMessage: `async configuration must be a struct literal { ... } or _( ... ).`,
      });
    }

    // Check if it's a call to _ (struct literal)
    if (!exprIsFunctionCallOf(configExpr, "_")) {
      throw formatErrorMessage({
        token: configExpr.token,
        errorMessage: `async configuration must be a struct literal { ... } or _( ... ).`,
      });
    }

    // Parse fields from struct literal
    // Format: _( stack_size: expr, ... )
    for (const arg of configExpr.args) {
      if (!exprIsFunctionCallOf(arg, ":")) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Expected field assignment (field: value) in async configuration.`,
        });
      }

      // Now we know arg is a FuncCallExpr
      const fieldAssignment = arg as FuncCallExpr;

      if (fieldAssignment.args.length !== 2) {
        throw formatErrorMessage({
          token: fieldAssignment.token,
          errorMessage: `Field assignment must have exactly 2 arguments (field: value).`,
        });
      }

      const fieldName = fieldAssignment.args[0]!;
      const fieldValue = fieldAssignment.args[1]!;

      // Check field name
      if (!exprIsAtom(fieldName)) {
        throw formatErrorMessage({
          token: fieldName.token,
          errorMessage: `Field name must be an identifier.`,
        });
      }

      const fieldNameStr = fieldName.token.value;

      if (fieldNameStr === "stack_size") {
        stackSizeExpr = fieldValue;
      } else {
        throw formatErrorMessage({
          token: fieldName.token,
          errorMessage: `Unknown async configuration field: ${fieldNameStr}. Supported fields: stack_size.`,
        });
      }
    }
  }

  // Evaluate optional stack size expression (runtime-known)
  let evaluatedStackSize: Expr | undefined = undefined;
  if (stackSizeExpr) {
    evaluatedStackSize = context.evaluateExpression({
      expr: stackSizeExpr,
      env,
      context: { ...context },
    });

    if (!evaluatedStackSize.$) {
      throw formatErrorMessage({
        token: stackSizeExpr.token,
        errorMessage: `Failed to evaluate stack_size expression.`,
      });
    }

    // Update env after evaluation
    env = evaluatedStackSize.$.env;

    // TODO: Add type checking - stack_size should be usize or i32/i64
    // For now, we trust the user to provide a valid integer expression
  }

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
    // Store the evaluated closure call for codegen to use (it has the dup expressions)
    evaluatedClosure: evaluatedClosure,
    // Store the evaluated stack size (if provided)
    asyncStackSize: evaluatedStackSize,
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
