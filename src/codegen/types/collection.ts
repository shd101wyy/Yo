import {
  extractFnTraitFromType,
  extractFutureTraitFromType,
  typeImplementsFn,
  typeImplementsFuture,
} from "../../evaluator/trait-checking";
import {
  BuiltinKeywords,
  type Expr,
  exprIsFunctionCallOf,
  ExprTag,
} from "../../expr";
import type {
  ArrayType,
  DynType,
  FunctionType,
  IsoType,
  SliceType,
  Type,
} from "../../types/definitions";
import {
  isArrayType,
  isDynType,
  isEnumType,
  isFunctionType,
  isIsoType,
  isSourceNamespaceType,
  isPtrType,
  isSliceType,
  isSomeType,
  isStructType,
  isTraitType,
  isTupleType,
  isUnionType,
} from "../../types/guards";
import { typeContainsSomeType } from "../../types/utils";

/**
 * A struct whose only SomeType content lives inside function-typed fields
 * is still registerable as a concrete C type — the fn-ptr fields get
 * type-erased at the C ABI (forall functions become void*-cast call sites).
 * Io, Exception, and other effect-record structs match this shape.
 */
function structSomeTypeIsOnlyInFunctionFields(
  type: Type,
  visited: Set<string> = new Set()
): boolean {
  if (!isStructType(type)) return false;
  if (visited.has(type.id)) return true; // cyclic reference is fine
  visited.add(type.id);
  for (const field of type.fields) {
    // Function-typed fields are fine — they become fn-ptrs in C.
    if (isFunctionType(field.type)) continue;
    // Non-function field is OK if it itself is a struct whose SomeType
    // content is also confined to fn-ptr fields (recursive check).
    // This covers effect-bundle structs like `IoExn :: struct(io : Io,
    // exn : Exception)` where the nested Io/Exception structs hide
    // their forall behind function fields. Without this recursion,
    // such bundles can't be registered as C types and any code that
    // constructs / returns them fails codegen with
    // "No C type name found for struct …".
    if (
      isStructType(field.type) &&
      structSomeTypeIsOnlyInFunctionFields(field.type, visited)
    ) {
      continue;
    }
    if (typeContainsSomeType(field.type)) return false;
  }
  return true;
}

/** Check if an enum's SomeType content is only in function-typed variant fields. */
function enumSomeTypeIsOnlyInFunctionFields(
  type: Type,
  visited: Set<string> = new Set()
): boolean {
  if (!isEnumType(type)) return false;
  if (visited.has(type.id)) return true;
  visited.add(type.id);
  for (const variant of type.variants) {
    if (!variant.fields) continue;
    for (const field of variant.fields) {
      if (isFunctionType(field.type)) continue;
      if (
        isStructType(field.type) &&
        structSomeTypeIsOnlyInFunctionFields(field.type, visited)
      ) {
        continue;
      }
      if (typeContainsSomeType(field.type)) return false;
    }
  }
  return true;
}
import {
  isFunctionValue,
  isStructValue,
  isNumberValue,
  isTraitValue,
  isTypeValue,
  type StructValue,
} from "../../value";
import { PrimitiveTypeTags } from "../constants";
import {
  collectRequiredFunctions,
  findFunctionCallsInExpr,
} from "../functions/collection";
import {
  type CodeGenContext,
  getRuntimeStructFields,
  getTypeString,
  sanitizeForCIdentifier,
} from "../utils";

/**
 * Collect all user-defined types that need to be generated
 */
