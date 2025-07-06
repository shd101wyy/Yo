import { formatErrorMessage } from "../error";
import { Token } from "../token";
import {
  createFreeType,
  createLinearType,
  createTypeHierarchy,
  createTypeType,
} from "./creators";
import {
  FunctionParameter,
  ModuleType,
  TupleElement,
  Type,
  TypeHierarchyType,
} from "./definitions";
import {
  isArrayType,
  isComptFloatType,
  isComptIntType,
  isComptStringType,
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
import { typeToString } from "./utils";

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
  t: Type,

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
  if (t.forceLinear) {
    return createLinearType(t); // Force linear type
  }

  if (isPrimitiveType(t)) {
    return createFreeType(t); // Primitive types are free types
  } else if (isTypeHierarchyType(t)) {
    return createTypeHierarchy((t as TypeHierarchyType).level + 1);
  } else if (
    isComptIntType(t) ||
    isComptFloatType(t) ||
    isComptStringType(t) ||
    isExprListType(t)
  ) {
    return createFreeType(t);
  } else if (isExprType(t)) {
    return createFreeType(t);
  } else if (isFunctionType(t)) {
    return createFreeType(t);
  } else if (isArrayType(t)) {
    // For arrays, check the element type
    return typeOfType(t.elementType);
  } else if (isTupleType(t)) {
    // For tuples, check all element types
    return determineTypeUniverse(
      t,
      t.elements.filter((element) => !element.isCompileTimeOnly),
      checkedTupleElements
    );
  } else if (isStructType(t)) {
    return determineTypeUniverse(
      t,
      t.elements.filter((element) => !element.isCompileTimeOnly),
      checkedTupleElements
    );
  } else if (isEnumType(t)) {
    // For enums, check all variant
    const elements: TupleElement[] = [];
    for (const variant of t.variants) {
      if (variant.elements) {
        elements.push(
          ...variant.elements.filter((element) => !element.isCompileTimeOnly)
        );
      }
    }
    return determineTypeUniverse(t, elements, checkedTupleElements);
  } else if (isUnionType(t)) {
    // For unions, check all member types
    return determineTypeUniverse(
      t,
      t.elements.filter((element) => !element.isCompileTimeOnly),
      checkedTupleElements
    );
  } else if (isModuleType(t)) {
    return createTypeHierarchy(1, t);
    // Modules are treated as type hierarchies
    // It's the same level as Type(1)
    // Module type itself has the same level as Free/Linear/Type
  } else if (isSomeType(t)) {
    return t.parentType;
  } else if (
    isMutPtrType(t) ||
    isPtrType(t) ||
    isMutRefType(t) ||
    isRefType(t)
  ) {
    return createFreeType(t);
  } else if (t.isDynamicSized) {
    throw new Error(
      `Cannot determine the type of DST (Dynamic Sized Type) ${typeToString(t)}.`
    );
  } else {
    throw new Error(`Unknown type tag: ${t}`);
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
