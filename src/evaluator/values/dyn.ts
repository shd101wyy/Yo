import {
  addVariableToEnv,
  type Environment,
  getVariablesFromEnv,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  type AtomExpr,
  attachTempVariableToExpr,
  BuiltinKeywords,
  expectExprToBeFunctionCallOf,
  type Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  type FnCallExpr,
  setExprAsNeedsToCallDup,
} from "../../expr";
import type { FunctionValue } from "../../function-value";
import { PlaceholderToken, TokenType } from "../../token";
import { areTypesCompatible } from "../../types/compatibility";
import {
  createDynType,
  createSomeType,
  createType0,
} from "../../types/creators";
import type {
  DynType,
  SomeType,
  StructType,
  TraitType,
  Type,
} from "../../types/definitions";
import {
  isBoxedType,
  isDynType,
  isFunctionType,
  isReferenceStructType,
  isSomeType,
} from "../../types/guards";
import { typeToString } from "../../types/utils";
import {
  createTraitValue,
  createTypeValue,
  isFunctionValue,
  isTraitValue,
  isTypeValue,
  type TraitValue,
  type Value,
} from "../../value";
import { evaluateComptimeFunctionCall } from "../calls/comptime-fn";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { typeImplementsFuture } from "../trait-checking";
import { addRcFunctionsToDynType } from "../types/utils";

/**
 * Helper function to construct Box(T) type by calling the compile-time Box function.
 */
function createBoxedType(
  innerType: Type,
  env: Environment,
  context: EvaluatorContext
): { boxType: StructType; env: Environment } {
  // Look up the Box type constructor from environment
  const boxVariables = getVariablesFromEnv(env, "Box");
  const boxVariable = boxVariables.find(
    (v) => v.value && isFunctionValue(v.value[0]) && isFunctionType(v.type)
  );

  if (
    !boxVariable ||
    !boxVariable.value ||
    !isFunctionValue(boxVariable.value[0])
  ) {
    throw new Error(`Cannot find Box type constructor in environment`);
  }

  const boxFunctionValue = boxVariable.value[0] as FunctionValue;
  const boxFunctionType = boxFunctionValue.type;

  // Box :: (fn(comptime(V) : Type) -> comptime(Type))
  // We need to create a calleeEnv with the parameter V added
  const parameter = boxFunctionType.parameters[0]!;
  const innerTypeValue = createTypeValue(innerType);

  // Push new frame on top of the function's environment
  const calleeEnv = pushEnvFrame(boxFunctionType.env);

  // Add parameter V to calleeEnv
  const { env: calleeEnvWithParam } = addVariableToEnv({
    env: calleeEnv,
    variable: {
      name: parameter.label,
      token: PlaceholderToken,
      type: innerTypeValue.type,
      isCompileTimeOnly: true,
      initializedAtToken: PlaceholderToken,
      consumedAtToken: undefined,
      value: [innerTypeValue],
      isOwningTheRcValue: false,
    },
  });

  // Call Box(innerType) to get Box(innerType) type
  const { value: boxTypeValue, callerEnv: nextEnv } =
    evaluateComptimeFunctionCall({
      functionCalleeExpr: undefined,
      functionType: boxFunctionType,
      functionValue: boxFunctionValue,
      argValues: {
        forallArgs: [],
        args: [
          {
            value: innerTypeValue,
            parameterType: parameter.type,
            argType: createType0(),
          },
        ],
        variadicArgs: [],
      },
      callerEnv: env,
      calleeEnv: calleeEnvWithParam,
      context,
    });

  if (!isTypeValue(boxTypeValue) || !isReferenceStructType(boxTypeValue.value)) {
    throw new Error(`Box type constructor did not return a type value`);
  }

  return {
    boxType: boxTypeValue.value,
    env: nextEnv,
  };
}

function isBoxFunctionCall(
  funcExpr: Expr,
  env: Environment,
  context: EvaluatorContext
): boolean {
  try {
    // Evaluate the function expression to get its value
    const evaluatedFuncExpr = evaluateExpression({
      expr: funcExpr,
      env,
      context,
    }) as FnCallExpr;

    if (!evaluatedFuncExpr.$) {
      return false;
    }

    const funcValue = evaluatedFuncExpr.$.value;

    if (isFunctionValue(funcValue)) {
      // Check if the funcValue matches the `box` function in the env
      const boxVariables = getVariablesFromEnv(env, "box");
      const findBoxFunction = boxVariables.find(
        (v) =>
          v.value && isFunctionValue(v.value[0]) && v.value[0] === funcValue
      );
      return Boolean(findBoxFunction);
    } else if (isTypeValue(funcValue)) {
      const typeValue = funcValue;
      const type = typeValue.value;
      return Boolean(type?.typeName?.startsWith("Box("));
    } else {
      return false;
    }
  } catch (error) {
    return false;
  }
}

