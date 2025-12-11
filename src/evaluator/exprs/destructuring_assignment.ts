import { addVariableToEnv, Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  RuntimeDestructuring,
} from "../../expr";
import { Token } from "../../token";
import {
  isEnumType,
  isModuleType,
  isStructType,
  isTupleType,
  isUnionType,
  Type,
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
  lhsFields,
  rhsFields,
  rhsValue,
  rhsType,
  lhs,
  env,
  // context,
  isCompileTimeOnly,
  isDestructuringAtomVariable,
}: {
  lhsFunc: Expr;
  lhsFields: Expr[];
  rhsFields: { label: string; type: Type }[];
  rhsValue: Value | undefined;
  /**
   * The rhsType might be pointer or reference,
   * in this case, the rhsFields are the dereferenced fields.
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
    // Expect lhsFields to be a single field
    if (lhsFields.length !== 1) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Destructuring union type requires a single field, got ${lhsFields.length}`,
      });
    }
  }

  // Check if we have enough fields
  if (lhsFields.length > rhsFields.length) {
    throw formatErrorMessage({
      token: lhs.token,
      errorMessage: `Too many fields in destructuring pattern. Expected at most ${rhsFields.length}, got ${lhsFields.length}`,
    });
  }

  const destructuredRhsFields: Record<
    /**
     * key is the label
     */
    string,
    /**
     * the destructured field
     */
    RuntimeDestructuring
  > = {};
  // Process each lhs field
  for (let i = 0; i < lhsFields.length; i++) {
    const lhsField = lhsFields[i]!;
    let fieldIndex: number = i;
    let fieldValue: Value | undefined = undefined;
    // Initialize rhsField here, before any conditional branches
    let rhsField = rhsFields[fieldIndex]!;
    let variableName: string | undefined;
    let variableToken: Token | undefined;
    let labelExpr: Expr | undefined = undefined;
    let renameExpr: Expr | undefined = undefined;

    // Handle destructuring all fields with "..."
    // - (... : ...)
    // - ( ... )
    if (
      (exprIsFunctionCall(lhsField) &&
        exprIsFunctionCallOf(lhsField, ":", 2) &&
        lhsField.args[0]!.token.value === "..." &&
        lhsField.args[1]!.token.value === "...") ||
      (exprIsAtom(lhsField) && lhsField.token.value === "...")
    ) {
      if (isUnionType(rhsType)) {
        throw formatErrorMessage({
          token: lhsField.token,
          errorMessage: `Cannot destructure union type with _, got ${typeToString(rhsType)}`,
        });
      }

      // If it's a single ..., we destructure all fields
      // We can destructure all fields
      for (let j = 0; j < rhsFields.length; j++) {
        const field = rhsFields[j]!;

        if (destructuredRhsFields[field.label]) {
          continue; // Skip already destructured fields
        } else {
          destructuredRhsFields[field.label] = {
            label: field.label,
            variableName: field.label,
            type: field.type,
            isOwningTheValue: true,
          };
        }

        const fieldValue =
          isTupleValue(rhsValue) ||
          isStructValue(rhsValue) ||
          isModuleValue(rhsValue) ||
          isEnumValue(rhsValue)
            ? rhsValue.fields[j]
            : undefined;

        if (!fieldValue && isCompileTimeOnly) {
          throw formatErrorMessage({
            token: lhsField.token,
            errorMessage: `Destructuring field "${field.label}" is not defined in compile-time only context.`,
          });
        }

        // Add to environment
        // console.log("(2) addVariableToEnv");
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: field.label,
            value: fieldValue,
            type: field.type,
            isCompileTimeOnly,
            isOwningTheValue: true, // QUESTION: Should we set this to true here?
            token: lhsField.token,
            initializedAtToken: lhsField.token,
            consumedAtToken: undefined,
            isCreatedFromDestructuringAtomVariable: isDestructuringAtomVariable,
          },
        });
        env = nextEnv;
      }

      // Set the type and value of the lhsField
      lhsField.$ = {
        env,
        type: rhsType,
        value: rhsValue,
        pathCollection: [],
      };

      continue;
    }

    // Handle labeled destructuring pattern like:
    // - (c : x)
    // - (c : ref(x))
    // -  Nested destructuring is disallowed now
    // - ~~(c: (x, y))~~
    // - ~~(c: _(x, y))~~
    else if (
      exprIsFunctionCall(lhsField) &&
      exprIsFunctionCallOf(lhsField, ":", 2)
    ) {
      const leftSide = lhsField.args[0]!; // The label (c)
      let rightSide = lhsField.args[1]!; // Could be ref(x) or just x

      let isOwningTheValue = true;

      // Check if the right side is ref(x) - this means we want a reference
      if (
        exprIsFunctionCall(rightSide) &&
        exprIsFunctionCallOf(rightSide, BuiltinKeywords.ref, 1)
      ) {
        isOwningTheValue = false;
        rightSide = rightSide.args[0]!;
      }

      // The left side should be an identifier (the field label)
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
      const matchingMemberIndex = rhsFields.findIndex(
        (member) => member.label === label
      );

      if (matchingMemberIndex === -1) {
        throw formatErrorMessage({
          token: lhsField.token,
          errorMessage: `Label "${label}" being destructured not found.`,
        });
      }

      fieldIndex = matchingMemberIndex;
      rhsField = rhsFields[fieldIndex]!;

      // Get the nested value
      let nestedValue: Value | undefined = undefined;
      if (isTupleValue(rhsValue)) {
        nestedValue = rhsValue.fields[fieldIndex];
      } else if (isStructValue(rhsValue)) {
        nestedValue = rhsValue.fields[fieldIndex];
      } else if (isModuleValue(rhsValue)) {
        nestedValue = rhsValue.fields[fieldIndex];
      } else if (isEnumValue(rhsValue)) {
        nestedValue = rhsValue.fields[fieldIndex];
      }
      fieldValue = nestedValue;

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

      if (destructuredRhsFields[rhsField.label]) {
        throw formatErrorMessage({
          token: lhsField.token,
          errorMessage: `Label "${label}" being destructured already exists.`,
        });
      } else {
        destructuredRhsFields[rhsField.label] = {
          label: rhsField.label,
          variableName: variableName,
          type: rhsField.type,
          isOwningTheValue: isOwningTheValue,
        };
      }
    }

    // Handle positional destructuring
    // - (x)
    // - (ref(x))
    else if (
      exprIsAtom(lhsField) ||
      exprIsFunctionCallOf(lhsField, BuiltinKeywords.ref, 1)
    ) {
      let isOwningTheValue = true;
      let actualLhsField = lhsField;

      if (
        exprIsFunctionCall(lhsField) &&
        exprIsFunctionCallOf(lhsField, BuiltinKeywords.ref, 1)
      ) {
        isOwningTheValue = false;
        actualLhsField = lhsField.args[0]!;
      }

      // The lhsField should be an identifier
      if (!exprIsAtom(actualLhsField) || !isValidVariableName(actualLhsField)) {
        throw formatErrorMessage({
          token: actualLhsField.token,
          errorMessage: `Expected identifier for variable in destructuring pattern, got ${exprToString(
            actualLhsField
          )}`,
        });
      }

      if (isUnionType(rhsType)) {
        throw formatErrorMessage({
          token: actualLhsField.token,
          errorMessage: `Cannot destructure union type with positional destructuring, got ${typeToString(
            rhsType
          )}`,
        });
      }

      if (destructuredRhsFields[rhsField.label]) {
        throw formatErrorMessage({
          token: actualLhsField.token,
          errorMessage: `Label "${rhsField.label}" being destructured already exists.`,
        });
      } else {
        destructuredRhsFields[rhsField.label] = {
          label: rhsField.label,
          variableName: actualLhsField.token.value,
          type: rhsField.type,
          isOwningTheValue,
        };
      }

      if (isTupleValue(rhsValue)) {
        fieldValue = rhsValue.fields[fieldIndex];
      } else if (isStructValue(rhsValue)) {
        fieldValue = rhsValue.fields[fieldIndex];
      } else if (isEnumValue(rhsValue)) {
        fieldValue = rhsValue.fields[fieldIndex];
      } else if (isModuleValue(rhsValue)) {
        fieldValue = rhsValue.fields[fieldIndex];
      }

      variableName = actualLhsField.token.value;
      variableToken = actualLhsField.token;
    }

    // Throw error
    else {
      throw formatErrorMessage({
        token: lhsField.token,
        errorMessage: `Unsupported destructuring pattern for: ${exprToString(lhsField)}`,
      });
    }

    // After determining variableName and variableToken, add to environment
    if (variableName && variableToken) {
      // Add the variable to the environment
      // console.log("(4) addVariableToEnv");

      if (!fieldValue && isCompileTimeOnly) {
        throw formatErrorMessage({
          token: lhsField.token,
          errorMessage: `Destructuring field "${variableName}" is not defined in compile-time only context.`,
        });
      }

      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: variableName,
          type: rhsField.type,
          isCompileTimeOnly: isCompileTimeOnly,
          isOwningTheValue: false, // QUESTION: Should we set this to false here?
          value: fieldValue,
          token: variableToken,
          initializedAtToken: variableToken,
          consumedAtToken: undefined, // Not consumed yet
          isCreatedFromDestructuringAtomVariable: isDestructuringAtomVariable,
        },
      });

      env = nextEnv;

      // Set the type and value on the lhs field for completeness
      lhsField.$ = {
        env,
        type: rhsField.type,
        value: fieldValue,
        pathCollection: [],
      };

      if (labelExpr) {
        labelExpr.$ = {
          env,
          type: rhsField.type,
          value: fieldValue, // !renameExpr ? fieldValue : undefined,
          pathCollection: [],
        };
      }

      if (renameExpr) {
        renameExpr.$ = {
          env,
          type: rhsField.type,
          value: fieldValue,
          pathCollection: [],
        };
      }
    }
  }

  // Generate runtimeDestructurings
  const runtimeDestructurings: RuntimeDestructuring[] = [];
  for (const label in destructuredRhsFields) {
    const field = destructuredRhsFields[label]!;
    runtimeDestructurings.push({
      label: field.label,
      type: field.type,
      variableName: field.variableName,
      isOwningTheValue: field.isOwningTheValue,
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

  // Handle struct/union/module destructuring
  if (
    (isStructType(rhsType) || isUnionType(rhsType) || isModuleType(rhsType)) &&
    exprIsFunctionCall(lhs)
  ) {
    return handleMemberDestructuring({
      lhsFunc: lhs.func,
      lhsFields: lhs.args,
      rhsFields: rhsType.fields,
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
      lhsFields: lhs.args,
      rhsFields: rhsType.fields,
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
    if (!selectedVariant.fields) {
      throw formatErrorMessage({
        token: rhs.token,
        errorMessage: `Cannot destructure enum variant "${selectedVariantName}" without fields, got ${typeToString(rhsType)}`,
      });
    }

    return handleMemberDestructuring({
      lhsFunc: lhs.func,
      lhsFields: lhs.args,
      rhsFields: selectedVariant.fields,
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
