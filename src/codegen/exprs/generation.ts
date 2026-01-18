import {
  BuiltinFunctions,
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  FnCallExpr,
} from "../../expr";
import {
  ArrayType,
  extractFnTraitFromType,
  isArrayType,
  isDynType,
  isEnumType,
  isFunctionType,
  isPtrType,
  isSliceType,
  isSomeType,
  isStructType,
  isTupleType,
  isUnionType,
  isUnitType,
  SliceType,
  SomeType,
  typeImplementsFn,
  typeImplementsFuture,
  TypeTag,
} from "../../types";
import {
  isBooleanValue,
  isComptStringValue,
  isFunctionValue,
  isNumberValue,
  isTypeValue,
  isUnknownValue,
  Value,
} from "../../value";
import { BuiltinYoInlineFunctions } from "../constants";
import { FunctionGenerationContext } from "../functions/context";
import {
  canOptimizeAsNullablePointer,
  canOptimizeAsSimpleEnum,
  CodeGenContext,
  getDeferredDupTargetAtomName,
  getEnumVariantCName,
  getTypeString,
  getVariableNameForCodegen,
  getVariableTypeString,
  isFunctionValueWithOnlyBuiltinYoInlineFunctionCall,
  sanitizeForCIdentifier,
} from "../utils";
import { generateOpAnd, generateOpOr } from "./and_or";
import { generateYoArrayFill } from "./array_fns";
import { generateAssignment } from "./assignment";
import { generateAsyncBlock } from "./async";
import { generateAtom } from "./atom";
import { generateAwait } from "./await";
import { generateBegin } from "./begin";
import { generateBinding } from "./binding";
import {
  checkVariableIsClosureCaptured,
  generateClosureConstruction,
  isClosureConstruction,
} from "./closures";
import { generateComptValue } from "./compt_value";
import { generateCondExpression } from "./cond";
import {
  generateDeferredDropExpressions,
  generateDeferredDupExpressions,
  generateDropCodeForValue,
} from "./drop_dup";
import { generateDynCall } from "./dyn";
import { generateExpr, setGenerateExprFn } from "./expr";
import { generateYoGcCollect } from "./gc";
import { generateInitializationAssignment } from "./initialization_assignment";
import { generateYoInlineFunctionCall } from "./inline";
import {
  generateIsoTypeCall,
  generateYoIsoDispose,
  generateYoIsoExtract,
  isIsoTypeCall,
} from "./iso";
import { generateMatchExpression } from "./match";
import { generatePanic } from "./panic";
import {
  generateThreadSpawnCall,
  generateWorkerSpawnCall,
  generateYoThreadSetMaximumThreads,
} from "./parallelism";
import { generateFieldAccess } from "./property_access";
import {
  generateDrop,
  generateDup,
  generateRcCall,
  generateYoDecrRc,
  generateYoDecrRcAtomic,
  generateYoDropArrayElement,
  generateYoDropTupleElement,
  generateYoDupArrayElement,
  generateYoDupTupleElement,
  generateYoDynDrop,
  generateYoDynDup,
  generateYoIncrRc,
  generateYoIncrRcAtomic,
  generateYoRcOwn,
  generateYoSomeTypeDrop,
  generateYoSomeTypeDup,
} from "./rc_fns";
import { generateReturn } from "./return";
import { generateWhileLoop } from "./while";

/**
 * Generate C code for an expression - extracted from original codegen-c.ts
 */
export function _generateExpr(
  expr: Expr,
  indent: string,
  context: CodeGenContext
): string {
  let result: string;

  switch (expr.tag) {
    case ExprTag.FnCall:
      result = generateFuncCall(expr, indent, context);
      break;
    case ExprTag.Atom:
      result = generateAtom(expr, context);
      break;
  }

  return result;
}

// Set the generateExpr function for use in other modules
setGenerateExprFn(_generateExpr);

/**
 * Generate C code for a function call expression - extracted from original codegen-c.ts
 */
