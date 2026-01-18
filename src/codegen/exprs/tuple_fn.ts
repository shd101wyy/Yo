import { exprIsFunctionCall, FnCallExpr } from "../../expr";
import { FunctionGenerationContext } from "../functions/context";
import {
  CodeGenContext,
  getVariableNameForCodegen,
  getVariableTypeString,
} from "../utils";
import { generateDeferredDupExpressions } from "./drop_dup";
import { generateExpr } from "./expr";

/**
 * The `tuple` function call,
 * generating a tuple value.
 */
export function generateAnonymousTuple(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
  const cName = context.types[expr.$?.type?.id ?? ""]?.cName;
  const tempVar = expr.$?.variableName;

  if (runtimeArgExprs && cName) {
    const functionContext = context as FunctionGenerationContext;

    // Generate tuple initialization with dup handling for each argument
    // Use explicit field assignments with numeric indices
    const argsList = runtimeArgExprs
      .map((arg, index) => {
        const argCode = generateExpr(arg, indent, context);

        // Handle deferred dup expressions for tuple fields
        let finalArgValue = argCode;
        if (
          arg.$?.deferredDupExpressions &&
          arg.$.deferredDupExpressions.length > 0
        ) {
          generateDeferredDupExpressions(arg, indent, functionContext);
          // Use the dup result variable instead of the original
          const dupExpr = arg.$.deferredDupExpressions[0]!;
          if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
            finalArgValue = getVariableNameForCodegen(
              dupExpr.$.variableName,
              dupExpr.$.env
            );
          }
        }

        // Use explicit field assignment with numeric index
        return `._${index} = ${finalArgValue}`;
      })
      .join(", ");

    // If this tuple has a temporary variable name, declare it
    if (tempVar && expr.$?.type) {
      const tupleValue = `(${cName}){ ${argsList} }`;
      const varTypeAndName = getVariableTypeString(
        expr.$.type,
        tempVar,
        context
      );
      context.emitter.emitLine(`${indent}${varTypeAndName} = ${tupleValue};`);
      return tempVar;
    } else {
      return `(${cName}){ ${argsList} }`;
    }
  } else if (expr.args.length === 0) {
    // unit value - optimize away like Rust (no storage, no code)
    // If there's a temp variable, we don't declare it at all
    // Just return empty string for inline use
    return "";
  } else {
    // Fallback: use expr.args directly if runtimeArgExprsInOrder is not set
    const args = runtimeArgExprs ?? expr.args;
    if (!cName) {
      return `/* Error: tuple type not found - typeId: ${expr.$?.type?.id ?? "none"} */`;
    }

    const argsList = args
      .map((arg, index) => {
        const argCode = generateExpr(arg, indent, context);
        return `._${index} = ${argCode}`;
      })
      .join(", ");

    // If this tuple has a temporary variable name, declare it
    if (tempVar && expr.$?.type) {
      const tupleValue = `(${cName}){ ${argsList} }`;
      const varTypeAndName = getVariableTypeString(
        expr.$.type,
        tempVar,
        context
      );
      context.emitter.emitLine(`${indent}${varTypeAndName} = ${tupleValue};`);
      return tempVar;
    } else {
      return `(${cName}){ ${argsList} }`;
    }
  }
}
