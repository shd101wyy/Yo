import {
  exprIsFunctionCall,
  ExprTag,
  type Expr,
  type FnCallExpr,
} from "../../expr";
import { isBooleanValue } from "../../value";
import type { FunctionGenerationContext } from "../functions/context";
import { getDeferredDropTargetAtomName, type CodeGenContext } from "../utils";
import { generateExpr } from "./expr";

let _shortCircuitCounter = 0;

/**
 * Check whether generateExpr for this expression might emit side-effectful
 * statements (temp variable declarations, function calls, etc.).
 * If only atoms/literals/variable references, it's safe to evaluate eagerly.
 */
function exprMayHaveSideEffects(expr: Expr): boolean {
  // If the expression has a variableName assigned by the evaluator,
  // the codegen will emit a temp variable declaration — that's a side effect.
  if (expr.$?.variableName) {
    return true;
  }
  // Value-type expressions (atoms, literals) are safe
  if (expr.$?.value !== undefined) {
    return false;
  }
  // Recursively check sub-expressions in function calls.
  // This catches nested operators like (a && (b || side_effect_fn()))
  // where the inner || has side-effectful args that must not be eagerly evaluated.
  if (exprIsFunctionCall(expr)) {
    for (const arg of expr.args) {
      if (exprMayHaveSideEffects(arg)) {
        return true;
      }
    }
    if (expr.func && exprMayHaveSideEffects(expr.func)) {
      return true;
    }
  }
  // Runtime values without variableName are typically simple variable references
  return false;
}

/**
 * Recursively collect all variableNames that are CREATED by an expression tree
 * (new temp values from function call results). Atoms are skipped because they
 * merely reference existing variables, not newly created ones.
 *
 * Used to find temp variable names created by sub-expressions of a
 * short-circuit argument, so their drops can be emitted conditionally.
 */
function collectCreatedVarNamesFromExpr(expr: Expr, result: Set<string>): void {
  if (exprIsFunctionCall(expr)) {
    // Only collect variableNames from function calls — these are newly created temps
    if (expr.$?.variableName) {
      result.add(expr.$.variableName);
    }
    // Deferred `___dup` results are temps too — they are DECLARED next to the
    // expression they balance (inside this conditional branch), but they live
    // in the ExprInfo side-channel, not the syntactic tree. Without this, an
    // aliasing-Stage-0 borrow dup on a projection argument inside a
    // short-circuit RHS (`a && f(w.b)`) left its scope-end drop at the outer
    // block level: an undeclared identifier in C (the declaration is inside
    // the `if`), and an unconditional drop for a conditionally-run dup.
    if (expr.$?.deferredDupExpressions) {
      for (const dupExpr of expr.$.deferredDupExpressions) {
        if (dupExpr.$?.variableName) {
          result.add(dupExpr.$.variableName);
        }
      }
    }

    // For nested &&/||, only collect from the first (unconditional) arg.
    // Subsequent args are inside conditional branches and their drops are
    // handled by the inner &&/||'s own emitDropsForConditionalBranch.
    const func = expr.func;
    const isNestedShortCircuit =
      func.tag === ExprTag.Atom &&
      (func.token.value === "&&" || func.token.value === "||");

    if (isNestedShortCircuit) {
      if (expr.args.length > 0) {
        collectCreatedVarNamesFromExpr(expr.args[0]!, result);
      }
      // Skip args[1..] — they are inside conditional branches of the inner &&/||
    } else {
      for (const arg of expr.args) {
        collectCreatedVarNamesFromExpr(arg, result);
      }
    }
    if (expr.func && !isNestedShortCircuit) {
      collectCreatedVarNamesFromExpr(expr.func, result);
    }
  }
  // Do NOT collect from atoms — they reference existing variables, not new temps
}

