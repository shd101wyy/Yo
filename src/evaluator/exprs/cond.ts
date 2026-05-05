import { type Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  consumeCaseBodyTempVar,
  type ControlFlowFlags,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
  hasAnyControlFlow,
  hasControlFlow,
  mergeAndCheckEnvs,
  mergeControlFlows,
} from "../../expr";
import { areTypesCompatible } from "../../types/compatibility";
import { createBooleanType } from "../../types/creators";
import { type Type } from "../../types/definitions";
import {
  isBooleanType,
  isFunctionTypeAndReturnsComptimeValue,
} from "../../types/guards";
import {
  convertComptimeTypeToRuntimeType,
  typeContainsSomeType,
  typeToString,
} from "../../types/utils";
import { VUnit } from "../../unit-value";
import {
  type BooleanValue,
  createUnknownValue,
  isBooleanValue,
  type UnknownValue,
  type Value,
} from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "./begin";
import { evaluateExpression } from "./expr";

export function evaluateCond({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
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
    // NOTE: It's necessary to use evaluateBeginExpression here,
    // because the condition might contain Rc values that need to be properly managed by `begin` block.
    // Evaluate the condition expression
    const evaluatedCondExpr = exprIsAtom(condExpr)
      ? evaluateExpression({
          expr: condExpr,
          env: caseEnv,
          context: {
            ...context,
            expectedType: {
              type: createBooleanType(),
              env: caseEnv,
            },
          },
        })
      : evaluateBeginExpression({
          expr: condExpr,
          env: caseEnv,
          context: {
            ...context,
            expectedType: {
              type: createBooleanType(),
              env: caseEnv,
            },
          },
          variablesToAdd: [],
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
        errorMessage: `Expected bool for cond statement, got ${exprToString(evaluatedCondExpr)} of type ${typeToString(evaluatedCondExpr.$.type)}`,
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
      variablesToAdd: [],
    });

    if (hasAnyControlFlow(evaluatedCaseBodyExpr.$?.controlFlow)) {
      // No need to evaluate further if a return was encountered
      expr.$ = {
        env: evaluatedCaseBodyExpr.$!.env,
        type:
          context.expectedType?.type &&
          !typeContainsSomeType(context.expectedType.type)
            ? context.expectedType.type
            : evaluatedCaseBodyExpr.$!.type,
        value: evaluatedCaseBodyExpr.$!.value,
        pathCollection: evaluatedCaseBodyExpr.$!.pathCollection,
        controlFlow: evaluatedCaseBodyExpr.$!.controlFlow,
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

      // When we have a compile-time known true condition, we KNOW exactly which branch was taken.
      // Use the environment from that branch directly, not mergeAndCheckEnvs.
      // mergeAndCheckEnvs is for runtime unknown conditions where we need to merge metadata.
      // Using the branch's environment directly preserves compile-time values like updated variables.
      env = evaluatedCaseBodyExpr.$.env;

      // Determine the compile-time value
      let value: Value | undefined = undefined;
      // We have a compile-time true condition, use its body value
      value = caseBodyValues[0]; // Only one body was evaluated

      expr.$ = {
        env,
        type:
          context.expectedType?.type &&
          !typeContainsSomeType(context.expectedType.type)
            ? context.expectedType.type
            : valueType.type,
        value: value,
        pathCollection: [],
        variableName: evaluatedCaseBodyExpr.$.variableName,
      };

      // Only attach a new temp variable if the inner body doesn't have one.
      // This handles cases where the result is assigned to a variable (e.g., `value := cond(...)`)
      if (!evaluatedCaseBodyExpr.$.variableName) {
        attachTempVariableToExpr(expr, true);
      }

      return expr;
    }
  } else {
    let hasCaseThatDoesntHaveControlFlowSet = false;
    const controlFlows: ControlFlowFlags[] = []; // Track control flows from all cases
    const returnBodies: Expr[] = []; // Track bodies with return control flow for validation

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
          isExecuting: false, // We're analyzing, not executing
        },
        variablesToAdd: [],
      });

      // Consume the case body temp var so it doesn't cause phantom drops.
      // evaluateBeginExpression creates a temp var in the parent frame;
      // the cond will create its own result var, so the body temp var is unused.
      if (evaluatedCaseBodyExpr.$) {
        const consumed = consumeCaseBodyTempVar(
          evaluatedCaseBodyExpr,
          evaluatedCaseBodyExpr.$.env
        );
        evaluatedCaseBodyExpr.$.env = consumed;
      }

      if (hasAnyControlFlow(evaluatedCaseBodyExpr.$?.controlFlow)) {
        controlFlows.push(evaluatedCaseBodyExpr.$!.controlFlow!);
        // Collect bodies with return control flow for validation
        if (hasControlFlow(evaluatedCaseBodyExpr.$!.controlFlow, "return")) {
          returnBodies.push(evaluatedCaseBodyExpr);
        }
        continue; // No need to evaluate further if a control flow was encountered
      } else {
        hasCaseThatDoesntHaveControlFlowSet = true;
      }

      if (!evaluatedCaseBodyExpr.$?.type) {
        throw formatErrorMessage({
          token: evaluatedCaseBodyExpr.token,
          errorMessage: `Expected type for cond statement, got ${exprToString(evaluatedCaseBodyExpr)}`,
        });
      }

      bodies.push(evaluatedCaseBodyExpr);
      caseBodyValues.push(evaluatedCaseBodyExpr.$.value);

      if (context.expectedType) {
        if (
          !areTypesCompatible(context.expectedType, {
            type: evaluatedCaseBodyExpr.$.type,
            env: evaluatedCaseBodyExpr.$.env,
          })
        ) {
          throw formatErrorMessage({
            token: evaluatedCaseBodyExpr.token,
            errorMessage: `Incompatible type with expected type:
- Expected: ${typeToString(context.expectedType.type)}
- Actual  : ${typeToString(evaluatedCaseBodyExpr.$.type)}`,
          });
        }
      }
      if (!hasAnyControlFlow(evaluatedCaseBodyExpr.$.controlFlow)) {
        // skip continue/break/return cases

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
                  type: convertComptimeTypeToRuntimeType({
                    type: valueType.type,
                    expectedType: undefined,
                    expr: undefined,
                    env: valueType.env,
                  }),
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
    }

    // Merge all control flow flags from branches
    const finalControlFlow: ControlFlowFlags | undefined =
      controlFlows.length > 0 ? mergeControlFlows(controlFlows) : undefined;

    if (
      hasCaseThatDoesntHaveControlFlowSet || // some case has no control flow
      !hasAnyControlFlow(finalControlFlow) // no control flows at all
    ) {
      if (hasCaseThatDoesntHaveControlFlowSet && !valueType) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Failed to determine the type of value from the cond.`,
        });
      } else if (!valueType) {
        valueType = { type: VUnit.type, env: env };
      }

      // Merge and check all environments
      env = mergeAndCheckEnvs(
        env,
        bodies.filter(
          (body) =>
            body.$ &&
            !hasControlFlow(body.$.controlFlow, "return") &&
            !hasControlFlow(body.$.controlFlow, "escape")
        )
      );

      // Determine the compile-time value
      let value: Value | undefined = undefined;
      if (caseBodyValues.some((val) => val === undefined)) {
        // Contains runtime value
        value = undefined;
      } else {
        // All evaluated conditions were not compile-time true, so result is unknown
        value = createUnknownValue(valueType.type, { env, context });
      }

      expr.$ = {
        env,
        type:
          context.expectedType?.type &&
          !typeContainsSomeType(context.expectedType.type)
            ? context.expectedType.type
            : valueType.type,
        value: value,
        pathCollection: [],
      };
      attachTempVariableToExpr(expr, true);

      return expr;
    } else {
      // All cases have control flow - determine which one to use
      if (controlFlows.length === 0) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `No control flows found but expected some.`,
        });
      }

      if (hasControlFlow(finalControlFlow, "return")) {
        // At least some cases are returning from function
        if (!context.isEvaluatingFunctionBodyOrAsyncBlock) {
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `All cases in cond are returning from function, but not evaluating in function body.`,
          });
        }

        // Use the actual return value type from return bodies when available.
        // This ensures the cond's type reflects the concrete type being returned,
        // which is important for detecting generic return type mismatches.
        let returnType: Type | undefined;
        if (returnBodies.length > 0 && returnBodies[0]!.$) {
          returnType = returnBodies[0]!.$.type;
        } else if (
          context.isEvaluatingFunctionBodyOrAsyncBlock.kind === "function-body"
        ) {
          returnType =
            context.isEvaluatingFunctionBodyOrAsyncBlock.type.return.type;
        } else if (context.expectedType) {
          returnType = context.expectedType.type;
        }

        if (!returnType) {
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `Failed to determine the return type for cond statement.`,
          });
        }

        expr.$ = {
          env,
          type: returnType,
          value:
            context.isEvaluatingFunctionBodyOrAsyncBlock.kind ===
              "function-body" &&
            isFunctionTypeAndReturnsComptimeValue(
              context.isEvaluatingFunctionBodyOrAsyncBlock.type
            )
              ? createUnknownValue(returnType, { env, context })
              : undefined,
          pathCollection: [],
          controlFlow: finalControlFlow,
        };
      } else if (hasControlFlow(finalControlFlow, "escape")) {
        // All cases are escaping. Determine the result type:
        // 1. If we have an enclosing function return type, use that (true escape target)
        // 2. Otherwise, if we're inside a function body, use the function's return type
        //    (the escape from `exn.throw` etc. terminates this function at runtime)
        let escapeType: Type | undefined = context.enclosingFunctionReturnType;
        if (
          !escapeType &&
          context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "function-body"
        ) {
          escapeType =
            context.isEvaluatingFunctionBodyOrAsyncBlock.type.return.type;
        }
        if (!escapeType && context.expectedType?.type) {
          escapeType = context.expectedType.type;
        }
        if (!escapeType) {
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `All cases in cond use "escape", but not inside a function with an enclosing function.`,
          });
        }
        expr.$ = {
          env,
          type: escapeType,
          value: undefined,
          pathCollection: [],
          controlFlow: finalControlFlow,
        };
      } else if (hasControlFlow(finalControlFlow, "break")) {
        // All cases break from loop
        if (!context.isEvaluatingLoopBody) {
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `All cases in cond are breaking from loop, but not inside a loop.`,
          });
        }
        expr.$ = {
          env,
          type: VUnit.type,
          value: VUnit,
          pathCollection: [],
          controlFlow: finalControlFlow,
        };
      } else if (hasControlFlow(finalControlFlow, "continue")) {
        // All cases continue loop
        if (!context.isEvaluatingLoopBody) {
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `All cases in cond are continuing loop, but not inside a loop.`,
          });
        }
        expr.$ = {
          env,
          type: VUnit.type,
          value: VUnit,
          pathCollection: [],
          controlFlow: finalControlFlow,
        };
      } else {
        // This should never reach
      }

      return expr;
    }
  }
}
