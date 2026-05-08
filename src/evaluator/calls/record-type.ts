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
import type {
  FunctionType,
  SourceNamespaceType,
  Type,
} from "../../types/definitions";
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
  sourceNamespaceType,
  argExprs,
  callerEnv,
  context,
}: {
  moduleExpr: Expr;
  sourceNamespaceType: SourceNamespaceType;
  argExprs: Expr[];
  callerEnv: Environment;
  context: EvaluatorContext;
}): RecordTypeCallResult {
  if (argExprs.length > sourceNamespaceType.fields.length) {
    throw formatErrorMessage({
      token: moduleExpr.token,
      errorMessage: `Failed to implement the module. Too many fields provided.`,
    });
  }

  const fields: (Value | undefined)[] = Array(
    sourceNamespaceType.fields.length
  ).fill(undefined);

  // Create a working record type that we'll progressively update with concrete values
  // This allows Self.X references to resolve to concrete types as we bind values
  const workingRecordType: SourceNamespaceType = {
    ...sourceNamespaceType,
    fields: sourceNamespaceType.fields.map((field, idx) => ({
      ...field,
      assignedValue: fields[idx],
    })),
  };

  for (let i = 0; i < sourceNamespaceType.fields.length; i++) {
    const recordField = sourceNamespaceType.fields[i]!;
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
      if (!sourceNamespaceType.fields.find((e) => e.label === label)) {
        throw formatErrorMessage({
          token: labelExpr.token,
          errorMessage: `Record member with label "${label}" does not exist in the record type.`,
        });
      }

      if (recordField.label === label) {
        foundArgExpr = true;

        if (recordField.assignedValue) {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Record member "${recordField.label}" already has an assigned value:
${valueToString(recordField.assignedValue)}`,
          });
        }

        // evaluate the record member type again.
        // Check evaluateFunctionParameterTypeAgain function
        // They should be similar
        let recordFieldType: Type;
        const typeExpr = recordField.exprs.typeExpr;
        const defaultValueExpr = recordField.exprs.defaultValueExpr;
        if (typeExpr) {
          const evaluatedModuleMember = evaluateExpression({
            expr: cloneExpr(typeExpr),
            env: pushEnvFrame(
              sourceNamespaceType.env,
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
          recordFieldType = evaluatedModuleMemberTypeValue.value;
        } else if (defaultValueExpr) {
          const evaluatedValueExpr = evaluateExpression({
            expr: cloneExpr(defaultValueExpr),
            env: pushEnvFrame(
              sourceNamespaceType.env,
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
          recordFieldType = value.type;
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
            expectedType: { type: recordFieldType, env: callerEnv },
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
            { type: recordFieldType, env: callerEnv },
            { type: argType, env: callerEnv }
          )
        ) {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Type mismatch for the record member "${label}":
Expected: ${typeToString(recordFieldType)}
Got:   ${typeToString(argType)}`,
          });
        }
        const argValue = evaluatedArgExpr.$?.value;

        // Propagate ioBuiltin from extern function types to record field types.
        // This ensures io.async/io.await can be detected even when aliased.
        if (argType.ioBuiltin) {
          sourceNamespaceType.fields[i]!.type.ioBuiltin = argType.ioBuiltin;
        }

        if (isFunctionValue(argValue)) {
          argValue.funcId += `_${recordField.label}`;
          // If the function value's type contains SomeType but recordFieldType doesn't,
          // set the specializedType to the resolved recordFieldType
          // This ensures that generic functions in modules get their types specialized
          // when the module is instantiated with concrete type arguments
          if (!argValue.specializedType && isFunctionType(recordFieldType)) {
            // Copy the parametersFrame from the function's type to the specializedType
            // This preserves parameter aliases (e.g., self->lhs, other->rhs) for codegen
            // IMPORTANT: We must preserve the parameter labels from argValue.type,
            // because those are the labels used in the function body. The recordFieldType
            // has labels from the trait definition (e.g., lhs, rhs) which don't match
            // the actual parameter names in the anonymous function (e.g., a, b).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            argValue.specializedType = {
              ...recordFieldType,
              // Preserve the parameter labels from the function's actual type
              parameters: argValue.type.parameters,
              parametersFrame: argValue.type.parametersFrame,
            } as FunctionType;
          }
        }

        // Save the value to the members
        fields[i] = argValue;

        // Update the working record type with the newly bound value
        // This allows subsequent Self.X references to resolve to this concrete value
        workingRecordType.fields[i]!.assignedValue = argValue;

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
      const defaultValue = recordField.defaultValue;
      const assignedValue = recordField.assignedValue;

      // Re-evaluate default value in the current context if it exists
      let resolvedValue: Value | undefined = assignedValue;
      if (!assignedValue && defaultValue) {
        resolvedValue = defaultValue;
      }

      if (!resolvedValue) {
        // Check if the record member has default or required value
        throw formatErrorMessage({
          token: moduleExpr.token,
          errorMessage: `Record member "${recordField.label}" is not provided and has no required/default value.`,
        });
      }

      fields[i] = resolvedValue;

      // Update the working record type
      workingRecordType.fields[i]!.assignedValue = resolvedValue;
    }
  }

  // Create the record value
  const moduleValue = createStructValue({ ...sourceNamespaceType }, fields);
  return { moduleValue, callerEnv };
}
