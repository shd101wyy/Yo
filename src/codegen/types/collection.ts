import {
  extractFnTraitFromType,
  extractFutureTraitFromType,
  typeImplementsFn,
  typeImplementsFuture,
} from "../../evaluator/trait-checking";
import {
  BuiltinKeywords,
  Expr,
  exprIsFunctionCallOf,
  ExprTag,
} from "../../expr";
import {
  ArrayType,
  DynType,
  FunctionType,
  isArrayType,
  isDynType,
  isEnumType,
  isIsoType,
  isModuleType,
  IsoType,
  isPtrType,
  isSliceType,
  isSomeType,
  isStructType,
  isTraitType,
  isTupleType,
  isUnionType,
  SliceType,
  Type,
  typeContainsSomeType,
} from "../../types";
import {
  isFunctionValue,
  isModuleValue,
  isNumberValue,
  isTraitValue,
  isTypeValue,
  ModuleValue,
} from "../../value";
import { PrimitiveTypeTags } from "../constants";
import {
  collectRequiredFunctions,
  findFunctionCallsInExpr,
} from "../functions/collection";
import {
  CodeGenContext,
  getTypeString,
  sanitizeForCIdentifier,
} from "../utils";

/**
 * Collect all user-defined types that need to be generated
 */
export function collectRequiredTypes(
  moduleValue: ModuleValue,
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
    if (!context.functions[functionValue.funcId]) {
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
        cName: `yo_${captureType.id}`, // Use the capture struct's own ID for uniqueness
      };

      // Now collect the capture type's nested types and module functions (___drop, etc.)
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
    const fnModule = extractFnTraitFromType(type);
    if (fnModule) {
      collectType(fnModule, context);
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

  // Skip collecting any types that contain SomeType (generic type parameters)
  // Note: Extern types like YO_THREAD_SYNC_TYPE are excluded by typeContainsSomeType
  if (typeContainsSomeType(type)) {
    return;
  }

  if (
    isStructType(type) ||
    isUnionType(type) ||
    isEnumType(type) ||
    isTupleType(type) ||
    isDynType(type) ||
    isModuleType(type) ||
    isTraitType(type) ||
    isSliceType(type) ||
    isIsoType(type)
  ) {
    // Use the struct's id to generate a mangled C type name
    const cTypeName =
      // NOTE: OUTDATED
      // isFutureTraitType(type)
      // ? `yo_future_${sanitizeForCIdentifier(getTypeString((type as FutureType).childType, context))}_t`
      // :
      isSliceType(type)
        ? getTypeString(type, context) // For slices, use the special slice type name
        : `yo_${type.id}`;
    context.types[type.id] = {
      type,
      cName: cTypeName,
    };

    // For struct types, collect functions from the module (___dup, ___drop, etc.)
    if (isStructType(type)) {
      // Recursively collect types from struct fields
      for (const field of type.fields) {
        collectType(field.type, context);
      }
    }

    // For enum types, collect functions from the module and types from variants
    if (isEnumType(type)) {
      // Recursively collect types from enum variant fields
      for (const variant of type.variants) {
        if (variant.fields) {
          for (const field of variant.fields) {
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

    // For dynamic dispatch types, collect the module types
    if (isDynType(type)) {
      const dynType = type as DynType;
      // Collect all module types that this dynamic dispatch can handle
      for (const traitType of dynType.requiredTraits) {
        collectType(traitType, context);
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

    // For module types, collect types and functions from the module's fields directly
    // (module types don't have a .module field - they ARE the module)
    if (isModuleType(type) || isTraitType(type)) {
      // First, collect types from all module fields (like struct does)
      for (const field of type.fields) {
        collectType(field.type, context);
      }

      // Then, collect functions from the module's fields
      for (const field of type.fields) {
        if (field.assignedValue && isFunctionValue(field.assignedValue)) {
          const functionValue = field.assignedValue;
          if (!context.functions[functionValue.funcId]) {
            context.functions[functionValue.funcId] = {
              value: functionValue,
              cName: sanitizeForCIdentifier(functionValue.funcId),
            };

            // Collect types from the function signature (parameters and return type)
            collectTypesFromFunctionType(functionValue.type, context);

            // Recursively collect functions called by this module function
            findFunctionCallsInExpr(functionValue.body, context);
          }
        } else if (
          field.assignedValue &&
          (isModuleValue(field.assignedValue) ||
            isTraitValue(field.assignedValue))
        ) {
          // Module field has a module value - recursively collect its functions
          const moduleValue = field.assignedValue;
          collectRequiredFunctions(moduleValue, context);
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
