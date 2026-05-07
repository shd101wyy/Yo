import { type Environment, pushEnvFrame } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  cloneExpr,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
} from "../../expr";
import { areTypesCompatible } from "../../types/compatibility";
import type { FunctionType, ModuleType, Type } from "../../types/definitions";
import { isFunctionType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import {
  createStructValue,
  isFunctionValue,
  isTypeValue,
  type Value,
  valueToString,
} from "../../value";
import type { EvaluatorContext, RecordTypeCallResult } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function tryToImplementRecordWithArgumentsByRecordType({
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
}): RecordTypeCallResult {
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

      // Check if label exists in the record type
      if (!moduleType.fields.find((e) => e.label === label)) {
        throw formatErrorMessage({
          token: labelExpr.token,
          errorMessage: `Record member with label "${label}" does not exist in the record type.`,
        });
      }

      if (moduleField.label === label) {
        foundArgExpr = true;

        if (moduleField.assignedValue) {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Record member "${moduleField.label}" already has an assigned value:
${valueToString(moduleField.assignedValue)}`,
          });
        }

        // evaluate the record member type again.
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
              SelfType: undefined,
            },
          });
          const evaluatedModuleMemberTypeValue = evaluatedModuleMember.$?.value;
          if (!isTypeValue(evaluatedModuleMemberTypeValue)) {
            throw formatErrorMessage({
              token: argExpr.token,
              errorMessage: `Failed to evaluate the record member "${label}"`,
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
              SelfType: undefined,
            },
          });
          const value = evaluatedValueExpr.$?.value;
          if (!value) {
            throw formatErrorMessage({
              token: argExpr.token,
              errorMessage: `Failed to evaluate the record member "${label}"`,
            });
          }
          moduleFieldType = value.type;
        } else {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Record member "${label}" has no type or default value or assigned value.`,
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
            SelfType: undefined,
          },
        });
        const argType = evaluatedArgExpr.$?.type;
        if (!argType) {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Failed to evaluate the record member "${label}"`,
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
            errorMessage: `Type mismatch for the record member "${label}":
Expected: ${typeToString(moduleFieldType)}
Got:   ${typeToString(argType)}`,
          });
        }
        const argValue = evaluatedArgExpr.$?.value;

        // Propagate ioBuiltin from extern function types to module field types.
        // This ensures io.async/io.await can be detected even when aliased.
        if (argType.ioBuiltin) {
          moduleType.fields[i]!.type.ioBuiltin = argType.ioBuiltin;
        }

        if (isFunctionValue(argValue)) {
          argValue.funcId += `_${moduleField.label}`;
          // If the function value's type contains SomeType but moduleFieldType doesn't,
          // set the specializedType to the resolved moduleFieldType
          // This ensures that generic functions in modules get their types specialized
          // when the module is instantiated with concrete type arguments
          if (!argValue.specializedType && isFunctionType(moduleFieldType)) {
            // Copy the parametersFrame from the function's type to the specializedType
            // This preserves parameter aliases (e.g., self->lhs, other->rhs) for codegen
            // IMPORTANT: We must preserve the parameter labels from argValue.type,
            // because those are the labels used in the function body. The moduleFieldType
            // has labels from the trait definition (e.g., lhs, rhs) which don't match
            // the actual parameter names in the anonymous function (e.g., a, b).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            argValue.specializedType = {
              ...moduleFieldType,
              // Preserve the parameter labels from the function's actual type
              parameters: argValue.type.parameters,
              parametersFrame: argValue.type.parametersFrame,
            } as FunctionType;
          }
        }

        // Save the value to the members
        fields[i] = argValue;

        // Update the working module type with the newly bound value
        // This allows subsequent Self.X references to resolve to this concrete value
        workingModuleType.fields[i]!.assignedValue = argValue;

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
        // Check if the record member has default or required value
        throw formatErrorMessage({
          token: moduleExpr.token,
          errorMessage: `Record member "${moduleField.label}" is not provided and has no required/default value.`,
        });
      }

      fields[i] = resolvedValue;

      // Update the working module type
      workingModuleType.fields[i]!.assignedValue = resolvedValue;
    }
  }

  // Create the record value
  const moduleValue = createStructValue({ ...moduleType }, fields);
  return { moduleValue, callerEnv };
}
