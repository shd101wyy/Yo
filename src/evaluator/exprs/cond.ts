import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  ControlFlowKind,
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
  isFunctionTypeAndReturnsComptValue,
  Type,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import {
  BooleanValue,
  createUnknownValue,
  isBooleanValue,
  UnknownValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "./begin";

export function evaluateCond({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
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

  // First, parse and validate all statements
  const parsedStatements: Array<{
    condExpr: Expr;
    caseBodyExpr: Expr;
    caseEnv: Environment;
  }> = [];

  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i]!;

    if (
      !exprIsFunctionCall(statement) ||
      !exprIsFunctionCallOf(statement, "=>", 2)
    ) {
      throw formatErrorMessage({
        token: statement.token,
        errorMessage: `Expected => for cond statement, got ${statement.tag}`,
      });
    }

    const condExpr = statement.args[0]!;
    const caseBodyExpr = statement.args[1]!;
    const caseEnv = env; // pushEnvFrame(env); // NOTE: No need to do this. We now use evaluateBeginExpression instead of evaluateExpression. evaluateBeginExpression will push frame itself.

    parsedStatements.push({ condExpr, caseBodyExpr, caseEnv });
  }

  // Second, evaluate all conditions
  const evaluatedConditions: Array<{
    condExpr: Expr;
    caseBodyExpr: Expr;
    caseEnv: Environment;
    condValue: BooleanValue | UnknownValue | undefined;
  }> = [];

  for (let i = 0; i < parsedStatements.length; i++) {
    const { condExpr, caseBodyExpr, caseEnv } = parsedStatements[i]!;
    // Evaluate condition
    const evaluatedCondExpr = context.evaluateExpression({
      expr: condExpr,
      env: caseEnv,
      context: {
        ...context,
      },
    });

    if (!evaluatedCondExpr.$) {
      throw formatErrorMessage({
        token: evaluatedCondExpr.token,
        errorMessage: `Failed to evaluate condition expression: ${exprToString(evaluatedCondExpr)}`,
      });
    }

    if (!isBooleanType(evaluatedCondExpr.$.type)) {
      throw formatErrorMessage({
        token: evaluatedCondExpr.token,
        errorMessage: `Expected boolean for cond statement, got ${exprToString(evaluatedCondExpr)}`,
      });
    }

    const condValue = evaluatedCondExpr.$.value;
    const updatedCaseEnv = evaluatedCondExpr.$.env;

    // If it's the last condition, then we expect it to be the conpile-time known "true"
    if (
      i === parsedStatements.length - 1 &&
      !(isBooleanValue(condValue) && condValue.value === true)
    ) {
      throw formatErrorMessage({
        token: evaluatedCondExpr.token,
        errorMessage: `Expect the last condition to be compile-time known "true".`,
      });
    }

    evaluatedConditions.push({
      condExpr: evaluatedCondExpr,
      caseBodyExpr,
      caseEnv: updatedCaseEnv,
      condValue: condValue as BooleanValue | UnknownValue | undefined,
    });

    if (isBooleanValue(condValue) && condValue.value === true) {
      break; // Stop evaluating further conditions if we found a compile-time true condition
    }
  }

  // Third, find the first compile-time true condition (if any)
  let firstTrueIndex = -1;
  for (let i = 0; i < evaluatedConditions.length; i++) {
    const { condValue } = evaluatedConditions[i]!;
    if (
      isBooleanValue(condValue) &&
      condValue.value === true &&
      // Ensure all previous conditions were compile-time false
      evaluatedConditions
        .slice(0, i)
        .every(
          ({ condValue: prevCondValue }) =>
            isBooleanValue(prevCondValue) && prevCondValue.value === false
        )
    ) {
      firstTrueIndex = i;
      break;
    }
  }

  // Fourth, evaluate bodies based on the analysis
  const bodies: Expr[] = [];
  const caseBodyValues: (Value | undefined)[] = [];
  let valueType: { type: Type; env: Environment } | undefined = undefined;

  if (firstTrueIndex !== -1) {
    // We found a compile-time true condition, only evaluate its body
    const { caseBodyExpr, caseEnv, condExpr } =
      evaluatedConditions[firstTrueIndex]!;

    // Mark the condition as executed
    if (condExpr.$) {
      condExpr.$.caseExecuted = true; // Mark the condition as executed
    }

    const evaluatedCaseBodyExpr = evaluateBeginExpression({
      expr: caseBodyExpr,
      env: caseEnv,
      context: {
        ...context,
        // If the current branch might terminate (e.g., contains return), mark it
        // We'll let the begin expression determine if it actually terminates
      },
    });

    if (evaluatedCaseBodyExpr.$?.controlFlow) {
      // No need to evaluate further if a return was encountered
      expr.$ = {
        env: evaluatedCaseBodyExpr.$.env,
        type: evaluatedCaseBodyExpr.$.type,
        value: evaluatedCaseBodyExpr.$.value,
        isMutable: evaluatedCaseBodyExpr.$.isMutable,
        pathCollection: evaluatedCaseBodyExpr.$.pathCollection,
        controlFlow: evaluatedCaseBodyExpr.$.controlFlow,
      };
      return expr;
    } else {
      if (!evaluatedCaseBodyExpr.$?.type) {
        throw formatErrorMessage({
          token: evaluatedCaseBodyExpr.token,
          errorMessage: `Expected type for cond statement, got ${exprToString(evaluatedCaseBodyExpr)}`,
        });
      }

      bodies.push(evaluatedCaseBodyExpr);
      caseBodyValues.push(evaluatedCaseBodyExpr.$.value);
      valueType = {
        type: evaluatedCaseBodyExpr.$.type,
        env: evaluatedCaseBodyExpr.$.env,
      };

      // Merge and check all environments
      env = mergeAndCheckEnvs(env, bodies);

      // Determine the compile-time value
      let value: Value | undefined = undefined;
      // We have a compile-time true condition, use its body value
      value = caseBodyValues[0]; // Only one body was evaluated

      expr.$ = {
        env,
        type: valueType.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      attachTempVariableToExpr(expr);

      return expr;
    }
  } else {
    let hasCaseThatIsNotTerminated = false;
    const controlFlows: ControlFlowKind[] = []; // Track control flows from all cases

    // No compile-time true condition found, evaluate all bodies except compile-time false ones
    for (const {
      condExpr,
      condValue,
      caseBodyExpr,
      caseEnv,
    } of evaluatedConditions) {
      // Skip compile-time false conditions
      if (isBooleanValue(condValue) && condValue.value === false) {
        continue;
      }

      // Mark the condition as executed
      if (condExpr.$) {
        condExpr.$.caseExecuted = true; // Mark the condition as executed
      }

      const evaluatedCaseBodyExpr = evaluateBeginExpression({
        expr: caseBodyExpr,
        env: caseEnv,
        context: {
          ...context,
        },
      });

      if (evaluatedCaseBodyExpr.$?.controlFlow) {
        controlFlows.push(evaluatedCaseBodyExpr.$.controlFlow);
        continue; // No need to evaluate further if a control flow was encountered
      } else {
        hasCaseThatIsNotTerminated = true;
      }

      if (!evaluatedCaseBodyExpr.$?.type) {
        throw formatErrorMessage({
          token: evaluatedCaseBodyExpr.token,
          errorMessage: `Expected type for cond statement, got ${exprToString(evaluatedCaseBodyExpr)}`,
        });
      }

      bodies.push(evaluatedCaseBodyExpr);
      caseBodyValues.push(evaluatedCaseBodyExpr.$.value);

      if (!valueType) {
        valueType = {
          type: evaluatedCaseBodyExpr.$.type,
          env: evaluatedCaseBodyExpr.$.env,
        };
      } else {
        // Check if the types are compatible
        if (
          !areTypesCompatible(
            { type: valueType.type, env: valueType.env },
            {
              type: evaluatedCaseBodyExpr.$.type,
              env: evaluatedCaseBodyExpr.$.env,
            }
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
                type: evaluatedCaseBodyExpr.$.type,
                env: evaluatedCaseBodyExpr.$.env,
              }
            )
          ) {
            valueType = {
              type: evaluatedCaseBodyExpr.$.type,
              env: evaluatedCaseBodyExpr.$.env,
            };
          } else {
            throw formatErrorMessage({
              token: evaluatedCaseBodyExpr.token,
              errorMessage: `Incompatible types:
- Previous: ${typeToString(valueType.type)}
- Current : ${typeToString(evaluatedCaseBodyExpr.$.type)}`,
            });
          }
        }
      }
    }

    // Meets some cases that don't use "return" keyword.
    if (hasCaseThatIsNotTerminated) {
      if (!valueType) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Failed to determine the type of value from the cond.`,
        });
      }

      // Merge and check all environments
      env = mergeAndCheckEnvs(env, bodies);

      // Determine the compile-time value
      let value: Value | undefined = undefined;
      if (caseBodyValues.some((val) => val === undefined)) {
        // Contains runtime value
        value = undefined;
      } else {
        // All evaluated conditions were not compile-time true, so result is unknown
        value = createUnknownValue(valueType.type);
      }

      expr.$ = {
        env,
        type: valueType.type,
        value: value,
        isMutable: false,
        pathCollection: [],
      };
      attachTempVariableToExpr(expr);

      return expr;
    } else {
      // All cases have control flow - determine which one to use
      if (controlFlows.length === 0) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `No control flows found but expected some.`,
        });
      }

      // For mixed control flows, we need to determine the most restrictive one
      // Priority: return > break/continue (return exits function, break/continue exit loop)
      let finalControlFlow: ControlFlowKind;

      if (controlFlows.includes("return")) {
        finalControlFlow = "return";
      } else if (controlFlows.includes("break")) {
        finalControlFlow = "break";
      } else if (controlFlows.includes("continue")) {
        finalControlFlow = "continue";
      } else {
        finalControlFlow = controlFlows[0] as ControlFlowKind;
      }

      if (finalControlFlow === "return") {
        // All cases are returning from function
        if (!context.isEvaluatingFunctionBody) {
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `All cases in cond are returning from function, but not evaluating in function body.`,
          });
        }
        const functionReturnType =
          context.isEvaluatingFunctionBody.type.return.type;
        expr.$ = {
          env,
          type: functionReturnType,
          value: isFunctionTypeAndReturnsComptValue(
            context.isEvaluatingFunctionBody.type
          )
            ? createUnknownValue(functionReturnType)
            : undefined,
          isMutable: false,
          pathCollection: [],
          controlFlow: "return",
        };
      } else if (finalControlFlow === "break") {
        // All cases break from loop
        if (!context.isInBreakableLoop) {
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `All cases in cond are breaking from loop, but not inside a breakable loop.`,
          });
        }
        expr.$ = {
          env,
          type: VUnit.type,
          value: VUnit,
          isMutable: false,
          pathCollection: [],
          controlFlow: "break",
        };
      } else if (finalControlFlow === "continue") {
        // All cases continue loop
        if (!context.isInBreakableLoop) {
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `All cases in cond are continuing loop, but not inside a breakable loop.`,
          });
        }
        expr.$ = {
          env,
          type: VUnit.type,
          value: VUnit,
          isMutable: false,
          pathCollection: [],
          controlFlow: "continue",
        };
      }

      return expr;
    }
  }
}
