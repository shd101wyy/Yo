import {
  addVariableToEnv,
  Environment,
  getVariablesFromEnv,
  updateExistingVariable,
} from "../../env";
import { PlaceholderToken } from "../../token";
import {
  getValueOfSomeTypeFromEnv,
  isArrayType,
  isClosureType,
  isEnumType,
  isFunctionType,
  isModuleType,
  isMutPtrType,
  isMutRefType,
  isSliceType,
  isSomeType,
  isStructType,
  isTupleType,
  isTypeHierarchyType,
  Type,
} from "../../types";
import { TypeTag } from "../../types/tags";
import { createTypeValue, isTypeValue, isUnknownValue } from "../../value";

/**
 * Check if a given type hierarchy type can be assigned to an expected type hierarchy type.
 * Based on the logic from compatibility.ts
 */
export function canAssignTypeHierarchy(expected: Type, given: Type): boolean {
  if (!isTypeHierarchyType(expected) || !isTypeHierarchyType(given)) {
    return false;
  }

  // Check if the given type is a subtype of the expected type
  return (
    given.level === expected.level &&
    (given.tag === expected.tag || expected.tag === TypeTag.Type)
  );
}

/**
 * Synthesize the types, such as
 * compt(T): Type, i32  => T = i32
 */
export function synthesizeTypes(
  expected: {
    type: Type;
    env: Environment;
  },
  given: {
    type: Type;
    env: Environment;
  },
  checkedTypePairs: { expected: Type; given: Type }[] = []
): { expectedEnv: Environment; givenEnv: Environment } {
  // Prevent circular checks for `object` and similar recursive types
  if (
    checkedTypePairs.find(
      (pair) => pair.expected === expected.type && pair.given === given.type
    )
  ) {
    // Already checked this pair, avoid infinite recursion
    return { expectedEnv: expected.env, givenEnv: given.env };
  } else {
    checkedTypePairs.push({ expected: expected.type, given: given.type });
  }

  if (isSomeType(expected.type) && isSomeType(given.type)) {
    // Handle case where both are SomeTypes - unify them
    // Check if either SomeType is already bound
    const expectedBoundType = getValueOfSomeTypeFromEnv(
      expected.env,
      expected.type
    );
    const givenBoundType = getValueOfSomeTypeFromEnv(given.env, given.type);

    if (!isSomeType(expectedBoundType)) {
      // Expected is bound, use it to bind given
      const value = createTypeValue(expectedBoundType);
      const existingVariables = getVariablesFromEnv(given.env, given.type.name);
      const variable = existingVariables[existingVariables.length - 1];
      if (!variable) {
        const { env: nextEnv } = addVariableToEnv({
          env: given.env,
          variable: {
            name: given.type.name,
            value: value,
            type: value.type,
            isCompileTimeOnly: true,
            isImplicit: false,
            token: PlaceholderToken,
            initializedAtToken: PlaceholderToken,
            consumedAtToken: undefined,
          },
        });
        given.env = nextEnv;
      } else {
        given.env = updateExistingVariable(given.env, variable, {
          ...variable,
          value,
        });
      }
    } else if (!isSomeType(givenBoundType)) {
      // Given is bound, use it to bind expected
      const value = createTypeValue(givenBoundType);
      const existingVariables = getVariablesFromEnv(
        expected.env,
        expected.type.name
      );
      const variable = existingVariables[existingVariables.length - 1];
      if (!variable) {
        const { env: nextEnv } = addVariableToEnv({
          env: expected.env,
          variable: {
            name: expected.type.name,
            value: value,
            type: value.type,
            isCompileTimeOnly: true,
            isImplicit: false,
            token: PlaceholderToken,
            initializedAtToken: PlaceholderToken,
            consumedAtToken: undefined,
          },
        });
        expected.env = nextEnv;
      } else {
        expected.env = updateExistingVariable(expected.env, variable, {
          ...variable,
          value,
        });
      }
    } else if (expectedBoundType === givenBoundType) {
      // Do nothing since both are the same
    }
    // both are some type
    else {
      // Bind both to the same new concrete type
      const value = createTypeValue(
        given.type // NOTE: Using expected.type here causes some errors in tests
        // createSomeType(createType0(), `type_synth_${randomId()}`) // <= This also causes some errors in tests
      );

      // Update expected env
      {
        const existingVariables = getVariablesFromEnv(
          expected.env,
          expected.type.name
        );
        const variable = existingVariables[existingVariables.length - 1];
        if (!variable) {
          const { env: nextEnv } = addVariableToEnv({
            env: expected.env,
            variable: {
              name: expected.type.name,
              value: value,
              type: value.type,
              isCompileTimeOnly: true,
              isImplicit: false,
              token: PlaceholderToken,
              initializedAtToken: PlaceholderToken,
              consumedAtToken: undefined,
            },
          });
          expected.env = nextEnv;
        } else {
          expected.env = updateExistingVariable(expected.env, variable, {
            ...variable,
            value,
          });
        }
      }

      // Update given env
      {
        const existingVariables = getVariablesFromEnv(
          given.env,
          given.type.name
        );
        const variable = existingVariables[existingVariables.length - 1];
        if (!variable) {
          const { env: nextEnv } = addVariableToEnv({
            env: given.env,
            variable: {
              name: given.type.name,
              value: value,
              type: value.type,
              isCompileTimeOnly: true,
              isImplicit: false,
              token: PlaceholderToken,
              initializedAtToken: PlaceholderToken,
              consumedAtToken: undefined,
            },
          });
          given.env = nextEnv;
        } else {
          given.env = updateExistingVariable(given.env, variable, {
            ...variable,
            value,
          });
        }
      }
    }
  } else if (isSomeType(expected.type)) {
    // Check if the env has
    const type = getValueOfSomeTypeFromEnv(expected.env, expected.type);
    if (
      //type === expected.type
      isSomeType(type) &&
      type.name === expected.type.name
    ) {
      const value = createTypeValue(given.type);
      // console.log("(1) addVariableToEnv");

      // Check if the same variable already exists in the env
      const existingVariables = getVariablesFromEnv(
        expected.env,
        expected.type.name
      );
      const variable = existingVariables[existingVariables.length - 1];
      if (!variable) {
        const { env: nextEnv } = addVariableToEnv({
          env: expected.env,
          variable: {
            name: expected.type.name,
            value: value,
            type: value.type,
            isCompileTimeOnly: true,
            isImplicit: false,
            token: PlaceholderToken, // FIXME: What should be `token` here?
            initializedAtToken: PlaceholderToken, // Set as initialized
            consumedAtToken: undefined, // Not consumed yet
          },
        });
        expected.env = nextEnv;
      } else if (variable) {
        // Update existing
        expected.env = updateExistingVariable(expected.env, variable, {
          ...variable,
          value,
        });
      }
    } else if (!isSomeType(type)) {
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: type, env: expected.env },
        { type: given.type, env: given.env },
        checkedTypePairs
      );
      expected.env = expectedEnv;
      given.env = givenEnv;
    }
  } else if (isSomeType(given.type)) {
    // Handle case where given is SomeType but expected is not
    // This can happen in closure synthesis where we need to unify SomeTypes

    // Check if the given SomeType is already bound in its environment
    const existingType = getValueOfSomeTypeFromEnv(given.env, given.type);
    if (!isSomeType(existingType)) {
      // The given SomeType is already bound to a concrete type
      // Recursively synthesize with the bound type
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: expected.type, env: expected.env },
        { type: existingType, env: given.env },
        checkedTypePairs
      );
      expected.env = expectedEnv;
      given.env = givenEnv;
    } else {
      // Bind the given SomeType to the expected type
      const value = createTypeValue(expected.type);

      const existingVariables = getVariablesFromEnv(given.env, given.type.name);
      const variable = existingVariables[existingVariables.length - 1];
      if (!variable) {
        const { env: nextEnv } = addVariableToEnv({
          env: given.env,
          variable: {
            name: given.type.name,
            value: value,
            type: value.type,
            isCompileTimeOnly: true,
            isImplicit: false,
            token: PlaceholderToken,
            initializedAtToken: PlaceholderToken,
            consumedAtToken: undefined,
          },
        });
        given.env = nextEnv;
      } else if (variable) {
        // Update existing
        given.env = updateExistingVariable(given.env, variable, {
          ...variable,
          value,
        });
      }
    }
  } else if (
    isTupleType(expected.type) &&
    isTupleType(given.type) &&
    expected.type.elements.length === given.type.elements.length
  ) {
    for (let i = 0; i < expected.type.elements.length; i++) {
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: expected.type.elements[i]!.type, env: expected.env },
        { type: given.type.elements[i]!.type, env: given.env },
        checkedTypePairs
      );
      expected.env = expectedEnv;
      given.env = givenEnv;
    }
  } else if (
    isStructType(expected.type) &&
    isStructType(given.type) &&
    (expected.type.id === given.type.id ||
      (expected.type.functionValue &&
        given.type.functionValue &&
        expected.type.functionValue === given.type.functionValue))
    // NOTE: The typeId might not match
    // They might be different structs that both are returned from the same function.
    // We removed the typeName condition since it fails for Data(boolean) vs Data(A1)
  ) {
    for (let i = 0; i < expected.type.elements.length; i++) {
      const expectedElement = expected.type.elements[i]!;
      const givenElement = given.type.elements[i]!;
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: expectedElement.type, env: expected.env },
        { type: givenElement.type, env: given.env },
        checkedTypePairs
      );
      expected.env = expectedEnv;
      given.env = givenEnv;

      if (
        expectedElement.assignedValue &&
        givenElement.assignedValue &&
        isTypeValue(expectedElement.assignedValue) &&
        isTypeValue(givenElement.assignedValue)
      ) {
        const { expectedEnv, givenEnv } = synthesizeTypes(
          {
            type: expectedElement.assignedValue.value,
            env: expected.env,
          },
          {
            type: givenElement.assignedValue.value,
            env: given.env,
          },
          checkedTypePairs
        );
        expected.env = expectedEnv;
        given.env = givenEnv;
      }
    }
  } else if (
    isEnumType(expected.type) &&
    isEnumType(given.type) &&
    (expected.type.id === given.type.id ||
      (expected.type.functionValue &&
        given.type.functionValue &&
        expected.type.functionValue === given.type.functionValue))
    // NOTE: The typeId might not match
    // They might be different structs that both are returned from the same function.
  ) {
    for (let i = 0; i < expected.type.variants.length; i++) {
      const expectedTypeVariant = expected.type.variants[i]!;
      const givenTypeVariant = given.type.variants[i]!;

      const expectedTypeVariantElements = expectedTypeVariant.elements ?? [];
      const givenTypeVariantElements = givenTypeVariant.elements ?? [];

      for (let j = 0; j < expectedTypeVariantElements.length; j++) {
        const { expectedEnv, givenEnv } = synthesizeTypes(
          { type: expectedTypeVariantElements[j]!.type, env: expected.env },
          { type: givenTypeVariantElements[j]!.type, env: given.env },
          checkedTypePairs
        );
        expected.env = expectedEnv;
        given.env = givenEnv;
      }
    }
  } else if (
    isModuleType(expected.type) &&
    isModuleType(given.type) &&
    expected.type.functionValue &&
    given.type.functionValue &&
    expected.type.functionValue === given.type.functionValue
    // NOTE: The typeId might not match
    // They might be different structs that both are returned from the same function.
  ) {
    for (let i = 0; i < expected.type.elements.length; i++) {
      const expectedElement = expected.type.elements[i]!;
      const givenElement = given.type.elements[i]!;
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: expectedElement.type, env: expected.env },
        { type: givenElement.type, env: given.env },
        checkedTypePairs
      );
      expected.env = expectedEnv;
      given.env = givenEnv;

      if (
        expectedElement.assignedValue &&
        givenElement.assignedValue &&
        isTypeValue(expectedElement.assignedValue) &&
        isTypeValue(givenElement.assignedValue)
      ) {
        const { expectedEnv, givenEnv } = synthesizeTypes(
          {
            type: expectedElement.assignedValue.value,
            env: expected.env,
          },
          {
            type: givenElement.assignedValue.value,
            env: given.env,
          },
          checkedTypePairs
        );
        expected.env = expectedEnv;
        given.env = givenEnv;
      }
    }
  } else if (
    (isMutRefType(expected.type) && isMutRefType(given.type)) ||
    (isMutPtrType(expected.type) && isMutPtrType(given.type))
  ) {
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expected.type.type,
        env: expected.env,
      },
      {
        type: given.type.type,
        env: given.env,
      },
      checkedTypePairs
    );
    expected.env = expectedEnv;
    given.env = givenEnv;
  } else if (isArrayType(expected.type) && isArrayType(given.type)) {
    // Synthesize the element types of the arrays
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expected.type.elementType,
        env: expected.env,
      },
      {
        type: given.type.elementType,
        env: given.env,
      },
      checkedTypePairs
    );
    expected.env = expectedEnv;
    given.env = givenEnv;

    // Synthesize the array lengths
    // TODO: Extract this to a separate function?
    if (
      isUnknownValue(expected.type.length) &&
      expected.type.length.variableName &&
      !isUnknownValue(given.type.length)
    ) {
      const expectedLengthVariableName = expected.type.length.variableName;
      const givenLength = given.type.length;
      // Check if the variable already exists in the env
      const existingVariables = getVariablesFromEnv(
        expected.env,
        expectedLengthVariableName
      );
      const variable = existingVariables[existingVariables.length - 1];
      if (!variable) {
        // QUESTION: Will it enter this case?
        const { env: nextEnv } = addVariableToEnv({
          env: expected.env,
          variable: {
            name: expectedLengthVariableName,
            value: givenLength,
            type: given.type.length.type,
            isCompileTimeOnly: true,
            isImplicit: false,
            token: PlaceholderToken, // FIXME: What should be `token` here?
            initializedAtToken: PlaceholderToken, // Set as initialized
            consumedAtToken: undefined, // Not consumed yet
          },
        });
        expected.env = nextEnv;
      } else if (variable) {
        // Update existing
        expected.env = updateExistingVariable(expected.env, variable, {
          ...variable,
          value: givenLength,
        });
      }
    }
  } else if (isSliceType(expected.type) && isSliceType(given.type)) {
    // Synthesize the element types of the slices
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expected.type.elementType,
        env: expected.env,
      },
      {
        type: given.type.elementType,
        env: given.env,
      },
      checkedTypePairs
    );
    expected.env = expectedEnv;
    given.env = givenEnv;
  } else if (isClosureType(expected.type) && isClosureType(given.type)) {
    // Synthesize closure types - match capture types and function types
    const expectedClosure = expected.type;
    const givenClosure = given.type;

    // Synthesize the function types (callType)
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expectedClosure.callType,
        env: expected.env,
      },
      {
        type: givenClosure.callType,
        env: given.env,
      },
      checkedTypePairs
    );
    expected.env = expectedEnv;
    given.env = givenEnv;

    // Synthesize the capture types
    if (expectedClosure.captureType && givenClosure.captureType) {
      const { expectedEnv: captureExpectedEnv, givenEnv: captureGivenEnv } =
        synthesizeTypes(
          {
            type: expectedClosure.captureType,
            env: expected.env,
          },
          {
            type: givenClosure.captureType,
            env: given.env,
          },
          checkedTypePairs
        );
      expected.env = captureExpectedEnv;
      given.env = captureGivenEnv;
    }
  } else if (
    isFunctionType(expected.type) &&
    isFunctionType(given.type) &&
    expected.type.forallParameters.length ===
      given.type.forallParameters.length &&
    expected.type.parameters.length === given.type.parameters.length &&
    expected.type.implicitParameters.length ===
      given.type.implicitParameters.length
  ) {
    // Synthesize function types - match parameter types and return types
    const expectedFunction = expected.type;
    const givenFunction = given.type;

    // Synthesize the forall parameter types
    for (let i = 0; i < expectedFunction.forallParameters.length; i++) {
      const expectedForallParam = expectedFunction.forallParameters[i]!;
      const givenForallParam = givenFunction.forallParameters[i]!;
      const { expectedEnv, givenEnv } = synthesizeTypes(
        {
          type: expectedForallParam.type,
          env: expected.env,
        },
        {
          type: givenForallParam.type,
          env: given.env,
        },
        checkedTypePairs
      );
      expected.env = expectedEnv;
      given.env = givenEnv;
    }

    // Synthesize the parameter types
    for (let i = 0; i < expectedFunction.parameters.length; i++) {
      const { expectedEnv, givenEnv } = synthesizeTypes(
        {
          type: expectedFunction.parameters[i]!.type,
          env: expected.env,
        },
        {
          type: givenFunction.parameters[i]!.type,
          env: given.env,
        },
        checkedTypePairs
      );
      expected.env = expectedEnv;
      given.env = givenEnv;
    }

    // Synthesize the implicit parameter types
    for (let i = 0; i < expectedFunction.implicitParameters.length; i++) {
      const { expectedEnv, givenEnv } = synthesizeTypes(
        {
          type: expectedFunction.implicitParameters[i]!.type,
          env: expected.env,
        },
        {
          type: givenFunction.implicitParameters[i]!.type,
          env: given.env,
        },
        checkedTypePairs
      );
      expected.env = expectedEnv;
      given.env = givenEnv;
    }

    // Synthesize the return types
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expectedFunction.return.type,
        env: expected.env,
      },
      {
        type: givenFunction.return.type,
        env: given.env,
      },
      checkedTypePairs
    );
    expected.env = expectedEnv;
    given.env = givenEnv;
  }
  return { expectedEnv: expected.env, givenEnv: given.env };
}
