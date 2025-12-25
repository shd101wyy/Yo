import {
  addVariableToEnv,
  Environment,
  getVariablesFromEnv,
  isEvaluatingPreludeModule,
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
  FuncCallExpr,
} from "../../expr";
import { FunctionValue } from "../../function-value";
import { PlaceholderToken, Token } from "../../token";
import { TypeValue } from "../../type-value";
import {
  createType0,
  createTypeHierarchy,
  FunctionParameter,
  FunctionType,
  isArrayType,
  isComptListType,
  isEnumType,
  isFunctionType,
  isFutureModuleType,
  isIsoType,
  isModuleType,
  isPtrType,
  isSliceType,
  isSomeType,
  isStructType,
  isTupleType,
  isType0,
  isUnionType,
  ModuleField,
  ModuleType,
  SomeType,
  Type,
  typeToString,
} from "../../types";
import {
  createTypeValue,
  createUnknownValue,
  isFunctionValue,
  isModuleValue,
  isTypeValue,
  isUnknownValue,
  ModuleValue,
  UnknownValue,
  Value,
  valueToString,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "../exprs/begin";
import { evaluateExpression } from "../exprs/expr";
import {
  checkTypeImplementsSelfConstraints,
  typeImplementsModule,
} from "../exprs/subtype_of";
import { synthesizeTypes } from "../types/synthesizer";
import { evaluateAnonymousModuleBeginExprs } from "../values/anonymous_module";

/**
 * Registry of types that have impl fields from a specific module path.
 * This allows cleanup when a module is re-evaluated or deleted.
 */
const implRegistry: Map<string, Set<ModuleType>> = new Map();

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
  whereConstraints: { someType: SomeType; moduleType: ModuleType }[];
  /** The receiver type pattern containing SomeTypes (e.g., Data(T)) */
  receiverTypePattern: Type;
  /** The module type being implemented (e.g., Copy) */
  moduleType: ModuleType;
  /** The module value */
  moduleValue: ModuleValue;
  /** The expr that created this impl */
  expr: Expr;
  /** The source module path for cleanup on re-evaluation */
  sourceModulePath?: string;
  /** The environment where the impl was defined (for accessing non-exported variables like extern functions) */
  definitionEnv: Environment;
}

/**
 * Registry of generic impls keyed by module type name.
 * This allows lookup when checking if a concrete type implements a module.
 */
const genericImplRegistry: Map<string, GenericImpl[]> = new Map();

/**
 * Registry tracking which modules are implemented for which types.
 * Maps from type id to an array of impl records.
 * Used for duplicate impl detection.
 */
interface ImplRecord {
  moduleTypeId: string;
  moduleTypeName?: string;
  modulePath: string;
  expr: Expr;
}
const typeImplRegistry: Map<string, ImplRecord[]> = new Map();

/**
 * Clear all generic impls from the registry that were added by the specified module.
 * Call this before re-evaluating a module to prevent duplicate impls.
 */
export function clearGenericImplsFromModule(modulePath: string): void {
  for (const [moduleTypeName, impls] of genericImplRegistry.entries()) {
    const filteredImpls = impls.filter(
      (impl) => impl.sourceModulePath !== modulePath
    );
    if (filteredImpls.length === 0) {
      genericImplRegistry.delete(moduleTypeName);
    } else {
      genericImplRegistry.set(moduleTypeName, filteredImpls);
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
  moduleTypeName: string,
  genericImpl: GenericImpl
): void {
  let impls = genericImplRegistry.get(moduleTypeName);
  if (!impls) {
    impls = [];
    genericImplRegistry.set(moduleTypeName, impls);
  }
  impls.push(genericImpl);
}

/**
 * Check if a module is already implemented for a type.
 * Throws an error if duplicate impl is detected.
 */
function checkDuplicateImpl({
  receiverType,
  moduleType,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  currentModulePath,
  expr,
}: {
  receiverType: Type;
  moduleType: ModuleType;
  currentModulePath: string | undefined;
  expr: Expr;
}): void {
  const typeId = receiverType.id;
  const impls = typeImplRegistry.get(typeId) || [];

  const existing = impls.find((impl) => impl.moduleTypeId === moduleType.id);
  if (existing) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage:
        `Module "${moduleType.typeName ?? moduleType.id}" is already implemented for type "${typeToString(receiverType)}".\n` +
        `First implementation was in: ${existing.modulePath || "unknown"}`,
    });
  }
}

/**
 * Register that a module has been implemented for a type.
 */
function registerImplForType({
  receiverType,
  moduleType,
  currentModulePath,
  expr,
}: {
  receiverType: Type;
  moduleType: ModuleType;
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
    moduleTypeId: moduleType.id,
    moduleTypeName: moduleType.typeName,
    modulePath: currentModulePath || "unknown",
    expr,
  });
}