export function collectRequiredTypes(
  moduleValue: StructValue,
  context: CodeGenContext
): void {
  // Start with exports functions and collect types used in their signatures and bodies
  for (let i = 0; i < moduleValue.fields.length; i++) {
    const value = moduleValue.fields[i]!;

    if (isFunctionValue(value)) {
      // Collect types from function signatures
      collectTypesFromFunctionType(value.type, context);

      // Collect types from function body expressions
      collectTypesFromExpr(value.body, context);
    } else if (value.type && !isFunctionType(value.type)) {
      // Collect types from module-level non-function field declarations
      // (e.g., mutable globals like g_evaluate_expression_raw).
      collectType(value.type, context);
    }
  }

  // Collect types from module-level mutable variable init expressions
  // (these may reference types from imported modules not otherwise reachable)
  if (context.moduleLevelInitExprs) {
    for (const initExpr of context.moduleLevelInitExprs) {
      collectTypesFromExpr(initExpr, context);
    }
  }

  // Also collect types from non-exported functions we've already collected
  // Keep iterating until no new functions are discovered.
  // This is necessary because collectTypesFromExpr can discover new functions
  // (e.g., impl functions) which then need their types collected too.
  const processedFuncIds = new Set<string>();
  let foundNewFunctions = true;

  while (foundNewFunctions) {
    foundNewFunctions = false;

    for (const funcId in context.functions) {
      if (processedFuncIds.has(funcId)) {
        continue;
      }
      processedFuncIds.add(funcId);
      foundNewFunctions = true;

      const func = context.functions[funcId]!;
      collectTypesFromFunctionType(func.value.type, context);
      // For specialized generic functions, also collect types from the specialized type
      // This ensures concrete types (after type substitution) are registered
      if (func.value.specializedType) {
        collectTypesFromFunctionType(func.value.specializedType, context);
      }
      collectTypesFromExpr(func.value.body, context);

      // Collect types from compile-time function call caches
      // When a comptime function is called, the result is cached with concrete types
      // We need to collect those concrete types (e.g., [i32; 10] from cache, not [i32; n] from generic body)
      if (func.value.calledComptimeFunctionCaches) {
        for (const cache of func.value.calledComptimeFunctionCaches) {
          // Collect types from the cached return value
          if (cache.value && cache.value.type) {
            collectType(cache.value.type, context);
          }
          // Also collect from the evaluated body which has concrete types
          collectTypesFromExpr(cache.body, context);
        }
      }
    }
  }
}

/**
 * Collect types from a function type signature
 */
export function collectTypesFromFunctionType(
  functionType: FunctionType,
  context: CodeGenContext
): void {
  // Collect types from parameters
  for (const param of functionType.parameters) {
    collectType(param.type, context);
  }
  for (const param of functionType.forallParameters) {
    collectType(param.type, context);
  }

  // Collect type from return type
  collectType(functionType.return.type, context);
}

/**
 * Collect types from an expression
 */
