import type { FnCallExpr } from "../../expr";
import type { CodeGenContext } from "../utils";
import { generateExpr } from "./expr";

/**
 * The `sizeof` function call,
 * generating a sizeof expression.
 */
export function generateSizeOf(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const arg = expr.args[0]!;
  const argCode = generateExpr(arg, indent, context);
  return `sizeof(${argCode})`; // Use sizeof operator on the argument
}
