import {
  BuiltinFunctions,
  exprIsAtom,
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
  getVariableNameForCodegen,
  isFunctionValueWithOnlyBuiltinYoInlineFunctionCall,
  sanitizeForCIdentifier,
} from "../utils";
import { generateExpr } from "./expr";

let ptrFnsIndexTempCounter = 0;

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
        return `(${sliceTypeName}){ .data = &${arrayCode}.data[${startCode}], .length = (${endCode}) - (${startCode}) }`;
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
        return `(${sliceTypeName}){ .data = &${sliceCode}.data[${startCode}], .length = (${endCode}) - (${startCode}) }`;
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
      const calleeExpr = arg.func!;
      let calleeCode = generateExpr(calleeExpr, indent, context);

      // If the callee is a function call returning a temporary (rvalue), we
      // can't take its address directly. Emit it into a temp variable first.
      // Property access (`.` calls) generates lvalue C code, so skip those.
      if (
        exprIsFunctionCall(calleeExpr) &&
        !exprIsAtom(calleeExpr) &&
        !exprIsFunctionCallOf(calleeExpr, ".") &&
        calleeExpr.$?.type
      ) {
        const isAlreadyVariable =
          calleeExpr.$?.variableName &&
          calleeCode ===
            getVariableNameForCodegen(
              calleeExpr.$.variableName,
              calleeExpr.$.env
            );
        if (!isAlreadyVariable) {
          const calleeType = getTypeString(calleeExpr.$.type, context);
          const tempName = `__yo_ptr_idx_tmp_${ptrFnsIndexTempCounter++}`;
          context.emitter.emitLine(
            `${indent}${calleeType} ${tempName} = ${calleeCode};`
          );
          calleeCode = tempName;
        }
      }

      const indexArg = arg.args[0];
      const indexCode = indexArg
        ? generateExpr(indexArg, indent, context)
        : "0";

      // Inline builtin body if possible
      const inlineOp =
        isFunctionValueWithOnlyBuiltinYoInlineFunctionCall(methodValue);
      if (inlineOp) {
        if (
          BuiltinFunctions.__yo_array_index.includes(inlineOp) ||
          BuiltinFunctions.__yo_slice_index.includes(inlineOp)
        ) {
          return `(&((&${calleeCode})->data[${indexCode}]))`;
        }
      }

      // Fallback to function call
      const cFuncName = context.functions[methodValue.funcId]?.cName;
      if (cFuncName) {
        return `${cFuncName}(&${calleeCode}, ${indexCode})`;
      }
    }
  }

  const argCode = generateExpr(arg, indent, context);

  // If `arg` is an rvalue function-call expression (not a property access,
  // not a bare atom), C does not allow taking its address. Spill it into a
  // named temp first. Without this, code like `recur(...).to_string()` --
  // where the implicit `&self` argument wraps the recur call -- generates
  // `(&fn_recur(...))` which clang rejects with
  //   "cannot take the address of an rvalue".
  // See issues/template-string-rvalue-rc-interpolation.md.
  if (
    exprIsFunctionCall(arg) &&
    !exprIsAtom(arg) &&
    !exprIsFunctionCallOf(arg, ".") &&
    arg.$?.type
  ) {
    const isAlreadyVariable =
      arg.$?.variableName &&
      argCode === getVariableNameForCodegen(arg.$.variableName, arg.$.env);
    if (!isAlreadyVariable) {
      const argTypeStr = getTypeString(arg.$.type, context);
      const tempName =
        arg.$?.variableName ?? `__yo_addrof_tmp_${ptrFnsIndexTempCounter++}`;
      context.emitter.emitLine(
        `${indent}${argTypeStr} ${tempName} = ${argCode};`
      );
      return `(&${tempName})`;
    }
  }

  // For pointer/reference creation, we need to be careful about constness
  // Simply use the address-of operator without an explicit cast to avoid const issues
  return `(&${argCode})`;
}