/**
 * For a set of variable names defined inside a conditional branch of a
 * short-circuit expression, find matching drop expressions from the enclosing
 * scope's pending deferred drops and emit them. Then mark the variable names
 * so the enclosing begin block skips those drops.
 *
 * This prevents use-after-free when a short-circuit expression runs in a loop:
 * without this, drops for conditionally-created temps are emitted unconditionally
 * at the end of the begin block. On subsequent loop iterations where the short-circuit
 * IS taken, the drop would access a stale value from the previous iteration.
 */
function emitDropsForConditionalBranch(
  varNames: Set<string>,
  indent: string,
  context: CodeGenContext
): void {
  const functionContext = context as FunctionGenerationContext;
  const pendingDrops = functionContext.pendingDeferredDrops;
  if (!pendingDrops || varNames.size === 0) return;

  if (!functionContext.shortCircuitHandledDropVarNames) {
    functionContext.shortCircuitHandledDropVarNames = new Set<string>();
  }

  const handledDropExprs = new Set<Expr>();
  for (const dropExpr of pendingDrops) {
    const targetVarName = getDeferredDropTargetAtomName(dropExpr);
    if (targetVarName && varNames.has(targetVarName)) {
      const dropCode = generateExpr(dropExpr, indent, context);
      if (dropCode) {
        context.emitter.emitLine(`${indent}${dropCode};`);
      }
      functionContext.shortCircuitHandledDropVarNames.add(targetVarName);
      handledDropExprs.add(dropExpr);
    }
  }

  // Remove the conditionally-emitted drops from pendingDeferredDrops so that
  // early-return sites in nested scopes (loops, match arms) do not attempt to
  // drop variables that are already out of scope at that point.
  if (handledDropExprs.size > 0) {
    functionContext.pendingDeferredDrops = pendingDrops.filter(
      (d) => !handledDropExprs.has(d)
    );
  }
}

/**
 * op_and - && operator with short-circuit evaluation
 *
 * When sub-expressions have side effects (function calls that emit temp vars),
 * we generate an if-chain to ensure proper short-circuit semantics:
 *   bool __yo_sc_N = false;
 *   Type temp1 = arg1_code;
 *   if (temp1) {
 *     Type temp2 = arg2_code;
 *     __yo_sc_N = temp2;
 *   }
 */
export function generateOpAnd(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (expr.args.length === 0) {
    return `true`; // Empty && returns true
  }
  if (expr.args.length === 1) {
    return generateExpr(expr.args[0]!, indent, context);
  }

  // Filter out compile-time true values and short-circuit on compile-time false
  const runtimeArgs: typeof expr.args = [];
  for (const arg of expr.args) {
    const value = arg.$?.value;
    if (isBooleanValue(value)) {
      if (value.value === false) {
        return `false`;
      }
      continue;
    }
    runtimeArgs.push(arg);
  }

  if (runtimeArgs.length === 0) {
    return `true`;
  }
  if (runtimeArgs.length === 1) {
    return generateExpr(runtimeArgs[0]!, indent, context);
  }

  // Check if any arg beyond the first might have side effects
  const needsIfChain = runtimeArgs
    .slice(1)
    .some((arg) => exprMayHaveSideEffects(arg));

  if (!needsIfChain) {
    // All args are simple — safe to use C's && directly
    const argCodes = runtimeArgs.map((arg) =>
      generateExpr(arg, indent, context)
    );
    return `(${argCodes.join(" && ")})`;
  }

  // Emit if-chain for proper short-circuit evaluation
  const scVar = `__yo_sc_${_shortCircuitCounter++}`;
  context.emitter.emitLine(`${indent}bool ${scVar} = false;`);

  // Generate nested if-chain: evaluate each arg only if all previous were true
  let currentIndent = indent;
  const depth = runtimeArgs.length - 1;
  for (let i = 0; i < runtimeArgs.length; i++) {
    const argCode = generateExpr(runtimeArgs[i]!, currentIndent, context);
    if (i < runtimeArgs.length - 1) {
      // Not the last arg — wrap remaining in an if
      context.emitter.emitLine(`${currentIndent}if (${argCode}) {`);
      currentIndent += "  ";
    } else {
      // Last arg — assign to result variable
      context.emitter.emitLine(`${currentIndent}${scVar} = ${argCode};`);
    }
  }
  // Close all the if blocks, emitting drops for each conditional branch's temps
  for (let i = depth - 1; i >= 0; i--) {
    // Collect variable names from this conditional arg's expression tree
    const conditionalArg = runtimeArgs[i + 1]!;
    const varNames = new Set<string>();
    collectCreatedVarNamesFromExpr(conditionalArg, varNames);
    // Emit drops for temps created in this conditional branch
    emitDropsForConditionalBranch(varNames, currentIndent, context);
    currentIndent = currentIndent.slice(2);
    context.emitter.emitLine(`${currentIndent}}`);
  }

  return scVar;
}

