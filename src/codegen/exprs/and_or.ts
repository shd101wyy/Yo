import { FnCallExpr } from "../../expr";
import { CodeGenContext } from "../utils";
import { generateExpr } from "./expr";

/**
 * op_and - && operator with short-circuit evaluation
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
  // Generate: (arg1 && arg2 && ... && argN)
  const argCodes = expr.args.map((arg) => generateExpr(arg, indent, context));
  return `(${argCodes.join(" && ")})`;
}

/**
 * op_or - || operator with short-circuit evaluation
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
  // Generate: (arg1 || arg2 || ... || argN)
  const argCodes = expr.args.map((arg) => generateExpr(arg, indent, context));
  return `(${argCodes.join(" || ")})`;
}
