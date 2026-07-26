import {
  addVariableToEnv,
  type Environment,
  getVariablesFromEnv,
  keepTopLevelFrameAndComptimeVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  cloneExpr,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { evaluatedBodyContainsEscape } from "../../expr-traversal";
import type {
  FunctionCapturedVariableInfo,
  FunctionValue,
} from "../../function-value";
import { PlaceholderToken, type Token } from "../../token";
import { areTypesCompatible } from "../../types/compatibility";
import {
  isDynType,
  isFunctionType,
  isSourceNamespaceType,
  isPtrType,
  isArrayType,
  isIsoType,
  isSomeType,
} from "../../types/guards";
import {
  convertComptimeTypeToRuntimeType,
  typeContainsSomeType,
  typeContainsUnboundSomeType,
  typeIsControlBound,
  typeRepresentationContainsRawPtr,
  typeToString,
} from "../../types/utils";
import { isFlowableExpr } from "../types/flowability";
import { isImplicitlyUnsafeCapableFile } from "../memory-safety";
import { wrapFunctionBodyWithContracts } from "../builtins/contracts";
import {
  createPtrType,
  createArrayType,
  createFnTraitType,
  createSomeType,
  createType0,
} from "../../types/creators";
import type {
  FnTraitType,
  FunctionParameter,
  FunctionType,
  SomeType,
  StructType,
  Type,
} from "../../types/definitions";
import { randomId } from "../../utils";
import {
  createTypeValue,
  createUnknownValue,
  isTypeValue,
  type Value,
} from "../../value";
import { ValueTag } from "../../value-tag";
import { analyzeAwaitPoints } from "../async/await-analysis";
import {
  checkDeferredGenericReturnType,
  createFunctionBodyEvaluationContext,
} from "../calls/function-type";
import { type EvaluatorContext } from "../context";
import { analyzeCtfeCapability } from "../ctfe/ctfe-analysis";
import { evaluateBeginExpression } from "../exprs/begin";
import { evaluateExpression } from "../exprs/expr";
import { extractFnTraitFromType } from "../trait-checking";
import { applyWhereClauseConstraints } from "../types/function";
import {
  buildPathCollectionFromCapturedVariables,
  createCaptureTypeAndValue,
  enrichCapturedVariables,
  generateCapturedVariableDupExpressions,
  validateCaptureTraitRequirements,
} from "../utils/closure";
import { synthesizeTypes } from "../types/synthesizer";

/**
 * Substitute SomeTypes in `type` with concrete types looked up by name from `env`.
 *
 * When a lambda is passed to a function like
 *   fold :: (generic(A, Acc, F), self, init: Acc, f: F, where(F <: Fn(acc: Acc, item: A) -> Acc)) -> Acc
 * and called as `fold(0, (acc, x) => acc + x.*)`, the Fn trait's callType
 * still references the unresolved generic SomeTypes `Acc` and `A`. By the time
 * the lambda is being evaluated, these generic variables have been bound to
 * concrete types in the callee's env (e.g., `Acc -> i32, A -> *(i32)`).
 *
 * This helper walks `type` and substitutes any SomeType whose `name` matches a
 * comptime variable in `env` whose value is a TypeValue. This ensures that the
 * lambda parameter bindings and downstream codegen see concrete types instead
 * of unresolved generic SomeTypes.
 *
 * Recurses through wrapper types (Ptr, Slice, Array, Iso) and FunctionType.
 * Does NOT recurse into nominal types (Struct/Enum/Module) — those are
 * identity-keyed and substituting fields would create unrelated types.
 */
function substituteSomeTypesFromEnv(
  type: Type,
  env: Environment | undefined,
  visited: Set<Type> = new Set()
): Type {
  if (!env) return type;
  if (visited.has(type)) return type;
  visited.add(type);

  if (isSomeType(type)) {
    // If already resolved to a concrete type, prefer that.
    if (type.resolvedConcreteType) {
      return substituteSomeTypesFromEnv(
        type.resolvedConcreteType,
        env,
        visited
      );
    }
    const found = getVariablesFromEnv(env, type.name);
    for (let i = found.length - 1; i >= 0; i--) {
      const v = found[i]!;
      if (v.value && v.value[0] && isTypeValue(v.value[0])) {
        const bound = v.value[0].value;
        // Avoid trivial self-binding (variable bound to the same SomeType).
        if (bound !== type) {
          return substituteSomeTypesFromEnv(bound, env, visited);
        }
      }
    }
    return type;
  }

  if (isPtrType(type)) {
    const childSub = substituteSomeTypesFromEnv(type.childType, env, visited);
    if (childSub === type.childType) return type;
    return createPtrType(childSub);
  }

  if (isArrayType(type)) {
    const childSub = substituteSomeTypesFromEnv(type.childType, env, visited);
    if (childSub === type.childType) return type;
    return createArrayType(childSub, type.length);
  }

  if (isIsoType(type)) {
    // Iso construction needs an env; reuse the type's stored env.
    return type;
  }

  if (isFunctionType(type)) {
    let changed = false;
    const newParams = type.parameters.map((p) => {
      const sub = substituteSomeTypesFromEnv(p.type, env, visited);
      if (sub === p.type) return p;
      changed = true;
      return { ...p, type: sub };
    });
    const retSub = substituteSomeTypesFromEnv(type.return.type, env, visited);
    if (retSub !== type.return.type) changed = true;
    if (!changed) return type;
    const newFn: FunctionType = {
      ...type,
      parameters: newParams,
      return: { ...type.return, type: retSub },
    };
    return newFn;
  }

  return type;
}

export function evaluateAnonymousFunctionImplementation({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const expectedType = context.expectedType?.type;
  if (!expectedType) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected a function type, got:\n${exprToString(expr)}`,
    });
  }

  // Handle FunctionType and SomeType (from Impl(Fn(...)))
  // Use `dyn (x) => expr` to get Dyn(Fn(...)) for dynamic dispatch
  let functionType: FunctionType;
  let isCreatingClosure = false;
  let expectedFnTraitType: FnTraitType | undefined;
  let wrapperType: SomeType | undefined;

  if (isFunctionType(expectedType)) {
    functionType = expectedType;
  } else if (isSomeType(expectedType)) {
    // Handle Impl(Fn(...)) - SomeType with required modules containing a FnTraitType
    // The where-clause constraint (e.g., `where(F <: Fn(...))`) is registered in
    // the callee's env, not the caller's env. The lambda is evaluated with `env =
    // callerEnv`, so we must consult `context.expectedType?.env` (the calleeEnv)
    // when looking up where-clause constraints for SomeType `F`.
    const expectedTypeEnv = context.expectedType?.env ?? env;
    const fnTraitFromWrapper = extractFnTraitFromType(
      expectedType,
      expectedTypeEnv
    );
    if (fnTraitFromWrapper) {
      expectedFnTraitType = fnTraitFromWrapper;
      functionType = fnTraitFromWrapper.isFn.callType;
      isCreatingClosure = true;
      wrapperType = expectedType;

      // Phase 2 (lambda-annotation-driven generic unification):
      // When the lambda explicitly annotates a parameter (e.g. `(io2 :
      // Io) =>`) and the expected closure parameter type is a bare
      // NOTE: An attempted Phase 2 lambda-annotation-driven generic
      // unification (binding `E := Io` in expectedTypeEnv when the
      // user wrote `(io2 : Io) =>`) was abandoned because:
      //   (a) addVariableToEnv on a name already present in the
      //       top frame throws even with allowVariableShadowing —
      //       working around it via pushEnvFrame broke later body
      //       lookups (lambda's `io2` not found).
      //   (b) Mutating expectedP.type.resolvedConcreteType in place
      //       cascaded across the shared SomeType instance and
      //       likewise broke unrelated closures.
      // The return-type-driven Phase 2 path in helper.ts (commit
      // cf808ec0) still covers the cases where the io.async call
      // has an outer return-type constraint (most std/ usage).
      // Test-framework wrappers without explicit return types
      // remain unhandled — a deeper refactor of the closure
      // capture/cache path is needed.

      // Substitute generic SomeTypes (e.g., `Acc`, `A` from a generic
      // function's where-clause `F <: Fn(acc: Acc, item: A) -> Acc`) with
      // their concrete bindings from the callee's env. Without this, lambda
      // parameters keep unresolved SomeType refs and the closure's C
      // function is skipped by codegen (typeContainsSomeType gate).
      const substituted = substituteSomeTypesFromEnv(
        functionType,
        expectedTypeEnv
      );
      if (substituted !== functionType && isFunctionType(substituted)) {
        functionType = substituted;
      }
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected a function type or Impl(Fn(...)), got:\n${typeToString(expectedType)}`,
      });
    }
  } else {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected a function type or Impl(Fn(...)), got:\n${typeToString(expectedType)}${isDynType(expectedType) ? "\nUse 'dyn((x) => expr)' for dynamic dispatch" : ""}`,
    });
  }

  // For closures (from Impl(Fn(...))), we expect the `=>` operator
  // For regular functions, we expect `->`
  const expectedOperator = isCreatingClosure ? "=>" : "->";
  const operatorDescription = isCreatingClosure ? "closure" : "function";

  if (!exprIsFunctionCallOf(expr, expectedOperator, 2)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected ${expectedOperator} for anonymous ${operatorDescription}, got:\n${exprToString(expr)}`,
    });
  }
  const functionDeclarationExpr = expr.args[0]!;

  // NOTE: Don't cloneExpr here. It will affect the vscode extension.
  const functionBodyExpr = expr.args[1]!;

  let parameterExprs: Expr[] = [];
  if (
    exprIsFunctionCall(functionDeclarationExpr) &&
    exprIsFunctionCallOf(functionDeclarationExpr, BuiltinKeywords.tuple)
  ) {
    parameterExprs = functionDeclarationExpr.args;
  } else {
    parameterExprs = [functionDeclarationExpr];
  }

  // Parse parameter expressions to separate generic and regular parameters
  // `using` keyword is gone. All non-generic params are regular.
  let forallParamExprs: Expr[] = [];
  const regularParamExprs: Expr[] = [];

  for (let i = 0; i < parameterExprs.length; i++) {
    const paramExpr = parameterExprs[i]!;

    if (
      exprIsFunctionCall(paramExpr) &&
      exprIsFunctionCallOf(paramExpr, BuiltinKeywords.generic)
    ) {
      if (i !== 0) {
        throw formatErrorMessage({
          token: paramExpr.token,
          errorMessage: `generic(...) must be the first parameter expression`,
        });
      }
      forallParamExprs = paramExpr.args;
    } else {
      regularParamExprs.push(paramExpr);
    }
  }

  // Validate parameter counts match expected function type
  /*
  if (forallParamExprs.length !== functionType.forallParameters.length) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected ${functionType.forallParameters.length} generic parameters, got ${forallParamExprs.length}`,
    });
  }
  */

  if (regularParamExprs.length !== functionType.parameters.length) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected ${functionType.parameters.length} regular parameters, got ${regularParamExprs.length}`,
    });
  }

  // Add parameters to environment.
  // Save outerEnv so we can restore it after body evaluation — the
  // pushed frame must not leak back to the caller.
  const outerEnv = env;
  env = pushEnvFrame(env);

  // Validate parameter names for comptime parameters (generic, implicit, and comptime regular parameters)
  // Check generic parameters (always comptime)
  for (let i = 0; i < forallParamExprs.length; i++) {
    const paramExpr = forallParamExprs[i]!;
    const expectedParam = functionType.forallParameters[i]!;

    if (!exprIsAtom(paramExpr)) {
      throw formatErrorMessage({
        token: paramExpr.token,
        errorMessage: `Expected parameter name for generic parameter, got ${exprToString(paramExpr)}`,
      });
    }

    const paramName = paramExpr.token.value;
    if (paramName !== expectedParam.label) {
      throw formatErrorMessage({
        token: paramExpr.token,
        errorMessage: `Forall parameter name must match expected name.
