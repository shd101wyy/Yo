import {
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FnCallExpr,
} from "../../expr";
import {
  ArrayType,
  isArrayType,
  isPtrType,
  isSliceType,
  SliceType,
} from "../../types";
import { isBooleanValue, isComptStringValue, isNumberValue } from "../../value";
import {
  CodeGenContext,
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
        exprIsFunctionCallOf(firstArg, ":")
      ) {
        // *(arr(start:end)) -> create slice value directly
        const arrayCode = generateExpr(arg.func!, indent, context);
        const startCode = generateExpr(firstArg.args[0]!, indent, context);
        const endCode = generateExpr(firstArg.args[1]!, indent, context);

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString((funcType as ArrayType).childType, context))}`;
        // Register the slice type
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            childType: getTypeString(
              (funcType as ArrayType).childType,
              context
            ),
          });
        }
        return `(${sliceTypeName}){ .data = &${arrayCode}.data[${startCode}], .length = ${endCode} - ${startCode} }`;
      } else if (
        firstArg &&
        exprIsAtom(firstArg) &&
        firstArg.token.value === ":"
      ) {
        // *(arr(:)) -> create slice value for whole array
        const arrayCode = generateExpr(arg.func!, indent, context);
        const arrayType = funcType as ArrayType;
        const childType = arrayType.childType;

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(childType, context))}`;
        // Register the slice type
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            childType: getTypeString(childType, context),
          });
        }

        if (isNumberValue(arrayType.length)) {
          return `(${sliceTypeName}){ .data = &${arrayCode}.data[0], .length = ${arrayType.length.value} }`;
        } else {
          return `/* Error: Cannot slice array with non-compile-time length */`;
        }
      }
    } else if (
      funcType &&
      (isSliceType(funcType) ||
        (isPtrType(funcType) && isSliceType(funcType.childType)))
    ) {
      // Handle slice-from-slice: *(slice(start:end))
      const sliceBaseType = isSliceType(funcType)
        ? (funcType as SliceType)
        : (funcType.childType as SliceType);
      const firstArg = arg.args[0];
      if (
        firstArg &&
        exprIsFunctionCall(firstArg) &&
        exprIsFunctionCallOf(firstArg, ":")
      ) {
        // *(slice(start:end)) -> create sub-slice
        const sliceCode = generateExpr(arg.func!, indent, context);
        const startCode = generateExpr(firstArg.args[0]!, indent, context);
        const endCode = generateExpr(firstArg.args[1]!, indent, context);

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(sliceBaseType.childType, context))}`;
        // Register the slice type
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            childType: getTypeString(sliceBaseType.childType, context),
          });
        }
        return `(${sliceTypeName}){ .data = &${sliceCode}.data[${startCode}], .length = ${endCode} - ${startCode} }`;
      } else if (
        firstArg &&
        exprIsAtom(firstArg) &&
        firstArg.token.value === ":"
      ) {
        // *(slice(:)) -> create slice copy of whole slice
        const sliceCode = generateExpr(arg.func!, indent, context);

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(sliceBaseType.childType, context))}`;
        // Register the slice type
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            childType: getTypeString(sliceBaseType.childType, context),
          });
        }
        return `(${sliceTypeName}){ .data = ${sliceCode}.data, .length = ${sliceCode}.length }`;
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
    // For compt_string with conversion, the generateExpr already generates the struct
    if (isComptStringValue(argValue) && arg.$?.convertedRuntimeType) {
      const argCode = generateExpr(arg, indent, context);
      return `(&${argCode})`;
    }
  }

  const argCode = generateExpr(arg, indent, context);

  // For pointer/reference creation, we need to be careful about constness
  // Simply use the address-of operator without an explicit cast to avoid const issues
  return `(&${argCode})`;
}
