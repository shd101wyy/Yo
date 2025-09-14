import { Environment, getVariablesFromEnvByFilter } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  expectExprToBeFunctionCallOf,
  Expr,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
  setExprAsNeedsToCallDup,
} from "../../expr";
import {
  areTypesCompatible,
  isDynType,
  isModuleType,
  isStructTypeWithReferenceSemantics,
  ModuleType,
  typeToString,
} from "../../types";
import {
  createModuleValue,
  isModuleValue,
  isTypeValue,
  ModuleValue,
  Value,
  valueToString,
} from "../../value";
import { EvaluatorContext } from "../context";

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

  if (expr.args.length < 1 || expr.args.length > 2) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `'${BuiltinKeywords.dyn}' expects 1 or 2 arguments, but got ${expr.args.length}.`,
    });
  }

  const valueExpr = expr.args[0]!;
  const moduleExpr = expr.args[1]; // Optional - can be undefined for automatic inference

  // Evaluate the value expression
  const evaluatedValueExpr = context.evaluateExpression({
    expr: valueExpr,
    env,
    context: {
      ...context,
      expectedType: undefined, // Don't constrain the value type yet
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

  // Validate that the value type uses reference semantics
  // if (!isARCType(valueType)) {
  //   throw formatErrorMessage({
  //     token: valueExpr.token,
  //     errorMessage: `'dyn' can only be used with types that support reference counting (ref struct, Dyn, or Closure types). Got: ${typeToString(valueType)}\n${exprToString(valueExpr)}`,
  //   });
  // }
  if (!isStructTypeWithReferenceSemantics(valueType)) {
    throw formatErrorMessage({
      token: valueExpr.token,
      errorMessage: `'${BuiltinKeywords.dyn}' can only be used with types that have reference semantics (ref struct types). Got: ${typeToString(valueType)}\n${exprToString(valueExpr)}`,
    });
  }

  setExprAsNeedsToCallDup(evaluatedValueExpr, context);

  const moduleTypes: ModuleType[] = [];
  const moduleValues: ModuleValue[] = [];

  // Process explicitly provided modules first (if any)
  if (moduleExpr) {
    // Check if it's a tuple of modules or a single module
    let moduleExprs: Expr[];
    if (exprIsFunctionCallOf(moduleExpr, BuiltinKeywords.tuple)) {
      // Tuple of modules: dyn(x, (M1, M2))
      moduleExprs = (moduleExpr as FuncCallExpr).args;
    } else {
      // Single module: dyn(x, M1)
      moduleExprs = [moduleExpr];
    }

    // Process each module expression
    for (const singleModuleExpr of moduleExprs) {
      const evaluatedModuleExpr = context.evaluateExpression({
        expr: singleModuleExpr,
        env,
        context: {
          ...context,
          expectedType: undefined,
        },
      });

      if (!evaluatedModuleExpr.$) {
        throw formatErrorMessage({
          token: singleModuleExpr.token,
          errorMessage: `Failed to evaluate the module expression for 'dyn':\n${exprToString(singleModuleExpr)}`,
        });
      }
      env = evaluatedModuleExpr.$.env;

      const moduleValue = evaluatedModuleExpr.$.value;

      // Must be a module value
      if (!isModuleValue(moduleValue)) {
        throw formatErrorMessage({
          token: singleModuleExpr.token,
          errorMessage: `Expected a module value for 'dyn', but got ${typeToString(moduleValue!.type)}.`,
        });
      }

      if (!isModuleType(moduleValue.type)) {
        throw formatErrorMessage({
          token: singleModuleExpr.token,
          errorMessage: `Expected a module type for 'dyn', but got ${typeToString(moduleValue.type)}.`,
        });
      }

      // Check if the module has a 'Self' type
      const selfElementIndex = moduleValue.type.elements.findIndex(
        (element) => element.label === "Self"
      );
      if (selfElementIndex === -1) {
        throw formatErrorMessage({
          token: singleModuleExpr.token,
          errorMessage: `Module for 'dyn' must have a 'Self' type.`,
        });
      }

      // Get the actual Self value from the module
      const selfValue = moduleValue.elements[selfElementIndex];
      if (!selfValue) {
        throw formatErrorMessage({
          token: singleModuleExpr.token,
          errorMessage: `Module's 'Self' element is missing a value.`,
        });
      }

      // The selfValue should be a TypeValue containing the actual type
      if (!isTypeValue(selfValue)) {
        throw formatErrorMessage({
          token: singleModuleExpr.token,
          errorMessage: `Module's 'Self' must be a type value.`,
        });
      }

      const selfType = selfValue.value;

      // Check if the value type is compatible with the module's Self type
      if (
        !areTypesCompatible({ type: selfType, env }, { type: valueType, env })
      ) {
        throw formatErrorMessage({
          token: valueExpr.token,
          errorMessage: `Value type ${typeToString(valueType)} is not compatible with module's Self type ${typeToString(selfType)}.`,
        });
      }

      moduleTypes.push(moduleValue.type);
      moduleValues.push(moduleValue);
    }
  }

  // Validate expected type
  if (!context.expectedType) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `'${BuiltinKeywords.dyn}' requires an expected type context.`,
    });
  }

  if (!isDynType(context.expectedType.type)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected type for '${BuiltinKeywords.dyn}' must be a Dyn type, but got ${typeToString(context.expectedType.type)}.`,
    });
  }

  const expectedDynType = context.expectedType.type;

  // Check which modules we still need (automatic inference for missing modules)
  const checkedModuleTypes = new Set<ModuleType>();

  // Mark already provided modules as checked
  for (const moduleType of moduleTypes) {
    let matched = false;

    for (const expectedModuleType of expectedDynType.moduleTypes) {
      if (checkedModuleTypes.has(expectedModuleType)) {
        continue;
      }

      if (
        areTypesCompatible(
          { type: expectedModuleType, env },
          { type: moduleType, env }
        )
      ) {
        checkedModuleTypes.add(expectedModuleType);
        matched = true;
        break;
      }
    }

    if (!matched) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Provided module type ${typeToString(moduleType)} is not compatible with any expected module type.`,
      });
    }
  }

  // Find missing modules automatically
  for (const requiredModuleType of expectedDynType.moduleTypes) {
    if (checkedModuleTypes.has(requiredModuleType)) {
      continue;
    }

    // Check if the evaluatedArgExpr's module type is compatible with the required module type
    if (
      areTypesCompatible(
        { type: requiredModuleType, env },
        { type: valueType.module, env }
      )
    ) {
      // Create the module value from the value type's module
      const elements: (Value | undefined)[] = [];
      for (let i = 0; i < requiredModuleType.elements.length; i++) {
        const element = requiredModuleType.elements[i]!;
        const valueTypeElementIndex = valueType.module.elements.findIndex(
          (e) => e.label === element.label
        );
        if (valueTypeElementIndex === -1) {
          elements.push(undefined);
        } else {
          elements.push(
            valueType.module.elements[valueTypeElementIndex]!.assignedValue
          );
        }
      }
      const moduleValue = createModuleValue(requiredModuleType, elements);

      // This module type is actually a value type, not a module type
      // So we can skip it
      moduleValues.push(moduleValue);
      moduleTypes.push(moduleValue.type);
      checkedModuleTypes.add(requiredModuleType);
      continue;
    }

    // Find implicit variables that match this module type
    const implicitVariables = getVariablesFromEnvByFilter(env, (variable) => {
      if (!variable.isImplicit) {
        return false;
      }

      // Check if it's a module value
      if (!isModuleValue(variable.value)) {
        return false;
      }

      const moduleValue = variable.value;
      if (!isModuleType(moduleValue.type)) {
        return false;
      }

      // Check if the module has a 'Self' type
      const selfElementIndex = moduleValue.type.elements.findIndex(
        (element) => element.label === "Self"
      );
      if (selfElementIndex === -1) {
        return false;
      }

      // Get the Self value from the module
      const selfValue = moduleValue.elements[selfElementIndex];
      if (!selfValue || !isTypeValue(selfValue)) {
        return false;
      }

      const selfType = selfValue.value;

      // Check if the value type is compatible with the module's Self type
      if (
        !areTypesCompatible({ type: selfType, env }, { type: valueType, env })
      ) {
        return false;
      }

      // Check if the module type is compatible with the required module type
      return areTypesCompatible(
        { type: requiredModuleType, env },
        { type: moduleValue.type, env }
      );
    });

    // Get the max frame level of the implicit variables
    // This is to ensure that we get the most recent implicit variable
    const maxImplicitVariableFrameLevel = Math.max(
      ...implicitVariables.map((variable) => variable.frameLevel)
    );
    const filteredImplicitVariables = implicitVariables.filter(
      (variable) => variable.frameLevel === maxImplicitVariableFrameLevel
    );

    if (filteredImplicitVariables.length === 0) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `No implicit module found for type ${typeToString(requiredModuleType)} with Self type compatible with ${typeToString(valueType)}.`,
      });
    }

    if (filteredImplicitVariables.length > 1) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Ambiguous implicit modules found for type ${typeToString(requiredModuleType)}:
${filteredImplicitVariables
  .map((variable) => `- ${variable.name} : ${typeToString(variable.type)}`)
  .join("\n")}`,
      });
    }

    const implicitVariable = filteredImplicitVariables[0]!;
    const implicitVariableModuleValue = implicitVariable.value as ModuleValue;
    // Create the module value from the implicit variable
    const elements: (Value | undefined)[] = [];
    for (let i = 0; i < requiredModuleType.elements.length; i++) {
      const element = requiredModuleType.elements[i]!;
      const moduleValueElementIndex =
        implicitVariableModuleValue.type.elements.findIndex(
          (e) => e.label === element.label
        );
      if (moduleValueElementIndex === -1) {
        elements.push(undefined);
      } else {
        elements.push(
          implicitVariableModuleValue.elements[moduleValueElementIndex]
        );
      }
    }
    const moduleValue = createModuleValue(requiredModuleType, elements);

    moduleValues.push(moduleValue);
    moduleTypes.push(moduleValue.type);
    checkedModuleTypes.add(requiredModuleType);
  }

  // Reorder moduleValues to match the order of expectedDynType.moduleTypes
  // This ensures the constructor parameters match the vtable order
  const orderedModuleValues: ModuleValue[] = [];
  for (const expectedModuleType of expectedDynType.moduleTypes) {
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

  orderedModuleValues.forEach((moduleValue) => {
    console.log(valueToString(moduleValue));
  });
  console.log("----");
  expectedDynType.moduleTypes.forEach((moduleType) => {
    console.log(typeToString(moduleType));
  });
  console.log("====");
  console.log("");

  // Create a runtime object that implements dynamic dispatch
  // This will be a special runtime construct that holds the value and the modules
  // At runtime, property access on this object will dispatch to the appropriate module functions

  expr.$ = {
    env,
    value: undefined, // This indicates it's a runtime value
    type: expectedDynType,
    isMutable: evaluatedValueExpr.$.isMutable,
    pathCollection: evaluatedValueExpr.$.pathCollection,
    dynCallModuleValues: orderedModuleValues, // Store ordered module values for C codegen
  };

  // Attach temp variable to the expr
  attachTempVariableToExpr(expr, true);

  return expr;
}
