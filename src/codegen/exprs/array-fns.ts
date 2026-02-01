import { exprIsFunctionCall, FnCallExpr } from "../../expr";
import { isArrayType } from "../../types/guards";
import { randomId } from "../../utils";
import { isNumberValue, isTypeValue } from "../../value";
import { FunctionGenerationContext } from "../functions/context";
import {
  CodeGenContext,
  getTypeString,
  getVariableNameForCodegen,
  getVariableTypeString,
} from "../utils";
import { generateDeferredDupExpressions } from "./drop-dup";
import { generateExpr } from "./expr";

/**
 * `array` function call, to generate an anonymous array value.
 * eg: array(1, 2, 3)
 */
export function generateAnonymousArray(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string | undefined {
  const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
  const arrayType = expr.$?.type;
  const tempVar = expr.$?.variableName;

  if (isArrayType(arrayType) && runtimeArgExprs) {
    const functionContext = context as FunctionGenerationContext;

    // Generate struct wrapper initialization with dup handling for each element
    const argsList = runtimeArgExprs
      .map((arg) => {
        const argCode = generateExpr(arg, indent, context);

        // Handle deferred dup expressions for array fields
        if (
          arg.$?.deferredDupExpressions &&
          arg.$.deferredDupExpressions.length > 0
        ) {
          generateDeferredDupExpressions(arg, indent, functionContext);
          // Use the dup result variable instead of the original
          const dupExpr = arg.$.deferredDupExpressions[0]!;
          if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
            return getVariableNameForCodegen(
              dupExpr.$.variableName,
              dupExpr.$.env
            );
          }
        }

        return argCode;
      })
      .join(", ");
    const arrayTypeName = getTypeString(arrayType, context);

    // If this array has a temporary variable name, declare it
    if (tempVar && expr.$?.type) {
      const arrayValue = `(${arrayTypeName}){ .data = { ${argsList} } }`;
      const varTypeAndName = getVariableTypeString(
        expr.$.type,
        tempVar,
        context
      );
      context.emitter.emitLine(`${indent}${varTypeAndName} = ${arrayValue};`);
      return tempVar;
    } else {
      return `(${arrayTypeName}){ .data = { ${argsList} } }`;
    }
  }
}

/**
 * __yo_array_fill builtin (handled similarly to Array.fill)
 */
export function generateYoArrayFill(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const emitter = context.emitter;
  const arrayTypeArg = expr.args[0]!;
  const fillValueArg = expr.args[1]!;

  // Get the ArrayType from the first argument's value
  const arrayTypeValue = arrayTypeArg.$?.value;
  if (
    !arrayTypeValue ||
    !isTypeValue(arrayTypeValue) ||
    !isArrayType(arrayTypeValue.value)
  ) {
    return "/* ERROR: __yo_array_fill first argument must be an ArrayType */";
  }

  const arrayType = arrayTypeValue.value;
  const length = arrayType.length;
  if (!isNumberValue(length)) {
    return "/* ERROR: __yo_array_fill requires compile-time known array length */";
  }

  // Generate the array fill code (macro expansion)
  const arrayTypeName = getTypeString(arrayType, context);
  const fillValueCode = generateExpr(fillValueArg, indent, context);
  const tempVarName = expr.$?.variableName || `temp_array_${Date.now()}`;
  const indexVarName = `i_${randomId(expr.$?.env.modulePath ?? "")}`;

  // Generate array declaration and fill loop
  emitter.emitLine(`${indent}${arrayTypeName} ${tempVarName};`);
  emitter.emitLine(
    `${indent}for (int ${indexVarName} = 0; ${indexVarName} < ${length.value}; ${indexVarName}++) {`
  );
  emitter.emitLine(
    `${indent}  ${tempVarName}.data[${indexVarName}] = ${fillValueCode};`
  );
  emitter.emitLine(`${indent}}`);

  return tempVarName;
}
