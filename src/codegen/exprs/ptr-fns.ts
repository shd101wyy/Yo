import {
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import type { ArrayType, SliceType } from "../../types/definitions";
import { isArrayType, isPtrType, isSliceType } from "../../types/guards";
import {
  isBooleanValue,
  isComptimeStringValue,
  isFunctionValue,
  isNumberValue,
} from "../../value";
import {
  type CodeGenContext,
  getTypeString,
  sanitizeForCIdentifier,
} from "../utils";
import { generateExpr } from "./expr";

/**
 * The `&` (address-of) operator generation
 */
export function generateAddressOf(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const type = expr.$?.type;
  if (!type) {
    return `// Error: No type information for pointer/reference expression ${exprToString(expr)}\n`;
  }
  const arg = expr.args[0]!;

  // Special case: *(arr(0:3)) or *(arr(:)) should create slice values directly
  if (exprIsFunctionCall(arg)) {
    const funcType = arg.func.$?.type;
    if (funcType && isArrayType(funcType)) {
      const firstArg = arg.args[0];
      if (
        firstArg &&
        exprIsFunctionCall(firstArg) &&
        (exprIsFunctionCallOf(firstArg, "..") ||
          exprIsFunctionCallOf(firstArg, "..="))
      ) {
        const isInclusive = exprIsFunctionCallOf(firstArg, "..=");
        // *(arr(start..end)) or *(arr(start..=end)) -> create slice value directly
        const arrayCode = generateExpr(arg.func!, indent, context);
        const startCode = generateExpr(firstArg.args[0]!, indent, context);
        const endCode = generateExpr(firstArg.args[1]!, indent, context);

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString((funcType as ArrayType).childType, context))}`;
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            childType: getTypeString(
              (funcType as ArrayType).childType,
              context
            ),
          });
        }
        if (isInclusive) {
          return `(${sliceTypeName}){ .data = &${arrayCode}.data[${startCode}], .length = (${endCode}) - (${startCode}) + 1 }`;
        }
        return `(${sliceTypeName}){ .data = &${arrayCode}.data[${startCode}], .length = ${endCode} - ${startCode} }`;
      }
    } else if (
      funcType &&
      (isSliceType(funcType) ||
        (isPtrType(funcType) && isSliceType(funcType.childType)))
    ) {
      // Handle slice-from-slice: *(slice(start..end)) or *(slice(start..=end))
      const sliceBaseType = isSliceType(funcType)
        ? (funcType as SliceType)
        : (funcType.childType as SliceType);
      const firstArg = arg.args[0];
      if (
        firstArg &&
        exprIsFunctionCall(firstArg) &&
        (exprIsFunctionCallOf(firstArg, "..") ||
          exprIsFunctionCallOf(firstArg, "..="))
      ) {
        const isInclusive = exprIsFunctionCallOf(firstArg, "..=");
        // *(slice(start..end)) -> create sub-slice
        const sliceCode = generateExpr(arg.func!, indent, context);
        const startCode = generateExpr(firstArg.args[0]!, indent, context);
        const endCode = generateExpr(firstArg.args[1]!, indent, context);

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(sliceBaseType.childType, context))}`;
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            childType: getTypeString(sliceBaseType.childType, context),
          });
        }
        if (isInclusive) {
          return `(${sliceTypeName}){ .data = &${sliceCode}.data[${startCode}], .length = (${endCode}) - (${startCode}) + 1 }`;
        }
        return `(${sliceTypeName}){ .data = &${sliceCode}.data[${startCode}], .length = ${endCode} - ${startCode} }`;
      }
    }
  }

  // Check if the argument is a literal value that needs to be made addressable
  // In C, we can't take the address of a literal directly (&1 is invalid)
  // We need to use a compound literal: &(int32_t){1}
  const argValue = arg.$?.value;
  const argType = arg.$?.type;

  if (argValue !== undefined && argType) {
    // Check for compile-time values that need compound literals
    if (isNumberValue(argValue) || isBooleanValue(argValue)) {
      const argCode = generateExpr(arg, indent, context);
      const typeName = getTypeString(argType, context);
      return `(&(${typeName}){${argCode}})`;
    }
    // For comptime_string with conversion, the generateExpr already generates the struct
    if (isComptimeStringValue(argValue) && arg.$?.convertedRuntimeType) {
      const argCode = generateExpr(arg, indent, context);
      return `(&${argCode})`;
    }
  }

  // Special case: &(value(i)) where value(i) uses Index trait dispatch.
  // The Index.index() method already returns a pointer, so we just call it
  // without the auto-deref. This avoids generating &(*index_fn(&v, i)).
  if (
    expr.$?.isIndexTraitAddressOf &&
    exprIsFunctionCall(arg) &&
    arg.$?.indexMethodValue
  ) {
    const methodValue = arg.$.indexMethodValue;
    if (isFunctionValue(methodValue)) {
      const cFuncName = context.functions[methodValue.funcId]?.cName;
      if (cFuncName) {
        const calleeExpr = arg.func!;
        const calleeCode = generateExpr(calleeExpr, indent, context);
        const indexArg = arg.args[0];
        const indexCode = indexArg
          ? generateExpr(indexArg, indent, context)
          : "0";
        return `${cFuncName}(&${calleeCode}, ${indexCode})`;
      }
    }
  }

  const argCode = generateExpr(arg, indent, context);

  // For pointer/reference creation, we need to be careful about constness
  // Simply use the address-of operator without an explicit cast to avoid const issues
  return `(&${argCode})`;
}