/**
 * Check orphan rule: at least one of the module or the type must be defined in the current module.
 * Throws an error if the orphan rule is violated.
 */
function checkOrphanRule({
  receiverType,
  moduleType,
  currentModulePath,
  expr,
}: {
  receiverType: Type;
  moduleType: ModuleType;
  currentModulePath: string | undefined;
  expr: Expr;
}): void {
  // If we don't have a current module path, we can't check the orphan rule
  // This happens for top-level code or tests - allow it
  if (!currentModulePath) {
    return;
  }

  const moduleDefinedHere =
    moduleType.definedInModulePath === currentModulePath;
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
        `Orphan impl: Cannot implement foreign module "${moduleType.typeName ?? moduleType.id}" for foreign type "${typeToString(receiverType)}".\n` +
        `At least one of the module or the type must be defined in this module.\n` +
        `Module defined in: ${moduleType.definedInModulePath || "unknown"}\n` +
        `Type defined in: ${receiverType.definedInModulePath || "unknown"}\n` +
        `Current module: ${currentModulePath}`,
    });
  }
}

/**
 * Find a matching generic impl for a concrete type and module type.
 * Returns the matched impl if found, or undefined if no match.
 */
export function findMatchingGenericImpl({
  concreteType,
  moduleType,
  env,
}: {
  concreteType: Type;
  moduleType: ModuleType;
  env: Environment;
}): GenericImpl | undefined {
  // Use typeName if available, otherwise fall back to id for anonymous modules
  const moduleTypeKey = moduleType.typeName || moduleType.id;

  const impls = genericImplRegistry.get(moduleTypeKey);
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
  const methods: { type: FunctionType; value: Value | undefined }[] = [];

  // Search through all module types in the registry
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
      const moduleType = impl.moduleType;
      const moduleValue = impl.moduleValue;

      const methodIndex = moduleType.fields.findIndex(
        (f) => f.label === methodName && isFunctionType(f.type)
      );

      if (methodIndex >= 0) {
        const method = moduleType.fields[methodIndex]!;
        if (isFunctionType(method.type)) {
          // Get the actual function value from the module value
          const originalValue = moduleValue.fields[methodIndex];
          // Substitute Self and type parameters with concrete types
          const specializedType = substituteInFunctionType(
            method.type,
            match.substitutions,
            match.valueSubstitutions
          );

          // If it's a function value, we need to:
          // 1. Clone the function body
          // 2. Create an environment with value/type substitutions bound
          // 3. Re-evaluate the body to get correct type annotations
          // 4. Create the specialized function value with the re-evaluated body
          //
          // NOTE: We re-evaluate when there are VALUE substitutions OR TYPE substitutions.
          // Type substitutions need re-evaluation so that expressions like `__yo_iso_extract(self)`
          // get the correct specialized types (e.g., Iso(Box(i32)) instead of Iso(T)).
          let value: Value | undefined = originalValue;
          if (
            isFunctionValue(originalValue) &&
            (match.valueSubstitutions.size > 0 || match.substitutions.size > 0)
          ) {
            // Clone the function body for re-evaluation
            const clonedBody = cloneExpr(originalValue.body);

            // Use the environment where the impl was originally defined
            // This ensures access to non-exported variables (like extern "Yo" functions)
            // that were available when the impl was created
            const baseEnv = impl.definitionEnv;

            // Create a specialized environment with the specialized function parameters
            // Push the parametersFrame which contains the function parameters (like `self`)
            let specializedEnv = pushEnvFrame(
              baseEnv,
              specializedType.parametersFrame
            );

            // Add value substitutions (compile-time values like U=3)
            for (const [paramName, paramValue] of match.valueSubstitutions) {
              const { env: nextEnv } = addVariableToEnv({
                env: specializedEnv,
                variable: {
                  name: paramName,
                  type: paramValue.type,
                  isCompileTimeOnly: true,
                  value: paramValue,
                  token: PlaceholderToken,
                  initializedAtToken: PlaceholderToken,
                  consumedAtToken: undefined,
                  isOwningTheGcValue: false,
                },
              });
              specializedEnv = nextEnv;
            }

            // Also add type substitutions to the environment (like T=Box(i32))
            for (const [paramName, paramType] of match.substitutions) {
              if (paramName !== "Self") {
                const { env: nextEnv } = addVariableToEnv({
                  env: specializedEnv,
                  variable: {
                    name: paramName,
                    type: createType0(),
                    isCompileTimeOnly: true,
                    value: createTypeValue(paramType),
                    token: PlaceholderToken,
                    initializedAtToken: PlaceholderToken,
                    consumedAtToken: undefined,
                    isOwningTheGcValue: false,
                  },
                });
                specializedEnv = nextEnv;
              }
            }

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
              } as EvaluatorContext,
              variablesToAdd: [],
              isEvaluatingFunctionBodyBeginBlock: true,
            });

            // Update specializedType with the body's actual return type
            // The re-evaluated body will have the correct concrete types from the type registry
            // while substituteInFunctionType creates types with the wrong IDs
            let finalSpecializedType = specializedType;
            if (specializedBody.$?.type) {
              finalSpecializedType = {
                ...specializedType,
                return: {
                  ...specializedType.return,
                  type: specializedBody.$.type,
                },
              };
            }

            // Create a specialized function value with the re-evaluated body
            const specializedFunctionValue: FunctionValue = {
              ...originalValue,
              specializedType: finalSpecializedType,
              body: specializedBody,
              // Create a unique funcId for this specialization (include both type and value substitutions)
              funcId: `${originalValue.funcId}_specialized_${[...match.substitutions.entries()].map(([k, v]) => `${k}_${typeToString(v)}`).join("_")}_${[...match.valueSubstitutions.entries()].map(([k, v]) => `${k}_${valueToString(v)}`).join("_")}`,
              funcName: originalValue.funcName
                ? `${originalValue.funcName}_specialized`
                : undefined,
            };
            value = specializedFunctionValue;

            // Also update the type pushed to methods
            methods.push({ type: finalSpecializedType, value });
          } else if (isFunctionValue(originalValue)) {
            // No substitutions needed, just set the specialized type
            const specializedFunctionValue: FunctionValue = {
              ...originalValue,
              specializedType: specializedType,
            };
            value = specializedFunctionValue;
            methods.push({ type: specializedType, value });
          } else {
            methods.push({ type: specializedType, value });
          }
        }
      }
    }
  }

  return methods;
}

