import {
  BuiltinKeywords,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FnCallExpr,
} from "../../expr";
import { CodeGenContext, getVariableTypeString } from "../utils";

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
    exprIsFunctionCallOf(lhs, BuiltinKeywords.compt, 1)
  ) {
    // compile-time variable
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
