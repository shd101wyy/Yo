import { getVariablesFromEnv, type Variable } from "../../env";
import { extractFutureTraitFromType } from "../../evaluator/trait-checking";
import {
  type AtomExpr,
  BuiltinFunctions,
  BuiltinKeywords,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  type FnCallExpr,
} from "../../expr";
import type { Token } from "../../token";
import { isUnitType } from "../../types/guards";
import { isCodegenTempName } from "../../utils";
import type { FunctionGenerationContext } from "../functions/context";
import {
  type CodeGenContext,
  getDeferredDropTargetAtomName,
  getDeferredDropTargetVariable,
  getTypeString,
  getVariableNameForCodegen,
  isDeferredDropForClosureCapture,
  sanitizeForCIdentifier,
} from "../utils";
import { emitAsyncFutureCompletion } from "./async-completion";
import { generateAtom } from "./atom";
import {
  generateDeferredDropExpressions,
  generateDeferredDupExpressions,
} from "./drop-dup";
import { generateExpr } from "./expr";

/**
 * Helper: Handle deferred dup expressions for an atom and return the final code
 */
function handleAtomDeferredDup(
  expr: AtomExpr,
  atomCode: string,
  indent: string,
  context: FunctionGenerationContext
): string {
  if (
    expr.$?.deferredDupExpressions &&
    expr.$.deferredDupExpressions.length > 0
  ) {
    generateDeferredDupExpressions(expr, indent, context);
    const dupExpr = expr.$.deferredDupExpressions[0]!;
    if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
      return getVariableNameForCodegen(dupExpr.$.variableName, dupExpr.$.env);
    }
  }
  return atomCode;
}

/**
 * Helper: Handle deferred dup expressions for a function call and return the final code
 */
function handleFuncCallDeferredDup(
  expr: FnCallExpr,
  indent: string,
  context: FunctionGenerationContext
): string {
  if (
    expr.$?.deferredDupExpressions &&
    expr.$.deferredDupExpressions.length > 0
  ) {
    // Declare temp variable if needed
    if (expr.$?.variableName) {
      const savedVariableName = expr.$.variableName;
      expr.$.variableName = undefined;
      const rawCode = generateExpr(expr, indent, context);
      expr.$.variableName = savedVariableName;

      const exprType = getTypeString(expr.$.type!, context);
      const exprTempVar = sanitizeForCIdentifier(savedVariableName);
      if (exprTempVar !== rawCode) {
        context.emitter.emitLine(
          `${indent}${exprType} ${exprTempVar} = ${rawCode};`
        );
      }
    } else {
      const rawCode = generateExpr(expr, indent, context);
      context.emitter.emitLine(`${indent}${rawCode};`);
    }

    generateDeferredDupExpressions(expr, indent, context);

    const dupExpr = expr.$.deferredDupExpressions[0]!;
    if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
      return getVariableNameForCodegen(dupExpr.$.variableName, dupExpr.$.env);
    }
  }
  return generateExpr(expr, indent, context);
}

/**
 * Get the C codegen variable name from a deferred drop expression.
 * Used to match pending drops against SM-consumed arg C names.
 */
export function getDeferredDropTargetCName(dropExpr: Expr): string | undefined {
  // ___drop(varName) form
  if (
    exprIsFunctionCall(dropExpr) &&
    exprIsFunctionCallOf(dropExpr, BuiltinFunctions.___drop) &&
    dropExpr.args.length >= 1
  ) {
    const firstArg = dropExpr.args[0];
    if (firstArg && exprIsAtom(firstArg)) {
      return getVariableNameForCodegen(firstArg.token.value, firstArg.$?.env);
    }
  }
  // varName.drop() form (method call syntax)
  if (
    exprIsFunctionCall(dropExpr) &&
    dropExpr.args.length === 0 &&
    exprIsFunctionCall(dropExpr.func) &&
    exprIsFunctionCallOf(dropExpr.func, ".", 2) &&
    exprIsAtom(dropExpr.func.args[1]!) &&
    dropExpr.func.args[1]!.token.value === BuiltinFunctions.___drop[0] &&
    exprIsAtom(dropExpr.func.args[0]!)
  ) {
    const atom = dropExpr.func.args[0]!;
    return getVariableNameForCodegen(atom.token.value, atom.$?.env);
  }
  return undefined;
}

