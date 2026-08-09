/**
 * suspension-analysis.ts
 *
 * Shared tree-walking analysis for suspension points.
 * Both async/await and algebraic effects use the same algorithm to:
 * 1. Capture local variables that persist across suspension points
 * 2. Handle while loop nesting
 * 3. Merge cond/match branch suspension points
 * 4. Walk deferred drop/dup expressions
 *
 * The only difference is *what constitutes a suspension point*, which is
 * injected via the SuspensionPointDetector callback.
 */

import { getVariablesFromEnv } from "../../env";
import {
  BuiltinKeywords,
  type Expr,
  exprIsFunctionCallOf,
  ExprTag,
} from "../../expr";
import { TokenType } from "../../token";

import type {
  SuspensionAnalysisResult,
  SuspensionCapturedVariable,
  SuspensionPoint,
} from "./suspension-analysis-types";

/**
 * Callback interface for detecting system-specific suspension points.
 * Async and effect wrappers provide concrete implementations.
 */
export interface SuspensionPointDetector<P extends SuspensionPoint> {
  /**
   * Detect suspension point(s) in a FnCall expression and push them to `points`.
   * The detector is responsible for constructing the full point object including
   * system-specific fields. Use `extractTargetVariableId` for the common
   * parent `:=` assignment pattern.
   */
  detect(expr: Expr, parentExpr: Expr | undefined, points: P[]): void;

  /**
   * Return true if this FnCall expression's body should be skipped
   * (no recursion into func/args). Used for nested async blocks that
   * have their own analysis. Deferred dup expressions are still walked.
   */
  shouldSkipBody(expr: Expr): boolean;
}

/**
 * Extracts the target variable ID from a parent `:=` assignment expression.
 * Shared by both async and effect suspension point detection.
 */
export function extractTargetVariableId(
  parentExpr: Expr | undefined
): string | undefined {
  if (
    parentExpr &&
    parentExpr.tag === ExprTag.FnCall &&
    exprIsFunctionCallOf(parentExpr, ":=")
  ) {
    const varExpr = parentExpr.args[0];
    if (
      varExpr &&
      varExpr.tag === ExprTag.Atom &&
      varExpr.token.type === TokenType.Identifier &&
      varExpr.$
    ) {
      const varName = varExpr.token.value;
      const variables = getVariablesFromEnv(varExpr.$.env, varName);
      if (variables.length > 0) {
        return variables[variables.length - 1]!.id;
      }
    }
  }
  return undefined;
}

/**
 * Analyzes a function body to find all suspension points and captured variables.
 *
 * @param body The function body expression
 * @param detector System-specific suspension point detector
 * @returns Analysis result with suspension points, captured variables, and SSA remapping
 */
export function analyzeSuspensionPoints<P extends SuspensionPoint>(
  body: Expr,
  detector: SuspensionPointDetector<P>
): SuspensionAnalysisResult<P> {
  const suspensionPoints: P[] = [];
  const capturedVariables = new Map<string, SuspensionCapturedVariable>();
  const nameFrameToOriginalId = new Map<string, string>();
  const variableIdRemapping = new Map<string, string>();

  walkExpr(
    body,
    suspensionPoints,
    capturedVariables,
    nameFrameToOriginalId,
    variableIdRemapping,
    detector
  );

  if (body.$?.deferredDropExpressions) {
    for (const dropExpr of body.$.deferredDropExpressions) {
      walkExpr(
        dropExpr,
        suspensionPoints,
        capturedVariables,
        nameFrameToOriginalId,
        variableIdRemapping,
        detector
      );
    }
  }

  if (suspensionPoints.length === 0) {
    capturedVariables.clear();
  }

  return {
    suspensionPoints,
    capturedVariables: Array.from(capturedVariables.values()),
    hasSuspensions: suspensionPoints.length > 0,
    variableIdRemapping,
  };
}

/**
 * Recursively walks an expression tree to find suspension points and capture variables.
 */
