import {
  addVariableToEnv,
  Environment,
  getVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  cloneExpr,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FnCallExpr,
} from "../../expr";
import { FunctionValue } from "../../function-value";
import { PlaceholderToken, Token } from "../../token";
import { TypeValue } from "../../type-value";
import { createType0, createTypeHierarchy } from "../../types/creators";
import {
  FunctionParameter,
  FunctionType,
  SomeType,
  TraitField,
  TraitType,
  Type,
} from "../../types/definitions";
import { getValueOfSomeTypeFromEnv } from "../../types/env-lookup";
import {
  isArrayType,
  isFunctionType,
  isSliceType,
  isSomeType,
  isTraitType,
  isType0,
} from "../../types/guards";
import { typeContainsUnknownValue, typeToString } from "../../types/utils";
import {
  createTypeValue,
  createUnknownValue,
  isFunctionValue,
  isTraitValue,
  isTypeValue,
  isUnknownValue,
  TraitValue,
  UnknownValue,
  Value,
  valueToString,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "../exprs/begin";
import { evaluateExpression } from "../exprs/expr";
import {
  checkTypeImplementsSelfConstraints,
  typeImplementsTrait,
} from "../trait-checking";
import { synthesizeTypes } from "../types/synthesizer";
import { evaluateAnonymousModuleBeginExprs } from "./anonymous-module";
import { evaluateAnonymousTraitBeginExprs } from "./anonymous-trait";

/**
 * Re-evaluate a FunctionType's type expressions with substitutions bound in the environment.
 * This is used for specializing generic methods - instead of structurally substituting types,
 * we re-evaluate the original type expressions (e.g., `Option(T)`) with concrete type bindings
 * to get properly constructed nominal types with correct funcIds.
 *
 * @param functionType The original function type with type expressions to re-evaluate
 * @param specializedEnv Environment with type/value substitutions already bound
 * @param SelfType The concrete Self type for method specialization
 * @returns A new FunctionType with re-evaluated types
 */
function reEvaluateFunctionType({
  functionType,
  specializedEnv,
  SelfType,
}: {
  functionType: FunctionType;
  specializedEnv: Environment;
  SelfType: Type | undefined;
}): FunctionType {
  // Re-evaluate each parameter's type expression
  const newParameters: FunctionParameter[] = functionType.parameters.map(
    (param) => {
      if (!param.exprs.typeExpr) {
        // No type expression to re-evaluate - keep the original type
        // This shouldn't happen for trait methods due to validation in evaluateTraitField
        return param;
      }

      const typeExprClone = cloneExpr(param.exprs.typeExpr);
      const evaluatedTypeExpr = evaluateExpression({
        expr: typeExprClone,
        env: specializedEnv,
        context: {
          isEvaluatingGenericImplSpecialization: true,
          stdPath: "",
          isEvaluatingFunctionType: true,
          SelfType,
        } as EvaluatorContext,
      });

      if (isTypeValue(evaluatedTypeExpr.$?.value)) {
        // Clear typeExpr to prevent re-evaluation of already specialized type
        return {
          ...param,
          type: evaluatedTypeExpr.$.value.value,
          exprs: { ...param.exprs, typeExpr: undefined },
        };
      }

      // Fallback to original type if re-evaluation doesn't produce a type
      return param;
    }
  );

  // Re-evaluate the return type expression
  let newReturnType = functionType.return.type;
  if (functionType.return.expr) {
    const returnTypeExprClone = cloneExpr(functionType.return.expr);
    const evaluatedReturnTypeExpr = evaluateExpression({
      expr: returnTypeExprClone,
      env: specializedEnv,
      context: {
        isEvaluatingGenericImplSpecialization: true,
        stdPath: "",
        isEvaluatingFunctionType: true,
        SelfType,
      } as EvaluatorContext,
    });

    if (isTypeValue(evaluatedReturnTypeExpr.$?.value)) {
      newReturnType = evaluatedReturnTypeExpr.$.value.value;
    }
  }

  // Re-evaluate SelfType if present (it's likely already concrete from substitutions)
  let newSelfType = functionType.SelfType;
  if (SelfType) {
    newSelfType = SelfType;
  }

  // Create the new parametersFrame with re-evaluated types
  const newParametersFrame = {
    ...functionType.parametersFrame,
    variables: functionType.parametersFrame.variables.map((v) => {
      // Find the corresponding parameter in newParameters
      const newParam = newParameters.find((p) => p.label === v.name);
      const newType = newParam ? newParam.type : v.type;

      if (newType !== v.type) {
        return { ...v, type: newType };
      }
      return v;
    }),
  };

  return {
    ...functionType,
    forallParameters: [], // Clear forall parameters since we've specialized them
    parameters: newParameters,
    parametersFrame: newParametersFrame,
    return: { ...functionType.return, type: newReturnType, expr: undefined }, // Clear expr to prevent re-evaluation
    SelfType: newSelfType,
  };
}

/**
 * Registry of types that have impl fields from a specific module path.
 * This allows cleanup when a module is re-evaluated or deleted.
 */
const implRegistry: Map<string, Set<TraitType>> = new Map();

/**
 * Generic impl that uses forall type parameters.
 * For example: impl(forall(T : Type), Data(T), Copy())
 */
/** A forall parameter can be either a type parameter (SomeType) or a value parameter (unknown value) */
export type ForallParameter =
  | { kind: "type"; name: string; someType: SomeType }
  | { kind: "value"; name: string; type: Type; unknownValue: UnknownValue };

export interface GenericImpl {
  /** The type parameters (e.g., T, Size) */
  forallParameters: ForallParameter[];
  /** The constraints from where clause (e.g., T <: Copy) */
  whereConstraints: {
    someType: SomeType;
    traitType: TraitType;
    traitExpr?: Expr;
  }[];
  /** The receiver type pattern containing SomeTypes (e.g., Data(T)) */
  receiverTypePattern: Type;
  /** The trait type being implemented (e.g., Copy) */
  traitType: TraitType;
  /** The trait value */
  traitValue: TraitValue;
  /** The expr that created this impl */
  expr: Expr;
  /** The source module path for cleanup on re-evaluation */
  sourceModulePath?: string;
  /** The environment where the impl was defined (for accessing non-exported variables like extern functions) */
  definitionEnv: Environment;
  /**
   * The trait type argument expressions (e.g., [Box(T)] for Eq(Box(T)))
   * These need to be re-evaluated with substitutions to get concrete trait type parameters like Rhs
   */
  traitTypeArgExprs?: Expr[];
  /**
   * The trait function's parameter names (e.g., ["Rhs"] for Eq(Rhs))
   * Paired with traitTypeArgExprs to bind parameters during specialization
   */
  traitFunctionParamNames?: string[];
}

/**
 * Registry of generic impls keyed by trait type name.
 * This allows lookup when checking if a concrete type implements a trait.
 */
const genericImplRegistry: Map<string, GenericImpl[]> = new Map();

/**
 * Registry tracking which trait are implemented for which types.
 * Maps from type id to an array of impl records.
 * Used for duplicate impl detection.
 */
interface ImplRecord {
  traitTypeId: string;
  traitTypeName?: string;
  modulePath: string;
  expr: Expr;
}
const typeImplRegistry: Map<string, ImplRecord[]> = new Map();

/**
 * Clear all generic impls from the registry that were added by the specified module.
 * Call this before re-evaluating a trait to prevent duplicate impls.
 */
export function clearGenericImplsFromModule(modulePath: string): void {
  for (const [traitTypeName, impls] of genericImplRegistry.entries()) {
    const filteredImpls = impls.filter(
      (impl) => impl.sourceModulePath !== modulePath
    );
    if (filteredImpls.length === 0) {
      genericImplRegistry.delete(traitTypeName);
    } else {
      genericImplRegistry.set(traitTypeName, filteredImpls);
    }
  }
}

/**
 * Clear impl records from the type impl registry for a specific module.
 * Call this before re-evaluating a trait to prevent duplicate impl detection.
 */
function clearImplRecordsFromModule(modulePath: string): void {
  for (const [typeId, impls] of typeImplRegistry.entries()) {
    const filteredImpls = impls.filter(
      (impl) => impl.modulePath !== modulePath
    );
    if (filteredImpls.length === 0) {
      typeImplRegistry.delete(typeId);
    } else {
      typeImplRegistry.set(typeId, filteredImpls);
    }
  }
}

/**
 * Clear ALL global impl registries.
 * Use this to completely reset global state between independent compilation runs.
 */
export function clearAllGlobalImplState(): void {
  implRegistry.clear();
  genericImplRegistry.clear();
  typeImplRegistry.clear();
}

/**
 * Register a generic impl in the registry.
 */
function registerGenericImpl(
  traitTypeName: string,
  genericImpl: GenericImpl
): void {
  let impls = genericImplRegistry.get(traitTypeName);
  if (!impls) {
    impls = [];
    genericImplRegistry.set(traitTypeName, impls);
  }
  impls.push(genericImpl);
}

/**
 * Check if a trait is already implemented for a type.
 * Throws an error if duplicate impl is detected.
 */
function checkDuplicateImpl({
  receiverType,
  traitType,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  currentModulePath,
  expr,
}: {
  receiverType: Type;
  traitType: TraitType;
  currentModulePath: string | undefined;
  expr: Expr;
}): void {
  const typeId = receiverType.id;
  const impls = typeImplRegistry.get(typeId) || [];

  const existing = impls.find((impl) => impl.traitTypeId === traitType.id);
  if (existing) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage:
        `Trait "${traitType.typeName ?? traitType.id}" is already implemented for type "${typeToString(receiverType)}".\n` +
        `First implementation was in: ${existing.modulePath || "unknown"}`,
    });
  }
}

