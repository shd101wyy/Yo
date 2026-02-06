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
import type { FunctionType, TraitType, Type } from "../../types/definitions";
import { isFunctionType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import {
  createTraitValue,
  isFunctionValue,
  isTypeValue,
  type Value,
  valueToString,
} from "../../value";
import type { EvaluatorContext, TraitTypeCallResult } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function tryToImplementTraitWithArgumentsByTraitType({
  traitExpr,
  traitType,
  argExprs,
  callerEnv,
  context,
}: {
  traitExpr: Expr;
  traitType: TraitType;
  argExprs: Expr[];
  callerEnv: Environment;
  context: EvaluatorContext;
}): TraitTypeCallResult {
  if (argExprs.length > traitType.fields.length) {
    throw formatErrorMessage({
      token: traitExpr.token,
      errorMessage: `Failed to implement the trait. Too many fields provided.`,
    });
  }

  const fields: (Value | undefined)[] = Array(traitType.fields.length).fill(
    undefined
  );

  // Create a working trait type that we'll progressively update with concrete values
  // This allows Self.X references to resolve to concrete types as we bind values
  const workingTraitType: TraitType = {
    ...traitType,
    fields: traitType.fields.map((field, idx) => ({
      ...field,
      assignedValue: fields[idx],
    })),
  };

  const receiverType = context.ReceiverType;
  const selfType = context.ReceiverType ?? workingTraitType;

  if (!receiverType) {
    throw formatErrorMessage({
      token: traitExpr.token,
      errorMessage: `Receiver type is undefined when implementing trait.
Please consider using "impl" to specify the receiver type explicitly, like:

// impl receiverType, traitImplementation
impl Point, Id(Point)(
  id : ((p) -> p)
);
`,
    });
  }
  const receiverTypeOriginalTrait: TraitType | undefined = receiverType.trait;

  // Extend the receiverType trait
  if (!receiverType.trait) {
    receiverType.trait = workingTraitType;
  } else {
    receiverType.trait = {
      ...receiverType.trait,
      fields: [...workingTraitType.fields, ...receiverType.trait.fields],
    };
  }

  for (let i = 0; i < traitType.fields.length; i++) {
    const traitField = traitType.fields[i]!;
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

      // Check if label exists in the trait type
      if (!traitType.fields.find((e) => e.label === label)) {
        throw formatErrorMessage({
          token: labelExpr.token,
          errorMessage: `Trait member with label "${label}" does not exist in the trait type.`,
        });
      }

      if (traitField.label === label) {
        foundArgExpr = true;

        if (traitField.assignedValue) {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Trait member "${traitField.label}" already has a assigned value:
${valueToString(traitField.assignedValue)}`,
          });
        }

        // evaluate the trait member type again.
        // Check evaluateFunctionParameterTypeAgain function
        // They should be similar
        let traitFieldType: Type;
        const typeExpr = traitField.exprs.typeExpr;
        const defaultValueExpr = traitField.exprs.defaultValueExpr;
        if (typeExpr) {
          const evaluatedTraitMember = evaluateExpression({
            expr: cloneExpr(typeExpr),
            env: pushEnvFrame(
              traitType.env,
              callerEnv.frames[callerEnv.frames.length - 1]
            ),
            context: {
              ...context,
              expectedType: undefined,
              ReceiverType: undefined,
              SelfType: selfType, // Use working trait with progressively bound values
            },
          });
          const evaluatedTraitMemberTypeValue = evaluatedTraitMember.$?.value;
          if (!isTypeValue(evaluatedTraitMemberTypeValue)) {
            throw formatErrorMessage({
              token: argExpr.token,
              errorMessage: `Failed to evaluate the trait member "${label}"`,
            });
          }
          traitFieldType = evaluatedTraitMemberTypeValue.value;
        } else if (defaultValueExpr) {
          const evaluatedValueExpr = evaluateExpression({
            expr: cloneExpr(defaultValueExpr),
            env: pushEnvFrame(
              traitType.env,
              callerEnv.frames[callerEnv.frames.length - 1]
            ),
            context: {
              ...context,
              expectedType: undefined,
              ReceiverType: undefined,
              SelfType: selfType, // Use working trait with progressively bound values
            },
          });
          const value = evaluatedValueExpr.$?.value;
          if (!value) {
            throw formatErrorMessage({
              token: argExpr.token,
              errorMessage: `Failed to evaluate the trait member "${label}"`,
            });
          }
          traitFieldType = value.type;
        } else {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Trait member "${label}" has no type or default value or assigned value.`,
          });
        }

        // evaluate the argExpr
        const evaluatedArgExpr = evaluateExpression({
          expr: argExpr,
          env: callerEnv,
          context: {
            ...context,
            expectedType: { type: traitFieldType, env: callerEnv },
            ReceiverType: undefined,
            SelfType: selfType,
          },
        });
        const argType = evaluatedArgExpr.$?.type;
        if (!argType) {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Failed to evaluate the trait member "${label}"`,
          });
        }
        if (evaluatedArgExpr.$?.env) {
          callerEnv = evaluatedArgExpr.$.env;
        }

        // Compare the types
        if (
          !areTypesCompatible(
            { type: traitFieldType, env: callerEnv },
            { type: argType, env: callerEnv }
          )
        ) {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Type mismatch for the trait member "${label}":
Expected: ${typeToString(traitFieldType)}
Got:   ${typeToString(argType)}`,
          });
        }
        const argValue = evaluatedArgExpr.$?.value;

        if (isFunctionValue(argValue)) {
          argValue.funcId += `_${traitField.label}`;
          // If the function value's type contains SomeType but traitFieldType doesn't,
          // set the specializedType to the resolved traitFieldType
          // This ensures that generic functions in traits get their types specialized
          // when the trait is instantiated with concrete type arguments
          if (!argValue.specializedType && isFunctionType(traitFieldType)) {
            // Copy the parametersFrame from the function's type to the specializedType
            // This preserves parameter aliases (e.g., self->lhs, other->rhs) for codegen
            // IMPORTANT: We must preserve the parameter labels from argValue.type,
            // because those are the labels used in the function body. The traitFieldType
            // has labels from the trait definition (e.g., lhs, rhs) which don't match
            // the actual parameter names in the anonymous function (e.g., a, b).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            argValue.specializedType = {
              ...traitFieldType,
              // Preserve the parameter labels from the function's actual type
              parameters: argValue.type.parameters,
              parametersFrame: argValue.type.parametersFrame,
            } as FunctionType;
          }
        }

        // Save the value to the members
        fields[i] = argValue;

        // Update the working trait type with the newly bound value
        // This allows subsequent Self.X references to resolve to this concrete value
        workingTraitType.fields[i]!.assignedValue = argValue;

        if (receiverType && receiverType.trait) {
          // Add the field to the ReceiverType.trait as well
          receiverType.trait.fields[i]!.assignedValue = argValue;
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
      const defaultValue = traitField.defaultValue;
      const assignedValue = traitField.assignedValue;

      // Re-evaluate default value in the current context if it exists
      let resolvedValue: Value | undefined = assignedValue;
      if (!assignedValue && defaultValue) {
        resolvedValue = defaultValue;
      }

      if (!resolvedValue) {
        // Check if traitMember has default or required value
        throw formatErrorMessage({
          token: traitExpr.token,
          errorMessage: `Trait member "${traitField.label}" is not provided and has no required/default value.`,
        });
      }

      fields[i] = resolvedValue;

      // Update the working trait type
      workingTraitType.fields[i]!.assignedValue = resolvedValue;
    }
  }

  // Restore the receiverTypeOriginalTrait
  if (receiverType && receiverTypeOriginalTrait) {
    receiverType.trait = receiverTypeOriginalTrait;
  }

  // Create the trait value
  const traitValue = createTraitValue({ ...traitType, receiverType }, fields);
  return { traitValue, callerEnv };
}
