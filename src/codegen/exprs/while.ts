import {
  BuiltinKeywords,
  type Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import type { FunctionGenerationContext } from "../functions/context";
import { type CodeGenContext, getDeferredDropTargetAtomName } from "../utils";
import { generateExpr } from "./expr";

/**
 * Generate step expression for for loop increment section.
 * This generates the step expression inline without emitting it as a statement.
 */
function generateStepExpression(
  stepExpr: Expr,
  context: CodeGenContext
): string {
  // Handle begin blocks specially for multiple step expressions
  if (
    exprIsFunctionCall(stepExpr) &&
    exprIsFunctionCallOf(stepExpr, BuiltinKeywords.begin)
  ) {
    // Extract all assignment expressions from the begin block
    const assignments: string[] = [];

    for (const arg of stepExpr.args) {
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=", 2)) {
        const lhs = arg.args[0]!;
        const rhs = arg.args[1]!;

        const lhsCode = generateExpr(lhs, "", context);
        const rhsCode = generateExpr(rhs, "", context);

        assignments.push(`${lhsCode} = ${rhsCode}`);
      }
    }

    // Join multiple assignments with comma operator
    return assignments.join(", ");
  }
  // Handle single assignment expressions
  else if (
    exprIsFunctionCall(stepExpr) &&
    exprIsFunctionCallOf(stepExpr, "=", 2)
  ) {
    const lhs = stepExpr.args[0]!;
    const rhs = stepExpr.args[1]!;

    // For step expressions, we want inline assignment like "i = i + 1"
    const lhsCode = generateExpr(lhs, "", context);
    const rhsCode = generateExpr(rhs, "", context);

    return `${lhsCode} = ${rhsCode}`;
  }

  // For other expressions, just generate normally
  return generateExpr(stepExpr, "", context);
}

/**
 * Generate body statements for loop bodies.
 * This handles begin blocks by extracting their statements without the surrounding braces.
 */
function generateLoopBody(
  bodyExpr: Expr,
  indent: string,
  context: CodeGenContext
): void {
  // Handle begin blocks specially for loop bodies
  if (
    exprIsFunctionCall(bodyExpr) &&
    exprIsFunctionCallOf(bodyExpr, BuiltinKeywords.begin)
  ) {
    // Update pendingDeferredDrops for this begin block
    // IMPORTANT: Concatenate with previous drops so early returns drop ALL enclosing scope vars
    // BUT: Don't add currentDrops up front — add them incrementally after each statement
    // so that break/continue only drops variables that have actually been declared.
    const functionContext = context as FunctionGenerationContext;
    const previousPendingDeferredDrops = functionContext.pendingDeferredDrops;
    const currentDrops = bodyExpr.$?.deferredDropExpressions ?? [];

    // Build a map of drop target variable names to their drop expressions
    const dropsByTargetName = new Map<string, Expr>();
    for (const dropExpr of currentDrops) {
      const name = getDeferredDropTargetAtomName(dropExpr);
      if (name) dropsByTargetName.set(name, dropExpr);
    }

    // Start with only outer-scope drops; loop body drops are activated incrementally
    functionContext.pendingDeferredDrops = [
      ...(previousPendingDeferredDrops ?? []),
    ];
    // Propagate consumed variable drops into loop body for escape handling
    const previousConsumedVarDrops = functionContext.consumedVarPendingDrops;
    const currentConsumedDrops =
      bodyExpr.$?.consumedVariableDropExpressions ?? [];
    functionContext.consumedVarPendingDrops = [
      ...currentConsumedDrops,
      ...(previousConsumedVarDrops ?? []),
    ];
    const activatedDropNames = new Set<string>();

    // Generate each statement in the begin block directly
    for (const arg of bodyExpr.args) {
      const argCode = generateExpr(arg, indent, context);
      if (argCode) {
        context.emitter.emitLine(`${indent}${argCode};`);
      }

      // After each statement, activate drops for any newly-declared variables
      // by scanning the statement's result environment for matching drop targets
      if (arg.$?.env && dropsByTargetName.size > activatedDropNames.size) {
        for (const frame of arg.$.env.frames) {
          for (const variable of frame.variables) {
            if (
              dropsByTargetName.has(variable.name) &&
              !activatedDropNames.has(variable.name)
            ) {
              activatedDropNames.add(variable.name);
              functionContext.pendingDeferredDrops.unshift(
                dropsByTargetName.get(variable.name)!
              );
            }
          }
        }
      }
    }

    // Generate deferred drop expressions before end of loop body
    if (bodyExpr.$?.deferredDropExpressions) {
      for (const dropExpr of bodyExpr.$.deferredDropExpressions) {
        const dropCode = generateExpr(dropExpr, indent, context);
        if (dropCode) {
          context.emitter.emitLine(`${indent}${dropCode};`);
        }
      }
    }

    // Restore previous pending deferred drops
    functionContext.pendingDeferredDrops = previousPendingDeferredDrops;
    functionContext.consumedVarPendingDrops = previousConsumedVarDrops;
  } else {
    // For non-begin expressions, generate normally
    const bodyCode = generateExpr(bodyExpr, indent, context);
    if (bodyCode) {
      context.emitter.emitLine(`${indent}${bodyCode};`);
    }
  }
}

