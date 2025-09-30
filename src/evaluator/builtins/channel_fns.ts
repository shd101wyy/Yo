import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprToString,
  FuncCallExpr,
  setExprAsNeedsToCallDup,
} from "../../expr";
import { createChanType } from "../../types";
import { isChanType } from "../../types/guards";
import { VUnit } from "../../unit-value";
import { createComptIntValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";

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
  let bufferSizeValue;
  if (bufferSizeExpr) {
    // Evaluate buffer size expression
    const evaluatedBufferSizeExpr = context.evaluateExpression({
      expr: bufferSizeExpr,
      env,
      context: { ...context },
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

    // The buffer size must be a compile-time value (we need the actual Value, not just the type)
    if (!evaluatedBufferSizeExpr.$.value) {
      throw formatErrorMessage({
        token: bufferSizeExpr.token,
        errorMessage: `chan() expects a compile-time known buffer size, but got a runtime value:\n${exprToString(
          bufferSizeExpr
        )}`,
      });
    }

    bufferSizeValue = evaluatedBufferSizeExpr.$.value;
  } else {
    // Default to buffer size 0 (unbuffered channel)
    bufferSizeValue = createComptIntValue(0);
  }

  // Create the channel type
  const chanType = createChanType(elementType, bufferSizeValue, env);

  // chan() creates a runtime channel value, not a type value
  // The actual channel will be allocated and initialized in the C code generation phase
  expr.$ = {
    env,
    type: chanType,
    value: undefined, // Runtime value - no compile-time value
    pathCollection: [],
  };

  return expr;
}

/**
 * Evaluates the __yo_chan_send builtin function.
 *
 * __yo_chan_send sends a value through a channel.
 *
 * Example: __yo_chan_send(my_chan, value)
 * Returns: unit (successful send)
 *
 * This is a low-level placeholder implementation. The actual channel operations
 * will be implemented during the C code generation phase.
 */
export function evaluateYoChanSend({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_chan_send, 2);

  const channelExpr = expr.args[0]!;
  const valueExpr = expr.args[1]!;

  // Evaluate the channel expression
  const evaluatedChannelExpr = context.evaluateExpression({
    expr: channelExpr,
    env,
    context: { ...context },
  });

  if (!evaluatedChannelExpr.$) {
    throw formatErrorMessage({
      token: channelExpr.token,
      errorMessage: `Failed to evaluate channel expression for __yo_chan_send.`,
    });
  }
  env = evaluatedChannelExpr.$.env;

  // Verify it's a channel type
  if (!isChanType(evaluatedChannelExpr.$.type)) {
    throw formatErrorMessage({
      token: channelExpr.token,
      errorMessage: `Expected Chan type for first argument, got ${evaluatedChannelExpr.$.type.tag}`,
    });
  }

  // Evaluate the value expression
  const evaluatedValueExpr = context.evaluateExpression({
    expr: valueExpr,
    env,
    context: { ...context },
  });

  if (!evaluatedValueExpr.$) {
    throw formatErrorMessage({
      token: valueExpr.token,
      errorMessage: `Failed to evaluate value expression for __yo_chan_send.`,
    });
  }

  setExprAsNeedsToCallDup(evaluatedValueExpr, { ...context });

  env = evaluatedValueExpr.$.env;

  // __yo_chan_send returns unit
  expr.$ = {
    env,
    type: VUnit.type,
    value: undefined, // Runtime value
    pathCollection: [],
  };

  return expr;
}

/**
 * Evaluates the __yo_chan_recv builtin function.
 *
 * __yo_chan_recv receives a value from a channel (blocking).
 *
 * Example: __yo_chan_recv(my_chan)
 * Returns: ElementType (the received value)
 */
export function evaluateYoChanRecv({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_chan_recv, 1);

  const channelExpr = expr.args[0]!;

  // Evaluate the channel expression
  const evaluatedChannelExpr = context.evaluateExpression({
    expr: channelExpr,
    env,
    context: { ...context },
  });

  if (!evaluatedChannelExpr.$) {
    throw formatErrorMessage({
      token: channelExpr.token,
      errorMessage: `Failed to evaluate channel expression for __yo_chan_recv.`,
    });
  }
  env = evaluatedChannelExpr.$.env;

  // Verify it's a channel type and extract the element type
  if (!isChanType(evaluatedChannelExpr.$.type)) {
    throw formatErrorMessage({
      token: channelExpr.token,
      errorMessage: `Expected Chan type, got ${evaluatedChannelExpr.$.type.tag}`,
    });
  }

  // For Chan(ElementType, BufferSize), __yo_chan_recv should return ElementType
  const channelType = evaluatedChannelExpr.$.type;
  const elementType = channelType.elementType;

  // __yo_chan_recv returns the element type of the channel
  expr.$ = {
    env,
    type: elementType,
    value: undefined, // Runtime value
    pathCollection: [],
  };

  return expr;
}

/**
 * Evaluates the __yo_chan_close builtin function.
 *
 * __yo_chan_close closes a channel.
 *
 * Example: __yo_chan_close(my_chan)
 * Returns: unit
 */
export function evaluateYoChanClose({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_chan_close, 1);

  const channelExpr = expr.args[0]!;

  // Evaluate the channel expression
  const evaluatedChannelExpr = context.evaluateExpression({
    expr: channelExpr,
    env,
    context: { ...context },
  });

  if (!evaluatedChannelExpr.$) {
    throw formatErrorMessage({
      token: channelExpr.token,
      errorMessage: `Failed to evaluate channel expression for __yo_chan_close.`,
    });
  }
  env = evaluatedChannelExpr.$.env;

  // Verify it's a channel type
  if (!isChanType(evaluatedChannelExpr.$.type)) {
    throw formatErrorMessage({
      token: channelExpr.token,
      errorMessage: `Expected Chan type, got ${evaluatedChannelExpr.$.type.tag}`,
    });
  }

  // __yo_chan_close returns unit
  expr.$ = {
    env,
    type: VUnit.type,
    value: undefined, // Runtime value
    pathCollection: [],
  };

  return expr;
}
