import { Environment, pushEnvFrame } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
  mergeAndCheckEnvs,
} from "../../expr";
import {
  areTypesCompatible,
  convertComptTypeToRuntimeType,
  isBooleanType,
  Type,
  typeToString,
} from "../../type-checker";
import {
  BooleanValue,
  createUnknownValue,
  isBooleanValue,
  UnknownValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";

export function evaluateCond({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.cond)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "cond", got ${expr.tag}`,
    });
  }

  const statements = expr.args;
  if (statements.length === 0) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected at least one statement in "cond", got ${statements.length}`,
    });
  }

  // Evaluate each statement
  // condition => value.
  // expect each value to be the same type.
  const bodies: Expr[] = [];
  let valueType: { type: Type; env: Environment } | undefined = undefined;

  /**
   * BooleanValue means the condition could be evaluated at compile-time and we got a concrete boolean value.
   * UnknownValue means the condition could be evaluated at compile-time, but we don't know the value yet.
   * undefined means the condition could not be evaluated at compile-time, and it's runtime only.
   */
  const condValues: (BooleanValue | UnknownValue | undefined)[] = [];
  const caseBodyValues: (Value | undefined)[] = [];

  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i]!;

    // NOTE: We shouldn't use the parent `env` here
    // instead, we should create new env.
    let caseEnv = pushEnvFrame(env);

    if (
      !exprIsFunctionCall(statement) ||
      !exprIsFunctionCallOf(statement, "=>", 2)
    ) {
      throw formatErrorMessage({
        token: statement.token,
        errorMessage: `Expected => for cond statement, got ${statement.tag}`,
      });
    }
    let condExpr = statement.args[0]!;
    let caseBodyExpr = statement.args[1]!;

    // Expect condExpr to be a boolean
    condExpr = context.evaluateExpression({
      expr: condExpr,
      env: caseEnv,
      context: {
        ...context,
      },
    });

    // TODO: Check comptime value if exists
    if (!condExpr.$) {
      throw formatErrorMessage({
        token: condExpr.token,
        errorMessage: `Failed to evaluate condition expression: ${exprToString(condExpr)}`,
      });
    }
    caseEnv = condExpr.$.env;

    if (!isBooleanType(condExpr.$.type)) {
      throw formatErrorMessage({
        token: condExpr.token,
        errorMessage: `Expected boolean for cond statement, got ${exprToString(condExpr)}`,
      });
    }

    // Check if it's comptime false
    const condValue = condExpr.$.value;
    if (isBooleanValue(condValue) && condValue.value === false) {
      continue; // No need to evaluate the case body
    }

    // Evaluate the caseBodyExpr
    caseBodyExpr = context.evaluateExpression({
      expr: caseBodyExpr,
      env: caseEnv,
      context: {
        ...context,
      },
    });

    if (!caseBodyExpr.$?.type) {
      throw formatErrorMessage({
        token: caseBodyExpr.token,
        errorMessage: `Expected type for cond statement, got ${exprToString(caseBodyExpr)}`,
      });
    }
    caseEnv = caseBodyExpr.$.env;
    bodies.push(caseBodyExpr);

    if (!valueType) {
      valueType = { type: caseBodyExpr.$.type, env: caseEnv };
    } else {
      // Check if the types are compatible
      if (
        !areTypesCompatible(
          { type: valueType.type, env: valueType.env },
          { type: caseBodyExpr.$.type, env: caseEnv }
        )
      ) {
        // Check if the types match when converting to runtime type
        if (
          areTypesCompatible(
            {
              type: convertComptTypeToRuntimeType(valueType.type),
              env: valueType.env,
            },
            {
              type: caseBodyExpr.$.type,
              env: caseEnv,
            }
          )
        ) {
          valueType = { type: caseBodyExpr.$.type, env: caseEnv };
        } else {
          throw formatErrorMessage({
            token: caseBodyExpr.token,
            errorMessage: `Incompatible types:
- Previous: ${typeToString(valueType.type)}
- Current : ${typeToString(caseBodyExpr.$.type)}`,
          });
        }
      }
    }

    // Check if the condValue is true
    condValues.push(condValue as BooleanValue | UnknownValue | undefined);
    caseBodyValues.push(caseBodyExpr.$.value);
    if (isBooleanValue(condValue) && condValue.value === true) {
      break; // We found the first true condition, no need to evaluate further
    }
  }

  if (!valueType) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Failed to determine the type of value from the cond.`,
    });
  }

  // Merge and check all environments
  env = mergeAndCheckEnvs(env, bodies);

  let value: Value | undefined = undefined;
  if (caseBodyValues.some((val) => val === undefined)) {
    // contains runtime value
    value = undefined;
  } else {
    const lastCondValue = condValues[condValues.length - 1]!;
    if (isBooleanValue(lastCondValue) && lastCondValue.value === true) {
      value = caseBodyValues[caseBodyValues.length - 1]!;
    } else {
      value = createUnknownValue(valueType.type);
    }
  }

  expr.$ = {
    env,
    type: valueType.type,
    // TODO: set .value to support compile-time value.
    // Right now the createUnknownValue below is wrong
    value: value, // valueType ? createUnknownValue(valueType) : undefined;
    isMutable: false,
    pathCollection: [],
  };

  return expr;
}