function tokensAreComparable(left: Token, right: Token): boolean {
  return (
    left.modulePath === right.modulePath &&
    left.inputString === right.inputString
  );
}

function tokenIsAtOrBefore(left: Token, right: Token): boolean {
  if (!tokensAreComparable(left, right)) return false;
  return left.position.character <= right.position.character;
}

function getLastComparableTokenInExpr(expr: Expr, reference: Token): Token {
  let last = expr.token;
  if (!tokensAreComparable(last, reference)) {
    last = reference;
  }

  const visit = (node: Expr): void => {
    if (
      tokensAreComparable(node.token, reference) &&
      node.token.position.character > last.position.character
    ) {
      last = node.token;
    }

    if (exprIsFunctionCall(node)) {
      visit(node.func);
      for (const arg of node.args) {
        visit(arg);
      }
    }
  };

  visit(expr);
  return last;
}

function variableWasConsumedBeforeCleanupPoint(
  consumedAtToken: Token,
  cleanupExpr: Expr
): boolean {
  if (!tokensAreComparable(consumedAtToken, cleanupExpr.token)) {
    return false;
  }

  const cleanupPoint = getLastComparableTokenInExpr(
    cleanupExpr,
    consumedAtToken
  );
  return tokenIsAtOrBefore(consumedAtToken, cleanupPoint);
}

/**
 * Resolve which in-scope variable a pending drop targets at a cleanup point.
 *
 * Matching by NAME alone let a same-named shadowing binding (e.g. a
 * match-arm payload borrow) stand in for an outer variable declared later
 * in the source — the emitted C drop resolved to the borrow and
 * double-freed its payload (the ExprInfo-table use-after-free). Matching
 * strictly by Variable.id over-corrects the other way: reassignment
 * re-versions a variable's id (`current_opt_6` → `current_opt_9`), so the
 * recorded target id may legitimately be absent from the cleanup-point
 * env, and skipping the drop leaks the owned value (caught by ASan in
 * LinkedList.contains).
 *
 * So: prefer the id match; when the id is absent, decide by DECLARATION
 * POSITION — a target declared AFTER the cleanup point is the
 * shadowing-bug case (skip); a target declared before it is the same
 * logical variable with a re-versioned id (emit against the latest
 * binding, the pre-identity behavior).
 */
function resolveDropTargetInScope(
  dropExpr: Expr,
  variables: Variable[],
  cleanupToken: Token
): Variable | undefined {
  const targetVar = getDeferredDropTargetVariable(dropExpr);
  if (!targetVar) {
    return variables[variables.length - 1];
  }
  const byId = variables.find((v) => v.id === targetVar.id);
  if (byId) return byId;

  const declToken = targetVar.initializedAtToken ?? targetVar.token;
  if (
    declToken &&
    tokensAreComparable(declToken, cleanupToken) &&
    declToken.position.character > cleanupToken.position.character
  ) {
    // Declared after this cleanup point: only a same-named shadowing
    // binding is in scope here — the drop must not fire.
    return undefined;
  }
  return variables[variables.length - 1];
}

function generateEarlyReturnOnlyDeferredDropExpressions(
  expr: Expr,
  indent: string,
  context: CodeGenContext
): void {
  const earlyDrops = expr.$?.earlyReturnOnlyDeferredDropExpressions;
  if (!earlyDrops || earlyDrops.length === 0) return;

  const functionContext = context as FunctionGenerationContext;
  for (const dropExpr of earlyDrops) {
    if (
      isDeferredDropForClosureCapture(
        dropExpr,
        functionContext.currentClosureCaptures
      )
    ) {
      continue;
    }

    const dropCode = generateExpr(dropExpr, indent, context);
    if (dropCode) {
      context.emitter.emitLine(`${indent}${dropCode};`);
    }
  }
}

/**
 * Helper: Generate pending deferred drops from enclosing begin blocks.
 * Only drops variables that have been declared before the early return.
 * Variables that would be declared after the return point are filtered out
 * by checking if they exist in the return expression's environment.
 *
 * This function should be called AFTER the expression's own deferredDropExpressions
 * have been emitted, to drop variables from enclosing scopes.
 */
