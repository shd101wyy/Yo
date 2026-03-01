import type { Expr, FnCallExpr } from "../../expr";
import { isBooleanValue } from "../../value";
import type { CodeGenContext } from "../utils";
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
  // Runtime values without variableName are typically simple variable references
  return false;
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
  // Close all the if blocks
  for (let i = 0; i < depth; i++) {
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
  // Close all the if blocks
  for (let i = 0; i < depth; i++) {
    currentIndent = currentIndent.slice(2);
    context.emitter.emitLine(`${currentIndent}}`);
  }

  return scVar;
}
