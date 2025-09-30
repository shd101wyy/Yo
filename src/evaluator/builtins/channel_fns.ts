import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { createChanType, createUsizeType } from "../../types";
import { isUsizeType } from "../../types/guards";
import { VUnit } from "../../unit-value";
import { isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { addARCFunctionsToChanType } from "../types/utils";

/**
 * Evaluates the chan builtin function.
 *
 * chan creates a channel value with the specified element type and buffer size.
 *
 * Examples:
 * - chan(i32)        -> creates unbuffered channel value of type Chan(i32, 0)
 * - chan(i32, 0)     -> creates unbuffered channel value of type Chan(i32, 0)
 * - chan(String, 10) -> creates buffered channel value of type Chan(String, 10)
 *
 * Syntax: chan(ElementType) or chan(ElementType, BufferSize)
 * - ElementType: The type of elements the channel can hold
 * - BufferSize: Optional buffer capacity (defaults to 0 for unbuffered, >0 for buffered)
 */
export function evaluateChan({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  // Allow 1 or 2 arguments
  if (expr.args.length !== 1 && expr.args.length !== 2) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `chan() expects 1 or 2 arguments, got ${expr.args.length}. Usage: chan(ElementType) or chan(ElementType, BufferSize)`,
    });
  }

  const elementTypeExpr = expr.args[0]!;
  const bufferSizeExpr = expr.args[1]; // May be undefined

  // Evaluate element type expression
  const evaluatedElementTypeExpr = context.evaluateExpression({
    expr: elementTypeExpr,
    env,
    context: { ...context },
  });

  if (!evaluatedElementTypeExpr.$) {
    throw formatErrorMessage({
      token: elementTypeExpr.token,
      errorMessage: `Failed to evaluate element type expression for chan:\n${exprToString(
        elementTypeExpr
      )}`,
    });
  }
  env = evaluatedElementTypeExpr.$.env;

  // Check if the element type expression is a type
  if (!isTypeValue(evaluatedElementTypeExpr.$.value)) {
    throw formatErrorMessage({
      token: elementTypeExpr.token,
      errorMessage: `chan() expects a type as its first argument, but got:\n${exprToString(
        elementTypeExpr
      )}`,
    });
  }

  const elementType = evaluatedElementTypeExpr.$.value.value;

  // Handle buffer size - default to 0 if not provided
  if (bufferSizeExpr) {
    // Evaluate buffer size expression
    const evaluatedBufferSizeExpr = context.evaluateExpression({
      expr: bufferSizeExpr,
      env,
      context: {
        ...context,
        expectedType: {
          type: createUsizeType(),
          env,
        },
      },
    });

    if (!evaluatedBufferSizeExpr.$) {
      throw formatErrorMessage({
        token: bufferSizeExpr.token,
        errorMessage: `Failed to evaluate buffer size expression for chan:\n${exprToString(
          bufferSizeExpr
        )}`,
      });
    }
    env = evaluatedBufferSizeExpr.$.env;

    if (!isUsizeType(evaluatedBufferSizeExpr.$.type)) {
      throw formatErrorMessage({
        token: bufferSizeExpr.token,
        errorMessage: `chan() expects a usize type for its second argument (buffer size), but got ${evaluatedBufferSizeExpr.$.type.tag}:\n${exprToString(
          bufferSizeExpr
        )}`,
      });
    }
  }

  // Create the channel type (buffer size is stored in the value, not type)
  const chanType = createChanType(elementType, env);
  env = addARCFunctionsToChanType({
    chanType,
    env,
    context: { ...context },
  });

  // chan() creates a runtime channel value, not a type value
  // The actual channel will be allocated and initialized in the C code generation phase
  // Buffer size (if provided) will be handled during C codegen by checking the second argument
  expr.$ = {
    env,
    type: chanType,
    value: undefined, // Runtime value - no compile-time value
    pathCollection: [],
  };

  attachTempVariableToExpr(expr, true);

  return expr;
}

/**
 * Evaluates __yo_chan_drop builtin function.
 * Just evaluates the argument and returns unit.
 */
export function evaluateYoChanDrop({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, [BuiltinFunctions.__yo_chan_drop[0]!]);

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
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_chan_drop[0]!}":\n${exprToString(
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
 * Evaluates __yo_chan_dup builtin function.
 * Just evaluates the argument and returns unit.
 */
export function evaluateYoChanDup({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, [BuiltinFunctions.__yo_chan_dup[0]!]);

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
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_chan_dup[0]!}":\n${exprToString(
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
