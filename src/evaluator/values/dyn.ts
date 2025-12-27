import {
  addVariableToEnv,
  Environment,
  getVariablesFromEnv,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  AtomExpr,
  attachTempVariableToExpr,
  BuiltinKeywords,
  expectExprToBeFunctionCallOf,
  Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  FuncCallExpr,
  setExprAsNeedsToCallDup,
} from "../../expr";
import { PlaceholderToken, TokenType } from "../../token";
import {
  areTypesCompatible,
  createDynType,
  createSomeType,
  createType0,
  DynType,
  isBoxedType,
  isDynType,
  isFunctionType,
  isObjectType,
  isSomeType,
  ModuleType,
  SomeType,
  StructType,
  Type,
  typeImplementsFuture,
  typeToString,
} from "../../types";
import {
  flattenNegativeModules,
  flattenRequiredModules,
} from "../../types/utils";
import {
  createModuleValue,
  createTypeValue,
  isFunctionValue,
  isModuleValue,
  isTypeValue,
  ModuleValue,
  Value,
} from "../../value";
import { evaluateComptFunctionCall } from "../calls/compt_function";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { addARCFunctionsToDynType } from "../types/utils";

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
    (v) => v.value && isFunctionValue(v.value) && isFunctionType(v.type)
  );

  if (
    !boxVariable ||
    !boxVariable.value ||
    !isFunctionValue(boxVariable.value)
  ) {
    throw new Error(`Cannot find Box type constructor in environment`);
  }

  const boxFunctionValue = boxVariable.value;
  const boxFunctionType = boxFunctionValue.type;

  // Box :: (fn(compt(V) : Type) -> compt(Type))
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
      value: innerTypeValue,
      isOwningTheGcValue: false,
    },
  });

  // Call Box(innerType) to get Box(innerType) type
  const { value: boxTypeValue, callerEnv: nextEnv } = evaluateComptFunctionCall(
    {
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
    }
  );

  if (!isTypeValue(boxTypeValue) || !isObjectType(boxTypeValue.value)) {
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
    }) as FuncCallExpr;

    if (!evaluatedFuncExpr.$) {
      return false;
    }

    const funcValue = evaluatedFuncExpr.$.value;

    if (isFunctionValue(funcValue)) {
      // Check if the funcValue matches the `box` function in the env
      const boxVariables = getVariablesFromEnv(env, "box");
      const findBoxFunction = boxVariables.find(
        (v) => v.value && isFunctionValue(v.value) && v.value === funcValue
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
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinKeywords.dyn, 1);

  const valueExpr = expr.args[0]!;

  // Determine the expected type for the inner expression
  // If context expects DynType, convert it to SomeType for the inner expression
  let innerExpectedType = context.expectedType;
  let someType: SomeType | undefined;
  if (context.expectedType && isDynType(context.expectedType.type)) {
    const expectedDynType = context.expectedType.type;
    // Create a SomeType from the DynType's requiredModules
    someType = createSomeType(
      createType0(),
      "",
      undefined,
      expectedDynType.requiredModules,
      expectedDynType.negativeModules
    );

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
  }) as FuncCallExpr;

  if (!evaluatedValueExpr.$) {
    throw formatErrorMessage({
      token: valueExpr.token,
      errorMessage: `Failed to evaluate the value expression for 'dyn':\n${exprToString(valueExpr)}`,
    });
  }

  let valueType = evaluatedValueExpr.$.type;
  let finalValueExpr: FuncCallExpr = evaluatedValueExpr;

  // Auto-box non-object types so users don't need to call box() explicitly
  if (
    !isObjectType(valueType) &&
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

    const boxCallExpr: FuncCallExpr = {
      tag: ExprTag.FuncCall,
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
    }) as FuncCallExpr;

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
  // Either a SomeType (Impl) with requiredModules, or a concrete type with a .module field
  /// if (!isSomeType(valueType) && !valueType.module) {
  ///   throw formatErrorMessage({
  ///     token: valueExpr.token,
  ///     errorMessage: `'${BuiltinKeywords.dyn}' expects a SomeType (Impl) value or a type with an associated module. Got: ${typeToString(valueType)}\n${exprToString(valueExpr)}`,
  ///   });
  /// }

  setExprAsNeedsToCallDup(finalValueExpr, context);
  env = finalValueExpr.$!.env!;

  const moduleTypes: ModuleType[] = [];
  const moduleValues: ModuleValue[] = [];
  const checkedModuleTypes = new Set<ModuleType>();

  // Determine the expected DynType
  // If the value is a SomeType (Impl), we can infer the DynType from its requiredModules
  // For concrete types with .module, we need an explicit expected DynType from context
  let expectedDynType: DynType;

  if (context.expectedType && isDynType(context.expectedType.type)) {
    // Explicit expected DynType from context
    expectedDynType = context.expectedType.type;
  }
  // Check if it's Box(T) case
  else if (isBoxedType(valueType)) {
    const boxedFieldType = valueType.fields[0]!.type;
    if (boxedFieldType.module) {
      const implementedModuleTypes: ModuleType[] = [];
      for (const field of boxedFieldType.module.fields) {
        if (field.assignedValue && isModuleValue(field.assignedValue)) {
          implementedModuleTypes.push(field.assignedValue.type);
        }
      }

      expectedDynType = createDynType(implementedModuleTypes, env, []);
      // Add ARC functions to the DynType
      env = addARCFunctionsToDynType({
        dynType: expectedDynType,
        env,
        context,
      });
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `'${BuiltinKeywords.dyn}' with Box(T) requires T to have a module. Got boxed type: ${typeToString(boxedFieldType)}`,
      });
    }
  } else if (valueType.module) {
    // For concrete types with .module, create DynType from the module
    const implementedModuleTypes: ModuleType[] = [];
    for (const field of valueType.module.fields) {
      if (field.assignedValue && isModuleValue(field.assignedValue)) {
        implementedModuleTypes.push(field.assignedValue.type);
      }
    }

    expectedDynType = createDynType(implementedModuleTypes, env, []);
    // Add ARC functions to the DynType
    env = addARCFunctionsToDynType({
      dynType: expectedDynType,
      env,
      context,
    });
  } else {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `'${BuiltinKeywords.dyn}' requires either an expected Dyn type context, a SomeType (Impl) value, or a type with a module. Got value type: ${typeToString(valueType)}`,
    });
  }

  // Check negativeModules - ensure required modules are not in the negative list
  const negativeModules: ModuleType[] = [];
  // Check if it's Box(T) case
  if (isBoxedType(valueType)) {
    const boxedFieldType = valueType.fields[0]!.type;
    if (isSomeType(boxedFieldType) || isDynType(boxedFieldType)) {
      const flatNegativeModules = flattenNegativeModules(boxedFieldType);
      if (flatNegativeModules) {
        negativeModules.push(...flatNegativeModules);
      }
    }
  }

  const flatRequiredModules = flattenRequiredModules(expectedDynType);
  for (const requiredModuleType of flatRequiredModules) {
    for (const negativeModule of negativeModules) {
      if (
        areTypesCompatible(
          { type: requiredModuleType, env },
          { type: negativeModule, env }
        )
      ) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Required module ${typeToString(requiredModuleType)} is in the negative modules list and cannot be used.`,
        });
      }
    }
  }

  // Find modules automatically for all required module types
  for (const requiredModuleType of flatRequiredModules) {
    if (checkedModuleTypes.has(requiredModuleType)) {
      continue;
    }

    // For Boxed SomeType values, check if the required module is in requiredModules
    if (
      isBoxedType(valueType) &&
      (isSomeType(valueType.fields[0]!.type) ||
        isDynType(valueType.fields[0]!.type))
    ) {
      const boxedFieldType = valueType.fields[0]!.type;
      let foundInSomeType = false;
      const someTypeModules = flattenRequiredModules(boxedFieldType);
      for (const someTypeModule of someTypeModules) {
        if (
          areTypesCompatible(
            { type: requiredModuleType, env },
            { type: someTypeModule, env }
          )
        ) {
          // Create a module value from the SomeType's required module
          const fields: (Value | undefined)[] = [];
          for (let i = 0; i < requiredModuleType.fields.length; i++) {
            const field = requiredModuleType.fields[i]!;
            const someTypeModuleFieldIndex = someTypeModule.fields.findIndex(
              (e) => e.label === field.label
            );
            if (someTypeModuleFieldIndex === -1) {
              fields.push(undefined);
            } else {
              fields.push(
                someTypeModule.fields[someTypeModuleFieldIndex]!.assignedValue
              );
            }
          }
          const moduleValue = createModuleValue(requiredModuleType, fields);

          moduleValues.push(moduleValue);
          moduleTypes.push(moduleValue.type);
          checkedModuleTypes.add(requiredModuleType);
          foundInSomeType = true;
          break;
        }
      }
      if (!foundInSomeType) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Required module ${typeToString(requiredModuleType)} not found in SomeType's requiredModules.`,
        });
      }
    }
    // Check if it's Boxed T with T.module
    else {
      const fieldType = isBoxedType(valueType)
        ? valueType.fields[0]!.type
        : valueType;

      if (fieldType.module) {
        let foundInModule = false;
        for (const field of fieldType.module.fields) {
          if (field.assignedValue && isModuleValue(field.assignedValue)) {
            // For concrete types, check if the module matches
            if (
              areTypesCompatible(
                { type: requiredModuleType, env },
                { type: field.assignedValue.type, env }
              )
            ) {
              moduleValues.push(field.assignedValue);
              moduleTypes.push(field.assignedValue.type);
              checkedModuleTypes.add(requiredModuleType);

              foundInModule = true;
              break;
            }
          }
        }

        if (!foundInModule) {
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `Required module ${typeToString(requiredModuleType)} is not implemented by type ${typeToString(valueType)}.`,
          });
        }
      }
      // QUESTION: Should we allow to assign DynType to another DynType with superset of modules?
      else {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Cannot find module ${typeToString(requiredModuleType)} for value type ${typeToString(valueType)}.`,
        });
      }
    }
  }

  // Reorder moduleValues to match the order of expectedDynType.requiredModules
  // This ensures the constructor parameters match the vtable order
  const orderedModuleValues: ModuleValue[] = [];
  for (const expectedModuleType of flatRequiredModules) {
    // Find the corresponding module value
    const moduleValueIndex = moduleTypes.findIndex((moduleType) =>
      areTypesCompatible(
        { type: expectedModuleType, env },
        { type: moduleType, env }
      )
    );

    if (moduleValueIndex === -1) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `No module value found for expected module type ${typeToString(expectedModuleType)}.`,
      });
    }

    orderedModuleValues.push(moduleValues[moduleValueIndex]!);
  }

  // Create a runtime object that implements dynamic dispatch
  // This will be a special runtime construct that holds the value and the modules
  // At runtime, property access on this object will dispatch to the appropriate module functions

  expr.$ = {
    env,
    value: undefined, // This indicates it's a runtime value
    type: expectedDynType,
    pathCollection: evaluatedValueExpr.$.pathCollection,
    dynCallModuleValues: orderedModuleValues, // Store ordered module values for C codegen
  };

  // Attach temp variable to the expr
  attachTempVariableToExpr(expr, true);

  return expr;
}