/**
 * Register that a trait has been implemented for a type.
 */
function registerImplForType({
  receiverType,
  traitType,
  currentModulePath,
  expr,
}: {
  receiverType: Type;
  traitType: TraitType;
  currentModulePath: string | undefined;
  expr: Expr;
}): void {
  const typeId = receiverType.id;
  let impls = typeImplRegistry.get(typeId);
  if (!impls) {
    impls = [];
    typeImplRegistry.set(typeId, impls);
  }

  impls.push({
    traitTypeId: traitType.id,
    traitTypeName: traitType.typeName,
    modulePath: currentModulePath || "unknown",
    expr,
  });
}

/**
 * Check orphan rule: at least one of the trait or the type must be defined in the current module.
 * Throws an error if the orphan rule is violated.
 */
function checkOrphanRule({
  receiverType,
  traitType,
  currentModulePath,
  expr,
}: {
  receiverType: Type;
  traitType: TraitType;
  currentModulePath: string | undefined;
  expr: Expr;
}): void {
  // If we don't have a current module path, we can't check the orphan rule
  // This happens for top-level code or tests - allow it
  if (!currentModulePath) {
    return;
  }

  const moduleDefinedHere = traitType.definedInModulePath === currentModulePath;
  const typeDefinedHere =
    receiverType.definedInModulePath === currentModulePath;

  // Prelude is special - allow prelude to impl any module for any type
  // This is necessary for built-in impls
  if (
    currentModulePath.includes("prelude.yo") ||
    currentModulePath.includes("std/")
  ) {
    return;
  }

  if (!moduleDefinedHere && !typeDefinedHere) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage:
        `Orphan impl: Cannot implement foreign trait "${traitType.typeName ?? traitType.id}" for foreign type "${typeToString(receiverType)}".\n` +
        `At least one of the trait or the type must be defined in this module.\n` +
        `Trait defined in: ${traitType.definedInModulePath || "unknown"}\n` +
        `Type defined in: ${receiverType.definedInModulePath || "unknown"}\n` +
        `Current module: ${currentModulePath}`,
    });
  }
}

/**
 * Find a matching generic impl for a concrete type and trait type.
 * Returns the matched impl if found, or undefined if no match.
 */
export function findMatchingGenericImpl({
  concreteType,
  traitType,
  env,
}: {
  concreteType: Type;
  traitType: TraitType;
  env: Environment;
}): GenericImpl | undefined {
  // Use typeName if available, otherwise fall back to id for anonymous modules
  const traitTypeKey = traitType.typeName || traitType.id;

  const impls = genericImplRegistry.get(traitTypeKey);
  if (!impls || impls.length === 0) {
    return undefined;
  }

  for (const impl of impls) {
    const match = tryMatchGenericImpl({
      concreteType,
      impl,
      env,
    });
    if (match.matched) {
      return impl;
    }
  }

  return undefined;
}

/**
 * Find methods from generic impls for a concrete type.
 * Searches all generic impls to find ones that match the type and have the method.
 * Returns an array of matching methods' type and value.
 */