function walkExpr<P extends SuspensionPoint>(
  expr: Expr,
  points: P[],
  capturedVariables: Map<string, SuspensionCapturedVariable>,
  nameFrameToOriginalId: Map<string, string>,
  variableIdRemapping: Map<string, string>,
  detector: SuspensionPointDetector<P>,
  parentExpr?: Expr
): void {
  switch (expr.tag) {
    case ExprTag.Atom:
      if (expr.$ && expr.token.type === TokenType.Identifier) {
        const varName = expr.token.value;
        const varType = expr.$.type;
        const variables = getVariablesFromEnv(expr.$.env, varName);
        if (variables.length > 0) {
          const variable = variables[variables.length - 1]!;
          if (
            variable &&
            !capturedVariables.has(variable.id) &&
            !variable.isCompileTimeOnly
          ) {
            const nameFrameKey = `${variable.name}:${variable.frameLevel}`;
            const existingOriginalId = nameFrameToOriginalId.get(nameFrameKey);

            if (existingOriginalId && existingOriginalId !== variable.id) {
              variableIdRemapping.set(variable.id, existingOriginalId);
            } else if (variable.isOwningTheSameRcValueAs) {
              const ownerVar = variable.isOwningTheSameRcValueAs;
              if (!capturedVariables.has(ownerVar.id)) {
                const ownerCaptured: SuspensionCapturedVariable = {
                  id: ownerVar.id,
                  name: ownerVar.name,
                  type: ownerVar.type,
                  isOwningTheSameRcValueAs: undefined,
                };
                capturedVariables.set(ownerVar.id, ownerCaptured);
                const ownerNameFrameKey = `${ownerVar.name}:${ownerVar.frameLevel}`;
                if (!nameFrameToOriginalId.has(ownerNameFrameKey)) {
                  nameFrameToOriginalId.set(ownerNameFrameKey, ownerVar.id);
                }
              }
            } else {
              capturedVariables.set(variable.id, {
                id: variable.id,
                name: varName,
                type: varType,
                isOwningTheSameRcValueAs: undefined,
              });
              if (!nameFrameToOriginalId.has(nameFrameKey)) {
                nameFrameToOriginalId.set(nameFrameKey, variable.id);
              }
            }
          }
        }
      }
      break;

    case ExprTag.FnCall: {
      // Handle while loops — track nesting depth for enclosed suspension points
      if (exprIsFunctionCallOf(expr, BuiltinKeywords.while)) {
        const initialCount = points.length;
        walkExpr(
          expr.func,
          points,
          capturedVariables,
          nameFrameToOriginalId,
          variableIdRemapping,
          detector,
          expr
        );
        for (const arg of expr.args) {
          walkExpr(
            arg,
            points,
            capturedVariables,
            nameFrameToOriginalId,
            variableIdRemapping,
            detector,
            expr
          );
        }
        const newCount = points.length;
        if (newCount > initialCount) {
          for (let i = initialCount; i < newCount; i++) {
            points[i]!.isInsideWhile = true;
            points[i]!.whileNestingDepth =
              (points[i]!.whileNestingDepth ?? 0) + 1;
            if (!points[i]!.enclosingWhileExpr) {
              points[i]!.enclosingWhileExpr = expr;
            }
          }
        }
        break;
      }

      // `if` is a macro over `cond`. Its branch structure only exists in the
      // expansion, so walk that instead — otherwise its suspension points never
      // get the merged indices and `cond_branch` fields that codegen (which
      // does follow the expansion) goes on to reference.
      if (
        exprIsFunctionCallOf(expr, BuiltinKeywords.if) &&
        expr.$?.macroExpansion
      ) {
        walkExpr(
          expr.$.macroExpansion,
          points,
          capturedVariables,
          nameFrameToOriginalId,
          variableIdRemapping,
          detector,
          parentExpr
        );
        break;
      }

      // Handle cond branches — merge mutually exclusive suspension points
      if (exprIsFunctionCallOf(expr, BuiltinKeywords.cond)) {
        handleBranchingExpr(
          expr,
          points,
          capturedVariables,
          nameFrameToOriginalId,
          variableIdRemapping,
          detector
        );
        break;
      }

      // Handle match branches — same merging logic as cond
      if (exprIsFunctionCallOf(expr, BuiltinKeywords.match)) {
        handleBranchingExpr(
          expr,
          points,
          capturedVariables,
          nameFrameToOriginalId,
          variableIdRemapping,
          detector
        );
        break;
      }

      // Detect system-specific suspension points (await, ctl calls, etc.)
      detector.detect(expr, parentExpr, points);

      // Check if body should be skipped (e.g., nested async blocks)
      if (detector.shouldSkipBody(expr)) {
        if (expr.$?.deferredDupExpressions) {
          for (const dupExpr of expr.$.deferredDupExpressions) {
            walkExpr(
              dupExpr,
              points,
              capturedVariables,
              nameFrameToOriginalId,
              variableIdRemapping,
              detector,
              expr
            );
          }
        }
        break;
      }

      // Recurse into function and arguments
      walkExpr(
        expr.func,
        points,
        capturedVariables,
        nameFrameToOriginalId,
        variableIdRemapping,
        detector,
        expr
      );
      for (const arg of expr.args) {
        walkExpr(
          arg,
          points,
          capturedVariables,
          nameFrameToOriginalId,
          variableIdRemapping,
          detector,
          expr
        );
      }

      // Walk deferred drop expressions
      if (expr.$?.deferredDropExpressions) {
        for (const dropExpr of expr.$.deferredDropExpressions) {
          walkExpr(
            dropExpr,
            points,
            capturedVariables,
            nameFrameToOriginalId,
            variableIdRemapping,
            detector,
            expr
          );
        }
      }
      break;
    }
  }
}

