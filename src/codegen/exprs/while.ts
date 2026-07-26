import {
  BuiltinKeywords,
  type Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import { isCodegenTempName } from "../../utils";
import type { FunctionGenerationContext } from "../functions/context";
import { getDeferredDropTargetAtomName, type CodeGenContext } from "../utils";
import { generateExpr } from "./expr";
import { getDeferredDropTargetCName } from "./return";

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

    // Populate ALL body drops UP FRONT so that early exits (break/continue/
    // escape/return) can see and emit the drops for variables that are
    // already live at the exit point. The drop emitter (`emitLoopBodyDropsBeforeExit`
    // in atom.ts and `generatePendingDeferredDrops` in return.ts) uses
    // `initializedAtToken` position to filter out drops for variables not
    // yet declared in source order.
    functionContext.pendingDeferredDrops = [
      ...currentDrops,
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

    // Generate each statement in the begin block directly
    for (const arg of bodyExpr.args) {
      const argCode = generateExpr(arg, indent, context);
      if (argCode) {
        context.emitter.emitLine(`${indent}${argCode};`);
      }
    }

    // Generate deferred drop expressions before end of loop body.
    // Apply the SAME two skip-guards as begin.ts's scope-end drop pass —
    // this inlined loop-body variant used to apply neither
    // (issues/ts-while-loop-body-drops-missing-guards.md):
    //   1. a codegen TEMP whose C declaration was never emitted in this
    //      scope (e.g. it lives inside a short-circuit conditional block)
    //      must not be referenced — clang "use of undeclared identifier";
    //   2. a drop already emitted inside a short-circuit conditional branch
    //      (and-or.ts emitDropsForConditionalBranch) must not be re-emitted
    //      — double drop.
    if (bodyExpr.$?.deferredDropExpressions) {
      for (const dropExpr of bodyExpr.$.deferredDropExpressions) {
        {
          const dropCName = getDeferredDropTargetCName(dropExpr);
          if (
            dropCName &&
            isCodegenTempName(dropCName) &&
            !(context.declaredCVarNames?.has(dropCName) ?? true)
          ) {
            continue;
          }
        }
        if (functionContext.shortCircuitHandledDropVarNames) {
          const targetVarName = getDeferredDropTargetAtomName(dropExpr);
          if (
            targetVarName &&
            functionContext.shortCircuitHandledDropVarNames.has(targetVarName)
          ) {
            functionContext.shortCircuitHandledDropVarNames.delete(
              targetVarName
            );
            continue;
          }
        }
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
 *
 * When the evaluator has unrolled the loop (comptime condition with runtime body),
 * the unrolled bodies are emitted sequentially without a loop.
 */
export function generateWhileLoop(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  // Handle comptime-unrolled loops: emit bodies sequentially, no C loop
  if (expr.$?.comptimeUnrolledBodies) {
    for (const body of expr.$.comptimeUnrolledBodies) {
      generateLoopBody(body, indent, context);
    }
    return "";
  }

  const args = expr.args;

  if (args.length === 2) {
    // 2-argument form: while(condition, body) -> C while loop
    // We need to re-evaluate the condition on each iteration, so we use while(true)
    // and check the condition inside with a break statement
    const rawConditionExpr = args[0]!;
    // Strip comptime() wrapper if present — it was for evaluator semantics only
    const conditionExpr = exprIsFunctionCallOf(rawConditionExpr, "comptime", 1)
      ? (rawConditionExpr as FnCallExpr).args[0]!
      : rawConditionExpr;
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
    const rawConditionExpr3 = args[0]!;
    // Strip comptime() wrapper if present — it was for evaluator semantics only
    const conditionExpr = exprIsFunctionCallOf(rawConditionExpr3, "comptime", 1)
      ? (rawConditionExpr3 as FnCallExpr).args[0]!
      : rawConditionExpr3;
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
