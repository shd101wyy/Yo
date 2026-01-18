import { FnCallExpr } from "../../expr";
import { CodeGenContext } from "../utils";
import { generateDropCodeForValue } from "./drop_dup";
import { generateExpr } from "./expr";

/**
 * The `consume` function call,
 * generating a consume expression.
 */
export function generateConsume(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const argExpr = expr.args[0]!;
  const argCode = generateExpr(argExpr, indent, context);
  const argType = argExpr.$?.type;

  // Generate drop code for the consumed value
  // consume() marks the value as moved in the evaluator, so we must drop it in codegen
  if (argType && argCode) {
    const dropCode = generateDropCodeForValue(argCode, argType, context);
    if (dropCode) {
      const emitter = context.emitter;
      emitter.emitLine(`${indent}${dropCode};`);
    }
  }

  return argCode;
}
