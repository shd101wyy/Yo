import type { Expr } from "../../expr";
import type { CodeGenContext } from "../utils";

export type GenerateExprFn = (
  expr: Expr,
  indent: string,
  context: CodeGenContext
) => string;

let _generateExpr: GenerateExprFn | undefined = undefined;

export function setGenerateExprFn(fn: GenerateExprFn) {
  _generateExpr = fn;
}

export function generateExpr(
  expr: Expr,
  indent: string,
  context: CodeGenContext
): string {
  if (!_generateExpr) {
    throw new Error("Internal Error: generateExpr function is not set.");
  }
  return _generateExpr(expr, indent, context);
}