/**
 * Generate C code for while loop expression
 * Supports both while(condition, body) and while(condition, step, body) forms
 * The 3-argument form is transpiled to a C for loop, 2-argument form to a C while loop
 */
export function generateWhileLoop(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const args = expr.args;

  if (args.length === 2) {
    // 2-argument form: while(condition, body) -> C while loop
    // We need to re-evaluate the condition on each iteration, so we use while(true)
    // and check the condition inside with a break statement
    const conditionExpr = args[0]!;
    const bodyExpr = args[1]!;

    // Track that we're in a loop for proper break/continue handling in nested match expressions
    const savedLoopLabel = context.currentLoopLabel;
    const loopLabel = `loop_${Math.random().toString(36).substr(2, 9)}`;
    context.currentLoopLabel = loopLabel;

    const functionContext = context as FunctionGenerationContext;
    const savedBaselineCount = functionContext.loopBodyDropsBaselineCount;
    functionContext.loopBodyDropsBaselineCount =
      functionContext.pendingDeferredDrops?.length ?? 0;

    context.emitter.emitLine(`${indent}while (true) {`);
    const conditionCode = generateExpr(conditionExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}  if (!(${conditionCode})) {`);
    context.emitter.emitLine(`${indent}    break;`);
    context.emitter.emitLine(`${indent}  }`);
    generateLoopBody(bodyExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}}`);
    context.emitter.emitLine(`${indent}${loopLabel}:;`);

    functionContext.loopBodyDropsBaselineCount = savedBaselineCount;
    context.currentLoopLabel = savedLoopLabel;

    return "";
  } else if (args.length === 3) {
    // 3-argument form: while(condition, step, body) -> C for loop
    // We need to re-evaluate the condition on each iteration
    const conditionExpr = args[0]!;
    const stepExpr = args[1]!;
    const bodyExpr = args[2]!;

    // Track that we're in a loop for proper break/continue handling in nested match expressions
    const savedLoopLabel = context.currentLoopLabel;
    const savedContinueLabel = context.currentContinueLabel;
    const loopLabel = `loop_${Math.random().toString(36).substr(2, 9)}`;
    const continueLabel = `continue_${Math.random().toString(36).substr(2, 9)}`;
    context.currentLoopLabel = loopLabel;
    context.currentContinueLabel = continueLabel;

    const functionContext3 = context as FunctionGenerationContext;
    const savedBaselineCount3 = functionContext3.loopBodyDropsBaselineCount;
    functionContext3.loopBodyDropsBaselineCount =
      functionContext3.pendingDeferredDrops?.length ?? 0;

    context.emitter.emitLine(`${indent}while (true) {`);
    const conditionCode = generateExpr(conditionExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}  if (!(${conditionCode})) {`);
    context.emitter.emitLine(`${indent}    break;`);
    context.emitter.emitLine(`${indent}  }`);
    generateLoopBody(bodyExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}${continueLabel}:;`);
    const stepCode = generateStepExpression(stepExpr, context);
    context.emitter.emitLine(`${indent}  ${stepCode};`);
    context.emitter.emitLine(`${indent}}`);
    context.emitter.emitLine(`${indent}${loopLabel}:;`);

    functionContext3.loopBodyDropsBaselineCount = savedBaselineCount3;
    context.currentLoopLabel = savedLoopLabel;
    context.currentContinueLabel = savedContinueLabel;

    return "";
  } else {
    context.emitter.emitLine(
      `${indent}/* Error: while loop expects 2 or 3 arguments, got ${args.length} */`
    );
    return "";
  }
}