/**
 * op_or - || operator with short-circuit evaluation
 *
 * When sub-expressions have side effects, we generate an if-chain:
 *   bool __yo_sc_N = true;
 *   Type temp1 = arg1_code;
 *   if (!(temp1)) {
 *     Type temp2 = arg2_code;
 *     __yo_sc_N = temp2;
 *   }
 */
export function generateOpOr(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (expr.args.length === 0) {
    return `false`; // Empty || returns false
  }
  if (expr.args.length === 1) {
    return generateExpr(expr.args[0]!, indent, context);
  }

  // Filter out compile-time false values and short-circuit on compile-time true
  const runtimeArgs: typeof expr.args = [];
  for (const arg of expr.args) {
    const value = arg.$?.value;
    if (isBooleanValue(value)) {
      if (value.value === true) {
        return `true`;
      }
      continue;
    }
    runtimeArgs.push(arg);
  }

  if (runtimeArgs.length === 0) {
    return `false`;
  }
  if (runtimeArgs.length === 1) {
    return generateExpr(runtimeArgs[0]!, indent, context);
  }

  // Check if any arg beyond the first might have side effects
  const needsIfChain = runtimeArgs
    .slice(1)
    .some((arg) => exprMayHaveSideEffects(arg));

  if (!needsIfChain) {
    // All args are simple — safe to use C's || directly
    const argCodes = runtimeArgs.map((arg) =>
      generateExpr(arg, indent, context)
    );
    return `(${argCodes.join(" || ")})`;
  }

  // Emit if-chain for proper short-circuit evaluation
  const scVar = `__yo_sc_${_shortCircuitCounter++}`;
  context.emitter.emitLine(`${indent}bool ${scVar} = true;`);

  // Generate nested if-chain: evaluate each arg only if all previous were false
  let currentIndent = indent;
  const depth = runtimeArgs.length - 1;
  for (let i = 0; i < runtimeArgs.length; i++) {
    const argCode = generateExpr(runtimeArgs[i]!, currentIndent, context);
    if (i < runtimeArgs.length - 1) {
      // Not the last arg — wrap remaining in an if(!)
      context.emitter.emitLine(`${currentIndent}if (!(${argCode})) {`);
      currentIndent += "  ";
    } else {
      // Last arg — assign to result variable
      context.emitter.emitLine(`${currentIndent}${scVar} = ${argCode};`);
    }
  }
  // Close all the if blocks, emitting drops for each conditional branch's temps
  for (let i = depth - 1; i >= 0; i--) {
    // Collect variable names from this conditional arg's expression tree
    const conditionalArg = runtimeArgs[i + 1]!;
    const varNames = new Set<string>();
    collectCreatedVarNamesFromExpr(conditionalArg, varNames);
    // Emit drops for temps created in this conditional branch
    emitDropsForConditionalBranch(varNames, currentIndent, context);
    currentIndent = currentIndent.slice(2);
    context.emitter.emitLine(`${currentIndent}}`);
  }

  return scVar;
}
