import { addVariableToEnv, Environment } from "../env";
import { randomId } from "../utils";
import { areValuesEqual, createUnknownValue } from "../value";
import { FunctionType, ModuleElement, Type } from "./definitions";
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
import { getFunctionParameterToken } from "./hierarchy";
import { TypeTag } from "./tags";
import { getValueOfSomeTypeFromEnv, typeContainsSomeType } from "./utils";

/**
 * Check if two types are compatible.
 */
export function areTypesCompatible(
  expected: {
    type: Type;
    env: Environment;
  },
  given: {
    type: Type;
    env: Environment;
  },
  exactNumericTypeMatch = false
): boolean {
  if (isPrimitiveType(expected.type) && isPrimitiveType(given.type)) {
    return expected.type.tag === given.type.tag;
  }

  // compt_int can be converted to
  // - compt_int
  // - u8
  // - i8
  // - u16
  // - i16
  // - u32
  // - i32
  // - u64
  // - i64
  // - usize
  // - isize
  if (
    (isComptIntType(expected.type) ||
      expected.type.tag === TypeTag.U8 ||
      expected.type.tag === TypeTag.I8 ||
      expected.type.tag === TypeTag.U16 ||
      expected.type.tag === TypeTag.I16 ||
      expected.type.tag === TypeTag.U32 ||
      expected.type.tag === TypeTag.I32 ||
      expected.type.tag === TypeTag.U64 ||
      expected.type.tag === TypeTag.I64 ||
      expected.type.tag === TypeTag.Usize ||
      expected.type.tag === TypeTag.Isize) &&
    isComptIntType(given.type)
  ) {
    if (exactNumericTypeMatch && !isComptIntType(expected.type)) {
      // If exact match is required, compt_int cannot be converted to other numeric types
      return false;
    }

    return true;
  }

  // compt_float can be converted to
  // - compt_float
  // - f32
  // - f64
  if (
    (isComptFloatType(expected.type) ||
      expected.type.tag === TypeTag.F32 ||
      expected.type.tag === TypeTag.F64) &&
    isComptFloatType(given.type)
  ) {
    if (exactNumericTypeMatch && !isComptFloatType(expected.type)) {
      // If exact match is required, compt_float cannot be converted to other numeric types
      return false;
    }

    return true;
  }

  // compt_string can be converted to
  // - compt_float
  // TODO:
  // - *(u8);  // C-style string pointer.
  // - Array(u8, N); // Fixed-length array of u8.
  // - &(str); // Rust-style string slice, fat pointer.
  if (isComptStringType(expected.type) && isComptStringType(given.type)) {
    return true;
  }

  if (isExprType(expected.type) && isExprType(given.type)) {
    return true;
  }

  if (isExprListType(expected.type) && isExprListType(given.type)) {
    return true;
  }

  if (isArrayType(expected.type) && isArrayType(given.type)) {
    // Arrays must have same length and compatible element types
    return (
      areValuesEqual(
        { value: expected.type.length, env: expected.env },
        { value: given.type.length, env: expected.env }
      ) &&
      areTypesCompatible(
        {
          type: expected.type.elementType,
          env: expected.env,
        },
        { type: given.type.elementType, env: given.env }
      )
    );
  }

  if (isTupleType(expected.type) && isTupleType(given.type)) {
    if (expected.type.elements.length !== given.type.elements.length) {
      return false;
    }
    for (let i = 0; i < expected.type.elements.length; i++) {
      const expectedTypeElement = expected.type.elements[i]!;
      const givenTypeElement = given.type.elements[i]!;

      if (
        !areTypesCompatible(
          { type: expectedTypeElement.type, env: expected.env },
          { type: givenTypeElement.type, env: given.env }
        )
      ) {
        return false;
      }

      // QUESTION: Should we check the label here?
      // NOTE: We don't check labels, as the Tuple is a structural type,
      //       not a nominal type.
    }
    return true;
  }

  if (isStructType(expected.type) && isStructType(given.type)) {
    // Structs must have same elements and compatible types
    if (
      expected.type.elements.length !== given.type.elements.length ||
      // NOTE: Below is not necessarily true
      // We might compare Box(T) and Box(U), where T and U are SomeType.
      (expected.type.typeId !== given.type.typeId &&
        !typeContainsSomeType(expected.type) &&
        !typeContainsSomeType(given.type))
    ) {
      return false;
    }

    if (expected.type.typeId === given.type.typeId) {
      return true;
    }

    for (let i = 0; i < expected.type.elements.length; i++) {
      const expectedElement = expected.type.elements[i]!;
      const givenElement = given.type.elements[i]!;

      if (
        expectedElement.label !== givenElement.label ||
        !areTypesCompatible(
          {
            type: expectedElement.type,
            env: expected.env,
          },
          { type: givenElement.type, env: given.env }
        )
      ) {
        return false;
      }
    }
    return true;
  }

  if (isEnumType(expected.type) && isEnumType(given.type)) {
    if (expected.type.typeId === given.type.typeId) {
      return true;
    }

    // Check each variants
    if (expected.type.variants.length !== given.type.variants.length) {
      return false;
    }

    for (let i = 0; i < expected.type.variants.length; i++) {
      const expectedVariant = expected.type.variants[i]!;
      const givenVariant = given.type.variants[i]!;

      if (expectedVariant.name !== givenVariant.name) {
        return false;
      }

      if (expectedVariant.elements?.length !== givenVariant.elements?.length) {
        return false;
      }

      if (expectedVariant.elements) {
        for (let j = 0; j < expectedVariant.elements.length; j++) {
          const expectedElement = expectedVariant.elements![j]!;
          const givenElement = givenVariant.elements![j]!;

          if (
            expectedElement.label !== givenElement.label ||
            !areTypesCompatible(
              { type: expectedElement.type, env: expected.env },
              { type: givenElement.type, env: given.env }
            )
          ) {
            return false;
          }
        }
      }
    }

    if (
      expected.type.requiredVariantNames &&
      ((given.type.selectedVariantName &&
        !expected.type.requiredVariantNames.includes(
          given.type.selectedVariantName
        )) ||
        !given.type.selectedVariantName)
    ) {
      return false;
    } else if (!expected.type.selectedVariantName) {
      return true;
    } else {
      return false;
    }
  }

  if (isUnionType(expected.type) && isUnionType(given.type)) {
    // Unions must have same elements and compatible types
    if (
      expected.type.elements.length !== given.type.elements.length ||
      (expected.type.typeId !== given.type.typeId &&
        !typeContainsSomeType(expected.type) &&
        !typeContainsSomeType(given.type))
    ) {
      return false;
    }

    if (expected.type.typeId === given.type.typeId) {
      return true;
    }

    for (let i = 0; i < expected.type.elements.length; i++) {
      const expectedElement = expected.type.elements[i]!;
      const givenElement = given.type.elements[i]!;

      if (
        expectedElement.label !== givenElement.label ||
        !areTypesCompatible(
          { type: expectedElement.type, env: expected.env },
          { type: givenElement.type, env: given.env }
        )
      ) {
        return false;
      }
    }
    return true;
  }

  // NOTE: Module type is a structural type.
  if (isModuleType(expected.type)) {
    let givenElements: ModuleElement[] | undefined = undefined;
    if (isModuleType(given.type)) {
      givenElements = given.type.elements;
    } else if (
      isTypeHierarchyType(given.type) &&
      given.type.baseType &&
      (isStructType(given.type.baseType) ||
        isEnumType(given.type.baseType) ||
        isUnionType(given.type.baseType))
    ) {
      givenElements = given.type.baseType.module.elements;
    }

    if (givenElements) {
      // Modules must have same elements and compatible types
      for (let i = 0; i < expected.type.elements.length; i++) {
        const expectedElement = expected.type.elements[i]!;

        const givenElement = givenElements.find(
          (element) => element.label === expectedElement.label
        );
        if (!givenElement) {
          return false;
        }
        if (
          !areTypesCompatible(
            { type: expectedElement.type, env: expected.env },
            { type: givenElement.type, env: given.env },
            true // exactNumericTypeMatch
          )
        ) {
          return false;
        }

        if (expectedElement.assignedValue && givenElement.assignedValue) {
          if (
            !areValuesEqual(
              {
                value: expectedElement.assignedValue,
                env: expected.env,
              },
              {
                value: givenElement.assignedValue,
                env: given.env,
              }
            )
          ) {
            return false;
          }
        }
      }
      return true;
    }
  }

  if (isFunctionType(expected.type) && isFunctionType(given.type)) {
    return areFunctionTypesCompatible(
      { type: expected.type, env: expected.env },
      { type: given.type, env: given.env },
      exactNumericTypeMatch
    );
  }

  if (isTypeHierarchyType(expected.type) && isTypeHierarchyType(given.type)) {
    // Free can be assigned to Linear,
    // but not the other way around.
    if (
      expected.type.tag === TypeTag.Linear &&
      given.type.tag === TypeTag.Free
    ) {
      return true;
    }

    // Check if the given type is a subtype of the expected type
    return (
      given.type.level === expected.type.level &&
      (given.type.tag === expected.type.tag ||
        expected.type.tag === TypeTag.Type)
    );
  }

  // *
  if (
    isPtrType(expected.type) &&
    (isPtrType(given.type) || isMutPtrType(given.type))
  ) {
    // Pointers must have the same type
    return areTypesCompatible(
      { type: expected.type.type, env: expected.env },
      { type: given.type.type, env: given.env }
    );
  }

  // *!
  if (isMutPtrType(expected.type) && isMutPtrType(given.type)) {
    // Mut pointers must have the same type
    return areTypesCompatible(
      { type: expected.type.type, env: expected.env },
      { type: given.type.type, env: given.env }
    );
  }

  // &
  if (
    isRefType(expected.type) &&
    (isRefType(given.type) || isMutRefType(given.type))
  ) {
    // References must have the same type
    return areTypesCompatible(
      { type: expected.type.type, env: expected.env },
      { type: given.type.type, env: given.env }
    );
  }

  // &!
  if (isMutRefType(expected.type) && isMutRefType(given.type)) {
    // Mut references must have the same type
    return areTypesCompatible(
      { type: expected.type.type, env: expected.env },
      { type: given.type.type, env: given.env }
    );
  }

  // Meet SomeType,
  // eg: x: T
  // here T should already be added to env by the if condition above ^^^
  if (isSomeType(expected.type)) {
    if (isSomeType(given.type)) {
      const expectedType_ = getValueOfSomeTypeFromEnv(
        expected.env,
        expected.type
      );
      const givenType_ = getValueOfSomeTypeFromEnv(given.env, given.type);
      if (isSomeType(expectedType_) && isSomeType(givenType_)) {
        // QUESTION: Should compare name instead?
        return expectedType_.typeId === givenType_.typeId;
      } else {
        // QUESTION: Is this correct?
        return false;
      }
    } else {
      const expectedType_ = getValueOfSomeTypeFromEnv(
        expected.env,
        expected.type
      );
      if (expected.type === expectedType_) {
        return false;
      }
      return areTypesCompatible(
        { type: expectedType_, env: expected.env },
        given
      );
    }
  }

  return false;
}

