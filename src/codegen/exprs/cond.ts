import {
  BuiltinKeywords,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  FnCallExpr,
} from "../../expr";
import { isUnitType } from "../../types";
import { isTempVariableName } from "../../utils";
import { isBooleanValue } from "../../value";
import { FunctionGenerationContext } from "../functions/context";
import { CodeGenContext, getTypeString } from "../utils";
import {
  generateDeferredDropExpressions,
  generateDeferredDupExpressions,
} from "./drop_dup";
import { generateExpr } from "./expr";

/**
 * Generate a conditional expression (cond) as a value expression - extracted from original codegen-c.ts
 */
export function generateCondExpression(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  // Check if the cond expression has been evaluated and has a variable name
  if (expr.$) {
    const tempVar = expr.$.variableName;
    const valueType = expr.$.type;
    const isUnit = valueType && isUnitType(valueType);

    // For unit types, don't declare a temporary variable
    if (!isUnit && tempVar) {
      const varType = getTypeString(valueType, context);
      context.emitter.emitLine(`${indent}${varType} ${tempVar};`);
    }

    // Generate if-else chain for each condition => value pair
    // Strategy:
    // - If all conditions before a compile-time true are compile-time false, just generate the value directly
    // - Otherwise: First condition becomes `if (...) {}`, all subsequent become nested in a single `else { ... }`

    // First pass: check if we can optimize to direct value generation
    let firstNonFalseBranchIndex = -1;
    for (let i = 0; i < expr.args.length; i++) {
      const arg = expr.args[i];
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=>", 2)) {
        const condition = arg.args[0];
        if (condition) {
          const isFalse =
            isBooleanValue(condition.$?.value) &&
            condition.$.value.value === false;
          if (!isFalse) {
            firstNonFalseBranchIndex = i;
            break;
          }
        }
      }
    }

    // Check if the first non-false branch is a compile-time true
    let canOptimizeToDirect = false;
    if (firstNonFalseBranchIndex >= 0) {
      const firstArg = expr.args[firstNonFalseBranchIndex];
      if (
        firstArg &&
        exprIsFunctionCall(firstArg) &&
        exprIsFunctionCallOf(firstArg, "=>", 2)
      ) {
        const firstCondition = firstArg.args[0];
        if (
          firstCondition &&
          isBooleanValue(firstCondition.$?.value) &&
          firstCondition.$.value.value === true
        ) {
          canOptimizeToDirect = true;
        }
      }
    }

    // If we can optimize to direct generation, just generate the value expression
    if (canOptimizeToDirect && firstNonFalseBranchIndex >= 0) {
      const arg = expr.args[firstNonFalseBranchIndex];
      if (
        arg &&
        exprIsFunctionCall(arg) &&
        exprIsFunctionCallOf(arg, "=>", 2)
      ) {
        const value = arg.args[1];
        if (value) {
          // Generate the value expression directly
          const valueCode = generateExpr(value, indent, context);

          // Check if we need to assign to temp variable
          if (tempVar && !isUnit) {
            if (
              valueCode &&
              valueCode !== "" &&
              !valueCode.startsWith("goto") &&
              valueCode !== "continue" &&
              valueCode !== "break" &&
              !valueCode.includes("return")
            ) {
              context.emitter.emitLine(`${indent}${tempVar} = ${valueCode};`);
            }
            // For goto, continue, break, return statements, emit them directly
            else if (
              valueCode &&
              (valueCode.startsWith("goto") ||
                valueCode === "continue" ||
                valueCode === "break" ||
                valueCode.includes("return"))
            ) {
              context.emitter.emitLine(`${indent}${valueCode};`);
            }
          }
        }
      }

      // For unit types, return empty string; for others, return temp variable
      return isUnit ? "" : (tempVar ?? "");
    }

    // Otherwise, generate full if-else chain
    let currentIndent = indent;
    let elseBlockDepth = 0; // Track how many else blocks we need to close at the end
    let hasEmittedBranch = false; // Track whether we've emitted any branch (not skipped)

    for (let i = 0; i < expr.args.length; i++) {
      const arg = expr.args[i];
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=>", 2)) {
        // This is a condition => value pair
        const condition = arg.args[0];
        const value = arg.args[1];

        if (condition && value) {
          // Skip compile-time false conditions
          if (
            isBooleanValue(condition.$?.value) &&
            condition.$.value.value === false
          ) {
            continue;
          }

          // For the first EMITTED branch, generate `if (...) {}` or just `{}`
          if (!hasEmittedBranch) {
            if (
              isBooleanValue(condition.$?.value) &&
              condition.$.value.value === true
            ) {
              // Compile-time true as first condition - just use a block
              context.emitter.emitLine(`${currentIndent}{`);
            } else {
              // Regular condition
              const conditionCode = generateExpr(
                condition,
                currentIndent,
                context
              );
              context.emitter.emitLine(
                `${currentIndent}if (${conditionCode}) {`
              );
            }
            hasEmittedBranch = true;
          } else {
            // For subsequent conditions, wrap in `else {` and increment depth
            context.emitter.emitLine(`${currentIndent}else {`);
            elseBlockDepth++;
            currentIndent += "  ";

            const isCompileTimeTrue =
              isBooleanValue(condition.$?.value) &&
              condition.$.value.value === true;

            if (isCompileTimeTrue) {
              // Compile-time true - no condition needed, value goes directly in the else block
              // We'll close the else block at the end, not here
            } else {
              // Regular condition - generate if inside the else block
              const conditionCode = generateExpr(
                condition,
                currentIndent,
                context
              );
              context.emitter.emitLine(
                `${currentIndent}if (${conditionCode}) {`
              );
            }
          }

          // Determine the indent for the value block
          const isCompileTimeTrue =
            isBooleanValue(condition.$?.value) &&
            condition.$.value.value === true;

          // For compile-time true in else block (not first branch), don't add extra indentation
          const valueIndent =
            hasEmittedBranch && isCompileTimeTrue
              ? currentIndent
              : currentIndent + "  ";

          // Handle begin blocks specially in conditional expressions
          if (
            exprIsFunctionCall(value) &&
            exprIsFunctionCallOf(value, BuiltinKeywords.begin)
          ) {
            // For begin blocks in conditionals, we need to generate the statements inline
            // like generateLoopBody but also capture the final expression result

            const beginArgs = value.args;

            // Generate each statement except the last one
            for (let j = 0; j < beginArgs.length - 1; j++) {
              const arg = beginArgs[j]!;
              const argCode = generateExpr(arg, valueIndent, context);
              // Skip temp variable references
              if (
                argCode &&
                arg.$ &&
                !isTempVariableName(arg.$.env.modulePath, argCode)
              ) {
                context.emitter.emitLine(`${valueIndent}${argCode};`);
              }
            }

            // Generate the final expression and assign it to temp variable
            if (beginArgs.length > 0) {
              const finalExpr = beginArgs[beginArgs.length - 1]!;
              // Generate deferred dup expressions for the final expression (e.g., returning a borrowed value)
              if (finalExpr.$?.deferredDupExpressions) {
                generateDeferredDupExpressions(
                  finalExpr,
                  valueIndent,
                  context as FunctionGenerationContext
                );
              }
              const finalExprCode = generateExpr(
                finalExpr,
                valueIndent,
                context
              );

              if (finalExprCode) {
                // Check if this is a control flow statement
                if (
                  finalExprCode === "continue" ||
                  finalExprCode === "break" ||
                  finalExprCode.startsWith("goto") ||
                  (exprIsFunctionCall(finalExpr) &&
                    exprIsFunctionCallOf(finalExpr, BuiltinKeywords.return)) ||
                  finalExprCode.includes("return")
                ) {
                  // For control flow statements, emit them directly without assignment
                  context.emitter.emitLine(`${valueIndent}${finalExprCode};`);
                } else if (tempVar && !isUnit) {
                  context.emitter.emitLine(
                    `${valueIndent}${tempVar} = ${finalExprCode};`
                  );
                }
              }
            }

            // Generate deferred drop expressions for the begin block
            if (value.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(value, valueIndent, context);
            }
          } else {
            // Generate deferred dup expressions for non-begin value expressions
            if (value.$?.deferredDupExpressions) {
              generateDeferredDupExpressions(
                value,
                valueIndent,
                context as FunctionGenerationContext
              );
            }
            // Generate the value expression INSIDE the conditional block
            const valueCode = generateExpr(value, valueIndent, context);

            // Check if this is a control flow statement or unit expression
            if (
              valueCode === "continue" ||
              valueCode === "break" ||
              valueCode.startsWith("goto") ||
              (exprIsFunctionCall(value) &&
                exprIsFunctionCallOf(value, BuiltinKeywords.return)) ||
              valueCode.includes("return")
            ) {
              // For control flow statements, emit them directly without assignment
              context.emitter.emitLine(`${valueIndent}${valueCode};`);
            } else if (valueCode === "" || !valueCode) {
              // For unit expressions, don't emit anything
            } else if (tempVar) {
              // For regular expressions, assign to temp variable (only if not unit type)
              if (!isUnit) {
                context.emitter.emitLine(
                  `${valueIndent}${tempVar} = ${valueCode};`
                );
              }
            }
          }

          // Close the if/block for this condition
          // For compile-time true in an else block, we don't close anything here (the else block closes at the end)
          // For all other cases, close the if block or the initial block
          const needsClosing = !(hasEmittedBranch && isCompileTimeTrue);
          if (needsClosing) {
            context.emitter.emitLine(`${currentIndent}}`);
          }
        }
      }
    }

    // Close all the else blocks we opened
    for (let i = 0; i < elseBlockDepth; i++) {
      currentIndent = currentIndent.slice(0, -2); // Remove 2 spaces
      context.emitter.emitLine(`${currentIndent}}`);
    }

    // For unit types, return empty string; for others, return temp variable
    return isUnit ? "" : (tempVar ?? "");
  }

  // Fallback for non-evaluated expressions
  return '/* "cond" expression is not evaluated */';
}