export function findMethodsFromGenericImpls({
  concreteType,
  methodName,
  env,
}: {
  concreteType: Type;
  methodName: string;
  env: Environment;
}): { type: FunctionType; value: Value | undefined }[] {
  // CRITICAL: If concreteType is a SomeType, resolve it from the environment
  // to get the actual concrete type. This is necessary when checking trait
  // constraints like `K <: Hash` where `K = Box(i32)`. Without this resolution,
  // the impl matching would try to match `Box(T)` against `K` instead of `Box(i32)`,
  // resulting in incorrect type parameter bindings.
  if (isSomeType(concreteType)) {
    const resolvedType = getValueOfSomeTypeFromEnv(env, concreteType);
    if (!isSomeType(resolvedType)) {
      concreteType = resolvedType;
    }
  }

  const methods: { type: FunctionType; value: Value | undefined }[] = [];

  // Search through all trait types in the registry
  for (const [_moduleTypeName, impls] of genericImplRegistry.entries()) {
    for (const impl of impls) {
      // Check if this impl matches the concrete type
      const match = tryMatchGenericImpl({
        concreteType,
        impl,
        env,
      });
      if (!match.matched) {
        continue;
      }

      // Found a matching impl - look for the method
      const traitType = impl.traitType;
      const traitValue = impl.traitValue;

      const methodIndex = traitType.fields.findIndex(
        (f) => f.label === methodName && isFunctionType(f.type)
      );

      if (methodIndex >= 0) {
        const method = traitType.fields[methodIndex]!;
        if (isFunctionType(method.type)) {
          // Get the actual function value from the trait value
          const originalValue = traitValue.fields[methodIndex];

          // Check if we should create a specialized function value
          // IMPORTANT: We should NOT create specialized function values when the concreteType
          // contains Unknown values. This happens during initial function definition when
          // parameters are still Unknown. In this case, just return the original type
          // with undefined value - no specialized function body is created.
          // The proper specialization will happen later when called with concrete values.
          const hasUnknownTypes = typeContainsUnknownValue(concreteType);
          const shouldCreateSpecializedValue =
            isFunctionValue(originalValue) &&
            (match.valueSubstitutions.size > 0 ||
              match.substitutions.size > 0) &&
            !hasUnknownTypes;

          if (shouldCreateSpecializedValue) {
            // Use the environment where the impl was originally defined
            // This ensures access to non-exported variables (like extern "Yo" functions)
            // that were available when the impl was created
            const baseEnv = impl.definitionEnv;

            // Create a specialized environment with type/value substitutions bound
            // Start with a fresh frame
            let specializedEnv = pushEnvFrame(baseEnv);

            // Add type substitutions to the environment first (like T=i32, U=usize, Self=[i32; 5])
            // These must come BEFORE re-evaluating trait type args so that expressions like Box(T) become Box(i32)
            for (const [paramName, paramType] of match.substitutions) {
              // Include Self - it's needed for method bodies that reference it
              const { env: nextEnv } = addVariableToEnv({
                env: specializedEnv,
                variable: {
                  name: paramName,
                  type: createType0(),
                  isCompileTimeOnly: true,
                  value: [createTypeValue(paramType)],
                  token: PlaceholderToken,
                  initializedAtToken: PlaceholderToken,
                  consumedAtToken: undefined,
                  isOwningTheRcValue: false,
                },
              });
              specializedEnv = nextEnv;
            }

            // Add value substitutions (compile-time values like n=3)
            for (const [paramName, paramValue] of match.valueSubstitutions) {
              const { env: nextEnv } = addVariableToEnv({
                env: specializedEnv,
                variable: {
                  name: paramName,
                  type: paramValue.type,
                  isCompileTimeOnly: true,
                  value: [paramValue],
                  token: PlaceholderToken,
                  initializedAtToken: PlaceholderToken,
                  consumedAtToken: undefined,
                  isOwningTheRcValue: false,
                },
              });
              specializedEnv = nextEnv;
            }

            // IMPORTANT: Re-evaluate trait type argument expressions to get concrete trait type parameters
            // For Eq(Box(T)) with T=i32, we re-evaluate Box(T) to get Box(i32), then bind Rhs=Box(i32)
            // This is necessary because types in Yo are nominal, so we can't just substitute structurally
            if (
              impl.traitTypeArgExprs &&
              impl.traitFunctionParamNames &&
              impl.traitTypeArgExprs.length ===
                impl.traitFunctionParamNames.length
            ) {
              for (let i = 0; i < impl.traitTypeArgExprs.length; i++) {
                const argExpr = impl.traitTypeArgExprs[i]!;
                const paramName = impl.traitFunctionParamNames[i]!;

                // Re-evaluate the argument expression with substitutions bound
                const evaluatedArg = evaluateExpression({
                  expr: cloneExpr(argExpr),
                  env: specializedEnv,
                  context: {
                    isEvaluatingGenericImplSpecialization: true,
                    stdPath: "",
                  } as EvaluatorContext,
                });

                if (evaluatedArg.$ && isTypeValue(evaluatedArg.$.value)) {
                  const { env: nextEnv } = addVariableToEnv({
                    env: specializedEnv,
                    variable: {
                      name: paramName,
                      type: createType0(),
                      isCompileTimeOnly: true,
                      value: [evaluatedArg.$.value],
                      token: PlaceholderToken,
                      initializedAtToken: PlaceholderToken,
                      consumedAtToken: undefined,
                      isOwningTheRcValue: false,
                    },
                    allowVariableShadowing: true,
                  });
                  specializedEnv = nextEnv;
                }
              }
            }

            // Re-evaluate the function type to get specialized types
            // This properly handles nominal types like Option(T) -> Option(Box(i32))
            const specializedType = reEvaluateFunctionType({
              functionType: method.type,
              specializedEnv,
              SelfType: match.substitutions.get("Self"),
            });

            // Now add the parametersFrame with the specialized parameter types
            specializedEnv = pushEnvFrame(
              specializedEnv,
              specializedType.parametersFrame
            );

            // Clone the function body for re-evaluation
            const clonedBody = cloneExpr(originalValue.body);

            // Re-evaluate the function body with the concrete values
            const specializedBody = evaluateBeginExpression({
              expr: clonedBody,
              env: specializedEnv,
              context: {
                isEvaluatingGenericImplSpecialization: true,
                expectedType: {
                  type: specializedType.return.type,
                  env: specializedEnv,
                },
                stdPath: "",
                isEvaluatingFunctionBodyOrAsyncBlock: {
                  kind: "function-body",
                  type: specializedType,
                  value: originalValue,
                  evaluationEnv: specializedEnv,
                },
                functionReturnImplConcreteType: [], // Fresh array for each specialization
                // Set SelfType to the concrete type from substitutions
                SelfType: match.substitutions.get("Self"),
              } as EvaluatorContext,
              variablesToAdd: [],
              isEvaluatingFunctionBodyBeginBlock: true,
            });

            // Create a specialized function value with the re-evaluated body
            const specializedFunctionValue: FunctionValue = {
              ...originalValue,
              specializedType: specializedType,
              body: specializedBody,
              // Create a unique funcId for this specialization (include both type and value substitutions)
              funcId: `${originalValue.funcId}_specialized_${[...match.substitutions.entries()].map(([k, v]) => `${k}_${typeToString(v)}`).join("_")}_${[...match.valueSubstitutions.entries()].map(([k, v]) => `${k}_${valueToString(v)}`).join("_")}`,
              funcName: originalValue.funcName
                ? `${originalValue.funcName}_specialized`
                : undefined,
            };

            methods.push({
              type: specializedType,
              value: specializedFunctionValue,
            });
          } else if (hasUnknownTypes) {
            // We have unknown types (like unknown array length), so we can't fully specialize
            // the function body. However, we should still re-evaluate the function TYPE
            // to properly substitute known type parameters (like T = i32).
            // Without this, the parameter type would remain as the unspecialized SomeType "T"
            // instead of being resolved to the concrete element type.

            // Use the environment where the impl was originally defined
            const baseEnv = impl.definitionEnv;

            // Create a specialized environment with type/value substitutions bound
            let specializedEnv = pushEnvFrame(baseEnv);

            // Add type substitutions to the environment (like T=i32, U=usize, Self=[i32; N])
            for (const [paramName, paramType] of match.substitutions) {
              const { env: nextEnv } = addVariableToEnv({
                env: specializedEnv,
                variable: {
                  name: paramName,
                  type: createType0(),
                  isCompileTimeOnly: true,
                  value: [createTypeValue(paramType)],
                  token: PlaceholderToken,
                  initializedAtToken: PlaceholderToken,
                  consumedAtToken: undefined,
                  isOwningTheRcValue: false,
                },
              });
              specializedEnv = nextEnv;
            }

            // Add value substitutions (compile-time values like n=3)
            for (const [paramName, paramValue] of match.valueSubstitutions) {
              const { env: nextEnv } = addVariableToEnv({
                env: specializedEnv,
                variable: {
                  name: paramName,
                  type: paramValue.type,
                  isCompileTimeOnly: true,
                  value: [paramValue],
                  token: PlaceholderToken,
                  initializedAtToken: PlaceholderToken,
                  consumedAtToken: undefined,
                  isOwningTheRcValue: false,
                },
              });
              specializedEnv = nextEnv;
            }

            // Re-evaluate the function type to get specialized parameter/return types
            const specializedType = reEvaluateFunctionType({
              functionType: method.type,
              specializedEnv,
              SelfType: match.substitutions.get("Self"),
            });

            // Return the specialized type but undefined value (body will be specialized at call site)
            methods.push({ type: specializedType, value: undefined });
          } else if (isFunctionValue(originalValue)) {
            // No substitutions needed, just set the specialized type
            const specializedFunctionValue: FunctionValue = {
              ...originalValue,
              specializedType: method.type,
            };
            methods.push({
              type: method.type,
              value: specializedFunctionValue,
            });
          } else {
            methods.push({ type: method.type, value: originalValue });
          }
        }
      }
    }
  }

  return methods;
}

