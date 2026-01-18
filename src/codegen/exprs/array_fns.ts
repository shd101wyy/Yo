import { FnCallExpr } from "../../expr";
import { isArrayType } from "../../types";
import { randomId } from "../../utils";
import { isNumberValue, isTypeValue } from "../../value";
import { CodeGenContext, getTypeString } from "../utils";
import { generateExpr } from "./expr";

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
