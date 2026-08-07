import { getVariablesFromEnv } from "../../env";
import {
  BuiltinKeywords,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  type FnCallExpr,
  hasAnyControlFlow,
} from "../../expr";
import { isPtrType, isUnitType } from "../../types/guards";
import { isTempVariableName } from "../../utils";
import { isBooleanValue } from "../../value";
import { type FunctionGenerationContext } from "../functions/context";
import {
  codeContainsReturnStatement,
  type CodeGenContext,
  getTypeString,
  getVariableNameForCodegen,
} from "../utils";
import {
  generateDeferredDropExpressions,
  generateDeferredDupExpressions,
} from "./drop-dup";
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

    // For `-> ref(T)` enclosing functions, the cond as a whole is a
    // place expression whose temp var is declared as `T*`. Arm bodies
    // that produce raw `T` (e.g. a field projection `p.x` of a ref-bound
    // parameter, accepted by the evaluator's PtrRelaxedMatch in
    // exprs/cond.ts) must have their assignment to that temp wrapped in
    // `&(...)` so the C-level lvalue types agree. Flowability has
    // already verified the arm roots back to a ref-bound parameter, so
    // taking the address is sound.
    const functionContext = context as FunctionGenerationContext;
    const condOuterIsPtr =
      !!functionContext.currentFunctionType?.return.isRef &&
      !!valueType &&
      isPtrType(valueType);
    const maybeAddressOf = (
      armExpr: Expr | undefined,
      code: string
    ): string => {
      if (!condOuterIsPtr) return code;
      const armType = armExpr?.$?.type;
      if (!armType || isPtrType(armType)) return code;
      return `&(${code})`;
    };

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

    // For unit types, don't declare a temporary variable
    // Also skip declaration when optimizing to direct (compile-time known condition)
    // because the inner expression already has its temp variable declared
    if (!isUnit && tempVar && !canOptimizeToDirect) {
      const varType = getTypeString(valueType, context);
      context.emitter.emitLine(`${indent}${varType} ${tempVar};`);
      // Record the C declaration so the drop-emission gate does not skip this
      // (declared) temp's drop as if undeclared (a skipped live-RC drop leaks).
      context.declaredCVarNames?.add(tempVar);
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
              !codeContainsReturnStatement(valueCode)
            ) {
              context.emitter.emitLine(`${indent}${tempVar} = ${valueCode};`);
            }
            // For goto, continue, break, return statements, emit them directly
            else if (
              valueCode &&
              (valueCode.startsWith("goto") ||
                valueCode === "continue" ||
                valueCode === "break" ||
                codeContainsReturnStatement(valueCode))
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

            // Save and update pendingDeferredDrops for this nested begin block
            // IMPORTANT: Concatenate with previous drops so early returns drop ALL enclosing scope vars
            const previousPendingDeferredDrops =
              functionContext.pendingDeferredDrops;
            const currentDrops = value.$?.deferredDropExpressions ?? [];
            functionContext.pendingDeferredDrops = [
              ...currentDrops,
              ...(previousPendingDeferredDrops ?? []),
            ];
            const previousConsumedVarDrops =
              functionContext.consumedVarPendingDrops;
            const currentConsumedDrops =
              value.$?.consumedVariableDropExpressions ?? [];
            functionContext.consumedVarPendingDrops = [
              ...currentConsumedDrops,
              ...(previousConsumedVarDrops ?? []),
            ];

            // Generate each statement except the last one
            for (let j = 0; j < beginArgs.length - 1; j++) {
              const beginArg = beginArgs[j]!;
              const argCode = generateExpr(beginArg, valueIndent, context);
              // Skip temp variable references
              if (
                argCode &&
                beginArg.$ &&
                !isTempVariableName(beginArg.$.env.modulePath, argCode)
              ) {
                context.emitter.emitLine(`${valueIndent}${argCode};`);
              }
              // Stop after control flow (dead code may lack metadata)
              if (hasAnyControlFlow(beginArg.$?.controlFlow)) {
                break;
              }
            }

            // Generate the final expression and assign it to temp variable
            if (beginArgs.length > 0) {
              const finalExpr = beginArgs[beginArgs.length - 1]!;

              // Skip if the begin block escaped early and finalExpr was never evaluated.
              // (The evaluator breaks the begin-block loop on escape/return, leaving
              // subsequent args unevaluated with expr.$ = undefined.)
              if (finalExpr.$) {
                // Generate deferred dup expressions for the final expression (e.g., returning a borrowed value)
                // We must first declare and assign the value to a temp variable,
                // THEN generate the dup call that references that temp variable.
                if (finalExpr.$?.deferredDupExpressions) {
                  if (finalExpr.$?.variableName) {
                    const savedVariableName = finalExpr.$.variableName;
                    finalExpr.$.variableName = undefined;
                    const rawCode = generateExpr(
                      finalExpr,
                      valueIndent,
                      context
                    );
                    finalExpr.$.variableName = savedVariableName;

                    const argType = getTypeString(finalExpr.$.type!, context);
                    const argTempVar = getVariableNameForCodegen(
                      savedVariableName,
                      finalExpr.$.env
                    );

                    // Skip the temp-var declaration when finalExpr is
                    // an ref-param atom — `T name = (*name);` would
                    // shadow the pointer parameter. See
                    // plans/MEMORY_SAFETY.md and
                    // issues/inout-multi-stmt-body-shadow.md.
                    let isInoutAtom = false;
                    if (exprIsAtom(finalExpr) && finalExpr.$?.env) {
                      const vars = getVariablesFromEnv(
                        finalExpr.$.env,
                        savedVariableName
                      );
                      if (vars.length > 0 && vars[vars.length - 1]!.isRef) {
                        isInoutAtom = true;
                      }
                    }
                    if (!isInoutAtom && argTempVar !== rawCode) {
                      context.emitter.emitLine(
                        `${valueIndent}${argType} ${argTempVar} = ${rawCode};`
                      );
                    }
                  }
                  generateDeferredDupExpressions(
                    finalExpr,
                    valueIndent,
                    context as FunctionGenerationContext
                  );
                  // Use the dup result as the final value
                  const dupExpr = finalExpr.$.deferredDupExpressions[0]!;
                  if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                    const dupResultVar = getVariableNameForCodegen(
                      dupExpr.$.variableName,
                      dupExpr.$.env
                    );
                    if (tempVar && !isUnit) {
                      context.emitter.emitLine(
                        `${valueIndent}${tempVar} = ${dupResultVar};`
                      );
                    }
                  } else {
                    // Fallback: generate final expr normally
                    const finalExprCode = generateExpr(
                      finalExpr,
                      valueIndent,
                      context
                    );
                    if (finalExprCode && tempVar && !isUnit) {
                      context.emitter.emitLine(
                        `${valueIndent}${tempVar} = ${maybeAddressOf(finalExpr, finalExprCode)};`
                      );
                    }
                  }
                } else {
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
                        exprIsFunctionCallOf(
                          finalExpr,
                          BuiltinKeywords.return
                        )) ||
                      codeContainsReturnStatement(finalExprCode)
                      // Use word boundary to avoid matching identifiers like
                      // `return_flag` inside struct-literal field names.
                      // (issue: struct-literal-in-match-arm-not-assigned)
                    ) {
                      // For control flow statements, emit them directly without assignment
                      context.emitter.emitLine(
                        `${valueIndent}${finalExprCode};`
                      );
                    } else if (tempVar && !isUnit) {
                      context.emitter.emitLine(
                        `${valueIndent}${tempVar} = ${maybeAddressOf(finalExpr, finalExprCode)};`
                      );
                    }
                  }
                }
              }
            }

            // Generate deferred drop expressions for the begin block
            if (value.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(value, valueIndent, context);
            }

            // Restore previous pendingDeferredDrops
            functionContext.pendingDeferredDrops = previousPendingDeferredDrops;
            functionContext.consumedVarPendingDrops = previousConsumedVarDrops;
          } else {
            // Non-begin value expression
            if (
              value.$?.deferredDupExpressions &&
              value.$.deferredDupExpressions.length > 0
            ) {
              // Declare the temp variable before generating dup
              if (value.$?.variableName) {
                const savedVariableName = value.$.variableName;
                value.$.variableName = undefined;
                const rawCode = generateExpr(value, valueIndent, context);
                value.$.variableName = savedVariableName;

                const argType = getTypeString(value.$.type!, context);
                const argTempVar = getVariableNameForCodegen(
                  savedVariableName,
                  value.$.env
                );

                // Skip the temp-var declaration when value is an
                // ref-param atom — `T name = (*name);` would shadow
                // the pointer parameter. See
                // issues/inout-multi-stmt-body-shadow.md.
                let isInoutAtom = false;
                if (exprIsAtom(value) && value.$?.env) {
                  const vars = getVariablesFromEnv(
                    value.$.env,
                    savedVariableName
                  );
                  if (vars.length > 0 && vars[vars.length - 1]!.isRef) {
                    isInoutAtom = true;
                  }
                }
                if (!isInoutAtom && argTempVar !== rawCode) {
                  context.emitter.emitLine(
                    `${valueIndent}${argType} ${argTempVar} = ${rawCode};`
                  );
                }
              }
              generateDeferredDupExpressions(
                value,
                valueIndent,
                context as FunctionGenerationContext
              );
              // Use the dup result as the value
              const dupExpr = value.$.deferredDupExpressions[0]!;
              if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                const dupResultVar = getVariableNameForCodegen(
                  dupExpr.$.variableName,
                  dupExpr.$.env
                );
                if (tempVar && !isUnit) {
                  context.emitter.emitLine(
                    `${valueIndent}${tempVar} = ${dupResultVar};`
                  );
                }
              } else {
                const valueCode = generateExpr(value, valueIndent, context);
                if (valueCode && tempVar && !isUnit) {
                  context.emitter.emitLine(
                    `${valueIndent}${tempVar} = ${maybeAddressOf(value, valueCode)};`
                  );
                }
              }
            } else {
              // Generate the value expression INSIDE the conditional block
              const valueCode = generateExpr(value, valueIndent, context);

              // Check if this is a control flow statement or unit expression
              if (
                valueCode === "continue" ||
                valueCode === "break" ||
                valueCode.startsWith("goto") ||
                (exprIsFunctionCall(value) &&
                  exprIsFunctionCallOf(value, BuiltinKeywords.return)) ||
                codeContainsReturnStatement(valueCode)
              ) {
                // For control flow statements, emit them directly without assignment
                context.emitter.emitLine(`${valueIndent}${valueCode};`);
              } else if (valueCode === "" || !valueCode) {
                // For unit expressions, don't emit anything
              } else if (tempVar) {
                // For regular expressions, assign to temp variable (only if not unit type)
                if (!isUnit) {
                  context.emitter.emitLine(
                    `${valueIndent}${tempVar} = ${maybeAddressOf(value, valueCode)};`
                  );
                }
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