/**
 * Find a method from a generic impl for a specific trait type and concrete receiver type.
 * This is used when accessing methods on a `<:` expression like `(Box(i32) <: Isolation).can_isolate`.
 * Returns the specialized method type and value if found.
 */
export function findMethodFromGenericImplForTrait({
  concreteType,
  traitType,
  methodName,
  env,
}: {
  concreteType: Type;
  traitType: TraitType;
  methodName: string;
  env: Environment;
}): { type: FunctionType; value: Value | undefined } | undefined {
  // Use typeName if available, otherwise fall back to id for anonymous modules
  const traitTypeKey = traitType.typeName || traitType.id;

  const impls = genericImplRegistry.get(traitTypeKey);
  if (!impls || impls.length === 0) {
    return undefined;
  }

  for (const impl of impls) {
    // Check if this impl matches the concrete type
    const match = tryMatchGenericImpl({
      concreteType,
      impl,
      env,
    });
    if (!match.matched) {
      continue;
    }

    // Found a matching impl - look for the method
    const implTraitType = impl.traitType;
    const implTraitValue = impl.traitValue;

    const methodIndex = implTraitType.fields.findIndex(
      (f) => f.label === methodName && isFunctionType(f.type)
    );

    if (methodIndex >= 0) {
      const method = implTraitType.fields[methodIndex]!;
      if (isFunctionType(method.type)) {
        // Get the actual function value from the trait value
        const originalValue = implTraitValue.fields[methodIndex];

        // If it's a function value, we need to re-evaluate with concrete substitutions
        if (
          isFunctionValue(originalValue) &&
          (match.valueSubstitutions.size > 0 || match.substitutions.size > 0)
        ) {
          // Use the environment where the impl was originally defined
          const baseEnv = impl.definitionEnv;

          // Create a specialized environment with type/value substitutions bound
          let specializedEnv = pushEnvFrame(baseEnv);

          // Add type substitutions to the environment (like T=Box(i32), Self=...)
          for (const [paramName, paramType] of match.substitutions) {
            const { env: nextEnv } = addVariableToEnv({
              env: specializedEnv,
              variable: {
                name: paramName,
                type: createType0(),
                isCompileTimeOnly: true,
                value: [createTypeValue(paramType)],
                token: PlaceholderToken,
                initializedAtToken: PlaceholderToken,
                consumedAtToken: undefined,
                isOwningTheRcValue: false,
              },
            });
            specializedEnv = nextEnv;
          }

          // Add value substitutions (compile-time values like U=3)
          for (const [paramName, paramValue] of match.valueSubstitutions) {
            const { env: nextEnv } = addVariableToEnv({
              env: specializedEnv,
              variable: {
                name: paramName,
                type: paramValue.type,
                isCompileTimeOnly: true,
                value: [paramValue],
                token: PlaceholderToken,
                initializedAtToken: PlaceholderToken,
                consumedAtToken: undefined,
                isOwningTheRcValue: false,
              },
            });
            specializedEnv = nextEnv;
          }

          // Re-evaluate the function type to get specialized types
          const specializedType = reEvaluateFunctionType({
            functionType: method.type,
            specializedEnv,
            SelfType: match.substitutions.get("Self"),
          });

          // Now add the parametersFrame with the specialized parameter types
          specializedEnv = pushEnvFrame(
            specializedEnv,
            specializedType.parametersFrame
          );

          // Clone the function body for re-evaluation
          const clonedBody = cloneExpr(originalValue.body);

          // Re-evaluate the function body with the concrete values
          const specializedBody = evaluateBeginExpression({
            expr: clonedBody,
            env: specializedEnv,
            context: {
              isEvaluatingGenericImplSpecialization: true,
              expectedType: {
                type: specializedType.return.type,
                env: specializedEnv,
              },
              stdPath: "",
              isEvaluatingFunctionBodyOrAsyncBlock: {
                kind: "function-body",
                type: specializedType,
                value: originalValue,
                evaluationEnv: specializedEnv,
              },
              functionReturnImplConcreteType: [], // Fresh array for each specialization
              // Set SelfType to the concrete type from substitutions
              SelfType: match.substitutions.get("Self"),
            } as EvaluatorContext,
            variablesToAdd: [],
            isEvaluatingFunctionBodyBeginBlock: true,
          });

          // Create a specialized function value with the re-evaluated body
          const specializedFunctionValue: FunctionValue = {
            ...originalValue,
            specializedType: specializedType,
            body: specializedBody,
            funcId: `${originalValue.funcId}_specialized_${[...match.substitutions.entries()].map(([k, v]) => `${k}_${typeToString(v)}`).join("_")}_${[...match.valueSubstitutions.entries()].map(([k, v]) => `${k}_${valueToString(v)}`).join("_")}`,
            funcName: originalValue.funcName
              ? `${originalValue.funcName}_specialized`
              : undefined,
          };

          return { type: specializedType, value: specializedFunctionValue };
        } else if (isFunctionValue(originalValue)) {
          // No substitutions needed, just set the specialized type
          const specializedFunctionValue: FunctionValue = {
            ...originalValue,
            specializedType: method.type,
          };
          return { type: method.type, value: specializedFunctionValue };
        } else {
          return { type: method.type, value: originalValue };
        }
      }
    }
  }

  return undefined;
}

/** Result from tryMatchGenericImpl */
interface GenericImplMatchResult {
  matched: boolean;
  /** Map from SomeType name to the concrete type it was bound to */
  substitutions: Map<string, Type>;
  /** Map from value parameter name to the concrete value it was bound to */
  valueSubstitutions: Map<string, Value>;
}

/**
 * Try to match a concrete type against a generic impl's receiver type pattern.
 * Returns match result with substitutions if matched, or matched=false otherwise.
 */