export function collectTypesFromExpr(
  expr: Expr,
  context: CodeGenContext
): void {
  // If the expression has type information, collect it
  if (expr.$ && expr.$.type) {
    collectType(expr.$.type, context);
  }

  // If the expression evaluates to a function value, collect the function
  // This handles cases like method lookups (e.g., temp.___drop)
  if (expr.$ && expr.$.value && isFunctionValue(expr.$.value)) {
    const functionValue = expr.$.value;
    // Skip ctl handler functions — they are inlined by the effect SM call site
    if (functionValue.isControlFunction) {
      // Still collect types from the function signature
      collectTypesFromFunctionType(functionValue.type, context);
      // Recursively collect sub-functions called by the handler body (e.g., println)
      findFunctionCallsInExpr(functionValue.body, context);
    } else if (!context.functions[functionValue.funcId]) {
      // Skip collecting SomeType's ARC functions that have Impl(Future) params without resolvedConcreteType
      // These are just wrapper functions that codegen handles specially
      const paramTypes = functionValue.type.parameters.map((p) => p.type);
      const hasSomeTypeWithoutResolved = paramTypes.some(
        (t) =>
          isSomeType(t) && typeImplementsFuture(t) && !t.resolvedConcreteType
      );
      if (hasSomeTypeWithoutResolved) {
        // Don't collect this function - it's a generic SomeType ARC wrapper
        // The codegen will handle dispatching to concrete type's functions directly
      } else {
        context.functions[functionValue.funcId] = {
          value: functionValue,
          cName: sanitizeForCIdentifier(functionValue.funcId),
        };
        // Collect types from the function signature
        collectTypesFromFunctionType(functionValue.type, context);
        // Recursively collect functions called by this function
        findFunctionCallsInExpr(functionValue.body, context);
      }
    }
  }

  // Collect types from deferred drop expressions
  // These are drop calls that are deferred to scope exit
  if (
    expr.$ &&
    expr.$.deferredDropExpressions &&
    expr.$.deferredDropExpressions.length > 0
  ) {
    for (const dropExpr of expr.$.deferredDropExpressions) {
      collectTypesFromExpr(dropExpr, context);
    }
  }

  // If this is a macro expansion, recursively collect from the expanded expression
  if (expr.$ && expr.$.macroExpansion) {
    collectTypesFromExpr(expr.$.macroExpansion, context);
  }

  // Collect types from runtime destructurings
  // These occur when compile-time values are converted to runtime (e.g., comptime array -> runtime array)
  if (expr.$ && expr.$.runtimeDestructurings) {
    for (const { type } of expr.$.runtimeDestructurings) {
      collectType(type, context);
    }
  }

  // For closure and async block expressions, collect the capture struct type
  // The capture type is stored in expr.$.captureType during evaluation
  if (expr.$ && expr.$.captureType && isStructType(expr.$.captureType)) {
    const captureType = expr.$.captureType;

    // Collect the capture type if not already collected
    if (!context.types[captureType.id]) {
      // For closure/future capture types, use the type ID to generate a unique C name
      // This ensures each unique capture struct gets its own type definition
      context.types[captureType.id] = {
        type: captureType,
        cName: `__yo_${captureType.id}`, // Use the capture struct's own ID for uniqueness
      };

      // Now collect the capture type's nested types and struct functions (___drop, etc.)
      // This is crucial for generating Rc functions for the capture struct
      // Recursively collect types from struct fields
      for (const field of captureType.fields) {
        collectType(field.type, context);
      }

      // Collect functions from the module (___dup, ___drop, etc.)
      for (const field of captureType.trait.fields) {
        if (field.assignedValue && isFunctionValue(field.assignedValue)) {
          const functionValue = field.assignedValue;
          if (!context.functions[functionValue.funcId]) {
            context.functions[functionValue.funcId] = {
              value: functionValue,
              cName: functionValue.funcId,
            };

            // Collect types from the function signature (parameters and return type)
            collectTypesFromFunctionType(functionValue.type, context);

            // Recursively collect functions called by this struct member function
            findFunctionCallsInExpr(functionValue.body, context);
          }
        }
      }
    }
  }

  switch (expr.tag) {
    case ExprTag.FnCall:
      // Skip test blocks - they should not generate code
      if (exprIsFunctionCallOf(expr, BuiltinKeywords.test)) {
        break;
      }

      // Collect types from the function expression itself (for chained calls)
      collectTypesFromExpr(expr.func, context);

      // Collect types from function arguments
      for (const arg of expr.args) {
        collectTypesFromExpr(arg, context);
      }
      break;
    case ExprTag.Atom:
      // Nothing special for atoms

      if (expr.$?.value && isTypeValue(expr.$.value)) {
        collectType(expr.$.value.value, context);
      }

      break;
  }
}

/**
 * Collect a single type if it's a user-defined type
 */
