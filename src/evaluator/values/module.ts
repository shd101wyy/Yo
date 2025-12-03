import {
  addVariableToEnv,
  Environment,
  popEnvFrame,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
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
  isEnumType,
  isFunctionType,
  isFutureType,
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
  ModuleValue,
  UnknownValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";
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
}

/**
 * Registry of generic impls keyed by module type name.
 * This allows lookup when checking if a concrete type implements a module.
 */
const genericImplRegistry: Map<string, GenericImpl[]> = new Map();

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
  const moduleTypeName = moduleType.typeName;
  if (!moduleTypeName) {
    return undefined;
  }

  const impls = genericImplRegistry.get(moduleTypeName);
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
            match.substitutions
          );

          // If it's a function value, create a copy with specializedType set
          // This ensures tryToCallFunctionWithArguments uses the correct type
          let value: Value | undefined = originalValue;
          if (isFunctionValue(originalValue)) {
            const specializedFunctionValue: FunctionValue = {
              ...originalValue,
              specializedType: specializedType,
            };
            value = specializedFunctionValue;
          }

          methods.push({ type: specializedType, value });
        }
      }
    }
  }

  return methods;
}

/** Result from tryMatchGenericImpl */
interface GenericImplMatchResult {
  matched: boolean;
  /** Map from SomeType name to the concrete type it was bound to */
  substitutions: Map<string, Type>;
}

/**
 * Apply type substitutions to a Type recursively.
 * Substitutes SomeTypes whose name matches a key in the substitutions map.
 */
function substituteInType(type: Type, substitutions: Map<string, Type>): Type {
  if (isSomeType(type)) {
    const substitute = substitutions.get(type.name);
    if (substitute) {
      return substitute;
    }
    return type;
  }

  if (isPtrType(type)) {
    const newChildType = substituteInType(type.childType, substitutions);
    if (newChildType === type.childType) {
      return type;
    }
    return { ...type, childType: newChildType } as Type;
  }

  if (isArrayType(type)) {
    const newChildType = substituteInType(type.childType, substitutions);
    if (newChildType === type.childType) {
      return type;
    }
    return { ...type, childType: newChildType } as Type;
  }

  if (isSliceType(type)) {
    const newChildType = substituteInType(type.childType, substitutions);
    if (newChildType === type.childType) {
      return type;
    }
    return { ...type, childType: newChildType } as Type;
  }

  if (isTupleType(type)) {
    let changed = false;
    const newFields = type.fields.map((f) => {
      const newType = substituteInType(f.type, substitutions);
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
      const newType = substituteInType(f.type, substitutions);
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
        const newType = substituteInType(f.type, substitutions);
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
      const newType = substituteInType(f.type, substitutions);
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

  if (isFutureType(type)) {
    const newChildType = substituteInType(type.childType, substitutions);
    if (newChildType === type.childType) {
      return type;
    }
    return { ...type, childType: newChildType } as Type;
  }

  if (isFunctionType(type)) {
    return substituteInFunctionType(type, substitutions);
  }

  return type;
}

/**
 * Apply type substitutions to a FunctionType.
 * This substitutes SomeTypes in parameters and return type.
 */
function substituteInFunctionType(
  functionType: FunctionType,
  substitutions: Map<string, Type>
): FunctionType {
  let changed = false;

  // Substitute in parameters
  const newParameters: FunctionParameter[] = functionType.parameters.map(
    (p) => {
      const newType = substituteInType(p.type, substitutions);
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
    substitutions
  );
  const returnChanged = newReturnType !== functionType.return.type;

  // Substitute in SelfType if present
  let newSelfType = functionType.SelfType;
  if (functionType.SelfType) {
    newSelfType = substituteInType(functionType.SelfType, substitutions);
    if (newSelfType !== functionType.SelfType) {
      changed = true;
    }
  }

  if (!changed && !returnChanged) {
    return functionType;
  }

  return {
    ...functionType,
    parameters: newParameters,
    return: returnChanged
      ? { ...functionType.return, type: newReturnType }
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

    // Extract substitutions from the unified environment
    const substitutions = new Map<string, Type>();
    for (const param of impl.forallParameters) {
      if (param.kind === "type") {
        const boundType = getValueOfSomeTypeFromEnvForGenericImpl(
          expectedEnv,
          param.someType
        );
        if (boundType && !isSomeType(boundType)) {
          substitutions.set(param.name, boundType);
        }
      }
    }

    // Also add Self -> concreteType substitution
    substitutions.set("Self", concreteType);

    return { matched: true, substitutions };
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
      if (constraintModule.typeName === moduleName) {
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
  if (!moduleType.selfConstraints || moduleType.selfConstraints.length === 0) {
    return;
  }

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
      if (wc.moduleType.typeName === constraintModule.typeName) {
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
 * Attach a module value to a receiver type's module with an empty label.
 * This allows method calls on values of the receiver type to find methods
 * from the implemented module, while preventing direct access by name.
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

  // Register this impl for cleanup on re-evaluation
  if (sourceModulePath) {
    registerImpl(sourceModulePath, receiverType.module);
  }

  // Create a field with empty label to attach the module
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
    const moduleValue = evaluatedModuleCallArg.$.value;
    const moduleType = moduleValue.type;

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

    // Get the module type name for registry key
    const moduleTypeName = moduleType.typeName;
    if (!moduleTypeName) {
      throw formatErrorMessage({
        token: moduleCallArg.token,
        errorMessage: `Module type must have a type name for generic impl.`,
      });
    }

    // Register the generic impl
    const genericImpl: GenericImpl = {
      forallParameters,
      whereConstraints,
      receiverTypePattern,
      moduleType,
      moduleValue,
      expr,
      sourceModulePath: context.currentModulePath,
    };

    registerGenericImpl(moduleTypeName, genericImpl);

    // Set the module value to the expr
    expr.$ = {
      env,
      type: evaluatedModuleCallArg.$.type,
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
