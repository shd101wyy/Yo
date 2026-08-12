import {
  BuiltinKeywords,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { type CodeGenContext, getVariableTypeString } from "../utils";
import { codegenFatal } from "../constants";

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

  if (!lhs.$?.type) {
    return codegenFatal(
      `No type information for left-hand side ${exprToString(lhs)}`
    );
  }
  const varName = lhs.token.value;
  const varTypeAndName = getVariableTypeString(lhs.$.type, varName, context);

  context.emitter.emitLine(
    // NOTE: We cannot assign "const" here.
    `${indent}${varTypeAndName};`
  );
  return "";
}