export function generatePendingDeferredDrops(
  indent: string,
  context: FunctionGenerationContext,
  expr: Expr,
  isCompletion: boolean = false,
  skipAlreadyDroppedCheck: boolean = false,
  skipEnvCheck: boolean = false,
  additionalSkipVarNames?: Set<string>
): void {
  if (context.pendingDeferredDrops && context.pendingDeferredDrops.length > 0) {
    // Filter drops to only include variables that exist in the return expression's environment.
    // Variables declared after the return point won't be in expr.$.env yet.
    // Also exclude variables that were already dropped by the expression's own deferredDropExpressions,
    // UNLESS skipAlreadyDroppedCheck is true (used for direct ctl returns where the goto
    // skips the scope-exit drops that would normally run after the expression).
    //
    // When skipEnvCheck is true (e.g., for escape inside inlined handler bodies),
    // we skip the environment check entirely because the escape expression's env
    // is from the handler's scope, not the enclosing function's scope.
    const alreadyDroppedVars = new Set<string>();
    if (!skipAlreadyDroppedCheck && expr.$?.deferredDropExpressions) {
      for (const dropExpr of expr.$.deferredDropExpressions) {
        const varName = getDeferredDropTargetAtomName(dropExpr);
        if (varName) {
          alreadyDroppedVars.add(varName);
        }
      }
    }
    if (
      !skipAlreadyDroppedCheck &&
      expr.$?.earlyReturnOnlyDeferredDropExpressions
    ) {
      for (const dropExpr of expr.$.earlyReturnOnlyDeferredDropExpressions) {
        const varName = getDeferredDropTargetAtomName(dropExpr);
        if (varName) {
          alreadyDroppedVars.add(varName);
        }
      }
    }

    // SM-consumed arg C names: for escape handlers, some pending drop targets
    // have their ownership transferred to the SM. The handler param drops already
    // free them, so we must skip them here to avoid double-free.
    const consumedArgCNames = context.effectSmConsumedArgCNames;

    const dropsToEmit =
      expr.$?.env && !skipEnvCheck
        ? context.pendingDeferredDrops.filter((dropExpr) => {
            const varName = getDeferredDropTargetAtomName(dropExpr);
            if (!varName) return false;
            if (
              isDeferredDropForClosureCapture(
                dropExpr,
                context.currentClosureCaptures
              )
            ) {
              return false;
            }
            if (alreadyDroppedVars.has(varName)) return false;
            if (additionalSkipVarNames?.has(varName)) return false;
            const variables = getVariablesFromEnv(expr.$!.env, varName);
            if (variables.length === 0) return false;
            // Match the drop target by variable identity, not just name: a
            // same-named shadowing binding in scope at the cleanup point
            // (e.g. a match-arm payload borrow) must not stand in for the
            // outer variable this drop targets — the emitted drop would
            // resolve to the inner binding in C and double-free its payload
            // (the ExprInfo-table use-after-free).
            const latestVar = resolveDropTargetInScope(
              dropExpr,
              variables,
              expr.token
            );
            if (!latestVar) return false;
            // Skip drops only for variables consumed before this cleanup point.
            // A later consume in another branch must not suppress this return's drop.
            if (
              latestVar.consumedAtToken &&
              variableWasConsumedBeforeCleanupPoint(
                latestVar.consumedAtToken,
                expr
              )
            ) {
              return false;
            }
            // Skip drops for variables that are declared but not yet
            // initialized — they exist in the env (e.g., the LHS of the
            // currently-evaluating assignment was added by `evaluateBinding`
            // before the RHS ran), but their C declaration appears after the
            // RHS evaluation. Emitting a drop here would reference an
            // undeclared C identifier.
            if (!latestVar.initializedAtToken) return false;
            // A TEMP whose C declaration has not been emitted yet at this exit
            // point (declaredCVarNames grows in C-emission order) must not be
            // dropped — it would otherwise reference an undeclared C identifier
            // (a synthetic temp can carry an initializedAtToken while its
            // declaration lives in a later/other branch). Applies only to temps;
            // regular named locals are always declared. Mirrors yo-self's
            // declared_c_var_names gate (codegen/exprs/return.yo).
            {
              const dropCName = getDeferredDropTargetCName(dropExpr);
              if (
                dropCName &&
                isCodegenTempName(dropCName) &&
                !(context.declaredCVarNames?.has(dropCName) ?? true)
              ) {
                return false;
              }
            }
            return true;
          })
        : context.pendingDeferredDrops.filter((dropExpr) => {
            const varName = getDeferredDropTargetAtomName(dropExpr);
            if (!varName) return false;
            if (
              isDeferredDropForClosureCapture(
                dropExpr,
                context.currentClosureCaptures
              )
            ) {
              return false;
            }
            if (alreadyDroppedVars.has(varName)) return false;
            if (additionalSkipVarNames?.has(varName)) return false;
            if (consumedArgCNames && consumedArgCNames.size > 0) {
              const cName = getDeferredDropTargetCName(dropExpr);
              if (cName && consumedArgCNames.has(cName)) return false;
            }
            return true;
          });

    if (dropsToEmit.length > 0) {
      const message = isCompletion
        ? "Drop local variables before early completion"
        : "Drop local variables before early return";
      context.emitter.emitLine(`${indent}// ${message}`);
      for (const dropExpr of dropsToEmit) {
        const dropCode = generateExpr(dropExpr, indent, context);
        if (dropCode) {
          context.emitter.emitLine(`${indent}${dropCode};`);
        }
      }
    }
  }
}

