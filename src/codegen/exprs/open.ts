import type { FnCallExpr } from "../../expr";
import { isStructType } from "../../types/guards";
import {
  type CodeGenContext,
  getTypeString,
  sanitizeForCIdentifier,
} from "../utils";
import { generateExpr } from "./expr";
import { codegenFatal } from "../constants";

/**
 * `open` for runtime struct
 */
export function generateOpen(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  // Check if this is a runtime struct destructuring
  if (
    expr.$?.runtimeDestructurings &&
    expr.$.runtimeDestructurings.length > 0
  ) {
    const argExpr = expr.args[0];
    if (!argExpr || !argExpr.$?.type) {
      return codegenFatal("open expression has no argument or type");
    }

    const argType = argExpr.$.type;
    const argValue = argExpr.$.value;

    // Only generate code for runtime struct values
    if (isStructType(argType) && argValue === undefined) {
      const structCode = generateExpr(argExpr, indent, context);
      const runtimeDestructurings = expr.$.runtimeDestructurings;

      // Generate local variable declarations for each field
      for (const destructuring of runtimeDestructurings) {
        const fieldType = getTypeString(destructuring.type, context);
        const varName = sanitizeForCIdentifier(destructuring.variableName);
        const fieldLabel = sanitizeForCIdentifier(destructuring.label);

        // Generate: type varName = structCode.fieldLabel;
        context.emitter.emitLine(
          `${indent}${fieldType} ${varName} = ${structCode}.${fieldLabel};`
        );
      }
    }
  }
  return "";
}
