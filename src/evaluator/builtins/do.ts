import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprIsFunctionCall, exprToString, FuncCallExpr } from "../../expr";
import {
  ClosureType,
  createTupleType,
  isFunctionType,
  isUnitType,
  TupleElement,
} from "../../types";
import { evaluateFunctionCall } from "../calls/function";
import { EvaluatorContext } from "../context";

/**
 * Handle `do` expressions - these indicate CPS transformation is needed
 *
 * `do` accepts a function call argument where the last parameter is a closure.
 * It returns the closure parameters as values:
 * - Single parameter closure: returns the parameter value directly
 * - Multi-parameter closure: returns a tuple of parameter values
 *
 * `do` can only be used inside functions with unit return type.
 */
export function evaluateDoExpression({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  // Check that we're inside a function body with unit return type
  if (!context.isEvaluatingFunctionBody) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `'do' can only be used inside a function body.`,
    });
  }

  // Check that we're not inside a loop body
  if (context.isEvaluatingLoopBody) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `'do' cannot be used inside ${context.isEvaluatingLoopBody.kind} loops. CPS transformation is not supported within loop bodies.`,
    });
  }

  if (!isUnitType(context.isEvaluatingFunctionBody.type.return.type)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `'do' can only be used inside functions with unit return type. Current function returns: ${context.isEvaluatingFunctionBody.type.return.type.id}`,
    });
  }

  // Record that this function uses `do` and needs CPS transformation
  if (!context.isEvaluatingFunctionBody.usedDo) {
    context.isEvaluatingFunctionBody.usedDo = [];
  }
  context.isEvaluatingFunctionBody.usedDo.push(expr);

  // Check that we have exactly one argument and it's a function call
  if (expr.args.length !== 1) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `'do' expects exactly one argument (a function call), got ${expr.args.length} arguments.`,
    });
  }

  const functionCallArg = expr.args[0]!;
  if (!exprIsFunctionCall(functionCallArg)) {
    throw formatErrorMessage({
      token: functionCallArg.token,
      errorMessage: `'do' expects a function call as argument, got:\n${exprToString(functionCallArg)}`,
    });
  }

  // Evaluate the function call with do validation
  const evaluatedFunctionCall = evaluateFunctionCall({
    expr: functionCallArg,
    env,
    context: { ...context },
    isEvaluatingDo: true,
  });

  // Update environment from function call evaluation
  env = evaluatedFunctionCall.$?.env || env;

  // Get the function type to determine return type
  const funcExpr = functionCallArg.func;
  const funcType = funcExpr.$?.type;

  if (!funcType || !isFunctionType(funcType)) {
    throw formatErrorMessage({
      token: funcExpr.token,
      errorMessage: `Expected function type for 'do' argument, got:\n${exprToString(functionCallArg)}`,
    });
  }

  // Get the closure type from the last parameter
  const lastParameter = funcType.parameters[funcType.parameters.length - 1]!;
  const closureType = lastParameter.type; // We already validated this is a closure type in evaluateFunctionCall
  const closureCallType = (closureType as ClosureType).callType;
  const closureParameters = closureCallType.parameters;

  // Determine return type based on closure parameters
  if (closureParameters.length === 1) {
    // Single parameter - return the parameter type
    const paramType = closureParameters[0]!.type;
    expr.$ = {
      env,
      type: paramType,
      value: undefined, // This will be filled in by CPS transformation
      isMutable: true,
      originType: paramType,
    };
  } else {
    // Multiple parameters - return a tuple type
    const tupleElements: TupleElement[] = closureParameters.map(
      (param, index: number) => ({
        type: param.type,
        label: param.label || `_${index}`,
        isCompileTimeOnly: false,
        isImplicit: false,
        exprs: {
          expr: functionCallArg, // Use the function call as placeholder
          labelExpr: undefined,
          typeExpr: undefined,
          defaultValueExpr: undefined,
          assignedValueExpr: undefined,
        },
      })
    );
    const tupleType = createTupleType(tupleElements);

    expr.$ = {
      env,
      type: tupleType,
      value: undefined, // This will be filled in by CPS transformation
      isMutable: true,
      originType: tupleType,
    };
  }

  return expr;
}