/**
 * Generate drops for consumed variables on unwind propagation paths.
 * These are RC-typed variables whose drops were optimized away because
 * they're consumed by the return value. On escape, the return value is
 * discarded, so these variables must be freed.
 */
export function generateConsumedVarDropsForEscape(
  indent: string,
  context: FunctionGenerationContext,
  expr: Expr,
  skipEnvCheck: boolean = false,
  excludeVarNames?: ReadonlySet<string>
): void {
  if (
    !context.consumedVarPendingDrops ||
    context.consumedVarPendingDrops.length === 0
  ) {
    return;
  }

  // Variables already released earlier in this same escape sequence (the
  // caller's own deferred drops). Re-releasing one here is a double free.
  const pendingDrops =
    excludeVarNames && excludeVarNames.size > 0
      ? context.consumedVarPendingDrops.filter((dropExpr) => {
          const varName = getDeferredDropTargetAtomName(dropExpr);
          return !varName || !excludeVarNames.has(varName);
        })
      : context.consumedVarPendingDrops;

  const dropsToEmit =
    expr.$?.env && !skipEnvCheck
      ? pendingDrops.filter((dropExpr) => {
          const varName = getDeferredDropTargetAtomName(dropExpr);
          if (!varName) return false;
          const variables = getVariablesFromEnv(expr.$!.env, varName);
          if (variables.length === 0) return false;
          // Same shadowing guard as generatePendingDeferredDrops.
          const latestVar = resolveDropTargetInScope(
            dropExpr,
            variables,
            expr.token
          );
          if (!latestVar) return false;
          // Skip variables that exist in the env but are not yet initialized —
          // evaluateBinding adds the LHS to the env before the RHS runs, so the
          // variable appears in the env at the unwind site but its C declaration
          // hasn't been emitted yet. Dropping it here would reference an
          // undeclared C identifier (same guard as generatePendingDeferredDrops).
          if (!latestVar.initializedAtToken) return false;
          // Same declared_c_var_names gate as generatePendingDeferredDrops: skip
          // a TEMP whose C declaration has not been emitted yet at this unwind.
          {
            const dropCName = getDeferredDropTargetCName(dropExpr);
            if (
              dropCName &&
              isCodegenTempName(dropCName) &&
              !(context.declaredCVarNames?.has(dropCName) ?? true)
            ) {
              return false;
            }
          }
          return true;
        })
      : [...pendingDrops];

  if (dropsToEmit.length > 0) {
    context.emitter.emitLine(
      `${indent}// Drop consumed variables (unwind propagation)`
    );
    for (const dropExpr of dropsToEmit) {
      const dropCode = generateExpr(dropExpr, indent, context);
      if (dropCode) {
        context.emitter.emitLine(`${indent}${dropCode};`);
      }
    }
  }
}

