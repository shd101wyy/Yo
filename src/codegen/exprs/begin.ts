import { getVariablesFromEnv } from "../../env";
import {
  exprIsAtom,
  exprIsFunctionCall,
  type FnCallExpr,
  hasAnyControlFlow,
} from "../../expr";
import { isUnitType } from "../../types/guards";
import { isCodegenTempName, isTempVariableName } from "../../utils";
import { type FunctionGenerationContext } from "../functions/context";
import {
  type CodeGenContext,
  getDeferredDropTargetAtomName,
  getTypeString,
  getVariableNameForCodegen,
  isDeferredDropForClosureCapture,
} from "../utils";
import { generateDeferredDupExpressions } from "./drop-dup";
import { getDeferredDropTargetCName } from "./return";
import { generateExpr } from "./expr";

/**
 * The `begin` block generation
 */
export function generateBegin(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const tempVariableName = expr.$?.variableName;
  const valueType = expr.$?.type;
  const functionContext = context as FunctionGenerationContext;

  if (tempVariableName && valueType) {
    // Expression form: begin block that returns a value
    if (!isUnitType(valueType) && !hasAnyControlFlow(expr.$?.controlFlow)) {
      context.emitter.emitLine(
        `${indent}${getTypeString(valueType, context)} ${tempVariableName};`
      );
      // Record the C declaration so the drop-emission gate does not treat this
      // (now-declared) temp as undeclared and SKIP its drop — a skipped drop for
      // a live RC temp leaks. This declaration uses getTypeString (not
      // getVariableTypeString), so declaredCVarNames must be updated explicitly.
      context.declaredCVarNames?.add(tempVariableName);
    }

    // Evaluate each argument
    context.emitter.emitLine(`${indent}{ // begin block`);

    // Set pending deferred drops from this begin block
    // These need to be generated when early returning from inside this block
    // IMPORTANT: Concatenate with previous drops so early returns drop ALL enclosing scope vars
    const previousPendingDeferredDrops = functionContext.pendingDeferredDrops;
    const currentDrops = expr.$?.deferredDropExpressions ?? [];
    functionContext.pendingDeferredDrops = [
      ...currentDrops,
      ...(previousPendingDeferredDrops ?? []),
    ];
    // Also propagate consumed variable drops into inner scopes for escape handling
    const previousConsumedVarDrops = functionContext.consumedVarPendingDrops;
    const currentConsumedDrops = expr.$?.consumedVariableDropExpressions ?? [];
    functionContext.consumedVarPendingDrops = [
      ...currentConsumedDrops,
      ...(previousConsumedVarDrops ?? []),
    ];

    // Generate and emit code for each arg IMMEDIATELY to preserve order
    // This is important because generateExpr may have side effects that emit code
    const argsCode: string[] = [];
    const isReturningValue =
      !isUnitType(valueType) && !hasAnyControlFlow(expr.$?.controlFlow);

    for (let idx = 0; idx < expr.args.length; idx++) {
      const arg = expr.args[idx]!;

      // Stop generating dead code after an escape/return/break/continue expression.
      // The evaluator already breaks its own loop at the same point, so subsequent
      // args are unevaluated (expr.$ = undefined). Mirror that behavior here.
      if (!arg.$) break;

      const result = generateExpr(arg, indent + "  ", context);
      argsCode.push(result);

      // Emit immediately to preserve order (generateExpr might emit temp vars as side effects)
      // But skip emitting the last expression if it's being used as the return value
      const isLastExpr = idx === expr.args.length - 1;
      if (result && !(isLastExpr && isReturningValue)) {
        if (arg.$ && isTempVariableName(arg.$.env.modulePath, result)) {
          // Skip
        } else {
          context.emitter.emitLine(`${indent}  ${result};`);
        }
      }

      // Stop after any control-flow-exiting expression; everything after is dead code.
      if (hasAnyControlFlow(arg.$?.controlFlow)) {
        break;
      }
    }
    if (isReturningValue) {
      const lastArg = expr.args[expr.args.length - 1]!;
      let lastArgCode = argsCode[argsCode.length - 1]!;

      // Handle deferred dup expressions for the return value
      // This is needed when returning a borrowed value - we must call dup
      if (
        lastArg.$?.deferredDupExpressions &&
        lastArg.$.deferredDupExpressions.length > 0
      ) {
        // Similar to return statement handling: first declare/assign the value
        // before calling dup on it
        if (lastArg.$?.variableName) {
          const savedVariableName = lastArg.$.variableName;
          lastArg.$.variableName = undefined;
          const rawArgCode = generateExpr(lastArg, indent + "  ", context);
          lastArg.$.variableName = savedVariableName;

          const argType = getTypeString(lastArg.$.type!, context);
          const argTempVar = getVariableNameForCodegen(
            savedVariableName,
            lastArg.$.env
          );

          // Skip the temp-var declaration when lastArg is an inout
          // parameter — `T name = (*name);` shadows the pointer
          // parameter and causes a C redefinition error. The
          // deferred dup below picks up the inout name directly. See
          // plans/MEMORY_SAFETY.md and
          // issues/inout-multi-stmt-body-shadow.md.
          let isInoutAtom = false;
          if (exprIsAtom(lastArg) && lastArg.$?.env) {
            const vars = getVariablesFromEnv(lastArg.$.env, savedVariableName);
            if (vars.length > 0 && vars[vars.length - 1]!.isRef) {
              isInoutAtom = true;
            }
          }
          if (!isInoutAtom && argTempVar !== rawArgCode) {
            context.emitter.emitLine(
              `${indent}  ${argType} ${argTempVar} = ${rawArgCode};`
            );
          }
          lastArgCode = isInoutAtom ? rawArgCode : argTempVar;
        }

        generateDeferredDupExpressions(lastArg, indent + "  ", context);
        const dupExpr = lastArg.$.deferredDupExpressions[0]!;
        if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
          lastArgCode = getVariableNameForCodegen(
            dupExpr.$.variableName,
            dupExpr.$.env
          );
        }
      }

      context.emitter.emitLine(
        `${indent}  ${tempVariableName} = ${lastArgCode};`
      );
    }

    // Generate deferred drop expressions before closing the block
    if (expr.$?.deferredDropExpressions) {
      for (const dropExpr of expr.$.deferredDropExpressions) {
        if (
          isDeferredDropForClosureCapture(
            dropExpr,
            functionContext.currentClosureCaptures
          )
        ) {
          continue;
        }
        // Skip a TEMP whose C declaration has not been emitted yet at this
        // block's scope end (declaredCVarNames grows in C-emission order) — a
        // synthetic temp scheduled for drop but declared only in a later/other
        // branch would otherwise reference an undeclared C identifier. Applies
        // only to temps; regular named locals are always declared. Mirrors
        // yo-self begin.yo's declared_c_var_names gate.
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

        // Skip drops already emitted inside short-circuit conditional branches
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
        const dropCode = generateExpr(dropExpr, indent + "  ", context);
        if (dropCode) {
          context.emitter.emitLine(`${indent}  ${dropCode};`);
        }
      }
    }

    context.emitter.emitLine(`${indent}} // end begin block`);

    // Restore previous pending deferred drops
    functionContext.pendingDeferredDrops = previousPendingDeferredDrops;
    functionContext.consumedVarPendingDrops = previousConsumedVarDrops;

    return isUnitType(valueType) || hasAnyControlFlow(expr.$?.controlFlow)
      ? ""
      : tempVariableName;
  } else {
    // Statement form: begin block without returning a value
    context.emitter.emitLine(`${indent}{ // begin block`);

    // Set pending deferred drops for statement form as well
    // IMPORTANT: Concatenate with previous drops so early returns drop ALL enclosing scope vars
    const previousPendingDeferredDrops = functionContext.pendingDeferredDrops;
    const currentDrops = expr.$?.deferredDropExpressions ?? [];
    functionContext.pendingDeferredDrops = [
      ...currentDrops,
      ...(previousPendingDeferredDrops ?? []),
    ];
    const previousConsumedVarDrops2 = functionContext.consumedVarPendingDrops;
    const currentConsumedDrops2 = expr.$?.consumedVariableDropExpressions ?? [];
    functionContext.consumedVarPendingDrops = [
      ...currentConsumedDrops2,
      ...(previousConsumedVarDrops2 ?? []),
    ];

    const argsCode = expr.args.map((arg) =>
      generateExpr(arg, indent + "  ", context)
    );
    argsCode.forEach((argCode) => {
      if (argCode) {
        context.emitter.emitLine(`${indent}  ${argCode};`);
      }
    });

    // Generate deferred drop expressions before closing the block
    if (expr.$?.deferredDropExpressions) {
      for (const dropExpr of expr.$.deferredDropExpressions) {
        if (
          isDeferredDropForClosureCapture(
            dropExpr,
            functionContext.currentClosureCaptures
          )
        ) {
          continue;
        }
        // Skip a TEMP whose C declaration has not been emitted yet at this
        // block's scope end (declaredCVarNames grows in C-emission order) — a
        // synthetic temp scheduled for drop but declared only in a later/other
        // branch would otherwise reference an undeclared C identifier. Applies
        // only to temps; regular named locals are always declared. Mirrors
        // yo-self begin.yo's declared_c_var_names gate.
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

        // Skip drops already emitted inside short-circuit conditional branches
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
        const dropCode = generateExpr(dropExpr, indent + "  ", context);
        if (dropCode) {
          context.emitter.emitLine(`${indent}  ${dropCode};`);
        }
      }
    }

    context.emitter.emitLine(`${indent}} // end begin block`);

    // Restore previous pending deferred drops
    functionContext.pendingDeferredDrops = previousPendingDeferredDrops;
    functionContext.consumedVarPendingDrops = previousConsumedVarDrops2;

    return "";
  }
}
