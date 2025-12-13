import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  expectExprToBeFunctionCallOf,
  exprToString,
  FuncCallExpr,
  setExprAsNeedsToCallDup,
} from "../../expr";
import {
  areTypesCompatible,
  createDynType,
  createSomeType,
  createType0,
  DynType,
  isDynType,
  isObjectType,
  isSomeType,
  ModuleType,
  Type,
  typeToString,
} from "../../types";
import {
  createModuleValue,
  isModuleValue,
  ModuleValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { addARCFunctionsToDynType } from "../types/utils";

function isBoxedType(type: Type): boolean {
  if (!isObjectType(type)) {
    return false;
  } else {
    // Check if it's the Box(T) where Box is from the prelude.yo
    return (
      type.fields.length === 1 &&
      type.fields[0]!.label === "*" &&
      !!type.typeName?.startsWith("Box(")
    );
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
  expectExprToBeFunctionCallOf(expr, BuiltinKeywords.dyn);

  if (expr.args.length !== 1) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `'${BuiltinKeywords.dyn}' expects exactly 1 argument, but got ${expr.args.length}.`,
    });
  }

  const valueExpr = expr.args[0]!;

  // Determine the expected type for the inner expression
  // If context expects DynType, convert it to SomeType for the inner expression
  let innerExpectedType = context.expectedType;
  if (context.expectedType && isDynType(context.expectedType.type)) {
    const expectedDynType = context.expectedType.type;
    // Create a SomeType from the DynType's requiredModules
    const someType = createSomeType(
      createType0(),
      "",
      undefined,
      expectedDynType.requiredModules,
      expectedDynType.negativeModules
    );
    innerExpectedType = { type: someType, env: context.expectedType.env };
  } else {
    innerExpectedType = undefined;
  }

  // Evaluate the value expression with SomeType expected type
  const evaluatedValueExpr = evaluateExpression({
    expr: valueExpr,
    env,
    context: {
      ...context,
      expectedType: innerExpectedType,
    },
  });

  if (!evaluatedValueExpr.$) {
    throw formatErrorMessage({
      token: valueExpr.token,
      errorMessage: `Failed to evaluate the value expression for 'dyn':\n${exprToString(valueExpr)}`,
    });
  }
  env = evaluatedValueExpr.$.env;

  const valueType = evaluatedValueExpr.$.type;

  if (!isObjectType(valueType)) {
    throw formatErrorMessage({
      token: valueExpr.token,
      errorMessage: `'${BuiltinKeywords.dyn}' expects an 'object' value. Got: ${typeToString(valueType)}\n${exprToString(valueExpr)}`,
    });
  }

  // Validate that the value type can be converted to Dyn
  // Either a SomeType (Impl) with requiredModules, or a concrete type with a .module field
  /// if (!isSomeType(valueType) && !valueType.module) {
  ///   throw formatErrorMessage({
  ///     token: valueExpr.token,
  ///     errorMessage: `'${BuiltinKeywords.dyn}' expects a SomeType (Impl) value or a type with an associated module. Got: ${typeToString(valueType)}\n${exprToString(valueExpr)}`,
  ///   });
  /// }

  setExprAsNeedsToCallDup(evaluatedValueExpr, context);
  env = evaluatedValueExpr.$!.env!;

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
  if (valueType.fields.length === 1 && valueType.fields[0]?.label === "*") {
    const boxedFieldType = valueType.fields[0]!.type;
    if (isSomeType(boxedFieldType) || isDynType(boxedFieldType)) {
      negativeModules.push(...(boxedFieldType.negativeModules ?? []));
    }
  }

  for (const requiredModuleType of expectedDynType.requiredModules) {
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
  for (const requiredModuleType of expectedDynType.requiredModules) {
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
      for (const someTypeModule of boxedFieldType.requiredModules) {
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
  for (const expectedModuleType of expectedDynType.requiredModules) {
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