Expected: "${expectedParam.label}"
Got:      "${paramName}"`,
      });
    }
  }
  for (let i = 0; i < functionType.forallParameters.length; i++) {
    const paramExpr = forallParamExprs[i];
    const expectedParam = functionType.forallParameters[i]!;
    // Add generic parameter to environment.
    // Allow variable shadowing because in nested ctl handlers, the inner handler's
    // generic T needs to shadow the outer handler's T that exists in the env chain
    // (e.g., raise2's T inside raise's handler body which already has T bound).
    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: expectedParam.label,
        type: expectedParam.type,
        isCompileTimeOnly: expectedParam.isCompileTimeOnly,
        value: [
          createUnknownValue(expectedParam.type, {
            variableName: expectedParam.label,
            env,
            context,
          }),
        ],
        token: paramExpr?.token ?? PlaceholderToken,
        initializedAtToken: paramExpr?.token ?? PlaceholderToken,
        consumedAtToken: undefined,
        isOwningTheRcValue: false,
        isParameter: true,
      },
      allowVariableShadowing: true,
    });
    env = nextEnv;

    if (paramExpr) {
      paramExpr.$ = {
        env: env,
        type: expectedParam.type,
        value: createUnknownValue(expectedParam.type, {
          variableName: expectedParam.label,
          env,
          context,
        }),
        pathCollection: [],
      };
    }
  }

  // Under explicit effects there is no `using(...)` clause on
  // anonymous functions any more.
  const effectParamEntries: Array<{
    name: string;
    type: Type;
    token: Token;
  }> = [];
  // When a closure parameter has an explicit annotation `(name : Type)` and
  // the expected (Fn-trait) parameter type is an unresolved SomeType (e.g.
  // io.async's `Impl(Fn(e : E) -> T)` exposes `e : E`), use the user's
  // annotation to resolve the SomeType. Without this, the lambda's param
  // type stays as `E` (free SomeType), `shouldDeferBodyEvaluation` fires,
  // and the closure body never gets evaluated — leaving sub-expressions
  // unannotated and producing "Unhandled function call" at codegen time.
  //
  // We build a per-lambda substitution env in a fresh frame (so the binding
  // doesn't conflict with any outer `E` and doesn't escape to the caller),
  // then run `substituteSomeTypesFromEnv` to produce a new `functionType`
  // with the SomeType replaced throughout.
  {
    let needsSubstitution = false;
    let substEnv: Environment | undefined;
    for (let i = 0; i < regularParamExprs.length; i++) {
      const paramExpr = regularParamExprs[i]!;
      const expectedParam = functionType.parameters[i]!;
      if (
        !isCreatingClosure ||
        !exprIsFunctionCall(paramExpr) ||
        !exprIsAtom(paramExpr.func) ||
        paramExpr.func.token.value !== ":" ||
        paramExpr.args.length !== 2 ||
        !isSomeType(expectedParam.type) ||
        expectedParam.type.resolvedConcreteType
      ) {
        continue;
      }
      const typeExpr = paramExpr.args[1]!;
      let userType: Type | undefined;
      try {
        const evalRes = evaluateExpression({
          expr: typeExpr,
          env,
          context: { ...context, isEvaluatingFunctionType: true },
        });
        const val = evalRes.$?.value;
        if (val && isTypeValue(val) && !isSomeType(val.value)) {
          userType = val.value;
        }
      } catch {
        // Annotation didn't evaluate to a concrete type — leave alone.
      }
      if (!userType) continue;
      if (!substEnv) substEnv = pushEnvFrame(env);
      const someName = expectedParam.type.name;
      // Skip if a binding with this name already exists in the new frame
      // (multi-param closures with two annotations using the same generic name).
      const topFrame = substEnv.frames[substEnv.frames.length - 1]!;
      if (topFrame.variables.some((v) => v.name === someName)) continue;
      const addRes = addVariableToEnv({
        env: substEnv,
        variable: {
          name: someName,
          type: expectedParam.type.parentType,
          isCompileTimeOnly: true,
          value: [createTypeValue(userType)],
          token: paramExpr.token,
          initializedAtToken: paramExpr.token,
          consumedAtToken: undefined,
          isOwningTheRcValue: false,
        },
        allowVariableShadowing: true,
      });
      substEnv = addRes.env;
      needsSubstitution = true;
    }
    if (needsSubstitution && substEnv) {
      const substituted = substituteSomeTypesFromEnv(functionType, substEnv);
      if (substituted !== functionType && isFunctionType(substituted)) {
        functionType = substituted;
      }
    }
  }

  // Check regular parameters (only comptime ones need exact matching)
  for (let i = 0; i < regularParamExprs.length; i++) {
    const paramExpr = regularParamExprs[i]!;
    const expectedParam = functionType.parameters[i]!;

    if (expectedParam.isCompileTimeOnly) {
      // For comptime parameters, require exact name matching (except for _ which is a wildcard)
      if (!exprIsAtom(paramExpr)) {
        throw formatErrorMessage({
          token: paramExpr.token,
          errorMessage: `Expected parameter name for compile-time parameter, got ${exprToString(paramExpr)}`,
        });
      }

      const paramName = paramExpr.token.value;
      // Allow _ as a wildcard that matches any expected parameter name
      if (paramName !== "_" && paramName !== expectedParam.label) {
        throw formatErrorMessage({
          token: paramExpr.token,
          errorMessage: `Compile-time parameter name must match expected name.