function tryMatchGenericImpl({
  concreteType,
  impl,
  env,
}: {
  concreteType: Type;
  impl: GenericImpl;
  env: Environment;
}): GenericImplMatchResult {
  const noMatch: GenericImplMatchResult = {
    matched: false,
    substitutions: new Map(),
    valueSubstitutions: new Map(),
  };

  // CRITICAL: If concreteType is an unresolved SomeType (type parameter like K),
  // we cannot match it against a concrete pattern like Box(T).
  // The SomeType represents any type that satisfies certain constraints,
  // not a specific concrete type. Matching should only succeed when
  // concreteType is a concrete type or a SomeType that is already bound.
  if (isSomeType(concreteType)) {
    const resolvedType = getValueOfSomeTypeFromEnv(env, concreteType);
    if (isSomeType(resolvedType)) {
      // concreteType is an unresolved type parameter, cannot match against a pattern
      return noMatch;
    }
    // Otherwise use the resolved type
    concreteType = resolvedType;
  }

  // Create a fresh env with the forall parameters in scope for unification
  let unifyEnv = pushEnvFrame(env);

  // Add the parameters from forall to the environment
  for (const param of impl.forallParameters) {
    if (param.kind === "type") {
      const { env: nextEnv } = addVariableToEnv({
        env: unifyEnv,
        variable: {
          name: param.name,
          type: createType0(),
          isCompileTimeOnly: true,
          value: [createTypeValue(param.someType)],
          token: PlaceholderToken,
          initializedAtToken: PlaceholderToken,
          consumedAtToken: undefined,
          isOwningTheRcValue: false,
        },
        allowVariableShadowing: true,
      });
      unifyEnv = nextEnv;
    } else {
      // Value parameter: add the unknown value to the environment
      const { env: nextEnv } = addVariableToEnv({
        env: unifyEnv,
        variable: {
          name: param.name,
          type: param.type,
          isCompileTimeOnly: true,
          value: [param.unknownValue],
          token: PlaceholderToken,
          initializedAtToken: PlaceholderToken,
          consumedAtToken: undefined,
          isOwningTheRcValue: false,
        },
        allowVariableShadowing: true,
      });
      unifyEnv = nextEnv;
    }
  }

  // Try to unify the concrete type with the receiver type pattern
  try {
    const { expectedEnv } = synthesizeTypes(
      { type: impl.receiverTypePattern, env: unifyEnv },
      { type: concreteType, env }
    );

    // Check if all where constraints are satisfied
    for (const {
      someType,
      traitType: constraintTrait,
      traitExpr: constraintExpr,
    } of impl.whereConstraints) {
      // Get the bound type for this SomeType from the unified environment
      const boundType = getValueOfSomeTypeFromEnvForGenericImpl(
        expectedEnv,
        someType
      );

      if (!boundType) {
        return noMatch;
      }

      // If we have the original expression, re-evaluate it with the bound types
      // This handles cases like Eq(T) -> Eq(i32) when T=i32
      let actualConstraintTrait = constraintTrait;
      if (constraintExpr) {
        try {
          const exprClone = cloneExpr(constraintExpr);
          const evaluated = evaluateExpression({
            expr: exprClone,
            env: expectedEnv,
            context: {
              stdPath: "",
              isEvaluatingGenericImplSpecialization: true,
            } as EvaluatorContext,
          });
          if (
            evaluated.$ &&
            isTypeValue(evaluated.$.value) &&
            isTraitType(evaluated.$.value.value)
          ) {
            actualConstraintTrait = evaluated.$.value.value;
          }
        } catch {
          // If re-evaluation fails, fall back to the original constraint trait
        }
      }

      // Handle negated constraints: the bound type must NOT implement the trait
      if (actualConstraintTrait.isNegatedConstraint) {
        // If bound to a SomeType, check if it has the negated constraint attached
        if (isSomeType(boundType)) {
          if (
            !someTypeHasNegatedModuleConstraint(
              boundType,
              actualConstraintTrait
            )
          ) {
            return noMatch;
          }
          continue;
        }

        // For concrete types, verify they do NOT implement the trait
        if (
          typeImplementsTrait({
            targetType: boundType,
            traitType: actualConstraintTrait,
            env,
          })
        ) {
          return noMatch;
        }
        continue;
      }

      // If bound to a SomeType, check if it has the required constraint attached
      if (isSomeType(boundType)) {
        if (!someTypeHasModuleConstraint(boundType, actualConstraintTrait)) {
          return noMatch;
        }
        continue;
      }

      // Check if the bound type implements the required trait
      if (
        !typeImplementsTrait({
          targetType: boundType,
          traitType: actualConstraintTrait,
          env: expectedEnv,
        })
      ) {
        return noMatch;
      }
    }

    // Extract type substitutions from the unified environment
    const substitutions = new Map<string, Type>();
    const valueSubstitutions = new Map<string, Value>();
    for (const param of impl.forallParameters) {
      if (param.kind === "type") {
        const boundType = getValueOfSomeTypeFromEnvForGenericImpl(
          expectedEnv,
          param.someType
        );
        if (boundType && !isSomeType(boundType)) {
          substitutions.set(param.name, boundType);
        }
      } else {
        // Value parameter: extract the bound value from the environment
        const variables = getVariablesFromEnv(expectedEnv, param.name);
        const variable = variables[variables.length - 1];
        if (variable && variable.value && !isUnknownValue(variable.value[0])) {
          // IMPORTANT: Use the parameter's declared type, not the value's type
          // For example, if forall(U : usize) and the value is 3 (comptime_int),
          // we should store it as 3 with type usize, not comptime_int
          const valueWithCorrectType = {
            ...variable.value[0],
            type: param.type,
          } as Value;
          valueSubstitutions.set(param.name, valueWithCorrectType);
        }
      }
    }

    // Also add Self -> concreteType substitution
    substitutions.set("Self", concreteType);

    return { matched: true, substitutions, valueSubstitutions };
  } catch {
    // Unification failed
    return noMatch;
  }
}

/**
 * Check if a SomeType has a specific trait constraint attached.
 * Used when checking where constraints during generic impl matching.
 */
