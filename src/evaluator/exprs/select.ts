import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  ControlFlowKind,
  Expr,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
  mergeAndCheckEnvs,
} from "../../expr";
import {
  areTypesCompatible,
  convertComptTypeToRuntimeType,
  Type,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import { EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "./begin";

/**
 * Evaluates the select statement for channel operations.
 *
 * Syntax:
 * select(
 *   (ch <- val) => body,           // send case
 *   (<-(ch)) => body,              // receive case
 *   (var := (<-(ch))) => body,     // receive with assignment
 *   _ => body                      // default case
 * )
 *
 * Similar to Go's select statement, but with Yo syntax.
 */
export function evaluateSelect({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.select)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "select", got ${expr.tag}`,
    });
  }

  const cases = expr.args;
  if (cases.length === 0) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected at least one case in "select", got ${cases.length}`,
    });
  }

  // Parse and validate all cases
  const parsedCases: Array<{
    caseExpr: Expr;
    bodyExpr: Expr;
    caseKind: "send" | "receive" | "receive_assign" | "default";
    caseEnv: Environment;
  }> = [];

  let hasDefault = false;

  for (let i = 0; i < cases.length; i++) {
    const caseStmt = cases[i]!;

    if (
      !exprIsFunctionCall(caseStmt) ||
      !exprIsFunctionCallOf(caseStmt, "=>", 2)
    ) {
      throw formatErrorMessage({
        token: caseStmt.token,
        errorMessage: `Expected => for select case, got ${exprToString(caseStmt)}`,
      });
    }

    const caseExpr = caseStmt.args[0]!;
    const bodyExpr = caseStmt.args[1]!;
    const caseEnv = env;

    // Determine case kind
    let caseKind: "send" | "receive" | "receive_assign" | "default";

    if (exprIsAtomOf(caseExpr, "_")) {
      // Default case
      if (hasDefault) {
        throw formatErrorMessage({
          token: caseExpr.token,
          errorMessage: `Only one default case (_) is allowed in select`,
        });
      }
      if (i !== cases.length - 1) {
        throw formatErrorMessage({
          token: caseExpr.token,
          errorMessage: `Default case (_) must be the last case in select`,
        });
      }
      hasDefault = true;
      caseKind = "default";
    } else if (
      exprIsFunctionCall(caseExpr) &&
      exprIsFunctionCallOf(caseExpr, ":=", 2)
    ) {
      // Receive with assignment: (var := (<-(ch)))
      const recvExpr = caseExpr.args[1]!;
      if (
        !exprIsFunctionCall(recvExpr) ||
        !exprIsFunctionCallOf(recvExpr, "<-", 1)
      ) {
        throw formatErrorMessage({
          token: recvExpr.token,
          errorMessage: `Expected receive operation (<-(ch)) on right side of :=, got ${exprToString(recvExpr)}`,
        });
      }
      caseKind = "receive_assign";
    } else if (
      exprIsFunctionCall(caseExpr) &&
      exprIsFunctionCallOf(caseExpr, "<-", 1)
    ) {
      // Receive without assignment: (<-(ch))
      caseKind = "receive";
    } else if (
      exprIsFunctionCall(caseExpr) &&
      exprIsFunctionCallOf(caseExpr, "<-", 2)
    ) {
      // Send: (ch <- val)
      caseKind = "send";
    } else {
      throw formatErrorMessage({
        token: caseExpr.token,
        errorMessage: `Invalid select case pattern: ${exprToString(caseExpr)}
Supported patterns:
- (ch <- val) => body           // send case
- (<-(ch)) => body              // receive case
- (var := (<-(ch))) => body     // receive with assignment
- _ => body                     // default case`,
      });
    }

    parsedCases.push({ caseExpr, bodyExpr, caseKind, caseEnv });
  }

  // Evaluate all case expressions to validate them and handle variable assignments
  const evaluatedCases: Array<{
    caseExpr: Expr;
    bodyExpr: Expr;
    caseKind: "send" | "receive" | "receive_assign" | "default";
    caseEnv: Environment;
  }> = [];

  for (const { caseExpr, bodyExpr, caseKind, caseEnv } of parsedCases) {
    let updatedCaseEnv = caseEnv;

    if (caseKind !== "default") {
      // Evaluate the case expression (send, receive, or receive_assign)
      const evaluatedCaseExpr = context.evaluateExpression({
        expr: caseExpr,
        env: updatedCaseEnv,
        context: { ...context },
      });

      if (!evaluatedCaseExpr.$) {
        throw formatErrorMessage({
          token: caseExpr.token,
          errorMessage: `Failed to evaluate select case expression: ${exprToString(caseExpr)}`,
        });
      }

      updatedCaseEnv = evaluatedCaseExpr.$.env;
    }

    evaluatedCases.push({
      caseExpr,
      bodyExpr,
      caseKind,
      caseEnv: updatedCaseEnv,
    });
  }

  // Evaluate all case bodies
  const bodies: Expr[] = [];
  let resultType: { type: Type; env: Environment } | undefined = undefined;
  let hasCaseThatDoesntHaveControlFlowSet = false;
  const controlFlows: ControlFlowKind[] = [];

  for (const { caseExpr, bodyExpr, caseEnv } of evaluatedCases) {
    // Mark the case as executed
    if (caseExpr.$) {
      caseExpr.$.caseExecuted = true;
    }

    // Evaluate the body
    const evaluatedBodyExpr = evaluateBeginExpression({
      expr: bodyExpr,
      env: caseEnv,
      context: {
        ...context,
        isExecuting: false, // We're analyzing all paths
      },
      variablesToAdd: [],
    });

    if (evaluatedBodyExpr.$?.controlFlow) {
      controlFlows.push(evaluatedBodyExpr.$.controlFlow);
      continue; // Skip type checking for control flow paths
    } else {
      hasCaseThatDoesntHaveControlFlowSet = true;
    }

    if (!evaluatedBodyExpr.$?.type) {
      throw formatErrorMessage({
        token: bodyExpr.token,
        errorMessage: `Expected type for select case body, got ${exprToString(bodyExpr)}`,
      });
    }

    bodies.push(evaluatedBodyExpr);

    if (context.expectedType) {
      if (
        !areTypesCompatible(context.expectedType, {
          type: evaluatedBodyExpr.$.type,
          env: evaluatedBodyExpr.$.env,
        })
      ) {
        throw formatErrorMessage({
          token: evaluatedBodyExpr.token,
          errorMessage: `Incompatible type with expected type:
- Expected: ${typeToString(context.expectedType.type)}
- Actual  : ${typeToString(evaluatedBodyExpr.$.type)}`,
        });
      }
    }

    if (!resultType) {
      resultType = {
        type: evaluatedBodyExpr.$.type,
        env: evaluatedBodyExpr.$.env,
      };
    } else {
      // Check if the types are compatible
      if (
        !areTypesCompatible(
          { type: resultType.type, env: resultType.env },
          {
            type: evaluatedBodyExpr.$.type,
            env: evaluatedBodyExpr.$.env,
          }
        )
      ) {
        // Check if the types match when converting to runtime type
        if (
          areTypesCompatible(
            {
              type: convertComptTypeToRuntimeType(resultType.type),
              env: resultType.env,
            },
            {
              type: evaluatedBodyExpr.$.type,
              env: evaluatedBodyExpr.$.env,
            }
          )
        ) {
          resultType = {
            type: evaluatedBodyExpr.$.type,
            env: evaluatedBodyExpr.$.env,
          };
        } else {
          throw formatErrorMessage({
            token: evaluatedBodyExpr.token,
            errorMessage: `Incompatible types in select cases:
- Previous: ${typeToString(resultType.type)}
- Current : ${typeToString(evaluatedBodyExpr.$.type)}`,
          });
        }
      }
    }
  }

  // Check the control flows
  let finalControlFlow: ControlFlowKind | undefined = undefined;
  if (controlFlows.every((cf) => cf === "return")) {
    finalControlFlow = "return";
  } else if (controlFlows.every((cf) => cf === "break")) {
    finalControlFlow = "break";
  } else if (controlFlows.every((cf) => cf === "continue")) {
    finalControlFlow = "continue";
  } else {
    if (context.isEvaluatingLoopBody) {
      if (controlFlows.find((cf) => cf === "continue")) {
        finalControlFlow = "continue";
      } else if (controlFlows.find((cf) => cf === "break")) {
        finalControlFlow = "break";
      } else if (controlFlows.find((cf) => cf === "return")) {
        finalControlFlow = "return";
      }
    } else {
      finalControlFlow = undefined; // Mixed control flows
    }
  }

  if (hasCaseThatDoesntHaveControlFlowSet || !finalControlFlow) {
    if (hasCaseThatDoesntHaveControlFlowSet && !resultType) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Failed to determine the type of value from the select`,
      });
    } else if (!resultType) {
      resultType = { type: VUnit.type, env: env };
    }

    // Merge and check all environments
    env = mergeAndCheckEnvs(
      env,
      bodies,
      bodies.map(() => ({ ...context }))
    );

    // select is always a runtime operation - it waits for channel operations
    // Therefore, we always return undefined as the compile-time value
    expr.$ = {
      env,
      type: context.expectedType?.type ?? resultType.type,
      value: undefined, // Always runtime - never compile-time known
      pathCollection: [],
    };
    attachTempVariableToExpr(expr, true);

    return expr;
  } else {
    // All cases have control flow
    if (controlFlows.length === 0) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `No control flows found but expected some`,
      });
    }

    if (finalControlFlow === "return") {
      if (!context.isEvaluatingFunctionBody) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `All cases in select are returning from function, but not evaluating in function body`,
        });
      }
      const functionReturnType =
        context.isEvaluatingFunctionBody.type.return.type;
      expr.$ = {
        env,
        type: context.expectedType?.type ?? functionReturnType,
        value: undefined,
        pathCollection: [],
        controlFlow: "return",
      };
    } else if (finalControlFlow === "break") {
      if (!context.isEvaluatingLoopBody) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `All cases in select are breaking from loop, but not inside a loop`,
        });
      }
      expr.$ = {
        env,
        type: VUnit.type,
        value: undefined,
        pathCollection: [],
        controlFlow: "break",
      };
    } else if (finalControlFlow === "continue") {
      if (!context.isEvaluatingLoopBody) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `All cases in select are continuing loop, but not inside a loop`,
        });
      }
      expr.$ = {
        env,
        type: VUnit.type,
        value: undefined,
        pathCollection: [],
        controlFlow: "continue",
      };
    }

    return expr;
  }
}