/**
 * Find a method from a generic impl for a specific module type and concrete receiver type.
 * This is used when accessing methods on a `<:` expression like `(Box(i32) <: Isolation).can_isolate`.
 * Returns the specialized method type and value if found.
 */
export function findMethodFromGenericImplForModule({
  concreteType,
  moduleType,
  methodName,
  env,
}: {
  concreteType: Type;
  moduleType: ModuleType;
  methodName: string;
  env: Environment;
}): { type: FunctionType; value: Value | undefined } | undefined {
  // Use typeName if available, otherwise fall back to id for anonymous modules
  const moduleTypeKey = moduleType.typeName || moduleType.id;

  const impls = genericImplRegistry.get(moduleTypeKey);
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
    const implModuleType = impl.moduleType;
    const implModuleValue = impl.moduleValue;

    const methodIndex = implModuleType.fields.findIndex(
      (f) => f.label === methodName && isFunctionType(f.type)
    );

    if (methodIndex >= 0) {
      const method = implModuleType.fields[methodIndex]!;
      if (isFunctionType(method.type)) {
        // Get the actual function value from the module value
        const originalValue = implModuleValue.fields[methodIndex];
        // Substitute Self and type parameters with concrete types
        const specializedType = substituteInFunctionType(
          method.type,
          match.substitutions,
          match.valueSubstitutions
        );

        // If it's a function value, we need to re-evaluate with concrete substitutions
        let value: Value | undefined = originalValue;
        if (
          isFunctionValue(originalValue) &&
          (match.valueSubstitutions.size > 0 || match.substitutions.size > 0)
        ) {
          // Clone the function body for re-evaluation
          const clonedBody = cloneExpr(originalValue.body);

          // Use the environment where the impl was originally defined
          const baseEnv = impl.definitionEnv;

          // Create a specialized environment with the specialized function parameters
          let specializedEnv = pushEnvFrame(
            baseEnv,
            specializedType.parametersFrame
          );

          // Add value substitutions (compile-time values like U=3)
          for (const [paramName, paramValue] of match.valueSubstitutions) {
            const { env: nextEnv } = addVariableToEnv({
              env: specializedEnv,
              variable: {
                name: paramName,
                type: paramValue.type,
                isCompileTimeOnly: true,
                value: paramValue,
                token: PlaceholderToken,
                initializedAtToken: PlaceholderToken,
                consumedAtToken: undefined,
                isOwningTheGcValue: false,
              },
            });
            specializedEnv = nextEnv;
          }

          // Also add type substitutions to the environment (like T=Box(i32))
          for (const [paramName, paramType] of match.substitutions) {
            if (paramName !== "Self") {
              const { env: nextEnv } = addVariableToEnv({
                env: specializedEnv,
                variable: {
                  name: paramName,
                  type: createType0(),
                  isCompileTimeOnly: true,
                  value: createTypeValue(paramType),
                  token: PlaceholderToken,
                  initializedAtToken: PlaceholderToken,
                  consumedAtToken: undefined,
                  isOwningTheGcValue: false,
                },
              });
              specializedEnv = nextEnv;
            }
          }

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
            } as EvaluatorContext,
            variablesToAdd: [],
            isEvaluatingFunctionBodyBeginBlock: true,
          });

          // Update specializedType with the body's actual return type
          let finalSpecializedType = specializedType;
          if (specializedBody.$?.type) {
            finalSpecializedType = {
              ...specializedType,
              return: {
                ...specializedType.return,
                type: specializedBody.$.type,
              },
            };
          }

          // Create a specialized function value with the re-evaluated body
          const specializedFunctionValue: FunctionValue = {
            ...originalValue,
            specializedType: finalSpecializedType,
            body: specializedBody,
            funcId: `${originalValue.funcId}_specialized_${[...match.substitutions.entries()].map(([k, v]) => `${k}_${typeToString(v)}`).join("_")}_${[...match.valueSubstitutions.entries()].map(([k, v]) => `${k}_${valueToString(v)}`).join("_")}`,
            funcName: originalValue.funcName
              ? `${originalValue.funcName}_specialized`
              : undefined,
          };
          value = specializedFunctionValue;

          return { type: finalSpecializedType, value };
        } else if (isFunctionValue(originalValue)) {
          // No substitutions needed, just set the specialized type
          const specializedFunctionValue: FunctionValue = {
            ...originalValue,
            specializedType: specializedType,
          };
          value = specializedFunctionValue;
          return { type: specializedType, value };
        } else {
          return { type: specializedType, value };
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
 * Apply type substitutions to a Type recursively.
 * Substitutes SomeTypes whose name matches a key in the substitutions map.
 * Also substitutes value parameters (for array lengths, etc.).
 */
function substituteInType(
  type: Type,
  substitutions: Map<string, Type>,
  valueSubstitutions: Map<string, Value> = new Map()
): Type {
  if (isSomeType(type)) {
    const substitute = substitutions.get(type.name);
    if (substitute) {
      return substitute;
    }
    return type;
  }

  if (isPtrType(type)) {
    const newChildType = substituteInType(
      type.childType,
      substitutions,
      valueSubstitutions
    );
    if (newChildType === type.childType) {
      return type;
    }
    return { ...type, childType: newChildType } as Type;
  }

  if (isArrayType(type)) {
    const newChildType = substituteInType(
      type.childType,
      substitutions,
      valueSubstitutions
    );
    // Also substitute the array length if it's an UnknownValue with a variable name
    let newLength = type.length;
    if (isUnknownValue(type.length) && type.length.variableName) {
      const substituteLength = valueSubstitutions.get(type.length.variableName);
      if (substituteLength) {
        newLength = substituteLength;
      }
    }
    if (newChildType === type.childType && newLength === type.length) {
      return type;
    }
    return { ...type, childType: newChildType, length: newLength } as Type;
  }

  if (isSliceType(type)) {
    const newChildType = substituteInType(
      type.childType,
      substitutions,
      valueSubstitutions
    );
    if (newChildType === type.childType) {
      return type;
    }
    return { ...type, childType: newChildType } as Type;
  }

  if (isComptListType(type)) {
    const newChildType = substituteInType(
      type.childType,
      substitutions,
      valueSubstitutions
    );
    if (newChildType === type.childType) {
      return type;
    }
    return { ...type, childType: newChildType } as Type;
  }

  if (isTupleType(type)) {
    let changed = false;
    const newFields = type.fields.map((f) => {
      const newType = substituteInType(
        f.type,
        substitutions,
        valueSubstitutions
      );
      if (newType !== f.type) {
        changed = true;
        return { ...f, type: newType };
      }
      return f;
    });
    if (!changed) {
      return type;
    }
    return { ...type, fields: newFields } as Type;
  }

  if (isStructType(type)) {
    let changed = false;
    const newFields = type.fields.map((f) => {
      const newType = substituteInType(
        f.type,
        substitutions,
        valueSubstitutions
      );
      if (newType !== f.type) {
        changed = true;
        return { ...f, type: newType };
      }
      return f;
    });
    if (!changed) {
      return type;
    }
    return { ...type, fields: newFields } as Type;
  }

  if (isEnumType(type)) {
    let changed = false;
    const newVariants = type.variants.map((v) => {
      if (!v.fields) {
        return v;
      }
      const newFields = v.fields.map((f) => {
        const newType = substituteInType(
          f.type,
          substitutions,
          valueSubstitutions
        );
        if (newType !== f.type) {
          changed = true;
          return { ...f, type: newType };
        }
        return f;
      });
      if (newFields !== v.fields) {
        return { ...v, fields: newFields };
      }
      return v;
    });
    if (!changed) {
      return type;
    }
    return { ...type, variants: newVariants } as Type;
  }

  if (isUnionType(type)) {
    let changed = false;
    const newFields = type.fields.map((f) => {
      const newType = substituteInType(
        f.type,
        substitutions,
        valueSubstitutions
      );
      if (newType !== f.type) {
        changed = true;
        return { ...f, type: newType };
      }
      return f;
    });
    if (!changed) {
      return type;
    }
    return { ...type, fields: newFields } as Type;
  }

  if (isFutureModuleType(type)) {
    const newChildType = substituteInType(
      type.isFuture.outputType,
      substitutions,
      valueSubstitutions
    );
    if (newChildType === type.isFuture.outputType) {
      return type;
    }
    return { ...type, isFuture: { childType: newChildType } } as Type;
  }

  if (isIsoType(type)) {
    const newChildType = substituteInType(
      type.childType,
      substitutions,
      valueSubstitutions
    );
    if (newChildType === type.childType) {
      return type;
    }
    return { ...type, childType: newChildType } as Type;
  }

  if (isFunctionType(type)) {
    return substituteInFunctionType(type, substitutions, valueSubstitutions);
  }

  return type;
}

/**
 * Apply type substitutions to a FunctionType.
 * This substitutes SomeTypes in parameters and return type.
 * Also substitutes value parameters (for array lengths, etc.).
 */
function substituteInFunctionType(
  functionType: FunctionType,
  substitutions: Map<string, Type>,
  valueSubstitutions: Map<string, Value> = new Map()
): FunctionType {
  let changed = false;

  // Substitute in parameters
  const newParameters: FunctionParameter[] = functionType.parameters.map(
    (p) => {
      const newType = substituteInType(
        p.type,
        substitutions,
        valueSubstitutions
      );
      if (newType !== p.type) {
        changed = true;
        return { ...p, type: newType };
      }
      return p;
    }
  );

  // Substitute in return type
  const newReturnType = substituteInType(
    functionType.return.type,
    substitutions,
    valueSubstitutions
  );
  const returnChanged = newReturnType !== functionType.return.type;

  // Substitute in SelfType if present
  let newSelfType = functionType.SelfType;
  if (functionType.SelfType) {
    newSelfType = substituteInType(
      functionType.SelfType,
      substitutions,
      valueSubstitutions
    );
    if (newSelfType !== functionType.SelfType) {
      changed = true;
    }
  }

  if (!changed && !returnChanged) {
    return functionType;
  }

  // Also update the parametersFrame with substituted types
  // This is critical for body re-evaluation where the frame variables need correct types
  const newParametersFrame = {
    ...functionType.parametersFrame,
    variables: functionType.parametersFrame.variables.map((v) => {
      const newType = substituteInType(
        v.type,
        substitutions,
        valueSubstitutions
      );
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
    return: returnChanged
      ? { ...functionType.return, type: newReturnType, expr: undefined }
      : functionType.return,
    SelfType: newSelfType,
  };
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
          value: createTypeValue(param.someType),
          token: PlaceholderToken,
          initializedAtToken: PlaceholderToken,
          consumedAtToken: undefined,
          isOwningTheGcValue: false,
        },
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
          value: param.unknownValue,
          token: PlaceholderToken,
          initializedAtToken: PlaceholderToken,
          consumedAtToken: undefined,
          isOwningTheGcValue: false,
        },
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
      moduleType: constraintModule,
    } of impl.whereConstraints) {
      // Get the bound type for this SomeType from the unified environment
      const boundType = getValueOfSomeTypeFromEnvForGenericImpl(
        expectedEnv,
        someType
      );
      if (!boundType) {
        return noMatch;
      }

      // Handle negated constraints: the bound type must NOT implement the module
      if (constraintModule.isNegatedConstraint) {
        // If bound to a SomeType, check if it has the negated constraint attached
        if (isSomeType(boundType)) {
          if (
            !someTypeHasNegatedModuleConstraint(boundType, constraintModule)
          ) {
            return noMatch;
          }
          continue;
        }

        // For concrete types, verify they do NOT implement the module
        if (
          typeImplementsModule({
            targetType: boundType,
            moduleType: constraintModule,
            env,
          })
        ) {
          return noMatch;
        }
        continue;
      }

      // If bound to a SomeType, check if it has the required constraint attached
      if (isSomeType(boundType)) {
        if (!someTypeHasModuleConstraint(boundType, constraintModule)) {
          return noMatch;
        }
        continue;
      }

      // Check if the bound type implements the required module
      if (
        !typeImplementsModule({
          targetType: boundType,
          moduleType: constraintModule,
          env,
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
        if (variable && variable.value && !isUnknownValue(variable.value)) {
          valueSubstitutions.set(param.name, variable.value);
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
 * Check if a SomeType has a specific module constraint attached.
 * Used when checking where constraints during generic impl matching.
 */
function someTypeHasModuleConstraint(
  someType: SomeType,
  requiredModule: ModuleType
): boolean {
  const moduleName = requiredModule.typeName;
  if (!moduleName) {
    return false;
  }

  for (const field of someType.module.fields) {
    if (
      field.assignedValue &&
      isTypeValue(field.assignedValue) &&
      isModuleType(field.assignedValue.value)
    ) {
      const constraintModule = field.assignedValue.value;
      // Only match non-negated constraints
      if (
        constraintModule.typeName === moduleName &&
        !constraintModule.isNegatedConstraint
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a SomeType has a specific negated module constraint attached.
 * Used when checking where constraints like `where(T <: !(Copy))`.
 */
function someTypeHasNegatedModuleConstraint(
  someType: SomeType,
  requiredNegatedModule: ModuleType
): boolean {
  const moduleName = requiredNegatedModule.typeName;
  if (!moduleName) {
    return false;
  }

  for (const field of someType.module.fields) {
    if (
      field.assignedValue &&
      isTypeValue(field.assignedValue) &&
      isModuleType(field.assignedValue.value)
    ) {
      const constraintModule = field.assignedValue.value;
      // Only match negated constraints
      if (
        constraintModule.typeName === moduleName &&
        constraintModule.isNegatedConstraint
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check that a generic impl's receiver type pattern satisfies the module's self-constraints.
 * For example, if module Id has `where(Self <: Copy)`, then any impl of Id must ensure
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
  moduleType,
  whereConstraints,
  env,
  errorToken,
}: {
  receiverTypePattern: Type;
  moduleType: ModuleType;
  whereConstraints: { someType: SomeType; moduleType: ModuleType }[];
  env: Environment;
  errorToken: Token;
}): void {
  // Check positive constraints (must implement)
  if (moduleType.selfConstraints && moduleType.selfConstraints.length > 0) {
    for (const constraintModule of moduleType.selfConstraints) {
      // Check if the receiver type pattern implements the constraint
      // This uses typeImplementsModule which will check generic impls
      if (
        typeImplementsModule({
          targetType: receiverTypePattern,
          moduleType: constraintModule,
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
          wc.moduleType.typeName === constraintModule.typeName &&
          !wc.moduleType.isNegatedConstraint
        ) {
          someTypesWithConstraint.add(wc.someType.name);
        }
      }

      // Check if receiver type pattern relies on SomeTypes that have the required constraint
      // For now, we just fail - the typeImplementsModule check should handle this
      // via findMatchingGenericImpl which checks someTypeHasModuleConstraint

      throw formatErrorMessage({
        token: errorToken,
        errorMessage: `Generic impl receiver type "${typeToString(receiverTypePattern)}" does not satisfy constraint "${constraintModule.typeName ?? typeToString(constraintModule)}" required by module "${moduleType.typeName ?? typeToString(moduleType)}".
Consider adding "where(T <: ${constraintModule.typeName ?? typeToString(constraintModule)})" to the impl.`,
      });
    }
  }

  // Check negative constraints (must NOT implement)
  if (
    moduleType.negativeSelfConstraints &&
    moduleType.negativeSelfConstraints.length > 0
  ) {
    for (const constraintModule of moduleType.negativeSelfConstraints) {
      // If the receiver type pattern directly implements the forbidden module, it's an error
      if (
        typeImplementsModule({
          targetType: receiverTypePattern,
          moduleType: constraintModule,
          env,
        })
      ) {
        throw formatErrorMessage({
          token: errorToken,
          errorMessage: `Generic impl receiver type "${typeToString(receiverTypePattern)}" implements "${constraintModule.typeName ?? typeToString(constraintModule)}" but module "${moduleType.typeName ?? typeToString(moduleType)}" requires it to NOT implement this module.
Consider adding "where(T <: !(${constraintModule.typeName ?? typeToString(constraintModule)}))" to the impl.`,
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
        if (isTypeValue(variable.value)) {
          return variable.value.value;
        }
      }
    }
  }
  return someType;
}

/**
 * Clear all impl fields from types that were added by the specified module.
 * Call this before re-evaluating a module to prevent duplicate impls.
 */
export function clearImplsFromModule(modulePath: string): void {
  const typesWithImpls = implRegistry.get(modulePath);
  if (!typesWithImpls) {
    return;
  }

  for (const moduleType of typesWithImpls) {
    moduleType.fields = moduleType.fields.filter(
      (field) => field.sourceModulePath !== modulePath
    );
  }

  implRegistry.delete(modulePath);
}

/**
 * Register that a type has an impl field from the specified module.
 */
function registerImpl(modulePath: string, moduleType: ModuleType): void {
  let types = implRegistry.get(modulePath);
  if (!types) {
    types = new Set();
    implRegistry.set(modulePath, types);
  }
  types.add(moduleType);
}

/**
 * Attach a module value to a receiver type's module.
 * For anonymous modules (begin blocks), flatten the fields directly.
 * For named modules, attach with an empty label for method lookup.
 *
 * Note: clearImplsFromModule should be called before re-evaluating a module
 * to remove old impls. This function just adds the new impl.
 */
function attachModuleToReceiverType(
  moduleValue: ModuleValue,
  expr: Expr,
  sourceModulePath?: string
): void {
  const receiverType = moduleValue.type.receiverType;
  if (!receiverType || !receiverType.module) {
    return;
  }

  // Check for duplicate impl (only for named modules, not anonymous ones)
  if (moduleValue.type.typeName) {
    // Check orphan rule
    checkOrphanRule({
      receiverType,
      moduleType: moduleValue.type,
      currentModulePath: sourceModulePath,
      expr,
    });

    // Check for duplicate impl
    checkDuplicateImpl({
      receiverType,
      moduleType: moduleValue.type,
      currentModulePath: sourceModulePath,
      expr,
    });

    // Register this impl for duplicate detection
    registerImplForType({
      receiverType,
      moduleType: moduleValue.type,
      currentModulePath: sourceModulePath,
      expr,
    });
  }

  // Register this impl for cleanup on re-evaluation
  if (sourceModulePath) {
    registerImpl(sourceModulePath, receiverType.module);
  }

  // Check if this is an anonymous module (no typeName) - flatten its fields
  if (!moduleValue.type.typeName) {
    // Flatten the module's fields directly onto the receiver type's module
    for (let i = 0; i < moduleValue.type.fields.length; i++) {
      const field = moduleValue.type.fields[i]!;
      const value = moduleValue.fields[i];

      const newField: ModuleField = {
        label: field.label,
        type: field.type,
        isCompileTimeOnly: field.isCompileTimeOnly,
        assignedValue: value,
        sourceModulePath,
        exprs: {
          expr,
        },
      };

      receiverType.module.fields.push(newField);
    }
  } else {
    // Named module - attach with empty label for method lookup
    const field: ModuleField = {
      label: "", // Empty label prevents direct access, only method calls work
      type: createTypeHierarchy(1), // Module type
      isCompileTimeOnly: true,
      assignedValue: moduleValue,
      sourceModulePath,
      exprs: {
        expr,
      },
    };

    // Add the field to the receiver type's module
    receiverType.module.fields.push(field);
  }
}

export function evaluateModuleValue({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
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
        SelfType: undefined,
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
  // Impl a module for a type
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

    // Anonymous module value
    if (
      exprIsFunctionCall(expr.args[1]) &&
      exprIsFunctionCallOf(expr.args[1], BuiltinKeywords.begin)
    ) {
      // Restrict anonymous module impl to prelude.yo only
      if (!isEvaluatingPreludeModule()) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `impl a receiver type with anonymous module (begin block) is only allowed in prelude.yo`,
        });
      }

      const beginExprs = expr.args[1]!.args;
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
          SelfType: undefined,
        },
        receiverType,
      });
      env = nextEnv;

      // Check that the receiver type implements all selfConstraints from the module's where clause
      checkTypeImplementsSelfConstraints({
        targetType: receiverType,
        moduleType: moduleValue.type,
        env,
        errorToken: expr.token,
      });

      // Attach the module to the receiver type for method lookup
      attachModuleToReceiverType(moduleValue, expr, context.currentModulePath);

      // Set the module value to the expr
      expr.$ = {
        env,
        type: moduleType,
        value: moduleValue,
        pathCollection: [],
      };

      return expr;
    } else {
      // Evaluate the module call
      const evaluatedModuleCallArg = evaluateExpression({
        expr: moduleCallArg,
        env,
        context: {
          ...context,
          expectedType: undefined,
          ReceiverType: receiverType,
        },
      });
      // Expect the module call to be a module value
      if (
        !evaluatedModuleCallArg.$ ||
        !isModuleValue(evaluatedModuleCallArg.$.value)
      ) {
        throw formatErrorMessage({
          token: moduleCallArg.token,
          errorMessage: `Expected module value for module call argument.`,
        });
      }
      env = evaluatedModuleCallArg.$.env;
      const moduleValue = evaluatedModuleCallArg.$.value;

      // Check that the receiver type implements all selfConstraints from the module's where clause
      checkTypeImplementsSelfConstraints({
        targetType: receiverType,
        moduleType: moduleValue.type,
        env,
        errorToken: expr.token,
      });

      // Attach the module to the receiver type for method lookup
      attachModuleToReceiverType(moduleValue, expr, context.currentModulePath);

      // Set the module value to the expr
      expr.$ = {
        env,
        type: evaluatedModuleCallArg.$.type,
        value: moduleValue,
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
    let whereArg: FuncCallExpr | undefined;
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
      const unknownOrTypeValue = createUnknownValue(effectiveType, paramName);

      // Add to environment
      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: paramName,
          type: effectiveType,
          isCompileTimeOnly: true,
          value: unknownOrTypeValue,
          token: paramExpr.token,
          initializedAtToken: paramExpr.token,
          consumedAtToken: undefined,
          isOwningTheGcValue: false,
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
    // The <: operator with isInsideWhereClause will attach constraints to SomeType's module

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
        // This will attach the module constraint to the SomeType's module fields
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

    // Collect where constraints from the SomeTypes' module fields
    const whereConstraints: { someType: SomeType; moduleType: ModuleType }[] =
      [];
    for (const param of forallParameters) {
      // Only type parameters have SomeTypes with constraints
      if (param.kind !== "type") continue;
      const { someType } = param;
      for (const field of someType.module.fields) {
        if (
          field.assignedValue &&
          isTypeValue(field.assignedValue) &&
          isModuleType(field.assignedValue.value)
        ) {
          whereConstraints.push({
            someType,
            moduleType: field.assignedValue.value,
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

    // Handle anonymous module value (begin block) or module call
    let moduleValue: ModuleValue;
    let moduleType: ModuleType;

    if (
      exprIsFunctionCall(moduleCallArg) &&
      exprIsFunctionCallOf(moduleCallArg, BuiltinKeywords.begin)
    ) {
      // Restrict anonymous module impl to prelude.yo only
      if (!isEvaluatingPreludeModule()) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `impl a receiver type with anonymous module (begin block) is only allowed in prelude.yo`,
        });
      }

      // Anonymous module value
      const beginExprs = moduleCallArg.args;
      const result = evaluateAnonymousModuleBeginExprs({
        beginExprs,
        env,
        context: {
          ...context,
          expectedType: undefined,
          SelfType: undefined,
        },
        receiverType: receiverTypePattern,
      });
      env = result.env;
      moduleType = result.moduleType;
      moduleValue = result.moduleValue;
    } else {
      // Evaluate the module call
      const evaluatedModuleCallArg = evaluateExpression({
        expr: moduleCallArg,
        env,
        context: {
          ...context,
          expectedType: undefined,
          ReceiverType: receiverTypePattern,
        },
      });

      if (
        !evaluatedModuleCallArg.$ ||
        !isModuleValue(evaluatedModuleCallArg.$.value)
      ) {
        throw formatErrorMessage({
          token: moduleCallArg.token,
          errorMessage: `Expected module value for module call argument.`,
        });
      }
      env = evaluatedModuleCallArg.$.env;
      moduleValue = evaluatedModuleCallArg.$.value;
      moduleType = moduleValue.type;
    }

    // Check that the receiver type pattern satisfies the module's self-constraints
    // For generic impls, we need to verify that the where constraints are sufficient
    // to satisfy the module's requirements
    checkGenericImplSelfConstraints({
      receiverTypePattern,
      moduleType,
      whereConstraints,
      env,
      errorToken: expr.token,
    });

    // Pop the forall env frame
    env = popEnvFrame(env);

    // Get the module type key for registry (use typeName if available, otherwise id)
    const moduleTypeKey = moduleType.typeName || moduleType.id;

    // Register the generic impl
    const genericImpl: GenericImpl = {
      forallParameters,
      whereConstraints,
      receiverTypePattern,
      moduleType,
      moduleValue,
      expr,
      sourceModulePath: context.currentModulePath,
      definitionEnv: env, // Store the environment where the impl was defined
    };

    registerGenericImpl(moduleTypeKey, genericImpl);

    // Set the module value to the expr
    expr.$ = {
      env,
      type: moduleType,
      value: moduleValue,
      pathCollection: [],
    };

    return expr;
  } else {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Invalid module implementation, expected a "begin" block, got:\n${exprToString(expr)}`,
    });
  }
}
