import {
  BuiltinKeywords,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
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

  // NOT fatal: this is the MISSING-ExprInfo class, which multi-pass emission
  // legitimately hits. A comptime `while(comptime(i < N), ...)` unrolls its body
  // once per iteration, and a discarded pass reaches this site with no type
  // information — tests/basic.test.yo "comptime while loop unrolling with runtime
  // body" does exactly that. Making it fatal failed that test on every target
  // (found by the wasm arms first, but it reproduces natively).
  //
  // The harmful case — a marker that survives into the program's entry point —
  // is caught separately: TS throws for an untranspilable expression
  // (generation.ts) and yo-self gates `__yo_user_main`
  // (codegen/functions/generation.yo). See
  // issues/self-hosted-compile-swallows-undefined-call.md.
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