function someTypeHasModuleConstraint(
  someType: SomeType,
  requiredTrait: TraitType
): boolean {
  const moduleName = requiredTrait.typeName;
  if (!moduleName) {
    return false;
  }

  for (const field of someType.trait.fields) {
    if (
      field.assignedValue &&
      isTypeValue(field.assignedValue) &&
      isTraitType(field.assignedValue.value)
    ) {
      const constraintTrait = field.assignedValue.value;
      // Only match non-negated constraints
      if (
        constraintTrait.typeName === moduleName &&
        !constraintTrait.isNegatedConstraint
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a SomeType has a specific negated trait constraint attached.
 * Used when checking where constraints like `where(T <: !(Copy))`.
 */
function someTypeHasNegatedModuleConstraint(
  someType: SomeType,
  requiredNegatedTrait: TraitType
): boolean {
  const moduleName = requiredNegatedTrait.typeName;
  if (!moduleName) {
    return false;
  }

  for (const field of someType.trait.fields) {
    if (
      field.assignedValue &&
      isTypeValue(field.assignedValue) &&
      isTraitType(field.assignedValue.value)
    ) {
      const constraintTrait = field.assignedValue.value;
      // Only match negated constraints
      if (
        constraintTrait.typeName === moduleName &&
        constraintTrait.isNegatedConstraint
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check that a generic impl's receiver type pattern satisfies the trait's self-constraints.
 * For example, if trait Id has `where(Self <: Copy)`, then any impl of Id must ensure
 * the receiver type implements Copy.
 *
 * For `impl(forall(T : Type), Data(T), Id(...))`, this would fail because Data(T) doesn't
 * necessarily implement Copy (T is unconstrained).
 *
 * For `impl(forall(T : Type), where(T <: Copy), Data(T), Id(...))`, this would succeed
 * because the where clause provides the necessary constraint.
 */
function checkGenericImplSelfConstraints({
  receiverTypePattern,
  traitType,
  whereConstraints,
  env,
  errorToken,
}: {
  receiverTypePattern: Type;
  traitType: TraitType;
  whereConstraints: {
    someType: SomeType;
    traitType: TraitType;
    traitExpr?: Expr;
  }[];
  env: Environment;
  errorToken: Token;
}): void {
  // Check positive constraints (must implement)
  if (traitType.selfConstraints && traitType.selfConstraints.length > 0) {
    for (const constraintTrait of traitType.selfConstraints) {
      // Check if the receiver type pattern implements the constraint
      // This uses typeImplementsTrait which will check generic impls
      if (
        typeImplementsTrait({
          targetType: receiverTypePattern,
          traitType: constraintTrait,
          env,
        })
      ) {
        continue;
      }

      // If direct check failed, collect all SomeTypes from the forall that have
      // the required constraint in whereConstraints and check if the receiver
      // pattern contains those SomeTypes with proper constraints
      const someTypesWithConstraint = new Set<string>();
      for (const wc of whereConstraints) {
        if (
          wc.traitType.typeName === constraintTrait.typeName &&
          !wc.traitType.isNegatedConstraint
        ) {
          someTypesWithConstraint.add(wc.someType.name);
        }
      }

      // Check if receiver type pattern relies on SomeTypes that have the required constraint
      // For now, we just fail - the typeImplementsTrait check should handle this
      // via findMatchingGenericImpl which checks someTypeHasModuleConstraint

      throw formatErrorMessage({
        token: errorToken,
        errorMessage: `Generic impl receiver type "${typeToString(receiverTypePattern)}" does not satisfy constraint "${constraintTrait.typeName ?? typeToString(constraintTrait)}" required by trait "${traitType.typeName ?? typeToString(traitType)}".
Consider adding "where(T <: ${constraintTrait.typeName ?? typeToString(constraintTrait)})" to the impl.`,
      });
    }
  }

  // Check negative constraints (must NOT implement)
  if (
    traitType.negativeSelfConstraints &&
    traitType.negativeSelfConstraints.length > 0
  ) {
    for (const constraintTrait of traitType.negativeSelfConstraints) {
      // If the receiver type pattern directly implements the forbidden trait, it's an error
      if (
        typeImplementsTrait({
          targetType: receiverTypePattern,
          traitType: constraintTrait,
          env,
        })
      ) {
        throw formatErrorMessage({
          token: errorToken,
          errorMessage: `Generic impl receiver type "${typeToString(receiverTypePattern)}" implements "${constraintTrait.typeName ?? typeToString(constraintTrait)}" but trait "${traitType.typeName ?? typeToString(traitType)}" requires it to NOT implement this trait.
Consider adding "where(T <: !(${constraintTrait.typeName ?? typeToString(constraintTrait)}))" to the impl.`,
        });
      }

      // If the receiver type pattern contains SomeTypes, check if they have the negated constraint
      // If they don't have the negated constraint in whereConstraints, we can't guarantee they won't implement it
      // For now, we allow this and rely on runtime checks when concrete types are substituted
    }
  }
}

/**
 * Get the bound value of a SomeType from the environment.
 * Returns the SomeType itself if not bound.
 */
function getValueOfSomeTypeFromEnvForGenericImpl(
  env: Environment,
  someType: SomeType
): Type {
  // Search from the most recent frame to the oldest
  for (let i = env.frames.length - 1; i >= 0; i--) {
    const frame = env.frames[i]!;
    for (const variable of frame.variables) {
      if (variable.name === someType.name && variable.value) {
        if (isTypeValue(variable.value[0])) {
          return variable.value[0].value;
        }
      }
    }
  }
  return someType;
}

/**
 * Clear all impl fields from types that were added by the specified trait.
 * Call this before re-evaluating a trait to prevent duplicate impls.
 */
export function clearImplsFromModule(modulePath: string): void {
  const typesWithImpls = implRegistry.get(modulePath);
  if (!typesWithImpls) {
    return;
  }

  for (const traitType of typesWithImpls) {
    traitType.fields = traitType.fields.filter(
      (field) => field.sourceModulePath !== modulePath
    );
  }

  implRegistry.delete(modulePath);

  // Also clear the duplicate detection registry for this trait
  clearImplRecordsFromModule(modulePath);
}

/**
 * Register that a type has an impl field from the specified trait.
 */
function registerImpl(modulePath: string, traitType: TraitType): void {
  let types = implRegistry.get(modulePath);
  if (!types) {
    types = new Set();
    implRegistry.set(modulePath, types);
  }
  types.add(traitType);
}

/**
 * Attach a trait value to a receiver type's trait.
 * For anonymous modules (begin blocks), flatten the fields directly.
 * For named modules, attach with an empty label for method lookup.
 *
 * Note: clearImplsFromModule should be called before re-evaluating a trait
 * to remove old impls. This function just adds the new impl.
 */
function attachTraitToReceiverType(
  traitValue: TraitValue,
  expr: Expr,
  sourceModulePath?: string
): void {
  const receiverType = traitValue.type.receiverType;
  if (!receiverType || !receiverType.trait) {
    return;
  }

  // Check for duplicate impl (only for named modules, not anonymous ones)
  if (traitValue.type.typeName) {
    // Check orphan rule
    checkOrphanRule({
      receiverType,
      traitType: traitValue.type,
      currentModulePath: sourceModulePath,
      expr,
    });

    // Check for duplicate impl
    checkDuplicateImpl({
      receiverType,
      traitType: traitValue.type,
      currentModulePath: sourceModulePath,
      expr,
    });

    // Register this impl for duplicate detection
    registerImplForType({
      receiverType,
      traitType: traitValue.type,
      currentModulePath: sourceModulePath,
      expr,
    });
  }

  // Register this impl for cleanup on re-evaluation
  if (sourceModulePath) {
    registerImpl(sourceModulePath, receiverType.trait);
  }

  // Check if this is an anonymous trait (no typeName) - flatten its fields
  if (!traitValue.type.typeName) {
    // Flatten the trait's fields directly onto the receiver type's trait
    for (let i = 0; i < traitValue.type.fields.length; i++) {
      const field = traitValue.type.fields[i]!;
      const value = traitValue.fields[i];

      const newField: TraitField = {
        label: field.label,
        type: field.type,
        isCompileTimeOnly: field.isCompileTimeOnly,
        assignedValue: value,
        sourceModulePath,
        exprs: {
          expr,
        },
      };

      receiverType.trait.fields.push(newField);
    }
  } else {
    // Named trait - attach with empty label for method lookup
    const field: TraitField = {
      label: "", // Empty label prevents direct access, only method calls work
      type: createTypeHierarchy(1), // Trait type
      isCompileTimeOnly: true,
      assignedValue: traitValue,
      sourceModulePath,
      exprs: {
        expr,
      },
    };

    // Add the field to the receiver type's trait
    receiverType.trait.fields.push(field);
  }
}

export function evaluateModuleValue({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.impl)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "impl", got:\n${exprToString(expr)}`,
    });
  }

  // Anonymous module value
  if (
    expr.args.length === 1 &&
    exprIsFunctionCall(expr.args[0]) &&
    exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.begin)
  ) {
    const beginExprs = expr.args[0]!.args;
    const {
      moduleType,
      moduleValue,
      env: nextEnv,
    } = evaluateAnonymousModuleBeginExprs({
      beginExprs,
      env,
      context: {
        ...context,
        expectedType: undefined,
        SelfType: context.SelfType,
      },
    });
    env = nextEnv;

    // Set the module value to the expr
    expr.$ = {
      env,
      type: moduleType,
      value: moduleValue,
      pathCollection: [],
    };

    return expr;
  }
  // Impl a trait for a type
  else if (expr.args.length === 2) {
    const receiverTypeArg = expr.args[0]!;
    const moduleCallArg = expr.args[1]!;

    // Evaluate the receiver type
    const evaluatedReceiverTypeArg = evaluateExpression({
      expr: receiverTypeArg,
      env,
      context: {
        ...context,
      },
    });

    // Expect the receiver type to be a type
    if (
      !evaluatedReceiverTypeArg.$ ||
      !evaluatedReceiverTypeArg.$.value ||
      !isTypeValue(evaluatedReceiverTypeArg.$.value)
    ) {
      throw formatErrorMessage({
        token: receiverTypeArg.token,
        errorMessage: `Expected type for receiver type argument.`,
      });
    }
    env = evaluatedReceiverTypeArg.$.env;
    const receiverType = evaluatedReceiverTypeArg.$.value.value;

    // Check if the receiver type is a structural type (SliceType, ArrayType)
    // For structural types, we need to register as a generic impl so they can be matched structurally
    // because each [u8] or Array(u8, 10) creates a new type instance
    const isStructuralType =
      isSliceType(receiverType) || isArrayType(receiverType);

    // Anonymous trait value
    if (
      exprIsFunctionCall(expr.args[1]) &&
      exprIsFunctionCallOf(expr.args[1], BuiltinKeywords.begin)
    ) {
      // Restrict anonymous trait impl to prelude.yo only
      // if (!context.currentModulePath?.endsWith("prelude.yo")) {
      //   throw formatErrorMessage({
      //     token: expr.token,
      //     errorMessage: `impl a receiver type with anonymous trait (begin block) is only allowed in prelude.yo`,
      //   });
      // }

      const beginExprs = expr.args[1]!.args;
      const {
        traitType,
        traitValue,
        env: nextEnv,
      } = evaluateAnonymousTraitBeginExprs({
        beginExprs,
        env,
        context: {
          ...context,
          expectedType: undefined,
          SelfType: undefined, // QUESTION: Should we pass receiverType here?
        },
        receiverType,
      });
      env = nextEnv;

      // Attach the anonymous trait to the receiver type
      attachTraitToReceiverType(traitValue, expr, context.currentModulePath);

      // Set the trait value to the expr
      expr.$ = {
        env,
        type: traitType,
        value: traitValue,
        pathCollection: [],
      };

      return expr;
    } else {
      // Evaluate the trait call
      const evaluatedTraitCallArg = evaluateExpression({
        expr: moduleCallArg,
        env,
        context: {
          ...context,
          expectedType: undefined,
          ReceiverType: receiverType,
        },
      });
      // Expect the trait call to be a trait value
      if (
        !evaluatedTraitCallArg.$ ||
        !isTraitValue(evaluatedTraitCallArg.$.value)
      ) {
        throw formatErrorMessage({
          token: moduleCallArg.token,
          errorMessage: `Expected trait value for trait call argument.`,
        });
      }
      env = evaluatedTraitCallArg.$.env;
      const traitValue = evaluatedTraitCallArg.$.value;
      const traitType = traitValue.type;

      // Check that the receiver type implements all selfConstraints from the trait's where clause
      checkTypeImplementsSelfConstraints({
        targetType: receiverType,
        traitType: traitValue.type,
        env,
        errorToken: expr.token,
      });

      if (isStructuralType) {
        // Register as a generic impl (with no forall parameters) for structural matching
        const traitTypeKey = traitType.typeName || traitType.id;
        const genericImpl: GenericImpl = {
          forallParameters: [],
          whereConstraints: [],
          receiverTypePattern: receiverType,
          traitType,
          traitValue,
          expr,
          sourceModulePath: context.currentModulePath,
          definitionEnv: env,
        };
        registerGenericImpl(traitTypeKey, genericImpl);
      } else {
        // Attach the trait to the receiver type for method lookup
        attachTraitToReceiverType(traitValue, expr, context.currentModulePath);
      }

      // Set the trait value to the expr
      expr.$ = {
        env,
        type: evaluatedTraitCallArg.$.type,
        value: traitValue,
        pathCollection: [],
      };

      return expr;
    }
  }
  // Generic impl with forall: impl(forall(...), ReceiverTypePattern, Module(...))
  // or with where: impl(forall(...), where(...), ReceiverTypePattern, Module(...))
  else if (expr.args.length === 3 || expr.args.length === 4) {
    const firstArg = expr.args[0]!;

    // First argument must be forall(...)
    if (
      !exprIsFunctionCall(firstArg) ||
      !exprIsFunctionCallOf(firstArg, BuiltinKeywords.forall)
    ) {
      throw formatErrorMessage({
        token: firstArg.token,
        errorMessage: `Expected forall(...) as first argument in generic impl, got: ${exprToString(firstArg)}`,
      });
    }

    // Determine if we have a where clause
    let hasWhere = false;
    let whereArg: FnCallExpr | undefined;
    let receiverTypeArg: Expr;
    let moduleCallArg: Expr;

    if (expr.args.length === 4) {
      const secondArg = expr.args[1]!;
      if (
        !exprIsFunctionCall(secondArg) ||
        !exprIsFunctionCallOf(secondArg, BuiltinKeywords.where)
      ) {
        throw formatErrorMessage({
          token: secondArg.token,
          errorMessage: `Expected where(...) as second argument in 4-argument generic impl, got: ${exprToString(secondArg)}`,
        });
      }
      hasWhere = true;
      whereArg = secondArg;
      receiverTypeArg = expr.args[2]!;
      moduleCallArg = expr.args[3]!;
    } else {
      // 3-argument case: check if second arg is where
      const secondArg = expr.args[1]!;
      if (
        exprIsFunctionCall(secondArg) &&
        exprIsFunctionCallOf(secondArg, BuiltinKeywords.where)
      ) {
        throw formatErrorMessage({
          token: secondArg.token,
          errorMessage: `impl with where clause requires 4 arguments: impl(forall(...), where(...), ReceiverType, Module(...))`,
        });
      }
      receiverTypeArg = secondArg;
      moduleCallArg = expr.args[2]!;
    }

    // Parse forall parameters and create SomeTypes or unknown values
    const forallParamExprs = firstArg.args;
    const forallParameters: ForallParameter[] = [];

    // Create a new env frame for forall parameters
    env = pushEnvFrame(env);

    for (const paramExpr of forallParamExprs) {
      // Parse parameter expression: T : Type or just T
      let paramName: string;
      let paramTypeExpr: Expr | undefined;

      if (
        exprIsFunctionCall(paramExpr) &&
        exprIsFunctionCallOf(paramExpr, ":", 2)
      ) {
        // T : Type form
        const nameExpr = paramExpr.args[0]!;
        if (!exprIsAtom(nameExpr)) {
          throw formatErrorMessage({
            token: nameExpr.token,
            errorMessage: `Expected identifier for forall parameter name, got: ${exprToString(nameExpr)}`,
          });
        }
        paramName = nameExpr.token.value;
        paramTypeExpr = paramExpr.args[1]!;
      } else if (exprIsAtom(paramExpr)) {
        // Just T form
        paramName = paramExpr.token.value;
      } else {
        throw formatErrorMessage({
          token: paramExpr.token,
          errorMessage: `Expected parameter name or "name : Type" for forall parameter, got: ${exprToString(paramExpr)}`,
        });
      }

      // Evaluate the type expression if present
      let paramType: Type | undefined;
      if (paramTypeExpr) {
        const evaluatedType = evaluateExpression({
          expr: paramTypeExpr,
          env,
          context: { ...context },
        });
        if (evaluatedType.$?.env) {
          env = evaluatedType.$.env;
        }
        // Verify it's a type
        if (
          !evaluatedType.$ ||
          !evaluatedType.$.value ||
          !isTypeValue(evaluatedType.$.value)
        ) {
          throw formatErrorMessage({
            token: paramTypeExpr.token,
            errorMessage: `Expected type for forall parameter type, got: ${exprToString(paramTypeExpr)}`,
          });
        }
        paramType = evaluatedType.$.value.value;
      }

      // Check if this is a Type parameter or a value parameter
      const isTypeParam = !paramType || isType0(paramType);
      const effectiveType = paramType || createType0();

      // createUnknownValue handles both cases:
      // - For Type0: creates SomeType wrapped in TypeValue
      // - For other types: creates UnknownValue
      const unknownOrTypeValue = createUnknownValue(effectiveType, {
        variableName: paramName,
        env,
        context,
      });

      // Add to environment
      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: paramName,
          type: effectiveType,
          isCompileTimeOnly: true,
          value: [unknownOrTypeValue],
          token: paramExpr.token,
          initializedAtToken: paramExpr.token,
          consumedAtToken: undefined,
          isOwningTheRcValue: false,
        },
      });
      env = nextEnv;

      if (isTypeParam) {
        // Type parameter: extract the SomeType from the TypeValue
        const someType = (unknownOrTypeValue as TypeValue).value as SomeType;
        forallParameters.push({ kind: "type", name: paramName, someType });
      } else {
        // Value parameter
        forallParameters.push({
          kind: "value",
          name: paramName,
          type: effectiveType,
          unknownValue: unknownOrTypeValue as UnknownValue,
        });
      }
    }

    // Parse where constraints if present
    // The <: operator with isInsideWhereClause will attach constraints to SomeType's trait

    if (hasWhere && whereArg) {
      for (const constraintExpr of whereArg.args) {
        // Each constraint must be of the form: T <: Module
        if (
          !exprIsFunctionCall(constraintExpr) ||
          !exprIsFunctionCallOf(constraintExpr, "<:", 2)
        ) {
          throw formatErrorMessage({
            token: constraintExpr.token,
            errorMessage: `Expected constraint in the form "T <: Module", got: ${exprToString(constraintExpr)}`,
          });
        }

        // Evaluate with isInsideWhereClause context
        // This will attach the trait constraint to the SomeType's trait fields
        const evaluated = evaluateExpression({
          expr: constraintExpr,
          env,
          context: {
            ...context,
            isInsideWhereClause: true,
          },
        });
        if (evaluated.$?.env) {
          env = evaluated.$.env;
        }
      }
    }

    // Collect where constraints from the SomeTypes' trait fields
    const whereConstraints: {
      someType: SomeType;
      traitType: TraitType;
      traitExpr?: Expr;
    }[] = [];
    for (const param of forallParameters) {
      // Only type parameters have SomeTypes with constraints
      if (param.kind !== "type") continue;
      const { someType } = param;
      for (const field of someType.trait.fields) {
        if (
          field.assignedValue &&
          isTypeValue(field.assignedValue) &&
          isTraitType(field.assignedValue.value)
        ) {
          whereConstraints.push({
            someType,
            traitType: field.assignedValue.value,
            traitExpr: field.exprs?.expr,
          });
        }
      }
    }

    // Evaluate the receiver type pattern with SomeTypes in scope
    const evaluatedReceiverTypeArg = evaluateExpression({
      expr: receiverTypeArg,
      env,
      context: { ...context },
    });

    if (
      !evaluatedReceiverTypeArg.$ ||
      !evaluatedReceiverTypeArg.$.value ||
      !isTypeValue(evaluatedReceiverTypeArg.$.value)
    ) {
      throw formatErrorMessage({
        token: receiverTypeArg.token,
        errorMessage: `Expected type for receiver type pattern.`,
      });
    }
    env = evaluatedReceiverTypeArg.$.env;
    const receiverTypePattern = evaluatedReceiverTypeArg.$.value.value;

    // Handle anonymous trait value (begin block) or trait call
    let traitValue: TraitValue;
    let traitType: TraitType;

    if (
      exprIsFunctionCall(moduleCallArg) &&
      exprIsFunctionCallOf(moduleCallArg, BuiltinKeywords.begin)
    ) {
      // Restrict anonymous trait impl to prelude.yo only
      // if (!context.currentModulePath?.endsWith("prelude.yo")) {
      //   throw formatErrorMessage({
      //     token: expr.token,
      //     errorMessage: `impl a receiver type with anonymous trait (begin block) is only allowed in prelude.yo`,
      //   });
      // }

      // Anonymous trait value
      const beginExprs = moduleCallArg.args;
      const result = evaluateAnonymousTraitBeginExprs({
        beginExprs,
        env,
        context: {
          ...context,
          expectedType: undefined,
          SelfType: undefined, // QUESTION: Should we pass receiverTypePattern here?
        },
        receiverType: receiverTypePattern,
      });
      env = result.env;
      traitType = result.traitType;
      traitValue = result.traitValue;
    } else {
      // Evaluate the trait call
      const evaluatedTraitCallArg = evaluateExpression({
        expr: moduleCallArg,
        env,
        context: {
          ...context,
          expectedType: undefined,
          ReceiverType: receiverTypePattern,
        },
      });

      if (
        !evaluatedTraitCallArg.$ ||
        !isTraitValue(evaluatedTraitCallArg.$.value)
      ) {
        throw formatErrorMessage({
          token: moduleCallArg.token,
          errorMessage: `Expected trait value for trait call argument.`,
        });
      }
      env = evaluatedTraitCallArg.$.env;
      traitValue = evaluatedTraitCallArg.$.value;
      traitType = traitValue.type;
    }

    // Extract trait type argument expressions for later re-evaluation during specialization
    // For Eq(Box(T))(...), we want to extract [Box(T)] and ["Rhs"]
    let traitTypeArgExprs: Expr[] | undefined;
    let traitFunctionParamNames: string[] | undefined;
    if (exprIsFunctionCall(moduleCallArg)) {
      // moduleCallArg is like Eq(Box(T))(...) - the func is Eq(Box(T))
      const traitTypeCallExpr = moduleCallArg.func;
      if (exprIsFunctionCall(traitTypeCallExpr)) {
        // traitTypeCallExpr is Eq(Box(T)) - args are [Box(T)]
        traitTypeArgExprs = traitTypeCallExpr.args.map((arg) => cloneExpr(arg));
        // Get parameter names from the trait's function type
        // Eq has signature (fn(comptime(Rhs) : Type) -> comptime(Trait)) so Rhs is a regular parameter
        if (
          traitType.functionValue &&
          isFunctionType(traitType.functionValue.type)
        ) {
          // Try regular parameters first (for comptime parameters like Rhs in Eq)
          const funcType = traitType.functionValue.type;
          if (funcType.parameters.length > 0) {
            traitFunctionParamNames = funcType.parameters.map((p) => p.label);
          } else if (funcType.forallParameters.length > 0) {
            // Fallback to forall parameters
            traitFunctionParamNames = funcType.forallParameters.map(
              (p) => p.label
            );
          }
        }
      }
    }

    // Check that the receiver type pattern satisfies the trait's self-constraints
    // For generic impls, we need to verify that the where constraints are sufficient
    // to satisfy the trait's requirements
    checkGenericImplSelfConstraints({
      receiverTypePattern,
      traitType,
      whereConstraints,
      env,
      errorToken: expr.token,
    });

    // Pop the forall env frame
    env = popEnvFrame(env);

    // Get the trait type key for registry (use typeName if available, otherwise id)
    const traitTypeKey = traitType.typeName || traitType.id;

    // Register the generic impl
    const genericImpl: GenericImpl = {
      forallParameters,
      whereConstraints,
      receiverTypePattern,
      traitType,
      traitValue,
      expr,
      sourceModulePath: context.currentModulePath,
      definitionEnv: env, // Store the environment where the impl was defined
      traitTypeArgExprs,
      traitFunctionParamNames,
    };

    registerGenericImpl(traitTypeKey, genericImpl);

    // Set the trait value to the expr
    expr.$ = {
      env,
      type: traitType,
      value: traitValue,
      pathCollection: [],
    };

    return expr;
  } else {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Invalid "impl" call, expected a "begin" block, got:\n${exprToString(expr)}`,
    });
  }
}