/**
 * Handles cond/match branching expressions. Suspension points in mutually
 * exclusive branches are merged by position (all position-0 suspensions share
 * an index, all position-1 suspensions share an index, etc.).
 */
function handleBranchingExpr<P extends SuspensionPoint>(
  expr: Expr,
  points: P[],
  capturedVariables: Map<string, SuspensionCapturedVariable>,
  nameFrameToOriginalId: Map<string, string>,
  variableIdRemapping: Map<string, string>,
  detector: SuspensionPointDetector<P>
): void {
  if (expr.tag !== ExprTag.FnCall) return;

  const initialCount = points.length;

  // Walk the func expression (cond/match keyword + condition/matched value)
  walkExpr(
    expr.func,
    points,
    capturedVariables,
    nameFrameToOriginalId,
    variableIdRemapping,
    detector,
    expr
  );

  // Save nameFrameToOriginalId before processing branches so that variables
  // declared inside one branch don't leak into subsequent cond/match expressions.
  // Without this, two independent variables with the same name:frameLevel in
  // sequential cond branches would be incorrectly remapped to share one field.
  const savedNameFrameToOriginalId = new Map(nameFrameToOriginalId);

  // Walk each branch separately to track per-branch suspension points
  const perBranchPoints: P[][] = [];
  for (const arg of expr.args) {
    const branchStart = points.length;
    walkExpr(
      arg,
      points,
      capturedVariables,
      nameFrameToOriginalId,
      variableIdRemapping,
      detector,
      expr
    );
    perBranchPoints.push(points.slice(branchStart));
  }

  // Restore nameFrameToOriginalId — branch-local declarations must not persist
  nameFrameToOriginalId.clear();
  for (const [k, v] of savedNameFrameToOriginalId) {
    nameFrameToOriginalId.set(k, v);
  }

  const maxDepth = Math.max(...perBranchPoints.map((b) => b.length), 0);
  if (maxDepth > 0) {
    // Remove all new points added during branch walking
    points.splice(initialCount);

    // Re-add merged by position across branches
    const firstIndex = initialCount;
    for (let pos = 0; pos < maxDepth; pos++) {
      let representative: P | undefined;
      for (const branchList of perBranchPoints) {
        if (pos < branchList.length) {
          representative = branchList[pos];
          break;
        }
      }
      if (representative) {
        representative.index = points.length;
        representative.isInsideCond = true;
        if (pos === 0) {
          representative.needsOwnCondBranchField = true;
        }
        if (pos > 0) {
          representative.condBranchSourceIndex = firstIndex;
        }
        points.push(representative);
      }
    }
  }
}