export function collectType(type: Type, context: CodeGenContext): void {
  if (context.types[type.id]) {
    return; // Already collected this type
  }

  // Handle SomeType (Impl) that implements Fn - collect the FnTraitType for closure generation
  // This must be checked BEFORE typeContainsSomeType since SomeType would otherwise be skipped
  if (isSomeType(type) && typeImplementsFn(type)) {
    // Prefer the resolved concrete type for static dispatch (capture struct).
    // This avoids generating/depending on the FnTraitType runtime closure struct.
    if (type.resolvedConcreteType) {
      collectType(type.resolvedConcreteType, context);
      return;
    }

    // Fallback: if concrete type is not resolved (shouldn't happen for Impl closures
    // at codegen time), keep the old behavior to avoid crashing.
    const fnTrait = extractFnTraitFromType(type);
    if (fnTrait) {
      collectType(fnTrait, context);
    }
    return;
  }

  // Handle SomeType (Impl) that implements Future - DON'T register the FutureTraitType here.
  // The async block generation will register it with the correct state machine struct name.
  // This must be checked BEFORE typeContainsSomeType since SomeType would otherwise be skipped.
  // ALSO: Don't collect the module (ARC functions) since those are generic and will be resolved
  // to concrete state machine types during specialization.
  if (isSomeType(type) && typeImplementsFuture(type)) {
    const futureModule = extractFutureTraitFromType(type);
    if (futureModule) {
      // Only collect the output type (T in Future(T)), not the FutureTraitType itself.
      // The FutureTraitType will be registered by generateAsyncBlock with the state machine struct name.
      collectType(futureModule.isFuture.outputType, context);
    }

    // Important: Don't collect type.module! The SomeType's ARC functions are generic and
    // should not be codegen'd directly. They will be resolved via resolvedConcreteType
    // during specialization, and the concrete type's ARC functions will be collected instead.
    return;
  }

  // Handle SomeType (Impl) with resolvedConcreteType for other traits (e.g., Impl(RetI32))
  // This must be checked BEFORE typeContainsSomeType since SomeType would otherwise be skipped
  if (isSomeType(type) && type.resolvedConcreteType) {
    // Collect the resolved concrete type (e.g., Box(i32) for Impl(RetI32))
    collectType(type.resolvedConcreteType, context);
    return;
  }

  // Skip collecting any types that contain SomeType (generic type parameters).
  // Exception: struct or enum types whose only SomeType content lives inside
  // function-typed fields (e.g., Option(EvaluateExprRawFn) with fn-typed variant).
  if (typeContainsSomeType(type)) {
    if (
      !(isStructType(type) && structSomeTypeIsOnlyInFunctionFields(type)) &&
      !(isEnumType(type) && enumSomeTypeIsOnlyInFunctionFields(type))
    ) {
      return;
    }
  }

  if (
    isStructType(type) ||
    isUnionType(type) ||
    isEnumType(type) ||
    isTupleType(type) ||
    isDynType(type) ||
    isSourceNamespaceType(type) ||
    isTraitType(type) ||
    isSliceType(type) ||
    isIsoType(type)
  ) {
    // Use the struct's id to generate a mangled C type name,
    // or the extern C name if the type is from c_include with a definition
    const cTypeName = isSliceType(type)
      ? getTypeString(type, context) // For slices, use the special slice type name
      : type.isExtern === "c" && type.externName
        ? type.externName // Use the C header's type name directly
        : `__yo_${type.id}`;
    context.types[type.id] = {
      type,
      cName: cTypeName,
    };

    // For struct types, collect functions from the module (___dup, ___drop, etc.)
    if (isStructType(type)) {
      // Recursively collect types from struct fields. Skip function-typed
      // fields — function types aren't registered as C types; their
      // signatures are emitted inline at call sites.
      for (const field of getRuntimeStructFields(type)) {
        if (isFunctionType(field.type)) continue;
        collectType(field.type, context);
      }
    }

    // For enum types, collect functions from the module and types from variants
    if (isEnumType(type)) {
      // Recursively collect types from enum variant fields
      for (const variant of type.variants) {
        if (variant.fields) {
          for (const field of variant.fields) {
            if (isFunctionType(field.type)) continue;
            collectType(field.type, context);
          }
        }
      }
    }

    // For union types, collect types from union fields
    if (isUnionType(type)) {
      // Recursively collect types from union fields
      for (const field of type.fields) {
        collectType(field.type, context);
      }
    }

    // For closures, also collect the call type
    // if (isClosureType(type)) {
    //   const closureType = type as ClosureType;
    //   // Note: capture type is collected from expr.$.captureType above, not from the closure type itself
    //   collectTypesFromFunctionType(closureType.callType, context);
    // }

    // For dynamic dispatch types, collect the required traits.
    if (isDynType(type)) {
      const dynType = type as DynType;
      // Collect all traits that this dynamic dispatch can handle.
      for (const entry of dynType.requiredTraits) {
        collectType(entry.traitType, context);
      }
    }

    // For Iso types, collect the child type and register the Iso type
    if (isIsoType(type)) {
      const isoType = type as IsoType;
      collectType(isoType.childType, context);
      // Register the Iso type in context.isoTypes by calling getTypeString
      // This ensures Iso type declarations are generated before function declarations
      getTypeString(isoType, context);
    }

    // For future types, collect the field type
    // NOTE: OUTDATED
    // if (isFutureTraitType(type)) {
    //   const futureType = type as FutureType;
    //   // Recursively collect the field type
    //   collectType(futureType.childType, context);
    // }

    // For slice types, collect the field type
    if (isSliceType(type)) {
      const sliceType = type as SliceType;
      // Recursively collect the field type
      collectType(sliceType.childType, context);
    }

    // For source namespace and trait types, collect types and functions from fields directly.
    if (isSourceNamespaceType(type) || isTraitType(type)) {
      // First, collect types from all fields (like struct does).
      for (const field of type.fields) {
        collectType(field.type, context);
      }

      // Then, collect functions from the fields.
      for (const field of type.fields) {
        if (field.assignedValue && isFunctionValue(field.assignedValue)) {
          const functionValue = field.assignedValue;

          // Skip compile-time-only functions — they never generate C code and their
          // parameter/return types (e.g. TypeInfo, ComptimeList) should not be collected
          const ft = functionValue.type;
          const allParamsComptime = ft.parameters.every(
            (p) => p.isCompileTimeOnly
          );
          if (allParamsComptime && ft.return.isCompileTimeOnly) {
            continue;
          }

          if (!context.functions[functionValue.funcId]) {
            context.functions[functionValue.funcId] = {
              value: functionValue,
              cName: sanitizeForCIdentifier(functionValue.funcId),
            };

            // Collect types from the function signature (parameters and return type)
            collectTypesFromFunctionType(functionValue.type, context);

            // Recursively collect functions called by this struct function
            findFunctionCallsInExpr(functionValue.body, context);
          }
        } else if (
          field.assignedValue &&
          (isStructValue(field.assignedValue) ||
            isTraitValue(field.assignedValue))
        ) {
          // Struct field has an effect record value - recursively collect its functions.
          const moduleValue = field.assignedValue;
          collectRequiredFunctions(moduleValue, context, false);
        }
      }
    }
  }
  // Check if it's array types
  else if (isArrayType(type)) {
    const arrayType = type as ArrayType;
    const childType = arrayType.childType;
    const length = arrayType.length;
    if (isNumberValue(length)) {
      // Recursively collect the field type
      collectType(childType, context);

      // Generate struct wrapper for arrays and register it
      const elementTypeString = getTypeString(childType, context);
      const arrayTypeName = `Array_${sanitizeForCIdentifier(elementTypeString)}_${length.value}`;

      // Register the array type if not already registered
      if (!context.arrayStructTypes.has(arrayTypeName)) {
        context.arrayStructTypes.set(arrayTypeName, {
          childType: elementTypeString,
          length:
            typeof length.value === "bigint"
              ? Number(length.value)
              : length.value,
        });
      }

      context.types[type.id] = {
        type,
        cName: arrayTypeName,
      };
    }
  }
  // Check if it's pointer types (including nullable pointers)
  else if (isPtrType(type)) {
    // Recursively collect the base type that this pointer points to
    collectType(type.childType, context);

    // QUESTION: The isSliceType check below could be removed since SliceType is no longer DST?
    // Special handling for pointer-to-slice types
    if (isSliceType(type.childType)) {
      const sliceType = type.childType as SliceType;
      const childType = sliceType.childType;

      // Recursively collect the field type
      collectType(childType, context);

      // Generate struct wrapper for slices and register it
      const elementTypeString = getTypeString(childType, context);
      const sliceTypeName = `Slice_${sanitizeForCIdentifier(elementTypeString)}`;

      // Register the slice type if not already registered
      if (!context.sliceStructTypes.has(sliceTypeName)) {
        context.sliceStructTypes.set(sliceTypeName, {
          childType: elementTypeString,
        });
      }
    }

    // The pointer type gets the usual pointer type treatment
    context.types[type.id] = {
      type,
      cName: getTypeString(type, context),
    };
  }
  // Check if it's primitive types
  else if (PrimitiveTypeTags.has(type.tag)) {
    context.types[type.id] = {
      type,
      cName: getTypeString(type, context),
    };
  }

  // For other types (struct/enum/union/etc), collect types and functions from their .trait property
  if (type.trait) {
    collectType(type.trait, context);
  }
}
