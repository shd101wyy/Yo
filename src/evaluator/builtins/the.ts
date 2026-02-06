import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import { areTypesCompatible } from "../../types/compatibility";
import { typeRequiresInference, typeToString } from "../../types/utils";
import { isTypeValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { synthesizeExprAndType } from "../types/expr-synthesizer";

export function evaluateThe({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.the, 2);

  const typeExpr = expr.args[0]!;
  const valueExpr = expr.args[1]!;

  // Evaluate the type expression first
  const evaluatedTypeExpr = evaluateExpression({
    expr: typeExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedTypeExpr.$) {
    throw formatErrorMessage({
      token: typeExpr.token,
      errorMessage: `Failed to evaluate type expression.`,
    });
  }
  env = evaluatedTypeExpr.$.env;

  // Check if the first argument is a type value
  if (!evaluatedTypeExpr.$.value || !isTypeValue(evaluatedTypeExpr.$.value)) {
    throw formatErrorMessage({
      token: typeExpr.token,
      errorMessage: `First argument to 'the' must be a type, got ${evaluatedTypeExpr.$.type}`,
    });
  }

  const expectedType = evaluatedTypeExpr.$.value.value;

  // Evaluate the value expression with the expected type
  const evaluatedValueExpr = evaluateExpression({
    expr: valueExpr,
    env,
    context: {
      ...context,
      expectedType: {
        type: expectedType,
        env,
      },
    },
  });
  if (!evaluatedValueExpr.$) {
    throw formatErrorMessage({
      token: valueExpr.token,
      errorMessage: `Failed to evaluate value expression.`,
    });
  }
  env = evaluatedValueExpr.$.env;

  // Check type compatibility
  if (
    !areTypesCompatible(
      { type: expectedType, env },
      { type: evaluatedValueExpr.$.type, env }
    )
  ) {
    // Only try synthesis if the expected type contains unknown values that could be resolved
    if (typeRequiresInference(expectedType)) {
      // If types are incompatible, try synthesis in case there are unknown values to resolve
      try {
        const {
          expr: synthesizedValueExpr,
          type: synthesizedValueType,
          env: synthesizedEnv,
        } = synthesizeExprAndType({
          expr: valueExpr,
          type: expectedType,
          env: env,
          context: { ...context },
        });

        // Check if synthesis made the types compatible
        if (
          areTypesCompatible(
            { type: expectedType, env: synthesizedEnv },
            { type: synthesizedValueType, env: synthesizedEnv }
          )
        ) {
          // Use the synthesized result
          expr.$ = {
            env: synthesizedEnv,
            type: expectedType,
            value: synthesizedValueExpr.$?.value,
            pathCollection: synthesizedValueExpr.$?.pathCollection || [],
          };
          return expr;
        }
      } catch (synthesisError) {
        // Synthesis failed, fall through to the original error
      }
    }

    throw formatErrorMessage({
      token: valueExpr.token,
      errorMessage: `Type mismatch: expected '${typeToString(expectedType)}', got '${typeToString(evaluatedValueExpr.$.type)}'`,
    });
  }

  // Return the value expression with the explicitly specified type
  expr.$ = {
    env,
    type: expectedType,
    value: evaluatedValueExpr.$.value,
    pathCollection: evaluatedValueExpr.$.pathCollection,
  };
  return expr;
}
