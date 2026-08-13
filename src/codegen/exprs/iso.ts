import type { FnCallExpr } from "../../expr";
import type { TypeValue } from "../../type-value";
import type { IsoType } from "../../types/definitions";
import { isIsoType } from "../../types/guards";
import { isTypeValue } from "../../value";
import { type CodeGenContext, getTypeString } from "../utils";
import { generateExpr } from "./expr";
import { codegenFatal } from "../constants";

/**
 * __yo_iso_extract - extract inner value from Iso type
 */
export function generateYoIsoExtract(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const selfArg = expr.args[0];
  if (!selfArg) {
    return codegenFatal(`__yo_iso_extract requires exactly 1 argument`);
  }
  const selfCode = generateExpr(selfArg, indent, context);
  const selfType = selfArg.$?.type;

  if (!selfType || !isIsoType(selfType)) {
    return codegenFatal(`__yo_iso_extract requires an Iso type`);
  }

  const isoTypeCName = getTypeString(selfType, context);

  // Register the Iso type's child C name for the extract function
  if (context.isoTypes?.has(isoTypeCName)) {
    const isoInfo = context.isoTypes.get(isoTypeCName)!;
    if (!isoInfo.childTypeCName) {
      isoInfo.childTypeCName = getTypeString(selfType.childType, context);
    }
  }

  const extractCall = `__yo_iso_extract_${isoTypeCName}(${selfCode})`;

  // If this expression has a temp variable (for cleanup), emit declaration + assignment
  const tempVar = expr.$?.variableName;
  const returnType = expr.$?.type;
  if (tempVar && returnType) {
    context.emitter.emitLine(
      `${indent}${getTypeString(returnType, context)} ${tempVar} = ${extractCall};`
    );
    context.declaredCVarNames?.add(tempVar);
    return tempVar;
  }

  return extractCall;
}

export function generateYoIsoDispose(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const selfArg = expr.args[0];
  if (!selfArg) {
    return codegenFatal(`__yo_iso_dispose requires exactly 1 argument`);
  }
  const selfCode = generateExpr(selfArg, indent, context);
  const selfType = selfArg.$?.type;

  if (!selfType || !isIsoType(selfType)) {
    return codegenFatal(`__yo_iso_dispose requires an Iso type`);
  }

  const isoTypeCName = getTypeString(selfType, context);
  return `__yo_iso_dispose_${isoTypeCName}(${selfCode})`;
}

export function isIsoTypeCall(expr: FnCallExpr): boolean {
  const funcValue = expr.func.$?.value;
  return (
    isTypeValue(funcValue) &&
    isIsoType(funcValue.value) &&
    expr.args.length === 1
  );
}

/**
 *
 * Iso(T)(value) - Iso value constructor
 * Check if this is a call to an Iso type constructor (not just any expression returning Iso type)
 * The function being called must be a TypeValue containing an IsoType
 */
export function generateIsoTypeCall(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (!isIsoTypeCall(expr)) {
    return `/* Error: generateIsoTypeCall called on non-Iso type call */`;
  }

  const funcValue = expr.func.$?.value as TypeValue;
  const isoType = funcValue!.value as IsoType;
  const childType = isoType.childType;

  const valueArg = expr.args[0]!;
  const valueCode = generateExpr(valueArg, indent, context);

  // Register the Iso type
  const isoTypeCName = getTypeString(isoType, context);
  const childTypeCName = getTypeString(childType, context);

  if (!context.isoTypes) {
    context.isoTypes = new Map();
  }
  if (!context.isoTypes.has(isoTypeCName)) {
    context.isoTypes.set(isoTypeCName, { childTypeCName, isoType });
  }

  // Generate allocation and initialization
  // Iso_T* iso = __yo_malloc(sizeof(Iso_T));
  // iso->arc = 1;
  // iso->extracted = false;
  // iso->value = value;
  // return iso;
  return `__yo_create_iso_${isoTypeCName}(${valueCode})`;
}