Expected: "${expectedParam.label}"
Got:      "${paramName}"`,
        });
      }
    }

    // Add regular parameter to environment
    // Use the expected parameter's isOwningTheRcValue to properly track ownership
    // (borrowed parameters default to false, owned parameters are true)
    //
    // Param surface forms:
    //   atom            — `(x) =>`         → paramExpr.token.value is the name
    //   colon pair      — `(x : T) =>`     → paramExpr is `:`(x, T); extract from args[0]
    let anonymousParamName = paramExpr.token.value;
    if (
      exprIsFunctionCall(paramExpr) &&
      exprIsFunctionCallOf(paramExpr, ":", 2) &&
      exprIsAtom(paramExpr.args[0]!)
    ) {
      anonymousParamName = paramExpr.args[0]!.token.value;
    }
    const expectedParamName = expectedParam.label;
    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: anonymousParamName,
        type: expectedParam.type,
        isCompileTimeOnly: expectedParam.isCompileTimeOnly,
        value: expectedParam.isCompileTimeOnly
          ? [
              createUnknownValue(expectedParam.type, {
                variableName: expectedParam.label,
                env,
                context,
              }),
            ]
          : undefined,
        token: paramExpr.token,
        initializedAtToken: paramExpr.token,
        consumedAtToken: undefined,
        isOwningTheRcValue: expectedParam.isOwningTheRcValue, // Parameters borrow by default
        // Propagate inout-ness from the expected (trait/declared) param.
        // When a lambda like `((self) -> self)` is being type-checked
        // against a trait method like `hash : (fn(inout(self) : Self)
        // -> u64)`, the lambda's `self` binding inherits isRef from
        // the trait's parameter; codegen then emits (*self) for reads
        // and writes. See plans/MEMORY_SAFETY.md Phase D.
        isRef: expectedParam.isRef || undefined,
        isReassignable: expectedParam.isRef,
        isParameter: true,
        // If anonymous function uses different parameter name than expected,
        // store the expected name as alias for C codegen
        parameterAlias:
          anonymousParamName !== expectedParamName
            ? expectedParamName
            : undefined,
      },
      // Lambda parameter names live in a NEW frame that opens just
      // for this closure body — they may legitimately shadow outer
      // bindings (`Thread.spawn(io => …)` is a common case: the
      // callback's `io` parameter shadows any outer `io` such as
      // the test-runner-injected one). The 348-line site
      // (`evaluateNamedFunctionParameter`) already sets this; mirror
      // it here for consistency.
      allowVariableShadowing: true,
    });
    env = nextEnv;

    paramExpr.$ = {
      env: env,
      type: expectedParam.type,
      value: expectedParam.isCompileTimeOnly
        ? createUnknownValue(expectedParam.type, {
            variableName: expectedParam.label,
            env,
            context,
          })
        : undefined,
      pathCollection: [],
    };
  }

  const parametersFrame = env.frames[env.frames.length - 1]!;

  // Create new function type using expected generic/implicit parameters and mixing anonymous + expected regular parameters
  const newFunctionType: FunctionType = {
    ...functionType,
    // generic parameters must use expected names/types entirely (they're always comptime)
    forallParameters: functionType.forallParameters,
    // For regular parameters: use expected types but allow anonymous names for non-comptime parameters
    parameters: functionType.parameters.map((expectedParam, index) => {
      if (expectedParam.isCompileTimeOnly) {
        // Comptime parameters must use expected name and type
        return expectedParam;
      } else {
        // Non-comptime parameters can use anonymous function's name with expected type
        const paramExpr = regularParamExprs[index]!;
        // Surface forms for paramExpr (mirror the binding site above):
        //   atom            — `(x) =>`        → name from paramExpr.token.value
        //   colon pair      — `(x : T) =>`    → name from paramExpr.args[0]
        const userParamLabel = exprIsAtom(paramExpr)
          ? paramExpr.token.value
          : exprIsFunctionCall(paramExpr) &&
              exprIsFunctionCallOf(paramExpr, ":", 2) &&
              exprIsAtom(paramExpr.args[0]!)
            ? paramExpr.args[0]!.token.value
            : expectedParam.label;
        return {
          ...expectedParam,
          label: userParamLabel,
          exprs: {
            ...expectedParam.exprs,
            expr: paramExpr,
            labelExpr: paramExpr,
            typeExpr: expectedParam.exprs.typeExpr,
            defaultValueExpr: undefined, // Anonymous functions can't have default values
          },
        };
      }
    }),
    return: {
      ...functionType.return,
      typeExpr: functionType.return.typeExpr,
    },
    parametersFrame: parametersFrame,
    env: keepTopLevelFrameAndComptimeVariablesFromEnv(functionType.env),
  };

  // Re-apply where-clause constraints for this function body evaluation.
  if (newFunctionType.whereClauseExprs?.length) {
    const constraintExprs = newFunctionType.whereClauseExprs.map((_expr) =>
      cloneExpr(_expr)
    );
    const result = applyWhereClauseConstraints({
      constraintExprs,
      env,
      context: {
        ...context,
        isEvaluatingFunctionType: true,
      },
    });
    env = result.env;
  }

  // Phase 0 of plans/FORMAL_VERIFICATION.md task #6: if the function
  // type has `requires(...)` clauses, splice synthetic `assert(P, msg)`
  // (runtime function) or `comptime_assert(P, msg)` (comptime function)
  // calls at the start of the body. The choice is driven by
  // `newFunctionType.return.isCompileTimeOnly`. `ensures(...)` lowering
  // is a separate sub-PR — it needs the `result` magic identifier scope.
  const effectiveBodyExpr = wrapFunctionBodyWithContracts(
    functionBodyExpr,
    newFunctionType
  );

  // Create the function value BEFORE evaluating the function body (fixing FIXME)
  const functionValue: FunctionValue = {
    tag: ValueTag.Function,
    type: newFunctionType,
    body: effectiveBodyExpr,
    frameLevel: env.frames.length - 1,
    funcId: `fn_${randomId(env.modulePath)}`,
    definitionSiteEnclosingFunctionType:
      context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "function-body"
        ? context.isEvaluatingFunctionBodyOrAsyncBlock.type
        : undefined,
    calledComptimeFunctionCaches: [],
    specializedFunctionCaches: [],
  };

  // Evaluate the function body
  // A function is a closure if it's being used as an implementation of an Fn trait (FnTraitType)
  const isClosureFunction = !!expectedFnTraitType;

  // Check if the function depends on generic type variables (generic parameters or SomeType in Self/params).
  // If so, we should NOT evaluate the body at definition time because we can't
  // execute code that uses unresolved type variables. The body will be evaluated
  // when the function is specialized with concrete type arguments.
  //
  // Only defer when the lambda explicitly declares generic parameters in its source.
  // When the expected type has generic params but the lambda doesn't declare them
  // (e.g., a concrete throw handler for Exception module), evaluate the body now —
  // the generic type polymorphism is handled by void* erasure at runtime.
  // Use the codegen-aware variant for the parameter check: an `exn :
  // Exception` or `io : Io` parameter must NOT trigger body deferral. These
  // are concrete structs whose only generic content lives in function-typed
  // fields (e.g. `throw : ctl(generic(R), ...) -> R`) — type-erased function
  // pointers at runtime, not generic body content. Plain
  // `typeContainsSomeType` reports the parameter as generic via that
  // recursion, which previously deferred every `fn(..., exn : Exception)`
  // and `fn(..., io : Io)` body and left sub-expressions un-annotated for
  // codegen (manifesting as link errors for `parse` etc. and
  // "Unhandled function call" errors for closures passed to Thread.spawn /
  // io.async / Worker).
  // Use `typeContainsUnboundSomeType` (generic-scope aware) instead of the
  // older `typeContainsSomeTypeForCodegenParam` to decide whether a parameter
  // type carries a *free* SomeType that should defer body evaluation. The old
  // function-fields carve-out treated struct fields containing fn-typed
  // foralls as concrete, but it stopped recursing entirely — losing fidelity
  // for other shapes (e.g. `*(T)` direct fields). The unbound variant walks
  // every shape and only reports SomeTypes whose name isn't bound by a
  // surrounding `generic(...)`.
  // Closure inference contract: when the surrounding context's expected
  // type still carries an unbound SomeType in a closure parameter
  // position AND the user did not provide a `(name : Type)` annotation
  // on that parameter (which is the only knob the substitution pass
  // above honors), the type genuinely cannot be inferred from the
  // closure source. Deferring the body in that case produces confusing
  // downstream failures ("Variable not found", "Internal error: return
  // expression missing metadata", etc.) far from the actual user
  // mistake. Report the missing annotation up front instead.
  //
  // Only fires for closure-creation (`=>`) — `->` regular function
  // values declare their own type and have a different evaluation
  // path that doesn't rely on caller-side inference.
  if (isCreatingClosure) {
    for (let i = 0; i < regularParamExprs.length; i++) {
      const paramExpr = regularParamExprs[i]!;
      const expectedParam = functionType.parameters[i];
      if (!expectedParam) continue;
      if (!typeContainsUnboundSomeType(expectedParam.type)) continue;
      // Did the user write `(name : Type)`? The substitution pass
      // upstream only honors that exact shape.
      const userAnnotatedThisParam =
        exprIsFunctionCall(paramExpr) &&
        exprIsAtom(paramExpr.func) &&
        paramExpr.func.token.value === ":" &&
        paramExpr.args.length === 2;
      if (userAnnotatedThisParam) continue;
      const displayName = exprIsAtom(paramExpr)
        ? paramExpr.token.value
        : exprToString(paramExpr);
      throw formatErrorMessage({
        token: paramExpr.token,
        errorMessage: `Cannot infer the type of anonymous closure parameter \`${displayName}\`.

The surrounding context expects a parameter of type \`${typeToString(
          expectedParam.type
        )}\` (an unbound generic), and the closure source provides no information that lets the evaluator pin it down.

Add an explicit annotation to the closure parameter, e.g.:
  (${displayName} : <ConcreteType>) => ...`,
      });
    }
  }

  const shouldDeferBodyEvaluation =
    forallParamExprs.length > 0 ||
    functionType.parameters.some((param) =>
      typeContainsUnboundSomeType(param.type)
    ) ||
    (functionType.SelfTraitType &&
      functionType.SelfType &&
      typeContainsUnboundSomeType(functionType.SelfType));

  let evaluationContext: EvaluatorContext;
  let evaluatedBody: Expr;

  if (shouldDeferBodyEvaluation) {
    // Don't evaluate the body for generic functions.
    // Trial-evaluate to catch return type mismatches (e.g., returning i32 for generic T).
    checkDeferredGenericReturnType({
      functionBodyExpr,
      functionType,
      functionValue,
      env,
      context,
    });

    // Attach the environment for later use when called
    functionBodyExpr.$ = {
      env,
      type: functionType.return.type,
      value: functionType.return.isCompileTimeOnly
        ? createUnknownValue(functionType.return.type, {
            variableName: "function_body",
            env,
            context,
          })
        : undefined,
      pathCollection: [],
    };
    // Create a minimal evaluation context for generic functions
    evaluationContext = {
      ...context,
      isExecuting: false,
      capturedVariables: new Map(),
    };
    evaluatedBody = functionBodyExpr;
  } else {
    // Non-generic function: evaluate the body now
    // eslint-disable-next-line prefer-const
    let { evaluationContext: ctx } = createFunctionBodyEvaluationContext(
      {
        ...context,
        isExecuting: false, // We're analyzing, not executing
        isValidatingFunctionDefinition: false, // Clear the validation flag during actual execution
      },
      functionType,
      functionValue,
      env
    );

    evaluationContext = ctx;

    // For io.async closures, override the evaluation context to async-block
    // so that `await` expressions are allowed inside the closure body.
    if (context.isInsideIoAsyncCall && isCreatingClosure) {
      evaluationContext = {
        ...evaluationContext,
        isEvaluatingFunctionBodyOrAsyncBlock: {
          kind: "async-block",
          evaluationEnv: env,
        },
      };
    }

    evaluatedBody = evaluateBeginExpression({
      expr: effectiveBodyExpr,
      env,
      context: evaluationContext,
      variablesToAdd: [],
      isEvaluatingFunctionBodyBeginBlock: true,
    });

    if (!evaluatedBody.$) {
      throw formatErrorMessage({
        token: functionBodyExpr.token,
        errorMessage: `Failed to evaluate the function body.`,
      });
    }
    env = evaluatedBody.$.env;
  }

  // Get captured variables from the evaluation context
  const capturedVariables = evaluationContext.capturedVariables;

  // Regular functions (->) are not closures and cannot capture outer runtime variables.
  // If the body references an outer runtime variable, the codegen would emit the function
  // as a standalone C function with no capture parameters, producing an "undeclared
  // identifier" C compile error. Catch this early with a clear diagnostic.
  //
  // Note: trackVariableUsage already skips comptime-only variables, so any entry in
  // capturedVariables represents a runtime variable. We further filter to only flag
  // *true* outer captures (frameLevel < outerEnv.frames.length), which mirrors the same
  // threshold used by enrichCapturedVariables for closures. Parameters live at
  // frameLevel == outerEnv.frames.length and are NOT outer captures.
  if (!isCreatingClosure && capturedVariables && capturedVariables.size > 0) {
    const trueOuterCaptures = Array.from(capturedVariables.entries()).filter(
      ([, info]) => info.frameLevel < outerEnv.frames.length
    );
    if (trueOuterCaptures.length > 0) {
      const capturedNames = trueOuterCaptures.map(([name]) => name).join(", ");
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `A regular function (using ->) cannot capture outer runtime variables: ${capturedNames}.
Use a closure (=> syntax) instead, or refactor the handler to not reference outer variables.
If this is an effect handler (e.g. Exception.throw), the handler type only accepts -> functions,
so only builtin functions (panic, escape) and local variables are accessible.`,
      });
    }
  }

  // §4 typing rule 1: `unwind` is only valid in a `ctl(...) -> ret`
  // body. A `fn(...) -> ret` body containing `unwind` is a type error.
  //
  // The check is wrapped in the evaluator's overload-resolution
  // try/catch (calls/function.ts:1133), so this throw may be swallowed
  // during candidate exploration. Genuine source-level violations
  // surface either via the same try/catch's failed-overload path or via
  // re-evaluation of the bound function value at the authoritative call
  // site. (Hard-error wiring outside the try/catch is tracked as
  // follow-up work.)
  if (evaluatedBodyContainsEscape(evaluatedBody)) {
    if (!newFunctionType.isControl && !newFunctionType.isClosure) {
      throw formatErrorMessage({
        token: functionBodyExpr.token,
        errorMessage: `\`unwind\` is only valid inside a control-function body. This function is declared with \`fn(...) -> ret\`; change the declared type to \`ctl(...) -> ret\` if the body needs to unwind.`,
      });
    }
    functionValue.isControlFunction = true;
  }

  // For functions with using(Io) implicit parameters or io.async closures,
  // run await analysis on the body to detect io.await calls and mark as async.
  // This enables the codegen to generate the function as a state machine.
  if (
    evaluatedBody.$ &&
    (([] as FunctionParameter[]).some((p) => isSourceNamespaceType(p.type)) ||
      context.isInsideIoAsyncCall)
  ) {
    const awaitAnalysis = analyzeAwaitPoints(evaluatedBody);
    if (awaitAnalysis.hasAwaits) {
      evaluatedBody.$.awaitAnalysis = awaitAnalysis;
    }
  }

  // Check if the return type is compatible
  // Skip when body uses escape because the escape returns
  // from the enclosing function, not this function. The body's type is the abort value
  // type, which may not match the handler function's declared return type.
  const evaluatedBodyReturnType = evaluatedBody.$?.type;

  // Phase B of plans/ITERATOR_REDESIGN.md — flowability check on
  // the return expression of a `-> ref(T)` function. The body must
  // root back to a `ref`-bound parameter along a
  // projection-respecting chain (R1–R4 in the plan); otherwise the
  // function would hand out a borrow into its own dying frame.
  //
  // The body might be a single expression (the implicit return)
  // OR a begin-block whose final expression is the return value.
  // For Phase B's first cut we handle both shapes; explicit
  // `return(expr)` statements buried deeper in the body aren't
  // checked yet — a follow-up can walk control-flow more
  // thoroughly when the projection redesign meets real iterator
  // bodies in Phase D.
  // (Ref-returning functions are banned at signature evaluation — see
  // evaluateFunctionType — so no `-> ref(T)` return enforcement is
  // needed here anymore.)
  if (
    typeRepresentationContainsRawPtr(functionType.return.type) &&
    !functionType.return.isCompileTimeOnly &&
    !isImplicitlyUnsafeCapableFile(functionBodyExpr.token.modulePath)
  ) {
    // plans/SLICE_FLOWABILITY.md Phase C — a function whose return
    // type is value-typed but transitively carries a raw pointer in
    // its representation (e.g. `Slice(T)`, `str`, or any struct that
    // wraps one) must root the returned value in caller-owned storage.
    let returnExpr: Expr = evaluatedBody;
    if (
      exprIsFunctionCall(evaluatedBody) &&
      exprIsFunctionCallOf(evaluatedBody, BuiltinKeywords.begin)
    ) {
      const beginCall = evaluatedBody as FnCallExpr;
      if (beginCall.args.length > 0) {
        returnExpr = beginCall.args[beginCall.args.length - 1]!;
      }
    }
    if (
      !isFlowableExpr(returnExpr, {
        allowParameterSource: true,
        allowComptimeSource: true,
      })
    ) {
      throw formatErrorMessage({
        token: returnExpr.token,
        errorMessage: `Function returning '${typeToString(functionType.return.type)}' carries a raw pointer in its representation; the returned value must be rooted in caller-owned storage. The body's final expression is not flowable:\n  ${exprToString(returnExpr)}\n\nFlowable sources: a 'ref'-bound parameter; a non-'ref' parameter (caller's value is alive across the call); a 'comptime' constant or string literal; '.field' on a flowable base; a call returning ref or slice with flowable arguments; or a 'cond'/'match' whose arms are all flowable.\n\nFixes:\n  - Take the source as a 'ref(name) : T' parameter and project a slice from it.\n  - Return an owned type ('ArrayList', 'String') instead — heap-allocated, no lifetime concern.\n  - Wrap unsafe construction in 'pragma(Pragma.AllowUnsafe);' at the file top if you genuinely need the raw form.`,
      });
    }
  }

  // For closures with SomeType return type (from generic parameters, e.g., T : Type),
  // resolve the body's runtime type as the concrete type for the SomeType.
  // This handles cases like io.async(() => { return 12; }) where T is inferred
  // from the closure body's return type.
  if (
    isSomeType(functionType.return.type) &&
    !functionType.return.type.resolvedConcreteType &&
    evaluatedBodyReturnType
  ) {
    // The body type might be concrete (e.g., i32) or a SomeType with resolvedConcreteType
    // (e.g., when the last expression is a binary op whose result inherits the expected
    // SomeType but has been resolved to a concrete type during evaluation).
    let concreteBodyType = evaluatedBodyReturnType;
    if (isSomeType(concreteBodyType) && concreteBodyType.resolvedConcreteType) {
      concreteBodyType = concreteBodyType.resolvedConcreteType;
    }
    if (!isSomeType(concreteBodyType)) {
      const runtimeType = convertComptimeTypeToRuntimeType({
        type: concreteBodyType,
        expectedType: undefined,
        expr: evaluatedBody,
        env,
      });
      functionType.return.type.resolvedConcreteType = runtimeType;
    }
  }

  // When return type contains nested SomeTypes (e.g., Option(B)) but is not itself
  // a SomeType, resolve nested SomeTypes by matching the expected return type structure
  // against the actual body return type. synthesizeTypes will recursively walk the
  // type tree, and when it encounters a SomeType matched against a concrete type,
  // it sets resolvedConcreteType on the SomeType (enabling generic inference in helper.ts).
  // Also update the return type on both functionType and newFunctionType so codegen
  // sees the concrete type.
  if (
    !isSomeType(functionType.return.type) &&
    typeContainsSomeType(functionType.return.type) &&
    evaluatedBodyReturnType &&
    !isSomeType(evaluatedBodyReturnType) &&
    !typeContainsSomeType(evaluatedBodyReturnType)
  ) {
    synthesizeTypes(
      { type: functionType.return.type, env },
      { type: evaluatedBodyReturnType, env },
      [],
      { setResolvedConcreteType: true }
    );
    functionType.return.type = evaluatedBodyReturnType;
    // newFunctionType has its own return object (spread copy), so update it too
    newFunctionType.return.type = evaluatedBodyReturnType;
  }

  if (
    !functionValue.isControlFunction &&
    evaluatedBodyReturnType &&
    !areTypesCompatible(
      { type: functionType.return.type, env },
      { type: evaluatedBodyReturnType, env }
    )
  ) {
    throw formatErrorMessage({
      token: functionBodyExpr.token,
      errorMessage: `Incompatible return type:
- Expected: ${typeToString(functionType.return.type)}
- Got     : ${typeToString(evaluatedBodyReturnType)}`,
    });
  }

  if (evaluatedBody.$?.env) {
    env = evaluatedBody.$?.env;
  }
  // Restore the env frame
  env = popEnvFrame(env, true);

  // Restore outer env so callers can still find variables that existed
  // before this anonymous function was evaluated (e.g. a `given(raise)`
  // variable created by evaluateBinding just before evaluating the RHS).
  env = outerEnv;

  // For closures, prepare captured variables with values and types for the function value
  // NOTE: This must happen BEFORE consuming the variables, using the current env
  let capturedVariablesWithValues:
    | Map<string, FunctionCapturedVariableInfo>
    | undefined;

  if (isClosureFunction && capturedVariables && capturedVariables.size > 0) {
    // Phase B non-escape enforcement (plans/MEMORY_SAFETY.md): an
    // `inout(name) : T` parameter is a second-class reference to
    // the caller's storage. Capturing it in a closure would let
    // that reference outlive the call frame, since the closure can
    // be stored, returned, or sent to a Future. Reject every such
    // capture — the synchronous-callback case (Open Question 3) is
    // forbidden in v1 alongside the escaping cases.
    for (const [varName, captureInfo] of capturedVariables.entries()) {
      if (captureInfo.frameLevel >= env.frames.length) continue;
      const frame = env.frames[captureInfo.frameLevel]!;
      const variable = frame.variables.find((v) => v.name === varName);
      if (variable?.isRef) {
        throw formatErrorMessage({
          token: captureInfo.token ?? expr.token,
          errorMessage: `Cannot capture inout binding '${varName}' in a closure. \`inout(${varName}) : T\` is a second-class reference to the caller's storage; a closure that captures it could outlive the call frame. Pass the value through (e.g. read it into a local first, or restructure to take the closure as a callback parameter).`,
        });
      }
      // §4 typing rule 4: closures cannot capture a value of
      // control-bound type. The captured ctl handler would escape
      // with the closure value (which can be stored or returned),
      // leaving an unwind that targets a dead install frame.
      // Mirror of the rule enforced in closure-type.ts:151, applied
      // here for the regular "closure passed as function arg" path
      // (e.g. `apply(() => raise(...))`).
      if (
        variable &&
        !variable.isCompileTimeOnly &&
        typeIsControlBound(variable.type)
      ) {
        throw formatErrorMessage({
          token: captureInfo.token ?? expr.token,
          errorMessage: `Closures cannot capture a value of control-bound type. The captured value \`${varName}\` has type \`${typeToString(
            variable.type
          )}\` which transitively contains a \`ctl(...) -> ret\` function. Closures can escape their enclosing frame, taking the captured control function with them — which would unwind to a dead install frame.

Pass \`${varName}\` as a regular function parameter instead of capturing it in a closure.`,
        });
      }
    }
    capturedVariablesWithValues = enrichCapturedVariables({
      capturedVariables,
      env,
    });
  }

  // For io.async closures, add effect params (function-typed using params) to the
  // capture struct so they can be injected at io.spawn/io.await time.
  // These are NOT captured through the normal tracking mechanism (they're function
  // parameters, not outer-scope variables), so we manually add them here.
  if (isClosureFunction && effectParamEntries.length > 0) {
    if (!capturedVariablesWithValues) {
      capturedVariablesWithValues = new Map();
    }
    for (const entry of effectParamEntries) {
      capturedVariablesWithValues.set(entry.name, {
        frameLevel: 0,
        usageType: "read",
        token: entry.token,
        value: undefined, // Runtime value — injected at spawn/await time
        type: entry.type,
        isEffectParam: true,
      });
    }
  }

  // Set the type and value of the expression
  let finalType: Type;
  let finalValue: Value | undefined;
  let capturedVariableDupExpressions: Expr[] | undefined;
  let captureType: StructType | undefined;
  let finalFunctionValue = functionValue;

  // If we're in CTFE analysis mode OR actually executing a CTFE function
  // (forceCompileTimeBindings is true), also analyze this nested function for CTFE capability
  if (
    (context.isAnalyzingCtfeCapability || context.forceCompileTimeBindings) &&
    !isCreatingClosure
  ) {
    const comptimeFunctionValue = analyzeCtfeCapability(
      functionValue,
      env,
      context
    );
    if (comptimeFunctionValue) {
      // Use the CTFE version for nested anonymous functions
      finalFunctionValue = comptimeFunctionValue;
    }
  }

  if (isCreatingClosure && expectedFnTraitType && wrapperType) {
    // Create a closure type and closure value using helper function
    // We don't need the captureValue since closures are runtime-only
    const result = createCaptureTypeAndValue({
      expectedCaptureType: undefined, // Capture type is no longer part of FnTraitType
      capturedVariablesWithValues,
      env,
      closureToken: expr.token,
      context: { ...context },
    });
    captureType = result.captureType;

    const closureType = createFnTraitType(newFunctionType, env);

    // Generate ___dup expressions for captured ARC variables
    // NOTE: This must happen BEFORE consuming the variables
    const { capturedVariableDupExpressions: dupExpressions, env: updatedEnv } =
      generateCapturedVariableDupExpressions({
        capturedVariablesWithValues,
        env,
        context,
      });
    capturedVariableDupExpressions = dupExpressions;
    env = updatedEnv;

    // Update the existing function value for closures
    functionValue.funcId = `closure_${randomId(env.modulePath)}`;

    // Set the closure info for easy codegen access
    const consumedCaptureNames = evaluationContext.ownConsumedCaptures
      ? Array.from(evaluationContext.ownConsumedCaptures)
      : undefined;
    functionValue.closureInfo = {
      closureType: closureType,
      captureType: captureType,
      effectParamNames:
        effectParamEntries.length > 0
          ? effectParamEntries.map((e) => e.name)
          : undefined,
      consumedCaptures: consumedCaptureNames?.length
        ? consumedCaptureNames
        : undefined,
    };

    // Validate that the capture struct implements all required non-Fn traits (e.g., Send)
    if (isSomeType(wrapperType) && captureType) {
      validateCaptureTraitRequirements({
        wrapperType,
        captureType,
        env,
        errorToken: expr.token,
        capturedVariablesWithValues,
      });
    }

    // IMPORTANT: When wrapperType is a generic SomeType (e.g., F from `generic(F:Type)`)
    // whose Fn trait constraint comes from a where-clause (not requiredTraits),
    // setting wrapperType.resolvedConcreteType = captureType (the bare closure struct)
    // strips the Fn trait info. Subsequent where-clause checks would then fail with
    // "Type struct() does not implement required trait Fn(...)".
    //
    // Fix: build a synthetic Impl(Fn(...)) SomeType wrapper that includes the Fn
    // trait in requiredTraits, and set THAT as F's resolvedConcreteType. Codegen
    // sees the concrete capture struct via one extra unwrap.
    const wrapperHasFnInRequired = wrapperType.requiredTraits.some(
      ({ traitType }) => traitType.id === expectedFnTraitType.id
    );
    if (!wrapperHasFnInRequired && captureType) {
      const implFnWrapper = createSomeType(createType0(), "__impl_fn", {
        requiredTraits: [expectedFnTraitType],
        env,
        context,
      });
      implFnWrapper.resolvedConcreteType = captureType;
      wrapperType.resolvedConcreteType = implFnWrapper;
      finalType = {
        ...wrapperType,
        resolvedConcreteType: implFnWrapper,
      } as SomeType;
    } else {
      // IMPORTANT: Mutate the wrapper SomeType in-place so downstream generic specialization
      // (e.g. `box`) can observe the concrete capture struct and codegen can use it.
      // We also return a resolved copy for local typing, but the in-place update is the key.
      wrapperType.resolvedConcreteType = captureType;
      finalType = {
        ...wrapperType,
        resolvedConcreteType: captureType,
      } as SomeType;
    }

    // Closures are always runtime values - create an UnknownValue
    // The closure will be constructed at runtime in C code
    finalValue = undefined;
  } else {
    // Regular function - use the final function value (CTFE version if available)
    finalType = finalFunctionValue.type;
    finalValue = finalFunctionValue;
  }

  expr.$ = {
    env,
    type: finalType,
    value: finalValue,
    pathCollection:
      isClosureFunction && capturedVariables
        ? buildPathCollectionFromCapturedVariables(capturedVariables)
        : [],
    deferredDupExpressions:
      isCreatingClosure && capturedVariableDupExpressions
        ? capturedVariableDupExpressions
        : undefined,
    captureType: isCreatingClosure ? captureType : undefined, // Store the capture struct type for codegen (used for both closures and async blocks)
    closureFunctionValue: isCreatingClosure ? finalFunctionValue : undefined,
    isAnonymousFunctionDefinition: true,
  };

  // For closures, attach a temporary variable so they can be consumed
  // This must be done AFTER expr.$ is set since attachTempVariableToExpr expects it
  if (isClosureFunction) {
    attachTempVariableToExpr(expr, true);
  }

  return expr;
}
