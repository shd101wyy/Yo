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
import {
  isFunctionType,
  isSomeType,
  isTypeHierarchyType,
} from "../../types/guards";
import { typeContainsSomeType, typeToString } from "../../types/utils";
import {
  createTraitValue,
  isFunctionValue,
  isTypeValue,
  type Value,
  valueToString,
} from "../../value";
import type {
  EvaluatorContext,
  TraitSpecializationResult,
  TraitTypeCallResult,
} from "../context";
import { evaluateExpression } from "../exprs/expr";
import { typeImplementsTraitBool } from "../trait-checking";

/**
 * Specialize a trait type by binding associated types via `:=` arguments.
 * e.g., `Iterator(Item := i32)` creates a specialized TraitType with
 * the constraint that Item must be i32.
 *
 * This is used in where clauses: `where(X <: Iterator(Item := Self.Item))`
 */
export function tryToSpecializeTraitType({
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
}): TraitSpecializationResult {
  const associatedTypeConstraints: { label: string; constraintType: Type }[] =
    [];

  for (const arg of argExprs) {
    if (!exprIsFunctionCall(arg) || !exprIsFunctionCallOf(arg, ":=", 2)) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Expected ":=" for trait specialization (binding associated types), got:\n${exprToString(arg)}`,
      });
    }

    const labelExpr = arg.args[0]!;
    const valueExpr = arg.args[1]!;

    if (!exprIsAtom(labelExpr)) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Expected identifier for associated type label, got:\n${exprToString(labelExpr)}`,
      });
    }
    const label = labelExpr.token.value;

    // Check that the label exists in the trait
    const field = traitType.fields.find((f) => f.label === label);
    if (!field) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Field "${label}" not found in trait "${traitType.typeName ?? "unknown"}".`,
      });
    }

    // Check that it's an associated type field (has unassignedSomeType or is Type-typed)
    if (!field.unassignedSomeType && !isTypeHierarchyType(field.type)) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Field "${label}" is not an associated type. Only associated type fields can be constrained with ":=".`,
      });
    }

    // Evaluate the constraint type expression
    const evaluated = evaluateExpression({
      expr: valueExpr,
      env: callerEnv,
      context: { ...context },
    });

    if (!evaluated.$ || !isTypeValue(evaluated.$.value)) {
      throw formatErrorMessage({
        token: valueExpr.token,
        errorMessage: `Expected type for associated type constraint "${label}", got:\n${exprToString(valueExpr)}`,
      });
    }
    callerEnv = evaluated.$.env;

    associatedTypeConstraints.push({
      label,
      constraintType: evaluated.$.value.value,
    });
  }

  // Create a specialized TraitType — same identity, with constraints added
  const specializedTraitType: TraitType = {
    ...traitType,
    associatedTypeConstraints,
  };

  return {
    specializedTraitType,
    callerEnv,
  };
}

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
  // For function-typed fields, substitute SelfType with receiverType so that
  // recursive lookups (e.g. recursive types like TreeNode containing Box(Self)
  // where Box(T).clone calls T.clone) find a properly-Self-bound method.
  // Without this, the abstract trait method's SelfType (a SomeType representing
  // an unbound Self) leaks into the recursive call, causing type mismatches
  // like "Expected: *(Self), Got: *(TreeNode)".
  const fieldsForReceiverTrait = workingTraitType.fields.map((f) => {
    if (isFunctionType(f.type)) {
      return {
        ...f,
        type: { ...f.type, SelfType: receiverType } as FunctionType,
      };
    }
    return f;
  });
  if (!receiverType.trait) {
    receiverType.trait = {
      ...workingTraitType,
      fields: fieldsForReceiverTrait,
    };
  } else {
    receiverType.trait = {
      ...receiverType.trait,
      fields: [...fieldsForReceiverTrait, ...receiverType.trait.fields],
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
              SelfTraitType: traitType, // Allow SelfTrait to resolve to the trait being implemented
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
              SelfTraitType: traitType, // Allow SelfTrait to resolve to the trait being implemented
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
            // IMPORTANT: But each parameter's type AND type exprs must come from
            // traitFieldType, NOT argValue.type. The specializedType's env is
            // traitFieldType.env (the trait definition's env), and call sites
            // re-evaluate parameter type exprs in that env
            // (evaluateFunctionParameterTypeAgain). The impl's own annotations
            // (argValue.type.parameters[i].exprs) may reference names that only
            // exist in the impl-site env — e.g. `other : str` in an
            // `impl(W, Eq(str)(...))` — and would fail with "Variable not found"
            // when re-evaluated in the trait's env. The trait's exprs (`Self`,
            // `Rhs`) are self-consistent with traitFieldType.env.
            argValue.specializedType = {
              ...traitFieldType,
              // Preserve the parameter labels (and body-facing metadata) from
              // the function's actual type; take type + exprs from the trait.
              parameters: argValue.type.parameters.map((param, paramIndex) => {
                const traitParam = traitFieldType.parameters[paramIndex];
                return traitParam
                  ? { ...param, type: traitParam.type, exprs: traitParam.exprs }
                  : param;
              }),
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
      const typeExpr = traitField.exprs.typeExpr;
      const defaultValueExpr = traitField.exprs.defaultValueExpr;
      const defaultValue = traitField.defaultValue;
      const assignedValue = traitField.assignedValue;

      // Re-evaluate default value expression in the current context with concrete Self.
      // This is needed so that defaults referencing Self (e.g., typeid(Self)) get the
      // concrete type. If re-evaluation fails (e.g., the default references Self methods
      // not yet available during impl), fall back to the pre-evaluated defaultValue.
      let resolvedValue: Value | undefined = assignedValue;
      if (!assignedValue && defaultValueExpr) {
        try {
          // First, evaluate the type expression to get the concrete field type
          // with Self resolved. This mirrors the foundArgExpr=true path which
          // evaluates typeExpr before the argument expression.
          let traitFieldType: Type | undefined;
          if (typeExpr) {
            const evaluatedTypeExpr = evaluateExpression({
              expr: cloneExpr(typeExpr),
              env: pushEnvFrame(
                traitType.env,
                callerEnv.frames[callerEnv.frames.length - 1]
              ),
              context: {
                ...context,
                expectedType: undefined,
                ReceiverType: undefined,
                SelfType: selfType,
                SelfTraitType: traitType,
              },
            });
            const typeValue = evaluatedTypeExpr.$?.value;
            if (isTypeValue(typeValue)) {
              traitFieldType = typeValue.value;
            }
          }

          const evaluatedDefault = evaluateExpression({
            expr: cloneExpr(defaultValueExpr),
            env: pushEnvFrame(
              traitType.env,
              callerEnv.frames[callerEnv.frames.length - 1]
            ),
            context: {
              ...context,
              expectedType: traitFieldType
                ? { type: traitFieldType, env: callerEnv }
                : undefined,
              ReceiverType: undefined,
              SelfType: selfType,
              SelfTraitType: traitType,
            },
          });
          resolvedValue = evaluatedDefault.$?.value;

          // If the resolved value is a function, add trait field label to funcId
          // and specialize its type, matching the behavior when args are provided
          if (resolvedValue && isFunctionValue(resolvedValue)) {
            resolvedValue.funcId += `_${traitField.label}`;
            if (
              !resolvedValue.specializedType &&
              traitFieldType &&
              isFunctionType(traitFieldType)
            ) {
              resolvedValue.specializedType = {
                ...traitFieldType,
                parameters: resolvedValue.type.parameters,
                parametersFrame: resolvedValue.type.parametersFrame,
              } as FunctionType;
            }
          }
        } catch {
          // Re-evaluation failed — fall back to pre-evaluated default value
          resolvedValue = defaultValue;
        }
      }
      if (!resolvedValue && defaultValue) {
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

  // Check where clause constraints on associated type fields.
  // Each unassignedSomeType may have requiredTraits from where clauses
  // (e.g., where(Self.IntoIterType <: Iter(Item := Self.Item)))
  // that need to be verified now that all fields have concrete values.
  for (let i = 0; i < traitType.fields.length; i++) {
    const field = traitType.fields[i]!;
    if (!field.unassignedSomeType) continue;

    const someType = field.unassignedSomeType;
    const boundValue = fields[i];
    if (!boundValue || !isTypeValue(boundValue)) continue;

    const concreteType = boundValue.value;

    // Skip where clause checking for generic impls where the bound type
    // still contains unresolved SomeTypes — constraints will be checked
    // when the generic impl is instantiated with concrete types
    if (typeContainsSomeType(concreteType)) continue;

    for (const { traitType: requiredTrait } of someType.requiredTraits) {
      // Resolve SomeTypes in associatedTypeConstraints to their concrete bound values
      let resolvedRequiredTrait = requiredTrait;
      if (requiredTrait.associatedTypeConstraints) {
        const resolvedConstraints = requiredTrait.associatedTypeConstraints.map(
          (c) => {
            let resolvedType = c.constraintType;
            if (isSomeType(resolvedType)) {
              for (let j = 0; j < traitType.fields.length; j++) {
                const otherField = traitType.fields[j]!;
                if (otherField.unassignedSomeType === resolvedType) {
                  const otherBoundValue = fields[j];
                  if (otherBoundValue && isTypeValue(otherBoundValue)) {
                    resolvedType = otherBoundValue.value;
                  }
                  break;
                }
              }
            }
            return { ...c, constraintType: resolvedType };
          }
        );
        resolvedRequiredTrait = {
          ...requiredTrait,
          associatedTypeConstraints: resolvedConstraints,
        };
      }

      const result = typeImplementsTraitBool({
        targetType: concreteType,
        traitType: resolvedRequiredTrait,
        env: callerEnv,
      });

      if (!result) {
        throw formatErrorMessage({
          token: traitExpr.token,
          errorMessage: `Where clause constraint not satisfied: ${typeToString(concreteType)} does not implement ${resolvedRequiredTrait.typeName ?? "trait"}(${resolvedRequiredTrait.associatedTypeConstraints?.map((c) => `${c.label} := ${typeToString(c.constraintType)}`).join(", ") ?? ""}).\nField "${field.label}" must satisfy the trait's where clause.`,
        });
      }
    }
  }

  // Create the trait value
  const traitValue = createTraitValue({ ...traitType, receiverType }, fields);
  return { traitValue, callerEnv };
}