/**
 * Check if two function types are compatible.
 * @param expectedType The expected function type.
 * @param givenType The given function type.
 * @param env
 * @returns
 */
export function areFunctionTypesCompatible(
  expected: {
    type: FunctionType;
    env: Environment;
  },
  given: {
    type: FunctionType;
    env: Environment;
  },
  exactNumericTypeMatch = false
): boolean {
  // Check if the type parameters have the same count
  if (expected.type.parameters.length !== given.type.parameters.length) {
    return false;
  }

  // Check if the parameters have the same count
  if (
    expected.type.typeParameters.length !== given.type.typeParameters.length
  ) {
    return false;
  }

  // Check if the implicit parameters have the same count
  if (
    expected.type.implicitParameters.length !==
    given.type.implicitParameters.length
  ) {
    return false;
  }

  // Check type parameters for compatibility
  for (let i = 0; i < expected.type.typeParameters.length; i++) {
    const expectedTypeParam = expected.type.typeParameters[i]!;
    const givenTypeParam = given.type.typeParameters[i]!;

    /**
     * Check if
     * Type == Type
     * Linear == Linear
     * Free == Free
     */
    if (
      !areTypesCompatible(
        { type: expectedTypeParam.type, env: expected.env },
        { type: givenTypeParam.type, env: given.env },
        exactNumericTypeMatch
      )
    ) {
      return false;
    }
    // Create some type value for expectedType and givenType
    // then add it to the env.
    const typeValue = createUnknownValue(
      givenTypeParam.type,
      `some_type_${randomId()}`
    );
    if (expectedTypeParam.label) {
      const { env: nextEnv } = addVariableToEnv({
        env: expected.env,
        variable: {
          name: expectedTypeParam.label,
          value: typeValue,
          type: typeValue.type,
          isCompileTimeOnly: true,
          isImplicit: false,
          isMutable: false,
          token: getFunctionParameterToken(expectedTypeParam),
          initializedAtToken: getFunctionParameterToken(expectedTypeParam),
          consumedAtToken: undefined,
        },
      });
      expected.env = nextEnv;
    }
    if (givenTypeParam.label) {
      const { env: nextEnv2 } = addVariableToEnv({
        env: given.env,
        variable: {
          name: givenTypeParam.label,
          value: typeValue,
          type: typeValue.type,
          isCompileTimeOnly: true,
          isImplicit: false,
          isMutable: false,
          token: getFunctionParameterToken(givenTypeParam),
          initializedAtToken: getFunctionParameterToken(givenTypeParam),
          consumedAtToken: undefined,
        },
      });
      given.env = nextEnv2;
    }
  }

  // Check regular parameters for compatibility
  for (let i = 0; i < expected.type.parameters.length; i++) {
    if (
      !areTypesCompatible(
        {
          type: expected.type.parameters[i]!.type,
          env: expected.env,
        },
        {
          type: given.type.parameters[i]!.type,
          env: given.env,
        },
        exactNumericTypeMatch
      )
    ) {
      return false;
    }
  }

  // Check implicit parameters for compatibility
  for (let i = 0; i < expected.type.implicitParameters.length; i++) {
    const expectedImplicitParam = expected.type.implicitParameters[i]!;
    const givenImplicitParam = given.type.implicitParameters[i]!;

    if (
      expectedImplicitParam.isCompileTimeOnly !==
        givenImplicitParam.isCompileTimeOnly ||
      !areTypesCompatible(
        { type: expectedImplicitParam.type, env: expected.env },
        { type: givenImplicitParam.type, env: given.env },
        exactNumericTypeMatch
      )
    ) {
      return false;
    }
  }

  return areTypesCompatible(
    { type: expected.type.return.type, env: expected.env },
    { type: given.type.return.type, env: given.env },
    exactNumericTypeMatch
  );
}
