import { addVariableToEnv, Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  RuntimeDestructuring,
} from "../../expr";
import { Token } from "../../token";
import {
  isEnumType,
  isLinearOrType0Type,
  isModuleType,
  isStructType,
  isTupleType,
  isUnionType,
  Type,
  typeContainsReference,
  typeOfType,
  typeToString,
} from "../../types";
import {
  isEnumValue,
  isModuleValue,
  isStructValue,
  isTupleValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";
import { isValidVariableName } from "../utils";

// Modified to handle member destructuring directly
export function handleMemberDestructuring({
  lhsFunc,
  lhsElements,
  rhsElements,
  rhsValue,
  rhsType,
  lhs,
  env,
  // context,
  isCompileTimeOnly,
  isDestructuringAtomVariable,
}: {
  lhsFunc: Expr;
  lhsElements: Expr[];
  rhsElements: { label: string; type: Type }[];
  rhsValue: Value | undefined;
  /**
   * The rhsType might be pointer or reference,
   * in this case, the rhsElements are the dereferenced elements.
   */
  rhsType: Type;
  lhs: Expr;
  env: Environment;
  context: EvaluatorContext;
  isCompileTimeOnly: boolean;
  isDestructuringAtomVariable: boolean;
}): { env: Environment; runtimeDestructurings: RuntimeDestructuring[] } {
  const requireUnderscore = !isTupleType(rhsType);
  const lhsFuncName = lhsFunc.token.value;

  // ~~Verify the struct type name matches if specified~~
  // We force to use _ for destructuring
  if (requireUnderscore && lhsFuncName !== "_") {
    throw formatErrorMessage({
      token: lhsFunc.token,
      errorMessage: `Expected "_" for non-tuple destructuring, got "${lhsFuncName}"`,
    });
  }

  // Check if it's destructuring a union type
  if (isUnionType(rhsType)) {
    // Expect lhsElements to be a single element
    if (lhsElements.length !== 1) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Destructuring union type requires a single element, got ${lhsElements.length}`,
      });
    }
  }

  // Check if we have enough elements
  if (lhsElements.length > rhsElements.length) {
    throw formatErrorMessage({
      token: lhs.token,
      errorMessage: `Too many elements in destructuring pattern. Expected at most ${rhsElements.length}, got ${lhsElements.length}`,
    });
  }

  const destructuredRhsElements: Record<
    /**
     * key is the label
     */
    string,
    /**
     * the destructured element
     */
    RuntimeDestructuring
  > = {};
  // Process each lhs element
  for (let i = 0; i < lhsElements.length; i++) {
    const lhsElement = lhsElements[i]!;
    let elementIndex: number = i;
    let elementValue: Value | undefined = undefined;
    // Initialize rhsElement here, before any conditional branches
    let rhsElement = rhsElements[elementIndex]!;
    let variableName: string | undefined;
    let variableToken: Token | undefined;
    let labelExpr: Expr | undefined = undefined;
    let renameExpr: Expr | undefined = undefined;

    // Handle destructuring all elements with "..."
    // - (... : ...)
    // - ( ... )
    if (
      (exprIsFunctionCall(lhsElement) &&
        exprIsFunctionCallOf(lhsElement, ":", 2) &&
        lhsElement.args[0]!.token.value === "..." &&
        lhsElement.args[1]!.token.value === "...") ||
      (exprIsAtom(lhsElement) && lhsElement.token.value === "...")
    ) {
      if (isUnionType(rhsType)) {
        throw formatErrorMessage({
          token: lhsElement.token,
          errorMessage: `Cannot destructure union type with _, got ${typeToString(rhsType)}`,
        });
      }

      // If it's a single ..., we destructure all elements
      // We can destructure all elements
      for (let j = 0; j < rhsElements.length; j++) {
        const element = rhsElements[j]!;

        if (destructuredRhsElements[element.label]) {
          continue; // Skip already destructured elements
        } else {
          destructuredRhsElements[element.label] = {
            label: element.label,
            variableName: element.label,
            type: element.type,
          };
        }

        const elementValue =
          isTupleValue(rhsValue) ||
          isStructValue(rhsValue) ||
          isModuleValue(rhsValue) ||
          isEnumValue(rhsValue)
            ? rhsValue.elements[j]
            : undefined;

        if (!elementValue && isCompileTimeOnly) {
          throw formatErrorMessage({
            token: lhsElement.token,
            errorMessage: `Destructuring element "${element.label}" is not defined in compile-time only context.`,
          });
        }

        if (
          typeContainsReference(element.type) &&
          !isDestructuringAtomVariable
        ) {
          throw formatErrorMessage({
            token: lhsElement.token,
            errorMessage: `Cannot destructure element "${element.label}" of type ${typeToString(
              element.type
            )} with references.`,
          });
        }

        // Add to environment
        // console.log("(2) addVariableToEnv");
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: element.label,
            value: elementValue,
            type: element.type,
            isMutable: false,
            isCompileTimeOnly,
            isImplicit: false,
            token: lhsElement.token,
            initializedAtToken: lhsElement.token,
            consumedAtToken: undefined,
            isCreatedFromDestructuringAtomVariable: isDestructuringAtomVariable,
          },
        });
        env = nextEnv;
      }

      // Set the type and value of the lhsElement
      lhsElement.$ = {
        env,
        type: rhsType,
        value: rhsValue,
        isMutable: false,
        pathCollection: [],
      };

      continue;
    }

    // Handle destructuring with implicit members
    // This only works with the module destructuring
    // - ( ...(given) ) or ( ...(not(given)) )
    else if (
      exprIsFunctionCall(lhsElement) &&
      exprIsFunctionCallOf(lhsElement, "...", 1) &&
      lhsElement.args.length === 1 &&
      (exprIsAtomOf(lhsElement.args[0]!, BuiltinKeywords.given) ||
        (exprIsFunctionCall(lhsElement.args[0]) &&
          exprIsFunctionCallOf(lhsElement.args[0]!, BuiltinKeywords.not) &&
          exprIsAtomOf(lhsElement.args[0]!.args[0]!, BuiltinKeywords.given))) // TODO: not implicit
    ) {
      const expectedImplicits = exprIsAtomOf(
        lhsElement.args[0]!,
        BuiltinKeywords.given
      );

      if (!isModuleType(rhsType) || !isModuleValue(rhsValue)) {
        throw formatErrorMessage({
          token: lhsElement.token,
          errorMessage: `Expected module value for destructuring with ${expectedImplicits ? "implicit" : "non-implicit"} members, got ${typeToString(
            rhsType
          )}`,
        });
      }

      // We can destructure all elements
      for (let j = 0; j < rhsElements.length; j++) {
        const element = rhsElements[j]!;

        if (destructuredRhsElements[element.label]) {
          continue; // Skip already destructured elements
        } else {
          destructuredRhsElements[element.label] = {
            label: element.label,
            variableName: element.label,
            type: element.type,
          };
        }

        const memberTypeIndex = rhsType.elements.findIndex(
          (m) => m.label === element.label
        )!;
        const memberType = rhsType.elements[memberTypeIndex]!;
        if (memberType.isImplicit !== expectedImplicits) {
          continue;
        }

        const memberValue = rhsValue.elements[memberTypeIndex];

        if (!memberValue && isCompileTimeOnly) {
          throw formatErrorMessage({
            token: lhsElement.token,
            errorMessage: `Destructuring member "${element.label}" is not defined in compile-time only context.`,
          });
        }

        if (
          typeContainsReference(element.type) &&
          !isDestructuringAtomVariable
        ) {
          throw formatErrorMessage({
            token: lhsElement.token,
            errorMessage: `Cannot destructure element "${element.label}" of type ${typeToString(
              element.type
            )} with references.`,
          });
        }

        // Add to environment
        // console.log("(3) addVariableToEnv");
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: element.label,
            value: memberValue,
            type: element.type,
            isMutable: false,
            isCompileTimeOnly,
            isImplicit: false,
            token: lhsElement.token,
            initializedAtToken: lhsElement.token,
            consumedAtToken: undefined,
            isCreatedFromDestructuringAtomVariable: isDestructuringAtomVariable,
          },
        });
        env = nextEnv;
      }

      // Set the type and value of the lhsElement
      lhsElement.$ = {
        env,
        type: rhsType,
        value: rhsValue,
        isMutable: false,
        pathCollection: [],
      };

      continue;
    }

    // Handle labeled destructuring pattern like:
    // - (c : x)
    // -  Nested destructuring is disallowed now
    // - ~~(c: (x, y))~~
    // - ~~(c: _(x, y))~~
    else if (
      exprIsFunctionCall(lhsElement) &&
      exprIsFunctionCallOf(lhsElement, ":", 2)
    ) {
      const leftSide = lhsElement.args[0]!; // The label (c)
      const rightSide = lhsElement.args[1]!; // Could be (x, y) or could be a variable

      // The left side should be an identifier
      if (!exprIsAtom(leftSide) || !isValidVariableName(leftSide)) {
        throw formatErrorMessage({
          token: leftSide.token,
          errorMessage: `Expected identifier for label in destructuring pattern, got ${exprToString(
            leftSide
          )}`,
        });
      }

      labelExpr = leftSide;
      const label = labelExpr.token.value;

      // Find the member with matching label
      const matchingMemberIndex = rhsElements.findIndex(
        (member) => member.label === label
      );

      if (matchingMemberIndex === -1) {
        throw formatErrorMessage({
          token: lhsElement.token,
          errorMessage: `Label "${label}" being destructured not found.`,
        });
      }

      elementIndex = matchingMemberIndex;
      rhsElement = rhsElements[elementIndex]!;

      // Get the nested value
      let nestedValue: Value | undefined = undefined;
      if (isTupleValue(rhsValue)) {
        nestedValue = rhsValue.elements[elementIndex];
      } else if (isStructValue(rhsValue)) {
        nestedValue = rhsValue.elements[elementIndex];
      } else if (isModuleValue(rhsValue)) {
        nestedValue = rhsValue.elements[elementIndex];
      } else if (isEnumValue(rhsValue)) {
        nestedValue = rhsValue.elements[elementIndex];
      }
      elementValue = nestedValue;

      // NOTE: Let's disable the nested destructuring for now
      if (exprIsAtom(rightSide) && isValidVariableName(rightSide)) {
        renameExpr = rightSide;
        variableName = rightSide.token.value;
        variableToken = rightSide.token;
      }
      // Other patterns that don't match previous conditions
      else {
        throw formatErrorMessage({
          token: rightSide.token,
          errorMessage: `Nested destructuring is not supported:

  ${exprToString(rightSide)}`,
        });
      }

      if (destructuredRhsElements[rhsElement.label]) {
        throw formatErrorMessage({
          token: lhsElement.token,
          errorMessage: `Label "${label}" being destructured already exists.`,
        });
      } else {
        destructuredRhsElements[rhsElement.label] = {
          label: rhsElement.label,
          variableName: variableName,
          type: rhsElement.type,
        };
      }
    }

    // Handle nested struct/module destructuring pattern like:
    // - ((x, y), )
    // - (_(x, y) )
    else if (exprIsFunctionCall(lhsElement)) {
      // NOTE: Let's disable the nested destructuring for now
      throw formatErrorMessage({
        token: lhsElement.token,
        errorMessage: `Nested destructuring is not supported:
  
  ${exprToString(lhsElement)}`,
      });
    }

    // Handle positional destructuring
    else if (exprIsAtom(lhsElement) && isValidVariableName(lhsElement)) {
      if (isUnionType(rhsType)) {
        throw formatErrorMessage({
          token: lhsElement.token,
          errorMessage: `Cannot destructure union type with positional destructuring, got ${typeToString(
            rhsType
          )}`,
        });
      }

      if (destructuredRhsElements[rhsElement.label]) {
        throw formatErrorMessage({
          token: lhsElement.token,
          errorMessage: `Label "${rhsElement.label}" being destructured already exists.`,
        });
      } else {
        destructuredRhsElements[rhsElement.label] = {
          label: rhsElement.label,
          variableName: lhsElement.token.value,
          type: rhsElement.type,
        };
      }

      if (isTupleValue(rhsValue)) {
        elementValue = rhsValue.elements[elementIndex];
      } else if (isStructValue(rhsValue)) {
        elementValue = rhsValue.elements[elementIndex];
      } else if (isEnumValue(rhsValue)) {
        elementValue = rhsValue.elements[elementIndex];
      } else if (isModuleValue(rhsValue)) {
        elementValue = rhsValue.elements[elementIndex];
      }

      variableName = lhsElement.token.value;
      variableToken = lhsElement.token;
    }

    // Throw error
    else {
      throw formatErrorMessage({
        token: lhsElement.token,
        errorMessage: `Unsupported destructuring pattern for: ${exprToString(lhsElement)}`,
      });
    }

    // After determining variableName and variableToken, add to environment
    if (variableName && variableToken) {
      // Add the variable to the environment
      // console.log("(4) addVariableToEnv");

      if (!elementValue && isCompileTimeOnly) {
        throw formatErrorMessage({
          token: lhsElement.token,
          errorMessage: `Destructuring element "${variableName}" is not defined in compile-time only context.`,
        });
      }

      if (
        typeContainsReference(rhsElement.type) &&
        !isDestructuringAtomVariable
      ) {
        throw formatErrorMessage({
          token: lhsElement.token,
          errorMessage: `Cannot destructure element "${rhsElement.label}" of type ${typeToString(
            rhsElement.type
          )} with references.`,
        });
      }

      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: variableName,
          type: rhsElement.type,
          isMutable: false,
          isImplicit: false,
          isCompileTimeOnly: isCompileTimeOnly,
          value: elementValue,
          token: variableToken,
          initializedAtToken: variableToken,
          consumedAtToken: undefined, // Not consumed yet
          isCreatedFromDestructuringAtomVariable: isDestructuringAtomVariable,
        },
      });

      env = nextEnv;

      // Set the type and value on the lhs element for completeness
      lhsElement.$ = {
        env,
        type: rhsElement.type,
        value: elementValue,
        isMutable: false,
        pathCollection: [],
      };

      if (labelExpr) {
        labelExpr.$ = {
          env,
          type: rhsElement.type,
          value: elementValue, // !renameExpr ? elementValue : undefined,
          isMutable: false,
          pathCollection: [],
        };
      }

      if (renameExpr) {
        renameExpr.$ = {
          env,
          type: rhsElement.type,
          value: elementValue,
          isMutable: false,
          pathCollection: [],
        };
      }
    }
  }

  // Iterate the rhsElements to check if there is any
  // "Linear" value that is not destructured
  for (const rhsElement of rhsElements) {
    if (!destructuredRhsElements[rhsElement.label]) {
      if (isLinearOrType0Type(typeOfType(rhsElement.type))) {
        // If it's a linear type, we should throw an error
        throw formatErrorMessage({
          token: lhs.token,
          errorMessage: `Linear value ${rhsElement.label ? `"${rhsElement.label}" ` : ""}of type ${typeToString(
            rhsElement.type
          )} is not destructured.`,
        });
      }
    }
  }

  // Generate runtimeDestructurings
  const runtimeDestructurings: RuntimeDestructuring[] = [];
  for (const label in destructuredRhsElements) {
    const element = destructuredRhsElements[label]!;
    runtimeDestructurings.push({
      label: element.label,
      type: element.type,
      variableName: element.variableName,
    });
  }

  return { env, runtimeDestructurings };
}

/**
 * rhs should be already evaluated
 */
export function evaluateDestructuringAssignment({
  lhs,
  rhs,
  env,
  isCompileTimeOnly,
  context,
}: {
  lhs: Expr;
  rhs: Expr;
  env: Environment;
  isCompileTimeOnly: boolean;
  context: EvaluatorContext;
}): { env: Environment; runtimeDestructurings: RuntimeDestructuring[] } {
  if (!rhs.$?.type) {
    throw formatErrorMessage({
      token: rhs.token,
      errorMessage: `(1) Expected type for right-hand side, got ${exprToString(rhs)}`,
    });
  }
  const rhsType = rhs.$.type;
  const rhsValue = rhs.$.value;

  // Handle struct destructuring
  if (
    (isStructType(rhsType) || isUnionType(rhsType) || isModuleType(rhsType)) &&
    exprIsFunctionCall(lhs)
  ) {
    return handleMemberDestructuring({
      lhsFunc: lhs.func,
      lhsElements: lhs.args,
      rhsElements: rhsType.elements,
      rhsValue: rhsValue,
      rhsType: rhsType,
      lhs,
      env,
      context: { ...context },
      isCompileTimeOnly,
      isDestructuringAtomVariable: exprIsAtom(rhs),
    });
  }
  // Handle tuple destructuring
  else if (
    isTupleType(rhsType) &&
    exprIsFunctionCall(lhs) &&
    exprIsFunctionCallOf(lhs, BuiltinKeywords.tuple)
  ) {
    return handleMemberDestructuring({
      lhsFunc: lhs.func,
      lhsElements: lhs.args,
      rhsElements: rhsType.elements,
      rhsValue: rhsValue,
      rhsType: rhsType,
      lhs,
      env,
      context: { ...context },
      isCompileTimeOnly,
      isDestructuringAtomVariable: exprIsAtom(rhs),
    });
  }
  // Handle enum variant destructuring
  else if (isEnumType(rhsType) && exprIsFunctionCall(lhs)) {
    const selectedVariantName = rhsType.selectedVariantName;
    if (!selectedVariantName) {
      throw formatErrorMessage({
        token: rhs.token,
        errorMessage: `Expected enum variant name to be determined, got ${typeToString(rhsType)}`,
      });
    }

    const selectedVariant = rhsType.variants.find(
      (variant) => variant.name === selectedVariantName
    );
    if (!selectedVariant) {
      throw formatErrorMessage({
        token: rhs.token,
        errorMessage: `Expected enum variant "${selectedVariantName}" to be defined, got ${typeToString(rhsType)}`,
      });
    }
    if (!selectedVariant.elements) {
      throw formatErrorMessage({
        token: rhs.token,
        errorMessage: `Cannot destructure enum variant "${selectedVariantName}" without elements, got ${typeToString(rhsType)}`,
      });
    }

    return handleMemberDestructuring({
      lhsFunc: lhs.func,
      lhsElements: lhs.args,
      rhsElements: selectedVariant.elements,
      rhsValue: rhsValue,
      rhsType: rhsType,
      lhs,
      env,
      context: { ...context },
      isCompileTimeOnly,
      isDestructuringAtomVariable: exprIsAtom(rhs),
    });
  }

  // Error:
  if (
    !(
      isTupleType(rhsType) ||
      isStructType(rhsType) ||
      isUnionType(rhsType) ||
      isModuleType(rhsType)
    )
  ) {
    throw formatErrorMessage({
      token: rhs.token,
      errorMessage: `Destructuring assignment not supported for the right-hand type:

  ${typeToString(rhsType)}`,
    });
  } else {
    throw formatErrorMessage({
      token: lhs.token,
      errorMessage: `Destructuring assignment not supported for the left-hand pattern:
  
      ${exprToString(lhs)}`,
    });
  }
}
