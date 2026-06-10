import { formatErrorMessage } from "../error";
import type { Token } from "../token";
import { createType0, createTypeHierarchy } from "./creators";
import type {
  FunctionParameter,
  Type,
  TypeField,
  TypeHierarchyType,
} from "./definitions";
import {
  isArrayType,
  isComptimeFloatType,
  isComptimeIntType,
  isComptimeListType,
  isComptimeStringType,
  isDynType,
  isEnumType,
  isExprType,
  isFnTraitType,
  isFunctionType,
  isFutureTraitType,
  isIsoType,
  isSourceNamespaceType,
  isObjectType,
  isPrimitiveType,
  isPtrType,
  isStrType,
  isSomeType,
  isStructType,
  isTraitType,
  isTupleType,
  isTypeHierarchyType,
  isUnionType,
  isVoidType,
} from "./guards";
import { TypeTag } from "./tags";

/*
 * Helper function to determine the type universe of a list of types
 */
function determineTypeUniverse(
  baseType: Type,
  elements: TypeField[],
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
  checkedTupleElements: TypeField[]
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
    const newCheckedElements = [...checkedTupleElements, element];
    const typeOfSubType = typeOfType(type, newCheckedElements);

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
  checkedTupleElements: TypeField[] = []
): Type {
  if (isDynType(type)) {
    return createType0(type); // All types are now level 0
  }

  if (isPrimitiveType(type)) {
    return createType0(type); // All types are now level 0
  } else if (isTypeHierarchyType(type)) {
    return createTypeHierarchy((type as TypeHierarchyType).level + 1);
  } else if (
    isComptimeIntType(type) ||
    isComptimeFloatType(type) ||
    isComptimeStringType(type) ||
    isComptimeListType(type)
  ) {
    return createType0(type);
  } else if (isExprType(type)) {
    return createType0(type);
  } else if (isFunctionType(type)) {
    // All functions are now level 0 types
    return createType0(type);
  } else if (isFnTraitType(type)) {
    // FnTraitType (closures) are level 0 types - they're just anonymous structs
    return createType0(type);
  } else if (isArrayType(type)) {
    // For arrays, check the element type
    return typeOfType(type.childType, checkedTupleElements);
  } else if (isStrType(type)) {
    // str is a value-typed fat pointer to static bytes — level 0.
    return createType0(type);
  } else if (isTupleType(type)) {
    // For tuples, check all element types
    return determineTypeUniverse(type, type.fields, checkedTupleElements);
  } else if (isStructType(type)) {
    return determineTypeUniverse(type, type.fields, checkedTupleElements);
  } else if (isEnumType(type)) {
    // For enums, check all variant
    const fields: TypeField[] = [];
    for (const variant of type.variants) {
      if (variant.fields) {
        fields.push(...variant.fields);
      }
    }
    return determineTypeUniverse(type, fields, checkedTupleElements);
  } else if (isUnionType(type)) {
    // For unions, check all member types
    return determineTypeUniverse(type, type.fields, checkedTupleElements);
  } else if (isSourceNamespaceType(type)) {
    return createTypeHierarchy(1, type);
    // Modules are treated as type hierarchies
    // It's the same level as Type(1)
    // Trait type itself has the same level as Type.
  } else if (isTraitType(type)) {
    return createTypeHierarchy(1, type);
    // Traits are treated as type hierarchies
    // It's the same level as Type(1)
    // Trait type itself has the same level as Type
  } else if (isSomeType(type)) {
    return type.parentType;
  } else if (isPtrType(type)) {
    // Pointer type hierarchy logic
    // Raw pointers are now level 0 types
    return createType0(type);
  } else if (isIsoType(type)) {
    // Isolated type hierarchy logic
    // Iso types use atomic RC, treated as level 0 types
    return createType0(type);
  } else if (isFutureTraitType(type)) {
    return createType0(type);
  } else if (isVoidType(type)) {
    return createType0(type);
  } else {
    throw new Error(`Unknown type tag: ${type.tag}`);
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
