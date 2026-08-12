import { getVariablesFromEnv } from "../../env";
import {
  BuiltinFunctions,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
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
} from "../utils";
import { generateExpr } from "./expr";
import { codegenFatal } from "../constants";

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
    return codegenFatal(
      `No type information for pointer/reference expression ${exprToString(expr)}`
    );
  }
  const arg = expr.args[0]!;

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
    // For comptime_str with conversion, the generateExpr already generates the struct
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
        if (BuiltinFunctions.__yo_array_index.includes(inlineOp)) {
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

  // If `&(arg)` is positioned in a return slot — i.e. the address-of
  // is the return value flowing out of a fn whose return type is `*(T)`
  // — and `arg` is itself a call to a function returning `ref(T)`
  // (which is `T*` at the C ABI), then `&(arg)` should forward the
  // pointer rather than take its stack address. The evaluator marks
  // such address-of expressions with `isReturnSlot` when it sees them
  // as the flowing return value.
  //
  // Without this, the body emits `T* temp = call(...); return &temp;`
  // — a use-after-free because `temp` dies when the function returns.
  // With the marker, we just forward `temp` (already `T*`).
  if (expr.$?.isReturnSlot && arg.$?.variableName && arg.$.env) {
    const argVars = getVariablesFromEnv(arg.$.env, arg.$.variableName);
    if (argVars.length > 0 && argVars[argVars.length - 1]!.isRef) {
      return argCode;
    }
  }

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
