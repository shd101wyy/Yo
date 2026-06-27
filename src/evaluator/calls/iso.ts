import { type Environment, getVariablesFromEnv } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  exprToString,
  type FnCallExpr,
  setExprAsConsumed,
} from "../../expr";
import { createIsoType } from "../../types/creators";
import type { IsoType } from "../../types/definitions";
import { canTypeFormRcCycle } from "../../types/utils";
import { isAtomicReferenceStructType } from "../../types/guards";
import { createTypeValue, isTypeValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { addRcFunctionsToIsoType } from "../types/utils";

/**
 * Evaluate Iso type constructor call
 * For example:
 *
 * IsoBoxI32 :: Iso(Box(i32));
 */
export function evaluateIsoTypeCall({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const argExpr = expr.args[0]!;

  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for Iso:\n${exprToString(argExpr)}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the argExpr is a type
  if (!isTypeValue(evaluatedArgExpr.$.value)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Iso expects a type as argument, but got:\n${exprToString(argExpr)}`,
    });
  }

  const typeValue = evaluatedArgExpr.$.value;
  const childType = typeValue.value;

  // Phase H: Ban Iso(Arc(T)) — Iso's uniqueness is about the Iso wrapper's
  // rc, not the inner Arc cell. After extract() you get the Arc back;
  // Iso adds nothing over naked Arc + move-on-spawn.
  if (isAtomicReferenceStructType(childType)) {
    const derefField = childType.fields.find((f) => f.label === "*");
    if (derefField) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Iso(Arc(T)) is not allowed.\n  - To send an Arc handle across a thread, send the Arc directly — the spawn closure already consumes it. Iso adds nothing.\n  - If you want unique-owned heap data, use Iso(Box(T)) or Iso(...your struct...).`,
      });
    }
  }

  // Create the Iso type
  const isoType = createIsoType(childType, env);

  // Add atomic ARC functions to the Iso type
  env = addRcFunctionsToIsoType({
    isoType,
    env,
    context,
  });

  const typeValueForIso = createTypeValue(isoType);

  expr.$ = {
    env,
    type: typeValueForIso.type,
    value: typeValueForIso,
    pathCollection: [],
  };

  return expr;
}

/**
 * Evaluate Iso value constructor call
 * For example:
 *
 * x := Box(i32)(42);
 * iso := Iso(Box(i32))(x);  // Consumes x
 *
 * This function:
 * 1. Checks that the value has no aliases (via isOwningTheSameRcValueAs)
 * 2. Consumes the variable (marks it as moved)
 * 3. Wraps the value in an Iso type with atomic RC
 */
export function evaluateIsoValueCall({
  expr,
  env,
  context,
  isoType,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
  isoType: IsoType;
}): FnCallExpr {
  const argExpr = expr.args[0]!;

  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
      expectedType: { type: isoType.childType, env },
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for Iso value constructor:\n${exprToString(
        argExpr
      )}`,
    });
  }

  env = evaluatedArgExpr.$.env;

  // Check that the value has no aliases
  const variableName = evaluatedArgExpr.$?.variableName;
  if (variableName) {
    const variables = getVariablesFromEnv(env, variableName);
    if (variables.length > 0) {
      const variable = variables[variables.length - 1]!;

      if (canTypeFormRcCycle(variable.type, new Set(), env)) {
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Cannot isolate variable ${variableName} because its type may form RC cycles.`,
        });
      }

      if (!variable.isOwningTheRcValue) {
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Cannot isolate variable ${variableName} because it does not own its RC value.`,
        });
      }

      // Check if there are other variables that own the same GC value
      // by looking for variables with isOwningTheSameRcValueAs pointing to this variable
      const allVariables = env.frames.flatMap((frame) => frame.variables);
      const aliases = allVariables.filter(
        (v) =>
          v.isOwningTheSameRcValueAs?.id === variable.id && v.id !== variable.id
      );

      if (aliases.length > 0) {
        const aliasNames = aliases.map((v) => v.name).join(", ");
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Cannot isolate ${variableName}, also owned by: ${aliasNames}
Iso requires unique ownership (no aliases). Drop other aliases first.`,
        });
      }
    } else {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Variable ${variableName} not found in the environment.`,
      });
    }
  }

  // Consume the variable (mark it as moved)
  env = setExprAsConsumed(evaluatedArgExpr, env);

  // The value is now isolated - wrap it in Iso type
  expr.$ = {
    env,
    type: isoType,
    value: undefined, // iso value should be runtime only
    pathCollection: evaluatedArgExpr.$.pathCollection || [],
  };

  attachTempVariableToExpr(expr, true);

  return expr;
}
