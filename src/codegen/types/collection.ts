import { Expr, ExprTag } from "../../expr";
import {
  ArrayType,
  ClosureType,
  DynType,
  FunctionType,
  FutureType,
  isArrayType,
  isClosureType,
  isDynType,
  isEnumType,
  isFutureType,
  isModuleType,
  isPtrType,
  isSliceType,
  isStructType,
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
  isTypeValue,
  ModuleValue,
} from "../../value";
import { PrimitiveTypeTags } from "../constants";
import {
  collectRequiredFunctions,
  findFunctionCallsInExpr,
} from "../functions";
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
  // Traverse this.functions
  for (const funcId in context.functions) {
    const func = context.functions[funcId]!;
    collectTypesFromFunctionType(func.value.type, context);
    collectTypesFromExpr(func.value.body, context);
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
  for (const param of functionType.implicitParameters) {
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

  // If this is a macro expansion, recursively collect from the expanded expression
  if (expr.$ && expr.$.macroExpansion) {
    collectTypesFromExpr(expr.$.macroExpansion, context);
  }

  // For closure and async block expressions, collect the capture struct type
  // The capture type needs a special C name: {closureTypeName}_capture
  if (expr.$ && expr.$.captureType && expr.$.type) {
    const captureType = expr.$.captureType;
    const exprType = expr.$.type;

    // Check if this is a closure or future type
    if (isClosureType(exprType) || isFutureType(exprType)) {
      // First collect the main type (closure or future)
      collectType(exprType, context);

      // Then collect the capture type with a special C name
      if (!context.types[captureType.id]) {
        // For closure/future capture types, use the type ID to generate a unique C name
        // This ensures each unique capture struct gets its own type definition
        context.types[captureType.id] = {
          type: captureType,
          cName: `yo_${captureType.id}`, // Use the capture struct's own ID for uniqueness
        };

        // Now collect the capture type's nested types and module functions (___drop, etc.)
        // This is crucial for generating ARC functions for the capture struct
        if (isStructType(captureType)) {
          // Recursively collect types from struct fields
          for (const field of captureType.fields) {
            collectType(field.type, context);
          }

          // Collect functions from the module (___dup, ___drop, etc.)
          for (const field of captureType.module.fields) {
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
    }
  }

  switch (expr.tag) {
    case ExprTag.FuncCall:
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

  // Skip collecting any types that contain SomeType (generic type parameters)
  if (typeContainsSomeType(type)) {
    return;
  }

  if (
    isStructType(type) ||
    isUnionType(type) ||
    isEnumType(type) ||
    isTupleType(type) ||
    isClosureType(type) ||
    isDynType(type) ||
    isFutureType(type) ||
    isModuleType(type) ||
    isSliceType(type)
  ) {
    // Use the struct's id to generate a mangled C type name
    const cTypeName = isFutureType(type)
      ? `yo_future_${sanitizeForCIdentifier(getTypeString((type as FutureType).childType, context))}_t`
      : isSliceType(type)
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
    if (isClosureType(type)) {
      const closureType = type as ClosureType;
      // Note: capture type is collected from expr.$.captureType above, not from the closure type itself
      collectTypesFromFunctionType(closureType.callType, context);
    }

    // For dynamic dispatch types, collect the module types
    if (isDynType(type)) {
      const dynType = type as DynType;
      // Collect all module types that this dynamic dispatch can handle
      for (const moduleType of dynType.moduleTypes) {
        collectType(moduleType, context);
      }
    }

    // For future types, collect the field type
    if (isFutureType(type)) {
      const futureType = type as FutureType;
      // Recursively collect the field type
      collectType(futureType.childType, context);
    }

    // For slice types, collect the field type
    if (isSliceType(type)) {
      const sliceType = type as SliceType;
      // Recursively collect the field type
      collectType(sliceType.childType, context);
    }

    // For module types, collect types and functions from the module's fields directly
    // (module types don't have a .module field - they ARE the module)
    if (isModuleType(type)) {
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
        } else if (field.assignedValue && isModuleValue(field.assignedValue)) {
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
          length: length.value,
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
  /*
    // NOTE: No need to collect pointer/reference types here,
    // Check if it's pointer/reference types
    else if (
      isPtrType(type) ||
      isPtrType(type) ||
      isRefType(type) ||
      isMutRefType(type)
    ) {
      // Use the base type's C name
      const baseType = type.type;
      const baseCName = this.getTypeString(baseType);
      const cName = `${baseCName}*`; // Pointer type in C
      this.types[type.id] = {
        type,
        cName,
      };
    }
    */

  // For other types (struct/enum/union/etc), collect types and functions from their .module property
  if (type.module) {
    collectType(type.module, context);
  }
}