function generateFuncCall(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  // Handle macro function calls (functions with isUnquote return type)
  // If expr.$.macroExpansion is set, this macro call has already been expanded
  // during evaluation. Generate code for the expanded form instead.
  if (expr.$?.macroExpansion) {
    return generateExpr(expr.$.macroExpansion, indent, context);
  }

  // Handle method calls to ___drop/___dup on SomeType with resolvedConcreteType.
  // These are wrapper functions that were not collected during function collection
  // because they just call builtins. We handle them here by dispatching to the
  // concrete type's methods or using the appropriate ref-counting operation.
  if (
    exprIsFunctionCall(expr.func) &&
    exprIsFunctionCallOf(expr.func, ".", 2) &&
    expr.func.args[1] &&
    exprIsAtom(expr.func.args[1])
  ) {
    const methodName = expr.func.args[1].token.value;
    const receiverExpr = expr.func.args[0];
    const receiverType = receiverExpr?.$?.type;

    if (
      receiverType &&
      isSomeType(receiverType) &&
      typeImplementsFuture(receiverType)
    ) {
      // SomeType implementing Future - ALWAYS use ref-counting operations directly.
      // Futures are heap-allocated state machines (pointers), not value types.
      // The resolvedConcreteType might be the capture struct (value type), but we can't
      // dispatch to its ___drop/___dup because those expect struct values, not pointers.
      // The state machine manages its own memory and uses ref-counting.
      if (methodName === BuiltinFunctions.___drop[0]) {
        const receiverCode = generateExpr(receiverExpr!, indent, context);
        return `if (${receiverCode} != NULL) { __yo_decr_rc((void*)${receiverCode}); }`;
      }

      if (methodName === BuiltinFunctions.___dup[0]) {
        const receiverCode = generateExpr(receiverExpr!, indent, context);
        return `__yo_incr_rc((void*)${receiverCode})`;
      }
    }
  }

  // Handle anonymous function/closure construction
  if (isClosureConstruction(expr)) {
    return generateClosureConstruction(expr, indent, context);
  }

  // __yo_decr_rc - handle reference count decrement
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_decr_rc)) {
    return generateYoDecrRc(expr, indent, context);
  }

  // __yo_incr_rc - handle reference count increment
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_incr_rc)) {
    return generateYoIncrRc(expr, indent, context);
  }

  // __yo_rc_own - return the value itself, used for transferring ownership
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_rc_own)) {
    return generateYoRcOwn(expr, indent, context);
  }

  // __yo_drop_array_element - drop array element at index without borrowing
  // This is used when dropping arrays to directly drop each element
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_drop_array_element)) {
    return generateYoDropArrayElement(expr, indent, context);
  }

  // __yo_dup_array_element - dup array element at index without borrowing
  // This is used when duping arrays to directly dup each element
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dup_array_element)) {
    return generateYoDupArrayElement(expr, indent, context);
  }

  // __yo_drop_tuple_element - drop tuple element at index without borrowing
  // This is used when dropping tuples to directly drop each element
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_drop_tuple_element)) {
    return generateYoDropTupleElement(expr, indent, context);
  }

  // __yo_dup_tuple_element - dup tuple element at index without borrowing
  // This is used when duping tuples to directly dup each element
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dup_tuple_element)) {
    return generateYoDupTupleElement(expr, indent, context);
  }

  // ___dup - generic dup hook used by evaluator for reference-counted values.
  // In many cases the evaluator rewrites `___dup(x)` into `x.___dup()`, but in
  // some contexts (e.g. deferred dup for dyn-closure captures) the builtin call
  // is intentionally deferred to codegen.
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.___dup)) {
    return generateDup(expr, indent, context);
  }

  // ___drop - generic drop hook used by evaluator for reference-counted values.
  // Similar to ___dup, some drops are deferred to codegen.
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.___drop)) {
    return generateDrop(expr, indent, context);
  }

  // __yo_dyn_drop - call dispose on dyn object via dispose function then __yo_decr_rc on dyn
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dyn_drop)) {
    return generateYoDynDrop(expr, indent, context);
  }

  // __yo_dyn_dup - call dup on wrapped object via vtable and __yo_incr_rc on dyn
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dyn_dup)) {
    return generateYoDynDup(expr, indent, context);
  }

  // __yo_incr_rc_atomic - atomic reference count increment for Iso types
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_incr_rc_atomic)) {
    return generateYoIncrRcAtomic(expr, indent, context);
  }

  // __yo_decr_rc_atomic - atomic reference count decrement for Iso types
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_decr_rc_atomic)) {
    return generateYoDecrRcAtomic(expr, indent, context);
  }

  // __yo_iso_extract - extract inner value from Iso type
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_iso_extract)) {
    return generateYoIsoExtract(expr, indent, context);
  }

  // __yo_iso_dispose - dispose inner value of Iso if not extracted
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_iso_dispose)) {
    return generateYoIsoDispose(expr, indent, context);
  }

  // Iso(T)(value) - Iso value constructor
  // Check if this is a call to an Iso type constructor (not just any expression returning Iso type)
  // The function being called must be a TypeValue containing an IsoType
  if (isIsoTypeCall(expr)) {
    return generateIsoTypeCall(expr, indent, context);
  }

  // __yo_sometype_drop - dispatch to resolvedConcreteType's ___drop if available
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_sometype_drop)) {
    return generateYoSomeTypeDrop(expr, indent, context);
  }

  // __yo_sometype_dup - dispatch to resolvedConcreteType's ___dup if available
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_sometype_dup)) {
    return generateYoSomeTypeDup(expr, indent, context);
  }

  // __yo_gc_collect - trigger garbage collection
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_gc_collect)) {
    return generateYoGcCollect(expr, indent, context);
  }

  // rc - get the reference count of a value
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.rc)) {
    return generateRcCall(expr, indent, context);
  }

  // panic - print error message and abort execution
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.panic)) {
    return generatePanic(expr, indent, context);
  }

  // test - test declaration, skipped during normal compilation
  // Tests are handled by the test runner which generates a main function for each test
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.test)) {
    // No-op: test declarations produce no C code
    return `/* test declaration skipped */`;
  }

  // __yo_thread_set_maximum_threads - set maxmium number of threads for coroutine schedular
  if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_thread_set_maximum_threads)
  ) {
    return generateYoThreadSetMaximumThreads(expr, indent, context);
  }

  // op_and - && operator with short-circuit evaluation
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.op_and)) {
    return generateOpAnd(expr, indent, context);
  }

  // op_or - || operator with short-circuit evaluation
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.op_or)) {
    return generateOpOr(expr, indent, context);
  }

  // async - async block that creates a Future
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.async)) {
    return generateAsyncBlock(expr, indent, context);
  }

  // dyn() - dynamic dispatch constructor
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.dyn)) {
    return generateDynCall(expr, indent, context);
  }

  // await - extract value from Future
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.await)) {
    return generateAwait(expr, indent, context);
  }

  // return
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.return)) {
    return generateReturn(expr, indent, context);
  }

  // __yo_array_fill builtin (handled similarly to Array.fill)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_array_fill, 2)) {
    return generateYoArrayFill(expr, indent, context);
  }

  // compile-time variable
  if (exprIsFunctionCallOf(expr, "::", 2)) {
    return "";
  }

  // bindings
  if (exprIsFunctionCallOf(expr, ":", 2)) {
    return generateBinding(expr, indent, context);
  }
  // Initialization assignment
  else if (exprIsFunctionCallOf(expr, ":=", 2)) {
    const result = generateInitializationAssignment(expr, indent, context);
    if (result) {
      return result;
    }
  }
  // Assignent with mutability or initialization
  else if (exprIsFunctionCallOf(expr, "=", 2)) {
    return generateAssignment(expr, indent, context);
  }
  // already computed and it's not unit value
  else if (
    expr.$?.value &&
    !isUnknownValue(expr.$?.value) &&
    !isUnitType(expr.$.type)
  ) {
    const value: Value = expr.$.value;
    return generateComptValue(value, context, expr);
  }
  // . field access
  else if (exprIsFunctionCallOf(expr, ".", 2)) {
    return generateFieldAccess(expr, indent, context);
  }
  // begin
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.begin)) {
    return generateBegin(expr, indent, context);
  }
  // cond
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.cond)) {
    return generateCondExpression(expr, indent, context);
  }
  // match
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.match)) {
    return generateMatchExpression(expr, indent, context);
  }
  // ptr value
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_address_of, 1)) {
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
  // (anonymous) tuple value
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.tuple)) {
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
  // (anonymous) array value
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.array)) {
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
  // recur
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.recur)) {
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
    if (runtimeArgExprs) {
      const functionContext = context as FunctionGenerationContext;

      // Generate recur call with arguments and dup handling
      const argsList = runtimeArgExprs
        .map((arg) => {
          const argCode = generateExpr(arg, indent, context);

          // Handle deferred dup expressions for recur arguments
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
      return `${context.currentFunctionName}(${argsList})`;
    } else {
      return `// Error: No arguments for recur call ${exprToString(expr)}\n`;
    }
  }
  // sizeof
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.sizeof, 1)) {
    const arg = expr.args[0]!;
    const argCode = generateExpr(arg, indent, context);
    return `sizeof(${argCode})`; // Use sizeof operator on the argument
  }
  // __yo_decr_rc
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_decr_rc)) {
    const arg = expr.args[0]!;
    const argCode = generateExpr(arg, indent, context);
    return `__yo_decr_rc(${argCode})`;
  }
  // Builtin Yo inline functions
  else if (exprIsFunctionCallOf(expr, BuiltinYoInlineFunctions)) {
    // NOTE: || expr.args is necessary to support function call like __yo_as(i, i32);
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder || expr.args;
    if (runtimeArgExprs) {
      const functionContext = context as FunctionGenerationContext;

      const args = runtimeArgExprs.map((arg) => {
        const argCode = generateExpr(arg, indent, context);

        // Handle deferred dup expressions for inline function arguments
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
      });

      return generateYoInlineFunctionCall(
        expr.func.token.value,
        args,
        expr,
        context
      );
    }
  }
  // while loop
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.while)) {
    return generateWhileLoop(expr, indent, context);
  }
  // anonymous function (fn(x) -> body)
  else if (
    exprIsFunctionCallOf(expr, "->", 2) &&
    exprIsFunctionCall(expr.args[0]) &&
    exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.fn)
  ) {
    // Anonymous functions should have been evaluated and have a function value
    const functionValue = expr.$?.value;
    if (isFunctionValue(functionValue)) {
      return generateComptValue(functionValue, context);
    } else {
      return `// Error: Anonymous function missing function value`;
    }
  }
  // consume
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.consume)) {
    const argExpr = expr.args[0]!;
    const argCode = generateExpr(argExpr, indent, context);
    const argType = argExpr.$?.type;

    // Generate drop code for the consumed value
    // consume() marks the value as moved in the evaluator, so we must drop it in codegen
    if (argType && argCode) {
      const dropCode = generateDropCodeForValue(argCode, argType, context);
      if (dropCode) {
        const emitter = context.emitter;
        emitter.emitLine(`${indent}${dropCode};`);
      }
    }

    return argCode;
  }
  // functions that should be skipped
  // compt_expect_error
  else if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.compt_expect_error) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.compt_assert) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_var_print_info) ||
    exprIsFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_var_is_owning_the_rc_value
    ) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_var_has_other_aliases)
  ) {
    // no-op in C, just return empty string
    return "";
  }
  // open for runtime struct
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.open)) {
    // Check if this is a runtime struct destructuring
    if (
      expr.$?.runtimeDestructurings &&
      expr.$.runtimeDestructurings.length > 0
    ) {
      const argExpr = expr.args[0];
      if (!argExpr || !argExpr.$?.type) {
        return "// Error: open expression has no argument or type";
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
          const varName = destructuring.variableName;
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
  // other function call
  else {
    const functionType = expr.func.$?.type;
    const functionValue = expr.func.$?.value;

    if (isFunctionType(functionType)) {
      const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;

      if (runtimeArgExprs) {
        // Check if this is a method call on a dyn object
        let isDynMethodCall = false;
        if (
          exprIsFunctionCall(expr.func) &&
          exprIsFunctionCallOf(expr.func, ".", 2)
        ) {
          const objectExpr = expr.func.args[0];
          const objectType = objectExpr?.$?.type;
          if (objectType && isDynType(objectType)) {
            isDynMethodCall = true;
          }
        }

        // Generate arg list with special handling for dyn method calls
        const args = runtimeArgExprs.map((arg, index) => {
          // First, check if this argument needs a temporary variable
          if (arg.$?.variableName && arg.$?.type) {
            const functionContext = context as FunctionGenerationContext;

            // Check if this variable is captured by a closure
            const isClosureCapturedVariable =
              functionContext.currentClosureCaptures &&
              functionContext.currentClosureCaptures.includes(
                arg.$.variableName
              ) &&
              exprIsAtom(arg) &&
              arg.$.env &&
              functionContext.currentClosureCaptureFrameLevel !== undefined &&
              checkVariableIsClosureCaptured(
                arg.token.value,
                arg.$.env,
                functionContext.currentClosureCaptureFrameLevel
              );

            // Generate the argument expression and declare it as a temp variable
            const argCode = generateExpr(arg, indent, context);

            // Check if this variable is captured by a state machine
            const isStateMachineCapturedVariable =
              functionContext.inStateMachine && argCode.startsWith("sm->");

            // Track whether we emitted a temp variable declaration
            let emittedTempVarDeclaration = false;

            if (
              argCode &&
              argCode !== arg.$.variableName &&
              !isClosureCapturedVariable &&
              !isStateMachineCapturedVariable
            ) {
              // Only emit declaration if:
              // 1. The expression doesn't already handle it
              // 2. It's not a closure-captured variable (those are accessed inline from closure_context->data)
              // 3. It's not a state machine variable (those are accessed via sm->var_xxx)
              // 4. It's not a redundant self-assignment (e.g., int32_t errno_ = errno_)
              const sanitizedVarName = getVariableNameForCodegen(
                arg.$.variableName,
                arg.$.env
              );
              if (argCode !== sanitizedVarName) {
                const varTypeAndName = getVariableTypeString(
                  arg.$.type,
                  arg.$.variableName,
                  context
                );
                context.emitter.emitLine(
                  `${indent}${varTypeAndName} = ${argCode};`
                );
                emittedTempVarDeclaration = true;
              }
            }

            // Handle deferred dup expressions for function arguments
            // After generating the argument temp variable, check if we need to dup it
            // Start with argCode (which may be aliased) instead of arg.$.variableName
            let finalArgVarName = emittedTempVarDeclaration
              ? arg.$.variableName
              : argCode;
            if (
              arg.$?.deferredDupExpressions &&
              arg.$.deferredDupExpressions.length > 0
            ) {
              // Only treat deferred dup as a replacement for the argument value
              // when it actually targets this argument. For example, closure
              // construction may carry deferred dups for captured variables; those
              // must be applied during capture initialization, not substituted as
              // the call argument.
              const argTargets = new Set<string>();
              if (arg.$?.variableName) {
                argTargets.add(
                  getVariableNameForCodegen(arg.$.variableName, arg.$.env)
                );
              }
              if (argCode) {
                argTargets.add(argCode);
              }
              if (exprIsAtom(arg)) {
                argTargets.add(
                  getVariableNameForCodegen(arg.token.value, arg.$.env)
                );
              }

              const matchingDupExpr = arg.$.deferredDupExpressions.find((e) => {
                const target = getDeferredDupTargetAtomName(e);
                if (!target) return false;
                return argTargets.has(
                  getVariableNameForCodegen(target, e.$?.env)
                );
              });

              if (matchingDupExpr) {
                generateDeferredDupExpressions(arg, indent, functionContext);
                if (
                  exprIsFunctionCall(matchingDupExpr) &&
                  matchingDupExpr.$?.variableName
                ) {
                  finalArgVarName = getVariableNameForCodegen(
                    matchingDupExpr.$.variableName,
                    matchingDupExpr.$.env
                  );
                }
              }
            }

            // For dyn method calls, transform the first argument (self) from dyn object to data pointer
            // EXCEPT for dyn object's own methods (which are in the dyn type's .trait)
            if (isDynMethodCall && index === 0) {
              // Check if this method exists in the dyn type's own trait
              if (
                exprIsFunctionCall(expr.func) &&
                exprIsFunctionCallOf(expr.func, ".", 2)
              ) {
                const objectExpr = expr.func.args[0];
                const dynType = objectExpr?.$?.type;
                const methodExpr = expr.func.args[1];

                if (exprIsAtom(methodExpr) && isDynType(dynType)) {
                  const methodName = methodExpr.token.value;
                  // Check if this method exists in the dyn type's trait
                  const dynMethod = dynType.trait.fields.find(
                    (field) => field.label === methodName
                  );

                  if (dynMethod) {
                    // This is a dyn object's own method, pass the dyn object directly
                    return sanitizeForCIdentifier(
                      finalArgVarName,
                      arg.$.type.isExtern === "c"
                    );
                  }
                }
              }

              // For all other methods (wrapped object methods), pass the wrapped object data
              // Dyn is a value type, but callers may pass a borrow (pointer) depending on the method signature.
              const argType = arg.$?.type;
              if (argType && isPtrType(argType)) {
                return `${sanitizeForCIdentifier(finalArgVarName, arg.$.type.isExtern === "c")}->data`;
              }
              return `(${sanitizeForCIdentifier(finalArgVarName, arg.$.type.isExtern === "c")}).data`;
            } else {
              // If this is a closure-captured variable, use the generated code (inline access)
              // If this is a state machine variable, use the generated code (sm->var_xxx access)
              // Otherwise use the sanitized variable name (potentially duped)
              return isClosureCapturedVariable || isStateMachineCapturedVariable
                ? argCode
                : sanitizeForCIdentifier(
                    finalArgVarName,
                    arg.$.type.isExtern === "c"
                  );
            }
          } else {
            // For dyn method calls, transform the first argument (self) from dyn object to data pointer
            // EXCEPT for dyn object's own methods (which are in the dyn type's .trait)
            if (isDynMethodCall && index === 0) {
              const dynObjectCode = generateExpr(arg, indent, context);

              // Check if this method exists in the dyn type's own trait
              if (
                exprIsFunctionCall(expr.func) &&
                exprIsFunctionCallOf(expr.func, ".", 2)
              ) {
                const objectExpr = expr.func.args[0];
                const dynType = objectExpr?.$?.type;
                const methodExpr = expr.func.args[1];

                if (exprIsAtom(methodExpr) && isDynType(dynType)) {
                  const methodName = methodExpr.token.value;
                  // Check if this method exists in the dyn type's trait
                  const dynMethod = dynType.trait.fields.find(
                    (field) => field.label === methodName
                  );

                  if (dynMethod) {
                    // This is a dyn object's own method, pass the dyn object directly
                    return dynObjectCode;
                  }
                }
              }

              // For all other methods (wrapped object methods), pass the wrapped object data
              const argType = arg.$?.type;
              if (argType && isPtrType(argType)) {
                return `(${dynObjectCode})->data`;
              }
              return `(${dynObjectCode}).data`;
            } else {
              return generateExpr(arg, indent, context);
            }
          }
        });
        const argsList = args.join(", ");

        // Check if this is an extern "yo" function - handle these first before regular function values
        if (functionType.isExtern === "yo" && functionType.externName) {
          const externFuncName = functionType.externName;

          if (BuiltinYoInlineFunctions.includes(externFuncName)) {
            return generateYoInlineFunctionCall(
              externFuncName,
              args,
              expr,
              context
            );
          } else if (externFuncName === "__yo_thread_spawn") {
            // Special handling for __yo_thread_spawn(cb : Impl(Fn() -> unit, Send))
            // We need to:
            // 1. Find the closure function from implClosureCallMap
            // 2. Heap-allocate the closure data (since thread needs it after function returns)
            // 3. Call __yo_thread_spawn(closure_fn, heap_closure_data)
            return generateThreadSpawnCall(expr, indent, context);
          } else if (externFuncName === "__yo_worker_spawn") {
            // Special handling for __yo_worker_spawn(cb : Impl(Fn() -> unit, Send))
            // Similar to __yo_thread_spawn but spawns on the worker pool
            return generateWorkerSpawnCall(expr, indent, context);
          } else if (isUnitType(functionType.return.type)) {
            // If the function returns unit, just call it without assignment
            context.emitter.emitLine(
              `${indent}${externFuncName}(${argsList});`
            );

            // Handle deferred drop expressions if they exist
            if (expr.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(expr, indent, context);
            }

            return ""; // No return value
          } else {
            return `${externFuncName}(${argsList})`;
          }
        }

        if (isFunctionValue(functionValue)) {
          // Check if it's function vaue whose body only contains Yo operator
          const operatorFunctionName =
            isFunctionValueWithOnlyBuiltinYoInlineFunctionCall(functionValue);
          if (operatorFunctionName) {
            return generateYoInlineFunctionCall(
              operatorFunctionName,
              args,
              expr,
              context
            );
          }

          // Get new function type, which might be specialized.
          const functionType =
            functionValue.specializedType ?? functionValue.type;
          // Normal function call
          const cFuncName = context.functions[functionValue.funcId]?.cName;
          if (cFuncName) {
            // Generate function call
            if (isUnitType(functionType.return.type)) {
              // If the function returns unit, just call it without assignment
              context.emitter.emitLine(`${indent}${cFuncName}(${argsList});`);

              // Handle deferred drop expressions if they exist
              if (expr.$?.deferredDropExpressions) {
                generateDeferredDropExpressions(expr, indent, context);
              }

              return ""; // No return value
            } else {
              // If it returns a value, assign to a temp variable
              const tempVar = expr.$?.variableName;
              if (tempVar) {
                // For Impl(Future(...)), use the actual function return type to get the correct state machine type
                const returnType =
                  functionValue.specializedType?.return.type ??
                  functionType.return.type;
                const exprType = expr.$?.type;

                // Check if both types implement Future
                const exprIsFuture = exprType && typeImplementsFuture(exprType);
                const returnIsFuture =
                  returnType && typeImplementsFuture(returnType);

                let cTypeString: string;
                if (exprIsFuture && returnIsFuture) {
                  // For Future types, we need to get the correct state machine struct name
                  // The function's body should have an async block with the correct struct name
                  // The body might be wrapped in a begin() block, so we need to unwrap it
                  let funcBody = functionValue.body;

                  // If body is begin(async(...)), unwrap to get the async block
                  if (funcBody && exprIsFunctionCallOf(funcBody, "begin")) {
                    const beginArgs = (funcBody as FnCallExpr).args;
                    if (beginArgs.length > 0) {
                      const lastArg = beginArgs[beginArgs.length - 1]!;
                      if (
                        exprIsFunctionCallOf(lastArg, BuiltinFunctions.async)
                      ) {
                        funcBody = lastArg;
                      }
                    }
                  }

                  if (
                    funcBody &&
                    exprIsFunctionCallOf(funcBody, BuiltinFunctions.async) &&
                    funcBody.$?.asyncStateMachineStructName
                  ) {
                    // Use the async block's registered struct name directly
                    const asyncStructName =
                      funcBody.$.asyncStateMachineStructName;
                    cTypeString = `${asyncStructName}*`;

                    // Store the mapping for variable binding later
                    if (!context.tempVarAsyncStructNames) {
                      context.tempVarAsyncStructNames = new Map();
                    }
                    context.tempVarAsyncStructNames.set(
                      tempVar,
                      asyncStructName
                    );
                  } else {
                    // Fallback to getTypeString on return type
                    cTypeString = getTypeString(returnType, context);
                  }
                } else {
                  // cTypeString = getTypeString(exprType ?? returnType, context);
                  // Use returnType (from function signature) instead of exprType (from expression metadata)
                  // because exprType might have unresolved type parameters from nested generic calls
                  cTypeString = getTypeString(returnType ?? exprType, context);
                }

                context.emitter.emitLine(
                  `${indent}${cTypeString} ${tempVar} = ${cFuncName}(${argsList});`
                );

                // Handle deferred drop expressions if they exist
                if (expr.$?.deferredDropExpressions) {
                  generateDeferredDropExpressions(expr, indent, context);
                }

                return tempVar; // Return the temp variable name
              } else {
                // Error: regular function call returns non-unit type but no temp variable assigned
                return `// Error: Regular function call returns ${getTypeString(functionValue.specializedType?.return.type ?? functionType.return.type, context)} but no temp variable assigned`;
              }
            }
          }
        } else {
          const externFunction = context.externFunctions[functionType.id];
          if (externFunction) {
            // Generate regular extern function call
            const cFuncName = externFunction.cName;

            // Handle deferred drop expressions if they exist
            if (expr.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(expr, indent, context);
            }

            return `${cFuncName}(${argsList})`;
          } else {
            // Function parameter call (e.g., callback(x))
            const funcCode = generateExpr(expr.func, indent, context);
            if (isUnitType(functionType.return.type)) {
              // If the function returns unit, just call it without assignment
              context.emitter.emitLine(`${indent}${funcCode}(${argsList});`);

              // Handle deferred drop expressions if they exist
              if (expr.$?.deferredDropExpressions) {
                generateDeferredDropExpressions(expr, indent, context);
              }

              return ""; // No return value
            } else {
              // If it returns a value, assign to a temp variable or return directly
              const tempVar = expr.$?.variableName;
              if (tempVar) {
                // For Impl(Future(...)), use the actual function return type to get the correct state machine type
                const returnType = functionType.return.type;
                const exprType = expr.$?.type;
                const typeToUse =
                  exprType &&
                  returnType &&
                  typeImplementsFuture(exprType) &&
                  typeImplementsFuture(returnType)
                    ? returnType // Use function's return type for correct state machine
                    : (exprType ?? returnType); // Otherwise use expr type or fallback to return type

                context.emitter.emitLine(
                  `${indent}${getTypeString(typeToUse, context)} ${tempVar} = ${funcCode}(${argsList});`
                );

                // Handle deferred drop expressions if they exist
                if (expr.$?.deferredDropExpressions) {
                  generateDeferredDropExpressions(expr, indent, context);
                }

                return tempVar; // Return the temp variable name
              } else {
                // Error: function parameter call returns non-unit type but no temp variable assigned
                return `// Error: Function parameter call returns ${getTypeString(functionType.return.type, context)} but no temp variable assigned`;
              }
            }
          }
        }
      }
    } else if (functionType && typeImplementsFn(functionType)) {
      const closureValueType = functionType;
      const fnModule = extractFnTraitFromType(closureValueType)!;
      // Check if this is a Dyn closure (uses vtable) or Impl closure (static dispatch)
      const isDynClosure = isDynType(closureValueType);
      {
        const callSig = fnModule.isFn.callType;
        // Handle closure calls with dynamic dispatch through vtable
        const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;

        if (runtimeArgExprs) {
          // First, handle arguments that need temporary variables
          const functionContext = context as FunctionGenerationContext;
          for (const arg of runtimeArgExprs) {
            if (arg.$?.variableName && arg.$?.type) {
              // Check if this variable is captured by a closure
              const isClosureCapturedVariable =
                functionContext.currentClosureCaptures &&
                functionContext.currentClosureCaptures.includes(
                  arg.$.variableName
                ) &&
                exprIsAtom(arg) &&
                arg.$.env &&
                functionContext.currentClosureCaptureFrameLevel !== undefined &&
                checkVariableIsClosureCaptured(
                  arg.token.value,
                  arg.$.env,
                  functionContext.currentClosureCaptureFrameLevel
                );

              // Generate the argument expression and declare it as a temp variable
              const argCode = generateExpr(arg, indent, context);

              // Check if this variable is captured by a state machine
              const isStateMachineCapturedVariable =
                functionContext.inStateMachine && argCode.startsWith("sm->");

              if (
                argCode &&
                argCode !== arg.$.variableName &&
                !isClosureCapturedVariable &&
                !isStateMachineCapturedVariable
              ) {
                // Only emit declaration if:
                // 1. The expression doesn't already handle it
                // 2. It's not a closure-captured variable (those are accessed inline from closure_context->data)
                // 3. It's not a state machine variable (those are accessed via sm->var_xxx)
                const varTypeAndName = getVariableTypeString(
                  arg.$.type,
                  arg.$.variableName,
                  context
                );
                context.emitter.emitLine(
                  `${indent}${varTypeAndName} = ${argCode};`
                );
              }
            }
          }

          // Generate closure value and function arguments
          const closureCode = generateExpr(expr.func, indent, context);
          const args = runtimeArgExprs.map((arg) => {
            if (arg.$?.variableName && arg.$?.type) {
              // Check if this is a closure-captured variable - if so, use the full access expression
              const isClosureCapturedVariable =
                functionContext.currentClosureCaptures &&
                functionContext.currentClosureCaptures.includes(
                  arg.$.variableName
                ) &&
                exprIsAtom(arg) &&
                arg.$.env &&
                functionContext.currentClosureCaptureFrameLevel !== undefined &&
                checkVariableIsClosureCaptured(
                  arg.token.value,
                  arg.$.env,
                  functionContext.currentClosureCaptureFrameLevel
                );

              if (isClosureCapturedVariable) {
                // Return the inline access expression
                return generateExpr(arg, indent, context);
              } else {
                // Check if this is a state machine variable
                const argCode = generateExpr(arg, indent, context);
                const isStateMachineCapturedVariable =
                  functionContext.inStateMachine && argCode.startsWith("sm->");

                // Handle deferred dup expressions for closure call arguments
                let finalArgVarName = arg.$.variableName;
                if (
                  arg.$?.deferredDupExpressions &&
                  arg.$.deferredDupExpressions.length > 0
                ) {
                  generateDeferredDupExpressions(arg, indent, functionContext);
                  // Use the dup result variable instead of the original
                  const dupExpr = arg.$.deferredDupExpressions[0]!;
                  if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                    finalArgVarName = getVariableNameForCodegen(
                      dupExpr.$.variableName,
                      dupExpr.$.env
                    );
                  }
                }

                return isStateMachineCapturedVariable
                  ? argCode
                  : finalArgVarName;
              }
            } else {
              return generateExpr(arg, indent, context);
            }
          });

          // Dispatch:
          // - Dyn(Fn(...)) uses vtable: closure.vtable->call(closure.data, args...)
          // - Impl(Fn(...)) uses static dispatch: closure_impl(&closure, args...)
          let closureCall: string;
          if (isDynClosure) {
            const allArgs = [`(${closureCode}).data`, ...args];
            closureCall = `(${closureCode}).vtable->call(${allArgs.join(", ")})`;
          } else {
            // For Impl closures, the value is the concrete capture struct.
            // Find the corresponding generated implementation function.
            let concreteTypeId: string | undefined;
            if (closureValueType.tag === TypeTag.SomeType) {
              const someType = closureValueType as SomeType;
              if (someType.resolvedConcreteType) {
                concreteTypeId = someType.resolvedConcreteType.id;
              }
            }

            const mapped = concreteTypeId
              ? context.implClosureCallMap.get(concreteTypeId)
              : undefined;

            if (!mapped) {
              // Fallback to old representation if mapping is missing.
              const allArgs = [`(${closureCode}).data`, ...args];
              closureCall = `(${closureCode}).call(${allArgs.join(", ")})`;
            } else {
              const allArgs = [`&(${closureCode})`, ...args];
              closureCall = `${mapped.functionCName}(${allArgs.join(", ")})`;
            }
          }

          // Get return type from the closure's function signature
          const returnType = callSig.return.type;

          if (isUnitType(returnType)) {
            // If the closure returns unit, just call it without assignment
            context.emitter.emitLine(`${indent}${closureCall};`);

            // Handle deferred drop expressions if they exist
            if (expr.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(expr, indent, context);
            }

            return ""; // No return value
          } else {
            // If it returns a value, assign to a temp variable or return directly
            const tempVar = expr.$?.variableName;
            if (tempVar) {
              context.emitter.emitLine(
                `${indent}${getTypeString(returnType, context)} ${tempVar} = ${closureCall};`
              );

              // Handle deferred drop expressions if they exist
              if (expr.$?.deferredDropExpressions) {
                generateDeferredDropExpressions(expr, indent, context);
              }

              return tempVar; // Return the temp variable name
            } else {
              // Error: closure returns non-unit type but no temp variable assigned
              return `// Error: Closure call returns ${getTypeString(returnType, context)} but no temp variable assigned`;
            }
          }
        } else {
          // Note: Closure construction is now handled in the isTypeValue(functionValue) branch below
          // by checking for expr.$?.closureFunctionValue
          return `// Error: No runtime args found for closure call`;
        }
      }
    } else if (isTypeValue(functionValue)) {
      // struct
      if (isStructType(functionValue.value)) {
        const structType = functionValue.value;
        const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
        const cName = context.types[structType.id]?.cName;
        const labels = structType.fields.map((field) => field.label);
        const tempVar = expr.$?.variableName;

        if (
          runtimeArgExprs &&
          cName &&
          labels.length === runtimeArgExprs.length
        ) {
          // Handle newtype as zero-cost abstraction
          if (structType.isNewtype && structType.fields.length === 1) {
            // For newtype, just use the underlying value directly (with cast for type safety)
            const argCode = generateExpr(runtimeArgExprs[0]!, indent, context);
            const newtypeValue = `((${cName})(${argCode}))`;

            // If this newtype has a temporary variable name, declare it
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${newtypeValue};`
              );
              return tempVar;
            } else {
              return newtypeValue;
            }
          }

          if (structType.isReferenceSemantics) {
            // For object, call the constructor function
            const functionContext = context as FunctionGenerationContext;

            const argsList = runtimeArgExprs
              .map((arg) => {
                const argCode = generateExpr(arg, indent, context);

                // Handle deferred dup expressions for constructor arguments
                if (
                  arg.$?.deferredDupExpressions &&
                  arg.$.deferredDupExpressions.length > 0
                ) {
                  // If the arg has a variable name but generateExpr didn't create a declaration,
                  // we need to create it now so the dup call can reference it
                  if (arg.$?.variableName && arg.$?.type) {
                    const argVarName = getVariableNameForCodegen(
                      arg.$.variableName,
                      arg.$.env
                    );
                    // Only emit the declaration if argCode is different from the variable name
                    // to avoid generating code like: prev_opt = prev_opt;
                    if (argCode !== argVarName) {
                      const argType = arg.$.type;
                      const argTypeStr = getTypeString(argType, context);
                      // Emit the variable declaration and assignment
                      context.emitter.emitLine(
                        `${indent}${argTypeStr} ${argVarName} = ${argCode};`
                      );
                    }
                  }

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

            const constructorName = `__yo_new_${cName}`;
            const structValue = `${constructorName}(${argsList})`;

            // If this struct has a temporary variable name, declare it
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${structValue};`
              );
              return tempVar;
            } else {
              return structValue;
            }
          } else {
            // For regular struct, generate struct initialization as before
            const functionContext = context as FunctionGenerationContext;

            const argsList = runtimeArgExprs
              .map((arg, index) => {
                const argCode = generateExpr(arg, indent, context);
                // For tuples, always use numeric field names _0, _1, _2...
                // For regular structs, use the actual field labels
                const fieldName = isTupleType(structType)
                  ? `_${index}`
                  : sanitizeForCIdentifier(
                      labels[index]!,
                      structType.isExtern === "c"
                    );

                // Handle deferred dup expressions for struct fields
                let finalArgValue = argCode;
                if (
                  arg.$?.deferredDupExpressions &&
                  arg.$.deferredDupExpressions.length > 0
                ) {
                  // If the arg has a variable name but generateExpr didn't create a declaration,
                  // we need to create it now so the dup call can reference it
                  if (arg.$?.variableName && arg.$?.type) {
                    const argVarName = getVariableNameForCodegen(
                      arg.$.variableName,
                      arg.$.env
                    );
                    const argType = arg.$.type;
                    const argTypeStr = getTypeString(argType, context);
                    // Only emit the variable declaration if argCode is different from argVarName
                    // to prevent self-assignment like: var = var;
                    if (argCode !== argVarName) {
                      context.emitter.emitLine(
                        `${indent}${argTypeStr} ${argVarName} = ${argCode};`
                      );
                    }
                  }

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

                return `.${fieldName} = ` + finalArgValue;
              })
              .join(", ");
            const structValue = `(${cName}){ ${argsList} }`;

            // If this struct has a temporary variable name, declare it
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${structValue};`
              );
              return tempVar;
            } else {
              return structValue;
            }
          }
        }
      }
      // closure type - closure construction
      // Note: This is now handled at the top of generateFuncCall by checking expr.$.closureFunctionValue
      else if (typeImplementsFn(functionValue.value)) {
        return `// Error: Closure construction should have been handled by closureFunctionValue check at top of generateFuncCall`;
      }
      // union
      // union is supposed to have only one member initialized
      else if (isUnionType(functionValue.value)) {
        const tempVar = expr.$?.variableName;
        const arg = expr.args[0]!;
        if (
          arg &&
          exprIsFunctionCall(arg) &&
          exprIsFunctionCallOf(arg, ":", 2)
        ) {
          const labelExpr = arg.args[0]!;
          const fieldExpr = arg.args[1]!;
          const cName = context.types[functionValue.value.id]?.cName;
          if (cName && exprIsAtom(labelExpr) && fieldExpr) {
            const functionContext = context as FunctionGenerationContext;
            const label = labelExpr.token.value;
            const sanitizedLabel = getVariableNameForCodegen(
              label,
              labelExpr.$?.env
            );
            const fieldCode = generateExpr(fieldExpr, indent, context);

            // Handle deferred dup expressions for union field
            let finalFieldValue = fieldCode;
            if (
              fieldExpr.$?.deferredDupExpressions &&
              fieldExpr.$.deferredDupExpressions.length > 0
            ) {
              generateDeferredDupExpressions(
                fieldExpr,
                indent,
                functionContext
              );
              // Use the dup result variable instead of the original
              const dupExpr = fieldExpr.$.deferredDupExpressions[0]!;
              if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                finalFieldValue = getVariableNameForCodegen(
                  dupExpr.$.variableName,
                  dupExpr.$.env
                );
              }
            }

            const unionValue = `(${cName}){ .${sanitizedLabel} = ${finalFieldValue} }`;

            // If this union has a temporary variable name, declare it
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${unionValue};`
              );
              return tempVar;
            } else {
              return unionValue;
            }
          }
        }
      }
      // enum
      else if (isEnumType(functionValue.value)) {
        const enumType = functionValue.value;
        const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
        const cName = context.types[enumType.id]?.cName;
        const tempVar = expr.$?.variableName;

        if (enumType.selectedVariantName && runtimeArgExprs && cName) {
          // Check if this enum can be optimized as a nullable pointer
          const nullablePointerType = canOptimizeAsNullablePointer(enumType);
          if (nullablePointerType) {
            const variantName = enumType.selectedVariantName;
            const variant = enumType.variants.find(
              (v) => v.name === variantName
            );

            if (variant) {
              if (!variant.fields || variant.fields.length === 0) {
                // This is the "None" case - return NULL
                const enumValue = "NULL";
                if (tempVar && expr.$?.type) {
                  const varTypeAndName = getVariableTypeString(
                    expr.$.type,
                    tempVar,
                    context
                  );
                  context.emitter.emitLine(
                    `${indent}${varTypeAndName} = ${enumValue};`
                  );
                  return tempVar;
                } else {
                  return enumValue;
                }
              } else if (variant.fields.length === 1) {
                // This is the "Some" case - return the pointer value directly
                const pointerValue = generateExpr(
                  runtimeArgExprs[0]!,
                  indent,
                  context
                );
                if (tempVar && expr.$?.type) {
                  const varTypeAndName = getVariableTypeString(
                    expr.$.type,
                    tempVar,
                    context
                  );
                  context.emitter.emitLine(
                    `${indent}${varTypeAndName} = ${pointerValue};`
                  );
                  return tempVar;
                } else {
                  return pointerValue;
                }
              }
            }
          }

          // Check if this enum can be optimized as a simple C enum
          const simpleEnumOptimizable = canOptimizeAsSimpleEnum(enumType);
          if (simpleEnumOptimizable) {
            const variantName = enumType.selectedVariantName;
            // For simple enums, just return the enum constant
            const enumValue = getEnumVariantCName(
              enumType,
              variantName,
              context
            );
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${enumValue};`
              );
              return tempVar;
            } else {
              return enumValue;
            }
          }

          // Generate enum initialization (fallback for non-optimized enums)
          const variantName = enumType.selectedVariantName;
          const variant = enumType.variants.find((v) => v.name === variantName);
          if (variant) {
            // Filter out unit type arguments - they don't need to be stored
            const nonUnitElements =
              variant.fields?.filter((field) => !isUnitType(field.type)) || [];

            const functionContext = context as FunctionGenerationContext;

            const argsList = runtimeArgExprs
              .map((arg, index) => {
                if (variant.fields) {
                  const field = variant.fields[index];
                  if (field && !isUnitType(field.type)) {
                    const argCode = generateExpr(arg, indent, context);
                    const sanitizedLabel = getVariableNameForCodegen(
                      field.label,
                      arg.$?.env
                    );

                    // Handle deferred dup expressions for enum variant fields
                    let finalArgValue = argCode;
                    if (
                      arg.$?.deferredDupExpressions &&
                      arg.$.deferredDupExpressions.length > 0
                    ) {
                      generateDeferredDupExpressions(
                        arg,
                        indent,
                        functionContext
                      );
                      // Use the dup result variable instead of the original
                      const dupExpr = arg.$.deferredDupExpressions[0]!;
                      if (
                        exprIsFunctionCall(dupExpr) &&
                        dupExpr.$?.variableName
                      ) {
                        finalArgValue = getVariableNameForCodegen(
                          dupExpr.$.variableName,
                          dupExpr.$.env
                        );
                      }
                    }

                    return `.${sanitizedLabel} = ` + finalArgValue;
                  }
                  return ""; // Skip if no field matches or if it's unit type
                } else {
                  return "";
                }
              })
              .filter((s) => s) // Remove empty strings
              .join(", ");

            // If there are no non-unit fields, we only need the tag
            const enumValue =
              nonUnitElements.length > 0
                ? `(${cName}){ .tag = ${getEnumVariantCName(enumType, variantName, context)}, .data = { .${variantName} = { ${argsList} } } }`
                : `(${cName}){ .tag = ${getEnumVariantCName(enumType, variantName, context)} }`;
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${enumValue};`
              );
              return tempVar;
            } else {
              return enumValue;
            }
          }
        }
      }
    } else if (isArrayType(functionType)) {
      const firstArg = expr.args[0];

      // Check if this is a slicing operation: arr(start:end) or arr(:)
      if (
        firstArg &&
        exprIsFunctionCall(firstArg) &&
        exprIsFunctionCallOf(firstArg, ":")
      ) {
        // arr(start:end) -> create slice value
        const arrayCode = generateExpr(expr.func!, indent, context);
        const startCode = generateExpr(firstArg.args[0]!, indent, context);
        const endCode = generateExpr(firstArg.args[1]!, indent, context);

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString((functionType as ArrayType).childType, context))}`;
        // Register the slice type
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            childType: getTypeString(
              (functionType as ArrayType).childType,
              context
            ),
          });
        }
        return `(${sliceTypeName}){ .data = &${arrayCode}.data[${startCode}], .length = (${endCode}) - (${startCode}) }`;
      } else if (
        firstArg &&
        exprIsAtom(firstArg) &&
        firstArg.token.value === ":"
      ) {
        // arr(:) -> create slice value for whole array
        const arrayCode = generateExpr(expr.func!, indent, context);
        const arrayType = functionType as ArrayType;
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

      // Array access by index: arr[index] or arr(index)
      const arrayCode = generateExpr(expr.func!, indent, context);
      const indexCode = generateExpr(firstArg!, indent, context);
      // Generate array access with struct wrapper
      return `${arrayCode}.data[${indexCode}]`; // Access the element at the index
    } else if (isSliceType(functionType)) {
      const firstArg = expr.args[0];

      // Check if this is a sub-slicing operation: slice(start:end) or slice(:)
      if (
        firstArg &&
        exprIsFunctionCall(firstArg) &&
        exprIsFunctionCallOf(firstArg, ":")
      ) {
        // slice(start:end) -> create sub-slice
        const sliceCode = generateExpr(expr.func!, indent, context);
        const startCode = generateExpr(firstArg.args[0]!, indent, context);
        const endCode = generateExpr(firstArg.args[1]!, indent, context);

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString((functionType as SliceType).childType, context))}`;
        // Register the slice type
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            childType: getTypeString(
              (functionType as SliceType).childType,
              context
            ),
          });
        }
        return `(${sliceTypeName}){ .data = &${sliceCode}.data[${startCode}], .length = (${endCode}) - (${startCode}) }`;
      } else if (
        firstArg &&
        exprIsAtom(firstArg) &&
        firstArg.token.value === ":"
      ) {
        // slice(:) -> create slice copy of whole slice
        const sliceCode = generateExpr(expr.func!, indent, context);

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString((functionType as SliceType).childType, context))}`;
        // Register the slice type
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            childType: getTypeString(
              (functionType as SliceType).childType,
              context
            ),
          });
        }
        return `(${sliceTypeName}){ .data = ${sliceCode}.data, .length = ${sliceCode}.length }`;
      }

      // Slice access by index: slice.data[index]
      const sliceCode = generateExpr(expr.func!, indent, context);
      const indexCode = generateExpr(firstArg!, indent, context);
      return `${sliceCode}.data[${indexCode}]`; // Access the element at the index in the slice
    } else if (
      functionType &&
      isPtrType(functionType) &&
      isSliceType(functionType.childType)
    ) {
      // This case should no longer exist since slices are no longer behind pointers
      // But keep it for backward compatibility during migration
      const sliceCode = generateExpr(expr.func!, indent, context);
      const indexCode = generateExpr(expr.args[0]!, indent, context);
      return `${sliceCode}.data[${indexCode}]`; // Access the element at the index in the slice
    }
  }

  if (exprIsFunctionCall(expr)) {
    throw new Error(`Unhandled function call: ${exprToString(expr)}`);
  }

  return `// Failed to transpile ${exprToString(expr)}`;
}

