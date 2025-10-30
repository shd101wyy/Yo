import { formatErrorMessage } from "../error";
import { Token } from "../token";
import { createType0, createTypeHierarchy } from "./creators";
import {
  FunctionParameter,
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
  isDynType,
  isEnumType,
  isExprListType,
  isExprType,
  isFunctionType,
  isFutureType,
  isModuleType,
  isMutPtrType,
  isObjectType,
  isPrimitiveType,
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
   * checkedTupleElements is used to prevent infinite recursion
   * when the type is a recursive type.
   * For example:
   *
   *   Recursive :: struct
   *     next : Self
   *   ;
   *
   * But `ref` is allowed.
   *
   *   Recursive :: object
   *     next : Self
   *   ;
   */
  checkedTupleElements: TupleElement[]
): Type {
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

    if (isObjectType(type)) {
      continue;
    }

    // For non-universe types, recursively check their type
    checkedTupleElements.push(element);
    const typeOfSubType = typeOfType(type, checkedTupleElements);

    if (isTypeHierarchyType(typeOfSubType)) {
      maxTypeLevel = Math.max(maxTypeLevel, typeOfSubType.level);
      if (typeOfSubType.tag === TypeTag.Type) {
        meetTypeTag = true;
      }
    }
  }

  if (maxTypeLevel > 0) {
    return createTypeHierarchy(maxTypeLevel);
  }
  if (meetTypeTag) {
    return createType0(baseType);
  }

  // All types are now at level 0
  return createType0(baseType);
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
  if (type.isDynamicSized) {
    return createType0(type); // All types are now level 0
  }

  if (isDynType(type)) {
    return createType0(type); // All types are now level 0
  }

  if (isPrimitiveType(type)) {
    return createType0(type); // All types are now level 0
  } else if (isTypeHierarchyType(type)) {
    return createTypeHierarchy((type as TypeHierarchyType).level + 1);
  } else if (
    isComptIntType(type) ||
    isComptFloatType(type) ||
    isComptStringType(type) ||
    isExprListType(type)
  ) {
    return createType0(type);
  } else if (isExprType(type)) {
    return createType0(type);
  } else if (isFunctionType(type)) {
    // All functions are now level 0 types
    return createType0(type);
  } else if (isClosureType(type)) {
    // FIXME: The captureType is now wrong in some ClosureType
    // if (type.captureType) {
    //   console.log(typeToString(type.captureType));
    // }
    /*
    // The type universe of a closure is determined by its capture type
    const closureType = type as ClosureType;
    if (closureType.captureType) {
      return typeOfType(closureType.captureType, checkedTupleElements);
    } else {
      // If no capture type, it's a level 0 type (no captures)
      return createType0(type);
    }
    */
    // All closures are now level 0 types
    return createType0(type);
  } else if (isArrayType(type)) {
    // For arrays, check the element type
    return typeOfType(type.elementType, checkedTupleElements);
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
  } else if (isMutPtrType(type)) {
    // Pointer type hierarchy logic
    // Raw pointers are now level 0 types
    return createType0(type);
  } else if (isFutureType(type)) {
    return createType0(type);
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
