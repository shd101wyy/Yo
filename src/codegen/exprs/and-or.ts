import type { FnCallExpr } from "../../expr";
import { isBooleanValue } from "../../value";
import type { CodeGenContext } from "../utils";
import { generateExpr } from "./expr";

/**
 * op_and - && operator with short-circuit evaluation
 * Handles compile-time short-circuiting when any operand is compile-time false
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
        // Compile-time false - short-circuit, entire expression is false
        return `false`;
      }
      // Compile-time true - skip this operand, continue to next
      continue;
    }
    // Runtime value - include in output
    runtimeArgs.push(arg);
  }

  if (runtimeArgs.length === 0) {
    // All were compile-time true
    return `true`;
  }
  if (runtimeArgs.length === 1) {
    return generateExpr(runtimeArgs[0]!, indent, context);
  }

  // Generate: (arg1 && arg2 && ... && argN)
  const argCodes = runtimeArgs.map((arg) => generateExpr(arg, indent, context));
  return `(${argCodes.join(" && ")})`;
}

/**
 * op_or - || operator with short-circuit evaluation
 * Handles compile-time short-circuiting when any operand is compile-time true
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
        // Compile-time true - short-circuit, entire expression is true
        return `true`;
      }
      // Compile-time false - skip this operand, continue to next
      continue;
    }
    // Runtime value - include in output
    runtimeArgs.push(arg);
  }

  if (runtimeArgs.length === 0) {
    // All were compile-time false
    return `false`;
  }
  if (runtimeArgs.length === 1) {
    return generateExpr(runtimeArgs[0]!, indent, context);
  }

  // Generate: (arg1 || arg2 || ... || argN)
  const argCodes = runtimeArgs.map((arg) => generateExpr(arg, indent, context));
  return `(${argCodes.join(" || ")})`;
}