/**
 * Generate a return statement for a function body expression - extracted from original codegen-c.ts
 */
export function generateReturnStatement(
  expr: Expr,
  indent: string,
  context: CodeGenContext
): void {
  switch (expr.tag) {
    case ExprTag.Atom: {
      // Use generateExpressionAsCode to handle compile-time values
      let atomCode = generateAtom(expr, context);

      // Handle deferred dup expressions for atoms (borrowed parameters that need to be duped before returning)
      if (
        expr.$?.deferredDupExpressions &&
        expr.$.deferredDupExpressions.length > 0
      ) {
        generateDeferredDupExpressions(
          expr,
          indent,
          context as FunctionGenerationContext
        );
        // Use the duped value's variable name instead of the original
        const dupExpr = expr.$.deferredDupExpressions[0]!;
        if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
          atomCode = getVariableNameForCodegen(
            dupExpr.$.variableName,
            dupExpr.$.env
          );
        }
      }

      context.emitter.emitLine(`${indent}return ${atomCode};`);
      break;
    }
    case ExprTag.FnCall: {
      // Handle deferred dup expressions for function calls (e.g., field access that needs duping)
      if (
        expr.$?.deferredDupExpressions &&
        expr.$.deferredDupExpressions.length > 0
      ) {
        // Check if expr has a variableName for storing the intermediate value
        if (expr.$?.variableName) {
          // Generate the expression value without the variableName to get the raw expression
          const savedVariableName = expr.$.variableName;
          expr.$.variableName = undefined;
          const rawCode = generateFuncCall(expr, indent, context);
          expr.$.variableName = savedVariableName;

          // Declare and assign the temp variable
          const exprType = getTypeString(expr.$.type!, context);
          const exprTempVar = sanitizeForCIdentifier(savedVariableName);
          if (exprTempVar !== rawCode) {
            context.emitter.emitLine(
              `${indent}${exprType} ${exprTempVar} = ${rawCode};`
            );
          }
        } else {
          // No temp variable name, just generate the expression
          const rawCode = generateFuncCall(expr, indent, context);
          context.emitter.emitLine(`${indent}${rawCode};`);
        }

        // Generate the deferred dup expressions
        generateDeferredDupExpressions(
          expr,
          indent,
          context as FunctionGenerationContext
        );

        // Use the duped value's variable name for the return
        const dupExpr = expr.$.deferredDupExpressions[0]!;
        if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
          const dupedValue = getVariableNameForCodegen(
            dupExpr.$.variableName,
            dupExpr.$.env
          );
          context.emitter.emitLine(`${indent}return ${dupedValue};`);
        } else {
          // Fallback: return the raw code
          const funcCallCode = generateFuncCall(expr, indent, context);
          context.emitter.emitLine(`${indent}return ${funcCallCode};`);
        }
      } else {
        // No deferred dup expressions, generate normally
        const funcCallCode = generateFuncCall(expr, indent, context);
        if (!exprIsFunctionCallOf(expr, BuiltinKeywords.return)) {
          context.emitter.emitLine(`${indent}return ${funcCallCode};`);
        } else {
          context.emitter.emitLine(`${indent}${funcCallCode};`);
        }
      }
      break;
    }
  }
}
