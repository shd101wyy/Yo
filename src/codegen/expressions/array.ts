import {
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  FuncCallExpr,
} from "../../expr";
import { ArrayType, isArrayType } from "../../types";
import { isNumberValue, isTypeValue } from "../../value";
import { CodeGenContext, getTypeString } from "../utils";
import { generateExpr } from "./generation";

/**
 * Check if a function call expression is an Array.fill method call
 */
export function isArrayFillMethodCall(expr: FuncCallExpr): boolean {
  // The structure should be: (receiver.method)(args...)
  // where expr.func is the (receiver.method) part

  // Check if func is a method call expression (receiver.method)
  if (
    !exprIsFunctionCall(expr.func) ||
    !exprIsFunctionCallOf(expr.func, ".", 2)
  ) {
    return false;
  }

  const methodCall = expr.func;
  const receiverExpr = methodCall.args[0];
  const methodExpr = methodCall.args[1];

  // Check if the method is "fill"
  if (!exprIsAtom(methodExpr) || methodExpr.token.value !== "fill") {
    return false;
  }

  // Check if receiver is an Array type constructor call or has ArrayType
  if (!receiverExpr) {
    return false;
  }

  // Check if the receiver's VALUE is a TypeValue with ArrayType
  const receiverValue = receiverExpr.$?.value;

  if (isTypeValue(receiverValue)) {
    const arrayType = receiverValue.value;
    if (isArrayType(arrayType)) {
      return true;
    }
  }

  // Fallback: Check receiver type - it should be ArrayType or a call that returns ArrayType
  const receiverType = receiverExpr.$?.type;
  if (isArrayType(receiverType)) {
    return true;
  }

  // Also check if it's an Array constructor call like Array(i32, n)
  if (exprIsFunctionCall(receiverExpr)) {
    const receiverCallType = receiverExpr.$?.type;
    return isArrayType(receiverCallType);
  }

  return false;
}

/**
 * Generate C code for Array.fill method call (macro-like expansion)
 */
export function generateArrayFillCall(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const emitter = context.emitter;
  const methodCall = expr.func as FuncCallExpr;
  const receiverExpr = methodCall.args[0]!;
  const fillValueArg = expr.args[0];

  if (!fillValueArg) {
    return "/* ERROR: Array.fill requires a fill value argument */";
  }

  // Get the ArrayType from the receiver's value (not type)
  const receiverValue = receiverExpr.$?.value;
  let arrayType: ArrayType;

  if (isTypeValue(receiverValue) && isArrayType(receiverValue.value)) {
    arrayType = receiverValue.value;
  } else {
    // Fallback: check if receiver type is ArrayType
    const receiverType = receiverExpr.$?.type;
    if (isArrayType(receiverType)) {
      arrayType = receiverType;
    } else {
      return "/* ERROR: Array.fill receiver is not an array type */";
    }
  }

  const length = arrayType.length;
  if (!isNumberValue(length)) {
    return "/* ERROR: Array.fill requires compile-time known array length */";
  }

  // Generate the array fill code (macro expansion)
  const arrayTypeName = getTypeString(arrayType, context);
  const fillValueCode = generateExpr(fillValueArg, indent, context);
  const tempVarName = expr.$?.variableName || `temp_array_${Date.now()}`;

  // Generate array declaration and fill loop
  emitter.emitLine(`${indent}${arrayTypeName} ${tempVarName};`);
  emitter.emitLine(`${indent}for (int i = 0; i < ${length.value}; i++) {`);
  emitter.emitLine(`${indent}  ${tempVarName}.data[i] = ${fillValueCode};`);
  emitter.emitLine(`${indent}}`);

  return tempVarName;
}