export function evaluateDynValue({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinKeywords.dyn, 1);

  const valueExpr = expr.args[0]!;

  // Determine the expected type for the inner expression
  // If context expects DynType, convert it to SomeType for the inner expression
  let innerExpectedType = context.expectedType;
  let someType: SomeType | undefined;
  if (context.expectedType && isDynType(context.expectedType.type)) {
    const expectedDynType = context.expectedType.type;
    // Create a SomeType from the DynType's requiredTraits
    someType = createSomeType(createType0(), "", {
      requiredTraits: expectedDynType.requiredTraits.map(
        (entry) => entry.traitType
      ),
      negativeTraits: expectedDynType.negativeTraits.map(
        (entry) => entry.traitType
      ),
      env,
      context,
    });

    // Special handling for dyn(box(...)) pattern:
    // For dyn(box(closure)), we need Box(Impl(A)) as the expected type
    if (
      exprIsFunctionCall(valueExpr) &&
      isBoxFunctionCall(valueExpr.func, env, { ...context }) && // Check if it's `box` or `Box(T)` call
      exprIsFunctionCallOf(valueExpr.args[0]!, "=>") // anonymous closure
    ) {
      // Construct Box(Impl(A)) type
      const { boxType, env: nextEnv } = createBoxedType(someType, env, context);
      env = nextEnv;

      // Pass Box(Impl(A)) as expected type for box(...)
      innerExpectedType = { type: boxType, env };
    } else {
      innerExpectedType = { type: someType, env: context.expectedType.env };
    }
  } else {
    innerExpectedType = undefined;
  }

  // Evaluate the value expression
  const evaluatedValueExpr = evaluateExpression({
    expr: valueExpr,
    env,
    context: {
      ...context,
      expectedType: innerExpectedType,
    },
  }) as FnCallExpr;

  if (!evaluatedValueExpr.$) {
    throw formatErrorMessage({
      token: valueExpr.token,
      errorMessage: `Failed to evaluate the value expression for 'dyn':\n${exprToString(valueExpr)}`,
    });
  }

  const originalValueType = evaluatedValueExpr.$.type;
  let valueType: Type = originalValueType;
  let finalValueExpr: FnCallExpr = evaluatedValueExpr;

  // Auto-box non-object types so users don't need to call box() explicitly
  if (
    !isReferenceStructType(valueType) &&
    !(isSomeType(valueType) && typeImplementsFuture(valueType))
  ) {
    // Create boxed type
    const { boxType, env: nextEnv } = createBoxedType(valueType, env, {
      ...context,
    });
    env = nextEnv;

    // Create a synthetic box(evaluatedValueExpr) expression
    const boxAtom: AtomExpr = {
      tag: ExprTag.Atom,
      token: {
        ...valueExpr.token,
        value: "box",
        type: TokenType.Identifier,
      },
      $: undefined,
    };

    const boxCallExpr: FnCallExpr = {
      tag: ExprTag.FnCall,
      func: boxAtom,
      args: [evaluatedValueExpr],
      token: valueExpr.token,
      $: undefined,
    };

    // Evaluate the box call
    const boxedExpr = evaluateExpression({
      expr: boxCallExpr,
      env,
      context: {
        ...context,
        expectedType: {
          type: boxType,
          env,
        },
      },
    }) as FnCallExpr;

    if (!boxedExpr.$) {
      throw formatErrorMessage({
        token: valueExpr.token,
        errorMessage: `Failed to auto-box value for 'dyn':\n${exprToString(valueExpr)}`,
      });
    }

    env = boxedExpr.$.env;
    valueType = boxedExpr.$.type;
    finalValueExpr = boxedExpr;

    // Update the original dyn expression's args to point to the boxed expression
    // This is important for C codegen to generate the correct code
    expr.args[0] = boxedExpr;
  } else {
    // NOTE: We don't set `env` in the `if` block above because we will re-evaluate them in `box`. Updating the `env` there will cause issues.
    env = evaluatedValueExpr.$.env;
  }

  // Validate that the value type can be converted to Dyn
  // Either a SomeType (Impl) with requiredTraits, or a concrete type with a .trait field
  /// if (!isSomeType(valueType) && !valueType.trait) {
  ///   throw formatErrorMessage({
  ///     token: valueExpr.token,
  ///     errorMessage: `'${BuiltinKeywords.dyn}' expects a SomeType (Impl) value or a type with an associated trait. Got: ${typeToString(valueType)}\n${exprToString(valueExpr)}`,
  ///   });
  /// }

  setExprAsNeedsToCallDup(finalValueExpr, context);
  env = finalValueExpr.$!.env!;

  const traitTypes: TraitType[] = [];
  const traitValues: TraitValue[] = [];
  const checkedTraitTypes = new Set<TraitType>();

  // Determine the expected DynType
  // If the value is a SomeType (Impl), we can infer the DynType from its requiredTraits
  // For concrete types with .trait, we need an explicit expected DynType from context
  let expectedDynType: DynType;

  if (context.expectedType && isDynType(context.expectedType.type)) {
    // Explicit expected DynType from context
    expectedDynType = context.expectedType.type;
  }
  // Check if it's Box(T) case
  else if (isBoxedType(valueType)) {
    const boxedFieldType = valueType.fields[0]!.type;
    if (boxedFieldType.trait) {
      const implementedTraitTypes: TraitType[] = [];
      for (const field of boxedFieldType.trait.fields) {
        if (field.assignedValue && isTraitValue(field.assignedValue)) {
          implementedTraitTypes.push(field.assignedValue.type);
        }
      }

      expectedDynType = createDynType({
        requiredTraits: implementedTraitTypes,
        negativeTraits: [],
        env,
      });
      // Add ARC functions to the DynType
      env = addRcFunctionsToDynType({
        dynType: expectedDynType,
        env,
        context,
      });
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `'${BuiltinKeywords.dyn}' with Box(T) requires T to have a trait. Got boxed type: ${typeToString(boxedFieldType)}`,
      });
    }
  } else if (valueType.trait) {
    // For concrete types with .trait, create DynType from the trait
    const implementedTraitTypes: TraitType[] = [];
    for (const field of valueType.trait.fields) {
      if (field.assignedValue && isTraitValue(field.assignedValue)) {
        implementedTraitTypes.push(field.assignedValue.type);
      }
    }

    expectedDynType = createDynType({
      requiredTraits: implementedTraitTypes,
      negativeTraits: [],
      env,
    });
    // Add ARC functions to the DynType
    env = addRcFunctionsToDynType({
      dynType: expectedDynType,
      env,
      context,
    });
  } else {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `'${BuiltinKeywords.dyn}' requires either an expected Dyn type context, a SomeType (Impl) value, or a type with a trait. Got value type: ${typeToString(valueType)}`,
    });
  }

  // Check negativeTraits - ensure required traits are not in the negative list
  const negativeTraits: TraitType[] = [];
  // Check if it's Box(T) case
  if (isBoxedType(valueType)) {
    const boxedFieldType = valueType.fields[0]!.type;
    if (isSomeType(boxedFieldType) || isDynType(boxedFieldType)) {
      // SomeType has new format with frameLevel
      negativeTraits.push(
        ...(boxedFieldType.negativeTraits.map((e) => e.traitType) ?? [])
      );
    }
  }

  for (const {
    traitType: requiredTraitType,
  } of expectedDynType.requiredTraits) {
    for (const negativeTrait of negativeTraits) {
      if (
        areTypesCompatible(
          { type: requiredTraitType, env },
          { type: negativeTrait, env }
        )
      ) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Required trait ${typeToString(requiredTraitType)} is in the negative traits list and cannot be used.`,
        });
      }
    }
  }

  // Find traits automatically for all required trait types
  for (const {
    traitType: requiredTraitType,
  } of expectedDynType.requiredTraits) {
    if (checkedTraitTypes.has(requiredTraitType)) {
      continue;
    }

    // For Boxed SomeType values, check if the required trait is in requiredTraits
    if (
      isBoxedType(valueType) &&
      (isSomeType(valueType.fields[0]!.type) ||
        isDynType(valueType.fields[0]!.type))
    ) {
      const boxedFieldType = valueType.fields[0]!.type;
      let foundInSomeType = false;

      // If we have the original concrete type (before auto-boxing), try to use
      // its actual trait values first. These have properly specialized defaults
      // (e.g., source method from Error trait with Self resolved to String).
      const concreteType =
        isSomeType(boxedFieldType) && boxedFieldType.resolvedConcreteType
          ? boxedFieldType.resolvedConcreteType
          : originalValueType !== valueType
            ? originalValueType
            : undefined;

      if (concreteType?.trait) {
        for (const field of concreteType.trait.fields) {
          if (field.assignedValue && isTraitValue(field.assignedValue)) {
            if (
              areTypesCompatible(
                { type: requiredTraitType, env },
                { type: field.assignedValue.type, env }
              )
            ) {
              traitValues.push(field.assignedValue);
              traitTypes.push(field.assignedValue.type);
              checkedTraitTypes.add(requiredTraitType);
              foundInSomeType = true;
              break;
            }
          }
        }
      }

      if (!foundInSomeType) {
        // Extract TraitTypes from requiredTraits (handle both SomeType and DynType formats)
        const someTypeTraitTypes = boxedFieldType.requiredTraits.map(
          (e) => e.traitType
        );
        for (const someTypeTrait of someTypeTraitTypes) {
          if (
            areTypesCompatible(
              { type: requiredTraitType, env },
              { type: someTypeTrait, env }
            )
          ) {
            // Create a trait value from the SomeType's required trait
            const fields: (Value | undefined)[] = [];
            for (let i = 0; i < requiredTraitType.fields.length; i++) {
              const field = requiredTraitType.fields[i]!;
              const someTypeTraitFieldIndex = someTypeTrait.fields.findIndex(
                (e) => e.label === field.label
              );
              if (someTypeTraitFieldIndex === -1) {
                fields.push(undefined);
              } else {
                fields.push(
                  someTypeTrait.fields[someTypeTraitFieldIndex]!.assignedValue
                );
              }
            }
            const traitValue = createTraitValue(requiredTraitType, fields);

            traitValues.push(traitValue);
            traitTypes.push(traitValue.type);
            checkedTraitTypes.add(requiredTraitType);
            foundInSomeType = true;
            break;
          }
        }
        if (!foundInSomeType) {
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `Required trait ${typeToString(requiredTraitType)} not found in SomeType's requiredTraits.`,
          });
        }
      } // end if (!foundInSomeType)
    }
    // Check if it's Boxed T with T.trait
    else {
      const fieldType = isBoxedType(valueType)
        ? valueType.fields[0]!.type
        : valueType;

      if (fieldType.trait) {
        let foundInModule = false;
        for (const field of fieldType.trait.fields) {
          if (field.assignedValue && isTraitValue(field.assignedValue)) {
            // For concrete types, check if the trait matches
            if (
              areTypesCompatible(
                { type: requiredTraitType, env },
                { type: field.assignedValue.type, env }
              )
            ) {
              traitValues.push(field.assignedValue);
              traitTypes.push(field.assignedValue.type);
              checkedTraitTypes.add(requiredTraitType);

              foundInModule = true;
              break;
            }
          }
        }

        if (!foundInModule) {
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `Required trait ${typeToString(requiredTraitType)} is not implemented by type ${typeToString(valueType)}.`,
          });
        }
      }
      // QUESTION: Should we allow to assign DynType to another DynType with superset of traits?
      else {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Cannot find trait ${typeToString(requiredTraitType)} for value type ${typeToString(valueType)}.`,
        });
      }
    }
  }

  // Reorder traitValues to match the order of expectedDynType.requiredTraits
  // This ensures the constructor parameters match the vtable order
  const orderedTraitValues: TraitValue[] = [];
  for (const {
    traitType: expectedTraitType,
  } of expectedDynType.requiredTraits) {
    // Find the corresponding trait value
    const traitIndex = traitTypes.findIndex((givenTraitType) =>
      areTypesCompatible(
        { type: expectedTraitType, env },
        { type: givenTraitType, env }
      )
    );

    if (traitIndex === -1) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `No trait value found for expected trait type ${typeToString(expectedTraitType)}.`,
      });
    }

    orderedTraitValues.push(traitValues[traitIndex]!);
  }

  // Create a runtime object that implements dynamic dispatch
  // This will be a special runtime construct that holds the value and the traits
  // At runtime, property access on this object will dispatch to the appropriate trait functions

  expr.$ = {
    env,
    value: undefined, // This indicates it's a runtime value
    type: expectedDynType,
    pathCollection: evaluatedValueExpr.$.pathCollection,
    dynCallTraitValues: orderedTraitValues, // Store ordered trait values for C codegen
  };

  // Attach temp variable to the expr
  attachTempVariableToExpr(expr, true);

  return expr;
}
