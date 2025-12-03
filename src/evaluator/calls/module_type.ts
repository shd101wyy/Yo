import { Environment, pushEnvFrame } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  cloneExpr,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
} from "../../expr";
import {
  areTypesCompatible,
  ModuleType,
  Type,
  typeToString,
} from "../../types";
import {
  createModuleValue,
  isFunctionValue,
  isTypeValue,
  Value,
  valueToString,
} from "../../value";
import { EvaluatorContext, ModuleTypeCallResult } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function tryToImplementModuleWithArgumentsByModuleType({
  moduleExpr,
  moduleType,
  argExprs,
  callerEnv,
  context,
}: {
  moduleExpr: Expr;
  moduleType: ModuleType;
  argExprs: Expr[];
  callerEnv: Environment;
  context: EvaluatorContext;
}): ModuleTypeCallResult {
  if (argExprs.length > moduleType.fields.length) {
    throw formatErrorMessage({
      token: moduleExpr.token,
      errorMessage: `Failed to implement the module. Too many fields provided.`,
    });
  }

  const fields: (Value | undefined)[] = Array(moduleType.fields.length).fill(
    undefined
  );

  // Create a working module type that we'll progressively update with concrete values
  // This allows Self.X references to resolve to concrete types as we bind values
  const workingModuleType: ModuleType = {
    ...moduleType,
    fields: moduleType.fields.map((field, idx) => ({
      ...field,
      assignedValue: fields[idx],
    })),
  };

  const receiverType = context.ReceiverType;
  const selfType = context.ReceiverType ?? workingModuleType;

  if (!receiverType) {
    throw formatErrorMessage({
      token: moduleExpr.token,
      errorMessage: `Receiver type is undefined when implementing module.
Please consider using "impl" to specify the receiver type explicitly, like:

// impl receiverType, moduleImplementation
impl Point, Id(Point)(
  id : ((p) -> p)
);
`,
    });
  }
  const receiverTypeOriginalModule: ModuleType | undefined =
    receiverType.module;

  // Extend the receiverType module
  if (!receiverType.module) {
    receiverType.module = workingModuleType;
  } else {
    receiverType.module = {
      ...receiverType.module,
      fields: [...workingModuleType.fields, ...receiverType.module.fields],
    };
  }

  for (let i = 0; i < moduleType.fields.length; i++) {
    const moduleField = moduleType.fields[i]!;
    let foundArgExpr = false;
    let label: string | undefined = undefined;
    // Traverse over argExprs to see if there is label for the member
    for (let j = 0; j < argExprs.length; j++) {
      let argExpr = argExprs[j]!;

      // Check if it's a label
      let labelExpr: Expr | undefined;
      if (
        exprIsFunctionCall(argExpr) &&
        exprIsFunctionCallOf(argExpr, ":", 2)
      ) {
        labelExpr = argExpr.args[0]!;
        argExpr = argExpr.args[1]!;

        if (!exprIsAtom(labelExpr)) {
          throw formatErrorMessage({
            token: labelExpr.token,
            errorMessage: `Expected identifier for label, got:\n${exprToString(labelExpr)}`,
          });
        }
        label = labelExpr.token.value;
      } else {
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Expected member label, but got:\n${exprToString(argExpr)}`,
        });
      }

      // Check if label exists in the module type
      if (!moduleType.fields.find((e) => e.label === label)) {
        throw formatErrorMessage({
          token: labelExpr.token,
          errorMessage: `Module member with label "${label}" does not exist in the module type.`,
        });
      }

      if (moduleField.label === label) {
        foundArgExpr = true;

        if (moduleField.assignedValue) {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Module member "${
              moduleField.label
            }" already has a assigned value:
${valueToString(moduleField.assignedValue)}`,
          });
        }

        // evaluate the module member type again.
        // Check evaluateFunctionParameterTypeAgain function
        // They should be similar
        let moduleFieldType: Type;
        const typeExpr = moduleField.exprs.typeExpr;
        const defaultValueExpr = moduleField.exprs.defaultValueExpr;
        if (typeExpr) {
          const evaluatedModuleMember = evaluateExpression({
            expr: cloneExpr(typeExpr),
            env: pushEnvFrame(
              moduleType.env,
              callerEnv.frames[callerEnv.frames.length - 1]
            ),
            context: {
              ...context,
              expectedType: undefined,
              ReceiverType: undefined,
              SelfType: selfType, // Use working module with progressively bound values
            },
          });
          const evaluatedModuleMemberTypeValue = evaluatedModuleMember.$?.value;
          if (!isTypeValue(evaluatedModuleMemberTypeValue)) {
            throw formatErrorMessage({
              token: argExpr.token,
              errorMessage: `Failed to evaluate the module member "${label}"`,
            });
          }
          moduleFieldType = evaluatedModuleMemberTypeValue.value;
        } else if (defaultValueExpr) {
          const evaluatedValueExpr = evaluateExpression({
            expr: cloneExpr(defaultValueExpr),
            env: pushEnvFrame(
              moduleType.env,
              callerEnv.frames[callerEnv.frames.length - 1]
            ),
            context: {
              ...context,
              expectedType: undefined,
              ReceiverType: undefined,
              SelfType: selfType, // Use working module with progressively bound values
            },
          });
          const value = evaluatedValueExpr.$?.value;
          if (!value) {
            throw formatErrorMessage({
              token: argExpr.token,
              errorMessage: `Failed to evaluate the module member "${label}"`,
            });
          }
          moduleFieldType = value.type;
        } else {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Module member "${label}" has no type or default value or assigned value.`,
          });
        }

        // evaluate the argExpr
        const evaluatedArgExpr = evaluateExpression({
          expr: argExpr,
          env: callerEnv,
          context: {
            ...context,
            expectedType: { type: moduleFieldType, env: callerEnv },
            ReceiverType: undefined,
            SelfType: selfType,
          },
        });
        const argType = evaluatedArgExpr.$?.type;
        if (!argType) {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Failed to evaluate the module member "${label}"`,
          });
        }
        if (evaluatedArgExpr.$?.env) {
          callerEnv = evaluatedArgExpr.$.env;
        }

        // Compare the types
        if (
          !areTypesCompatible(
            { type: moduleFieldType, env: callerEnv },
            { type: argType, env: callerEnv }
          )
        ) {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Type mismatch for the module member "${label}":
Expected: ${typeToString(moduleFieldType)}
Got:   ${typeToString(argType)}`,
          });
        }
        const argValue = evaluatedArgExpr.$?.value;

        if (isFunctionValue(argValue)) {
          argValue.funcId += `_${moduleField.label}`;
          // If the function value's type contains SomeType but moduleFieldType doesn't,
          // set the specializedType to the resolved moduleFieldType
          // This ensures that generic functions in modules get their types specialized
          // when the module is instantiated with concrete type arguments
          if (!argValue.specializedType && moduleFieldType.tag === "Function") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            argValue.specializedType = moduleFieldType as any;
          }
        }

        // Save the value to the members
        fields[i] = argValue;

        // Update the working module type with the newly bound value
        // This allows subsequent Self.X references to resolve to this concrete value
        workingModuleType.fields[i]!.assignedValue = argValue;

        if (receiverType && receiverType.module) {
          // Add the field to the ReceiverType.module as well
          receiverType.module.fields[i]!.assignedValue = argValue;
        }

        // Add the type information to argExpr
        argExpr.$ = {
          env: callerEnv,
          type: argType,
          value: argValue,
          pathCollection: [],
        };
        if (labelExpr) {
          labelExpr.$ = argExpr.$;
        }
        break;
      }
    }

    if (!foundArgExpr) {
      const defaultValue = moduleField.defaultValue;
      const assignedValue = moduleField.assignedValue;

      // Re-evaluate default value in the current context if it exists
      let resolvedValue: Value | undefined = assignedValue;
      if (!assignedValue && defaultValue) {
        resolvedValue = defaultValue;
      }

      if (!resolvedValue) {
        // Check if moduleMember has default or required value
        throw formatErrorMessage({
          token: moduleExpr.token,
          errorMessage: `Module member "${moduleField.label}" is not provided and has no required/default value.`,
        });
      }

      fields[i] = resolvedValue;

      // Update the working module type
      workingModuleType.fields[i]!.assignedValue = resolvedValue;
    }
  }

  // Restore the receiverTypeOriginalModule
  if (receiverType && receiverTypeOriginalModule) {
    receiverType.module = receiverTypeOriginalModule;
  }

  // Create the module value
  const moduleValue = createModuleValue(
    { ...moduleType, receiverType },
    fields
  );
  return { moduleValue, callerEnv };
}
