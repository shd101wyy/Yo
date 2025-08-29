import { formatErrorMessage } from "../error";
import { Token } from "../token";
import {
  createFreeType,
  createLinearType,
  createTypeHierarchy,
  createTypeType,
} from "./creators";
import {
  ClosureType,
  FunctionParameter,
  FunctionType,
  ModuleType,
  TupleElement,
  Type,
  TypeHierarchyType,
} from "./definitions";
import {
  isArrayType,
  isClosureType,
  isComptFloatType,
  isComptIntType,
  isComptStringType,
  isEffType,
  isEnumType,
  isExprListType,
  isExprType,
  isFunctionType,
  isModuleType,
  isMutPtrType,
  isMutRefType,
  isPrimitiveType,
  isPtrType,
  isRefType,
  isSomeType,
  isStructType,
  isTupleType,
  isTypeHierarchyType,
  isUnionType,
} from "./guards";
import { TypeTag } from "./tags";

/*
 * Helper function to determine the type universe of a list of types
 */
function determineTypeUniverse(
  baseType: Type,
  elements: TupleElement[],
  /**
   * checkedType is used to prevent infinite recursion
   * when the type is a recursive type.
   * For example:
   *
   *   Recursive :: struct
   *     next : Self
   *   ;
   */
  checkedTupleElements: TupleElement[]
): Type {
  let hasLinear = false;
  let meetTypeTag = false;
  let maxTypeLevel = 0;

  for (const element of elements) {
    const type = element.type;
    if (checkedTupleElements.includes(element)) {
      throw formatErrorMessage({
        token:
          checkedTupleElements[checkedTupleElements.length - 1]!.exprs.expr
            .token,
        errorMessage: `Recursive type has infinite size in field "${checkedTupleElements[checkedTupleElements.length - 1]!.label}"
Insert some indirection (e.g., a pointer '*' or reference '&') to break the cycle.`,
      });
    }
    // For non-universe types, recursively check their type
    checkedTupleElements.push(element);
    const typeOfSubType = typeOfType(type, checkedTupleElements);

    if (isTypeHierarchyType(typeOfSubType)) {
      maxTypeLevel = Math.max(maxTypeLevel, typeOfSubType.level);
      if (typeOfSubType.tag === TypeTag.Linear) {
        hasLinear = true;
      } else if (typeOfSubType.tag === TypeTag.Type) {
        meetTypeTag = true;
      }
    }
  }

  if (maxTypeLevel > 0) {
    return createTypeHierarchy(maxTypeLevel);
  }
  if (meetTypeTag) {
    return createTypeType(baseType);
  }

  // If we found any linear but no type, return linear
  if (hasLinear) {
    return createLinearType(baseType);
  }

  // Otherwise all are free
  return createFreeType(baseType);
}
/**
 * Get the type of a type (meta-type).
 */
export function typeOfType(
  /**
   * The type to get the type of.
   * This can be any type, including primitive types, complex types, etc.
   */
  type: Type,

  /**
   * checkedType is used to prevent infinite recursion
   * when the type is a recursive type.
   * For example:
   *
   *   Recursive :: struct
   *     next : Self
   *   ;
   */
  checkedTupleElements: TupleElement[] = []
): Type {
  if (type.forceLinear) {
    return createLinearType(type); // Force linear type
  }

  if (type.isDynamicSized) {
    return createFreeType(type); // Dynamic sized types are free types
  }

  if (isPrimitiveType(type)) {
    return createFreeType(type); // Primitive types are free types
  } else if (isTypeHierarchyType(type)) {
    return createTypeHierarchy((type as TypeHierarchyType).level + 1);
  } else if (
    isComptIntType(type) ||
    isComptFloatType(type) ||
    isComptStringType(type) ||
    isExprListType(type)
  ) {
    return createFreeType(type);
  } else if (isExprType(type)) {
    return createFreeType(type);
  } else if (isFunctionType(type)) {
    // FnMove closures are linear types (can only be called once)
    // Regular functions and Fn/FnMut closures are free types
    return (type as FunctionType).closureKind === "FnMove"
      ? createLinearType(type)
      : createFreeType(type);
  } else if (isClosureType(type)) {
    // The type universe of a closure is determined by its capture type
    const closureType = type as ClosureType;
    if (closureType.captureType) {
      return typeOfType(closureType.captureType, checkedTupleElements);
    } else {
      // If no capture type, it's a free type (no captures)
      return createFreeType(type);
    }
  } else if (isEffType(type)) {
    // Effects are linear types (they can only be executed once)
    return createLinearType(type);
  } else if (isArrayType(type)) {
    // For arrays, check the element type
    return typeOfType(type.elementType);
  } else if (isTupleType(type)) {
    // For tuples, check all element types
    return determineTypeUniverse(
      type,
      type.elements.filter((element) => !element.isCompileTimeOnly),
      checkedTupleElements
    );
  } else if (isStructType(type)) {
    return determineTypeUniverse(
      type,
      type.elements.filter((element) => !element.isCompileTimeOnly),
      checkedTupleElements
    );
  } else if (isEnumType(type)) {
    // For enums, check all variant
    const elements: TupleElement[] = [];
    for (const variant of type.variants) {
      if (variant.elements) {
        elements.push(
          ...variant.elements.filter((element) => !element.isCompileTimeOnly)
        );
      }
    }
    return determineTypeUniverse(type, elements, checkedTupleElements);
  } else if (isUnionType(type)) {
    // For unions, check all member types
    return determineTypeUniverse(
      type,
      type.elements.filter((element) => !element.isCompileTimeOnly),
      checkedTupleElements
    );
  } else if (isModuleType(type)) {
    return createTypeHierarchy(1, type);
    // Modules are treated as type hierarchies
    // It's the same level as Type(1)
    // Module type itself has the same level as Free/Linear/Type
  } else if (isSomeType(type)) {
    return type.parentType;
  } else if (
    isMutPtrType(type) ||
    isPtrType(type) ||
    isMutRefType(type) ||
    isRefType(type)
  ) {
    // Reference and pointer type hierarchy logic
    if (isMutRefType(type) || isRefType(type)) {
      // Simplified: all references are Linear
      return createLinearType(type);
    } else {
      // Raw pointers are always free
      return createFreeType(type);
    }
  } else {
    throw new Error(`Unknown type tag: ${type}`);
  }
}

/**
 * Get the function parameter token.
 */
export function getFunctionParameterToken(parameter: FunctionParameter): Token {
  if (parameter.exprs.labelExpr?.token) {
    return parameter.exprs.labelExpr.token;
  } else if (parameter.exprs.typeExpr?.token) {
    return parameter.exprs.typeExpr.token;
  } else if (parameter.exprs.defaultValueExpr?.token) {
    return parameter.exprs.defaultValueExpr.token;
  } else {
    throw new Error(`Cannot get token for function parameter`);
  }
}

/**
 * Get the module receiver type from a module type.
 */
export function getModuleReceiverType(moduleType: ModuleType): Type | null {
  const receiverType = moduleType.elements.find(
    (element) => element.label === "Self" && element.isCompileTimeOnly
  );
  if (!receiverType || !receiverType.assignedValue) {
    return null;
  }

  // This would need proper TypeValue handling in practice
  return null; // Simplified
}
