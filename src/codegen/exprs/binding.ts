import {
  BuiltinKeywords,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { isStructType } from "../../types/guards";
import { type CodeGenContext, getVariableTypeString } from "../utils";

/**
 * bindings `:`
 */
export function generateBinding(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const lhs = expr.args[0]!;
  if (
    exprIsFunctionCall(lhs) &&
    exprIsFunctionCallOf(lhs, BuiltinKeywords.comptime, 1)
  ) {
    // compile-time variable
    return "";
  }

  if (
    exprIsFunctionCall(lhs) &&
    exprIsFunctionCallOf(lhs, BuiltinKeywords.given, 1)
  ) {
    // Phase 4b: nominal struct given bindings are runtime values; emit a
    // C variable so the assignment can write into it. Module/non-struct
    // given bindings remain compile-time only and emit nothing.
    const innerLhs = lhs.args[0]!;
    if (innerLhs.$?.type && isStructType(innerLhs.$.type)) {
      const varName = innerLhs.token.value;
      const varTypeAndName = getVariableTypeString(
        innerLhs.$.type,
        varName,
        context
      );
      context.emitter.emitLine(`${indent}${varTypeAndName};`);
      return "";
    }
    return "";
  }

  if (!lhs.$?.type) {
    return `// Error: No type information for left-hand side ${exprToString(lhs)}\n`;
  }
  const varName = lhs.token.value;
  const varTypeAndName = getVariableTypeString(lhs.$.type, varName, context);

  context.emitter.emitLine(
    // NOTE: We cannot assign "const" here.
    `${indent}${varTypeAndName};`
  );
  return "";
}