/**
 * Generate a return statement for `return` expressions
 * Function with explicit return:
 *   bar :: (fn() -> i32) { return(42); }
 */
export function generateReturn(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const functionContext = context as FunctionGenerationContext;

  // Check if we're inside a ctl handler body (return = resume continuation)
  if (functionContext.continuationVariables) {
    const resumeInfo = functionContext.continuationVariables.get("resume");
    if (resumeInfo) {
      if ("directReturnVar" in resumeInfo) {
        // Direct ctl call (no state machine): assign the return value to the
        // captured temp variable so the call site can use it as an expression.
        // For unit-returning handlers, skip the assignment entirely.
        if (!resumeInfo.isUnitReturn) {
          const arg = expr.args[0];
          if (arg) {
            const argCode = generateExpr(arg, indent, context);
            if (argCode) {
              context.emitter.emitLine(
                `${indent}${resumeInfo.directReturnVar} = ${argCode};`
              );
            }
          }
        }
        // Emit pending deferred drops before the goto. For direct ctl returns,
        // we skip the alreadyDroppedVars exclusion because the goto will jump
        // past the scope-exit drops that would normally run — so those drops
        // MUST be emitted here from pendingDeferredDrops instead.
        // We do NOT emit deferredDropExpressions because those may include drops
        // for the caller's variables (e.g. ctl call arguments) that are borrowed
        // by the handler, not owned.
        generatePendingDeferredDrops(
          indent,
          functionContext,
          expr,
          false,
          true
        );
        // Goto exit label to skip any remaining handler code after `return`
        if (resumeInfo.directExitLabel) {
          context.emitter.emitLine(
            `${indent}goto ${resumeInfo.directExitLabel};`
          );
        }
        return "";
      }
    }
  }

  const arg = expr.args[0];
  if (arg) {
    if (!expr.$) {
      throw new Error(`Internal error: return expression missing metadata`);
    }
    // For non-unit types, we need a temporary variable to hold the return value
    // before deferred drop expressions run
    if (!expr.$.variableName && !isUnitType(expr.$.type)) {
      return `// Error: return expression missing temporary variable name`;
    }

    // Special handling for async functions: we need to get the raw value code
    // without temp variable indirection to properly declare the temp variable
    let argCode: string;
    let needsTempVarDeclaration = false;

    if (functionContext.inAsyncStateMachine && arg.$?.variableName) {
      // In async context: generate raw value code by temporarily clearing variableName
      const savedVariableName = arg.$.variableName;
      arg.$.variableName = undefined;
      argCode = generateExpr(arg, indent, context);
      arg.$.variableName = savedVariableName;
      needsTempVarDeclaration = true;
    } else {
      // Check if arg has both a variableName and deferredDupExpressions
      // This happens when we need to store the arg value in a temp var before duping it
      if (
        arg.$?.variableName &&
        arg.$?.deferredDupExpressions &&
        arg.$.deferredDupExpressions.length > 0
      ) {
        // Generate the arg value without the variableName to get the raw expression
        const savedVariableName = arg.$.variableName;
        arg.$.variableName = undefined;
        const rawArgCode = generateExpr(arg, indent, context);
        arg.$.variableName = savedVariableName;

        // Declare and assign the temp variable
        const argType = getTypeString(arg.$.type!, context);
        const argTempVar = getVariableNameForCodegen(
          savedVariableName,
          arg.$.env
        );

        // Skip the temp declaration when the arg is an ref parameter.
        // `T name = (*name);` would shadow the pointer parameter and
        // produce a C redefinition error. The deferred dup below can
        // reference the inout name directly. See
        // plans/MEMORY_SAFETY.md and
        // issues/inout-multi-stmt-body-shadow.md.
        let isInoutArgAtom = false;
        if (exprIsAtom(arg) && arg.$?.env) {
          const vars = getVariablesFromEnv(arg.$.env, savedVariableName);
          if (vars.length > 0 && vars[vars.length - 1]!.isRef) {
            isInoutArgAtom = true;
          }
        }

        if (!isInoutArgAtom && argTempVar !== rawArgCode) {
          context.emitter.emitLine(
            `${indent}${argType} ${argTempVar} = ${rawArgCode};`
          );
        }
        argCode = isInoutArgAtom ? rawArgCode : argTempVar;
      } else {
        argCode = generateExpr(arg, indent, context);
      }
    }

    // Handle deferred dup expressions for the return argument.
    // This is needed when returning a borrowed parameter - we must call dup
    // to increment the reference count since return values are owned.
    let handledDeferredDup = false;
    if (
      arg.$?.deferredDupExpressions &&
      arg.$.deferredDupExpressions.length > 0
    ) {
      generateDeferredDupExpressions(arg, indent, functionContext);
      const dupExpr = arg.$.deferredDupExpressions[0]!;
      if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
        argCode = getVariableNameForCodegen(
          dupExpr.$.variableName,
          dupExpr.$.env
        );
        handledDeferredDup = true;
      }
    }

    let returnType: string;
    try {
      returnType = getTypeString(expr.$.type!, context);
    } catch (e) {
      const funcName = context.currentFunctionName ?? "unknown";
      throw new Error(`In function ${funcName}: ${(e as Error).message}`);
    }

    // The evaluator provides a temp variable name for return expressions so we can
    // compute the value before running deferred drops.
    const returnTempVar = expr.$.variableName
      ? getVariableNameForCodegen(expr.$.variableName, expr.$.env)
      : undefined;

    // Skip re-declaring if we already generated a dup call with a temp variable
    // Also skip if the variable name is the same as the arg code (e.g., returning a local variable)
    if (
      !handledDeferredDup &&
      !isUnitType(expr.$.type) &&
      returnTempVar &&
      returnTempVar !== argCode // Prevent something like: int32_t counter = counter;
    ) {
      context.emitter.emitLine(
        `${indent}${returnType} ${returnTempVar} = ${argCode};`
      );
    }

    // Record which variables this return's own deferred drops release, so the
    // consumed-var escape drops below cannot release any of them a second time.
    // See the comment at the generateConsumedVarDropsForEscape call.
    // Both lists are collected — the same pair generatePendingDeferredDrops
    // treats as "already dropped" (see alreadyDroppedVars above).
    const droppedByThisReturn = new Set<string>();
    for (const dropExpr of expr.$.deferredDropExpressions ?? []) {
      const varName = getDeferredDropTargetAtomName(dropExpr);
      if (varName) droppedByThisReturn.add(varName);
    }
    for (const dropExpr of expr.$.earlyReturnOnlyDeferredDropExpressions ??
      []) {
      const varName = getDeferredDropTargetAtomName(dropExpr);
      if (varName) droppedByThisReturn.add(varName);
    }
    if (expr.$.deferredDropExpressions) {
      generateDeferredDropExpressions(expr, indent, context);
    }
    generateEarlyReturnOnlyDeferredDropExpressions(expr, indent, context);

    // Check if we're in an async state machine - if so, complete the Future instead of returning
    if (functionContext.inAsyncStateMachine) {
      // Async state machine return - complete the Future and clean up
      const futureType = functionContext.inAsyncStateMachine!.futureType;
      const futureTraitType = extractFutureTraitFromType(futureType)!;
      const childType = futureTraitType.isFuture.outputType;
      const isUnitResult = isUnitType(childType);

      generatePendingDeferredDrops(indent, functionContext, expr, true);

      context.emitter.emitLine(
        `${indent}// Final state - complete the result Future`
      );

      // Compute the result value if not unit
      let resultCode: string | undefined;
      if (!isUnitResult) {
        const resultValue =
          expr.$.variableName && needsTempVarDeclaration
            ? expr.$.variableName
            : expr.$.variableName || argCode;
        resultCode = resultValue;
      }

      emitAsyncFutureCompletion({
        emitter: context.emitter,
        indent,
        resultCode,
        debugLabel: context.currentFunctionName,
      });
      return ``;
    }

    // Normal (non-state-machine) return
    // When returning a directly consumed own parameter (ownership transfer),
    // skip the pending drop for that variable — we're returning it, not discarding it.
    // Detect by: variable has isOwningTheRcValue AND no dup was generated (direct transfer).
    let returnedOwnVarNames: Set<string> | undefined;
    if (
      arg &&
      exprIsAtom(arg) &&
      arg.$?.env &&
      !(
        arg.$?.deferredDupExpressions && arg.$.deferredDupExpressions.length > 0
      )
    ) {
      const returnedVarName = arg.token.value;
      const returnedVars = getVariablesFromEnv(arg.$.env, returnedVarName);
      const returnedVar = returnedVars[returnedVars.length - 1];
      if (returnedVar?.isOwningTheRcValue) {
        returnedOwnVarNames = new Set([returnedVarName]);
      }
    }
    generatePendingDeferredDrops(
      indent,
      functionContext,
      expr,
      false,
      false,
      false,
      returnedOwnVarNames
    );

    // When returning a dup'd borrowed variable, also drop the original.
    // The dup/drop optimizer marks the original as "consumed" (no scope-end drop)
    // and puts its drop expression in consumedVarPendingDrops (for escape paths).
    // On an early return-with-dup path, the original is still alive and must be
    // freed after we've created the dup'd copy for the caller.
    //
    // But a variable can appear BOTH in this return's own deferredDropExpressions
    // and in consumedVarPendingDrops — e.g. `return(out)` for an OWNED local
    // inside a branch: `out` is dup'd for the caller (rc 1->2), the return's own
    // deferred drop releases the local (2->1, correct), and then the consumed-var
    // escape drop released it AGAIN (1->0), so the function returned a FREED
    // pointer. Exclude anything already dropped just above — a second release of
    // the same variable in one return sequence can only ever be a double free.
    if (handledDeferredDup) {
      generateConsumedVarDropsForEscape(
        indent,
        functionContext,
        expr,
        false,
        droppedByThisReturn
      );
    }

    if (isUnitType(expr.$.type)) {
      return `return`;
    }

    const returnValue = handledDeferredDup
      ? argCode
      : (returnTempVar ?? argCode);
    return `return ${returnValue}`;
  } else {
    // Unit return (no argument)
    if (expr.$?.deferredDropExpressions) {
      generateDeferredDropExpressions(expr, indent, context);
    }
    generateEarlyReturnOnlyDeferredDropExpressions(expr, indent, context);

    // Check if we're in an async state machine - if so, complete the Future instead of returning
    if (functionContext.inAsyncStateMachine) {
      const futureType = functionContext.inAsyncStateMachine!.futureType;
      const futureTraitType = extractFutureTraitFromType(futureType)!;
      const childType = futureTraitType.isFuture.outputType;
      const isUnitResult = isUnitType(childType);

      generatePendingDeferredDrops(indent, functionContext, expr, true);

      context.emitter.emitLine(
        `${indent}// Final state - complete the result Future (early unit return)`
      );

      const resultCode = !isUnitResult
        ? `(${getTypeString(childType, context)}){0}`
        : undefined;

      emitAsyncFutureCompletion({
        emitter: context.emitter,
        indent,
        resultCode,
        debugLabel: context.currentFunctionName,
      });
      return ``;
    }

    generatePendingDeferredDrops(indent, functionContext, expr);

    return "return";
  }
}

/**
 * Generate a return statement for implicit function body return
 * Example: foo :: (fn() -> i32)(42)
 */
export function generateImplicitReturnStatement(
  expr: Expr,
  indent: string,
  context: CodeGenContext
): void {
  const functionContext = context as FunctionGenerationContext;

  switch (expr.tag) {
    case ExprTag.Atom: {
      const atomCode = generateAtom(expr, context);
      const finalCode = handleAtomDeferredDup(
        expr,
        atomCode,
        indent,
        functionContext
      );
      context.emitter.emitLine(`${indent}return ${finalCode};`);
      break;
    }

    case ExprTag.FnCall: {
      // Special case: explicit return call should not be wrapped in another return
      if (exprIsFunctionCallOf(expr, BuiltinKeywords.return)) {
        const funcCallCode = generateExpr(expr, indent, context);
        context.emitter.emitLine(`${indent}${funcCallCode};`);
      } else {
        const finalCode = handleFuncCallDeferredDup(
          expr,
          indent,
          functionContext
        );
        context.emitter.emitLine(`${indent}return ${finalCode};`);
      }
      break;
    }
  }
}
