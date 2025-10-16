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
  isMutPtrType,
  isStructType,
  isTupleType,
  isUnionType,
  SliceType,
  Type,
  typeContainsSomeType,
  TypeTag,
} from "../../types";
import {
  isFunctionValue,
  isNumberValue,
  isTypeValue,
  ModuleValue,
} from "../../value";
import { PrimitiveTypeTags } from "../constants";
import { findFunctionCallsInExpr } from "../functions";
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
  for (let i = 0; i < moduleValue.elements.length; i++) {
    const value = moduleValue.elements[i]!;

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

  // For async expressions, also collect types from the evaluated closure call
  if (expr.$ && expr.$.evaluatedClosure) {
    collectTypesFromExpr(expr.$.evaluatedClosure, context);
  }

  // For async block expressions, collect the capture struct type
  if (expr.$ && expr.$.asyncBlockCaptureType) {
    collectType(expr.$.asyncBlockCaptureType, context);
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
    isFutureType(type)
  ) {
    // Use the struct's id to generate a mangled C type name
    const cTypeName = isFutureType(type)
      ? `yo_future_${sanitizeForCIdentifier(getTypeString((type as FutureType).elementType, context))}_t`
      : `yo_${type.id}`;
    context.types[type.id] = {
      type,
      cName: cTypeName,
    };

    // For struct types, collect functions from the module (___dup, ___drop, etc.)
    if (isStructType(type)) {
      // Recursively collect types from struct elements
      for (const element of type.elements) {
        collectType(element.type, context);
      }

      for (const element of type.module.elements) {
        if (element.assignedValue && isFunctionValue(element.assignedValue)) {
          const functionValue = element.assignedValue;
          if (!context.functions[functionValue.funcId]) {
            context.functions[functionValue.funcId] = {
              value: functionValue,
              cName: functionValue.funcId,
            };

            // Recursively collect functions called by this struct member function
            // This is needed to collect extern functions like printf used in dispose methods
            findFunctionCallsInExpr(functionValue.body, context);
          }
        }
      }
    }

    // For enum types, collect functions from the module and types from variants
    if (isEnumType(type)) {
      // Recursively collect types from enum variant elements
      for (const variant of type.variants) {
        if (variant.elements) {
          for (const element of variant.elements) {
            collectType(element.type, context);
          }
        }
      }

      // Collect functions from the enum's module (___dup, ___drop, etc.)
      for (const element of type.module.elements) {
        if (element.assignedValue && isFunctionValue(element.assignedValue)) {
          const functionValue = element.assignedValue;
          if (!context.functions[functionValue.funcId]) {
            context.functions[functionValue.funcId] = {
              value: functionValue,
              cName: functionValue.funcId,
            };

            // Recursively collect functions called by this enum member function
            findFunctionCallsInExpr(functionValue.body, context);
          }
        }
      }
    }

    // For union types, collect types from union elements
    if (isUnionType(type)) {
      // Recursively collect types from union elements
      for (const element of type.elements) {
        collectType(element.type, context);
      }
    }

    // For closures, also collect the call type and capture type functions
    if (isClosureType(type)) {
      const closureType = type as ClosureType;
      // Collect the capture type - it needs to be registered for function signatures
      if (closureType.captureType && isStructType(closureType.captureType)) {
        const captureStructType = closureType.captureType;
        // Collect the capture struct type itself
        collectType(captureStructType, context);
        // Also collect functions from the capture type's module (___drop, ___dispose, etc.)
        for (const element of captureStructType.module.elements) {
          if (element.assignedValue && isFunctionValue(element.assignedValue)) {
            const functionValue = element.assignedValue;
            if (!context.functions[functionValue.funcId]) {
              context.functions[functionValue.funcId] = {
                value: functionValue,
                cName: functionValue.funcId,
              };
            }
          }
        }
      }
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

    // For future types, collect the element type
    if (isFutureType(type)) {
      const futureType = type as FutureType;
      // Recursively collect the element type
      collectType(futureType.elementType, context);
    }
  }
  // Check if it's array types
  else if (isArrayType(type)) {
    const arrayType = type as ArrayType;
    const elementType = arrayType.elementType;
    const length = arrayType.length;
    if (isNumberValue(length)) {
      // Recursively collect the element type
      collectType(elementType, context);

      // Generate struct wrapper for arrays and register it
      const elementTypeString = getTypeString(elementType, context);
      const arrayTypeName = `Array_${sanitizeForCIdentifier(elementTypeString)}_${length.value}`;

      // Register the array type if not already registered
      if (!context.arrayStructTypes.has(arrayTypeName)) {
        context.arrayStructTypes.set(arrayTypeName, {
          elementType: elementTypeString,
          length: length.value,
        });
      }

      context.types[type.id] = {
        type,
        cName: arrayTypeName,
      };
    }
  }
  // Check if it's pointer-to-slice types
  else if (isMutPtrType(type) && type.type.tag === TypeTag.Slice) {
    const sliceType = type.type as SliceType;
    const elementType = sliceType.elementType;

    // Recursively collect the element type
    collectType(elementType, context);

    // Generate struct wrapper for slices and register it
    const elementTypeString = getTypeString(elementType, context);
    const sliceTypeName = `Slice_${sanitizeForCIdentifier(elementTypeString)}`;

    // Register the slice type if not already registered
    if (!context.sliceStructTypes.has(sliceTypeName)) {
      context.sliceStructTypes.set(sliceTypeName, {
        elementType: elementTypeString,
      });
    }

    // The pointer-to-slice type gets the usual pointer type treatment
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
      isMutPtrType(type) ||
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
}
