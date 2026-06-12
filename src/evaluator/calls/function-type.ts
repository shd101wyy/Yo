import {
  addVariableToEnv,
  type Environment,
  keepTopLevelFrameAndComptimeVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  cloneExpr,
  type Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
  hasControlFlow,
} from "../../expr";
import { wrapFunctionBodyWithContracts } from "../builtins/contracts";
import { isFlowableExpr } from "../types/flowability";
import { evaluatedBodyContainsEscape } from "../../expr-traversal";
import type { FunctionValue } from "../../function-value";
import { PlaceholderToken } from "../../token";
import { areTypesCompatible } from "../../types/compatibility";
import { createPtrType, createUnitType } from "../../types/creators";
import type { FunctionType, Type } from "../../types/definitions";
import { isFunctionType, isSomeType } from "../../types/guards";
import {
  typeContainsSomeType,
  typeContainsSomeTypeForCodegenParam,
  typeRepresentationContainsRawPtr,
  typeToString,
} from "../../types/utils";
import { isImplicitlyUnsafeCapableFile } from "../memory-safety";
import { randomId } from "../../utils";
import { createUnknownValue } from "../../value";
import { ValueTag } from "../../value-tag";
import {
  type CapturedVariableInfo,
  type EvaluatorContext,
  type FunctionEvaluationContext,
} from "../context";
import { analyzeCtfeCapability } from "../ctfe/ctfe-analysis";
import { evaluateBeginExpression } from "../exprs/begin";
import { applyWhereClauseConstraints } from "../types/function";
import {
  buildPathCollectionFromCapturedVariables,
  consumeCapturedVariables,
} from "../utils/closure";

/**
 * Check if a generic (deferred) function body returns a concrete type that is
 * incompatible with the declared generic return type.
 *
 * For example, `fn(forall(T), value: T) -> T { return i32(0); }` should error
 * because the body returns i32 but the declared return type is the generic T.
 *
 * We trial-evaluate a clone of the body. If evaluation fails (e.g. because the
 * body uses operations on abstract types), we silently skip the check — the body
 * will be properly validated at specialization time.
 *
 * The check only fires when a SomeType from the return type also appears in
 * parameter types. Effect handlers (e.g., Raise :: fn(forall(T), msg: String) -> T)
 * use T only in the return type — T is determined by the call-site context, so
 * returning a concrete type is valid for resuming continuations.
 */
export function checkDeferredGenericReturnType({
  functionBodyExpr,
  functionType,
  functionValue,
  env,
  context,
}: {
  functionBodyExpr: Expr;
  functionType: FunctionType;
  functionValue: FunctionValue;
  env: Environment;
  context: EvaluatorContext;
}): void {
  if (!typeContainsSomeType(functionType.return.type)) {
    return;
  }

  // Trial-evaluate a clone of the body to discover its return type.
  let trialBodyReturnType: Type | undefined;
  try {
    const clonedBody = cloneExpr(functionBodyExpr);
    const trialCtx = createFunctionBodyEvaluationContext(
      { ...context, capturedVariables: undefined },
      functionType,
      { ...functionValue },
      env
    );
    const trialBody = evaluateBeginExpression({
      expr: clonedBody,
      env,
      context: trialCtx.evaluationContext,
      variablesToAdd: [],
      isEvaluatingFunctionBodyBeginBlock: true,
    });
    trialBodyReturnType = trialBody.$?.type;
    // If the body's control flow is purely escape (no return), it's a control
    // function that discards the continuation. Skip the return type check.
    // When mixed (return + escape), cond/match set both flags,
    // so we still check correctly when return is also set.
    if (
      hasControlFlow(trialBody.$?.controlFlow, "unwind") &&
      !hasControlFlow(trialBody.$?.controlFlow, "return")
    ) {
      return;
    }
  } catch {
    // Body evaluation failed due to abstract/unknown types — skip.
    return;
  }

  // Phase B/C of plans/ITERATOR_REDESIGN.md — for `-> ref(T)`
  // functions, the user-visible return is `T` but the body
  // produces `*(T)`. Compare against `*(T)` in that case.
  const expectedReturnForCompare: Type = functionType.return.isRef
    ? createPtrType(functionType.return.type)
    : functionType.return.type;
  // When the expected return type IS a bare SomeType (e.g. T from an
  // outer forall like `io.async`'s `Impl(Fn(e : E) -> T)`), the
  // closure body returning a concrete type is the CORRECT shape —
  // synthesis at the outer call site binds the forall var from the
  // concrete body type. Skip the strict trial check here; the
  // anonymous-function evaluator runs synthesizeTypes against the
  // SomeType separately to attach resolvedConcreteType for codegen.
  // Without this carve-out, every `io.async((e) => concrete_value)`
  // form is rejected at definition time with "Expected: T / Given:
  // <concrete>" before the call-site forall binding has a chance.
  //
  // BUT — when the function declares its OWN `forall(T)` and the
  // return type is exactly that T, the body MUST produce a T-shaped
  // value (or escape). A concrete-typed body would only type-check
  // for one monomorphization; we reject it at definition time. This
  // is the "generic function with concrete return" case caught by
  // `tests/fn.test.yo::Test generic functions`.
  if (trialBodyReturnType && isSomeType(expectedReturnForCompare)) {
    const returnedSomeName = expectedReturnForCompare.name;
    const isOwnForall = functionType.forallParameters.some(
      (p) => p.label === returnedSomeName
    );
    if (!isOwnForall) {
      return;
    }
  }
  if (
    trialBodyReturnType &&
    !(
      functionType.forallParameters.length > 0 &&
      isSomeType(functionType.return.type) &&
      isSomeType(trialBodyReturnType)
    ) &&
    !areTypesCompatible(
      { type: expectedReturnForCompare, env },
      { type: trialBodyReturnType, env },
      true // requireExactMatch: concrete types must not match unconstrained SomeType
    )
  ) {
    throw formatErrorMessage({
      token: functionType.return.typeExpr.token,
      errorMessage: `Incompatible function return type for:
- Expected: ${typeToString(expectedReturnForCompare)}
- Given  : ${typeToString(trialBodyReturnType)}`,
    });
  }
}

/**
 * Creates a fresh evaluation context for function body evaluation
 */
export function createFunctionBodyEvaluationContext(
  context: EvaluatorContext,
  functionType: FunctionType,
  functionValue: FunctionValue,
  env: Environment
): {
  evaluationContext: EvaluatorContext;
  functionBodyContext: FunctionEvaluationContext;
} {
  const functionBodyContext: FunctionEvaluationContext = {
    kind: "function-body",
    type: functionType,
    value: functionValue,
    evaluationEnv: env,
  };

  // Create captured variables map for tracking variable captures
  // Always create a fresh map for each function body to avoid contaminating
  // the caller's captured variables map (e.g., an async block's capture map)
  const capturedVariables = new Map<string, CapturedVariableInfo>();

  // Compute the enclosing function's return type so that `abort` can type-check.
  // This is derived from the parent context's current function/block, or from
  let enclosingFunctionReturnType: Type | undefined;
  if (context.isEvaluatingFunctionBodyOrAsyncBlock) {
    const block = context.isEvaluatingFunctionBodyOrAsyncBlock;
    if (block.kind === "function-body") {
      enclosingFunctionReturnType = block.type.return.type;
    } else {
      // test-block or async-block: enclosing return type is unit
      enclosingFunctionReturnType = createUnitType();
    }
  }

  // Phase B/C of plans/ITERATOR_REDESIGN.md — for `-> ref(T)`
  // functions, the body produces a place expression (`*(T)` at the
  // C ABI). Setting the body's expected type to `*(T)` lets
  // internal type unification — especially across `match` and
  // `cond` arms — agree on a single pointer-typed shape, so
  // bodies like `match(opt, .Some(b) => &(b(i)), .None => panic(...))`
  // type-check correctly. The user-visible call-site type stays
  // `T`; the flowability rule on the return expression owns the
  // soundness check.
  const bodyExpectedType: Type = functionType.return.isRef
    ? createPtrType(functionType.return.type)
    : functionType.return.type;

  const evaluationContext: EvaluatorContext = {
    ...context,
    isExecuting: false, // We're analyzing, not executing
    isValidatingFunctionDefinition: true, // We're validating function definition
    isEvaluatingFunctionBodyOrAsyncBlock: functionBodyContext,
    isEvaluatingFunctionType: false,
    isEvaluatingLoopBody: undefined, // Clear loop body context for function body
    capturedVariables, // Set the captured variables map here
    ownConsumedCaptures: new Set(), // Track captures consumed via own(self)
    expectedType: {
      type: bodyExpectedType,
      env: env,
    },
    functionReturnImplConcreteType: [], // Empty array for each function
    enclosingFunctionReturnType,

    // Clear CTFE
    forceCompileTimeBindings: false,
    isAnalyzingCtfeCapability: false,
  };

  return { evaluationContext, functionBodyContext };
}

/**
 * expr should be the:
 * functionType(functionBody);
 * Please note this is for regular functions only, closures are handled in closure_type.ts
 */
export function tryToImplementFunctionByFunctionType({
  expr,
  functionType,
  callerEnv,
  context,
}: {
  expr: FnCallExpr;
  functionType: FunctionType;
  callerEnv: Environment;
  context: EvaluatorContext;
}): Expr {
  const functionTypeExpr = expr.func;
  const argExprs = expr.args;
  if (argExprs.length !== 1) {
    throw formatErrorMessage({
      token: functionTypeExpr.token,
      errorMessage: `Failed to implement the function. Expected 1 argument for the function body, got ${argExprs.length}.`,
    });
  }
  // NOTE: Don't cloneExpr here. It will affect the vscode extension.
  const functionBodyExpr = argExprs[0]!;

  // Add parameters to the env new frame
  // Regular functions (defined with `::`) do NOT capture outer variables.
  // Only closures (defined with `=>`) track captures. So we always treat this as
  // a non-closure context and clear any inherited capturedVariables.
  const isInClosureContext = false;

  // Check if we need to set up parameter aliases
  // This happens when implementing a module trait method where the function type
  // has different parameter names than the expected type from the trait
  const expectedType = context.expectedType?.type;
  const needsParameterAliasing =
    expectedType &&
    isFunctionType(expectedType) &&
    expectedType.parameters.length === functionType.parameters.length &&
    expectedType.parameters.some(
      (expectedParam, i) =>
        expectedParam.label !== functionType.parameters[i]!.label
    );

  // Determine whether module-level runtime variables should be preserved.
  // At module scope (not inside a function body), all `:=` variables are
  // module-level globals and must remain accessible from module functions.
  // Only strip runtime variables when defining a non-closure function inside
  // another function body, where outer runtime vars would be captures.
  const isAtModuleLevel = !context.isEvaluatingFunctionBodyOrAsyncBlock;

  let env = pushEnvFrame(
    isInClosureContext
      ? callerEnv
      : isAtModuleLevel
        ? callerEnv
        : keepTopLevelFrameAndComptimeVariablesFromEnv(callerEnv)
  );

  // If we need parameter aliasing, manually add parameters with aliases
  // Otherwise use the functionType.parametersFrame directly
  if (needsParameterAliasing && expectedType && isFunctionType(expectedType)) {
    // Add forall parameters first (they must match exactly)
    for (const forallParam of functionType.forallParameters) {
      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: forallParam.label,
          type: forallParam.type,
          isCompileTimeOnly: true,
          value: [
            createUnknownValue(forallParam.type, {
              variableName: forallParam.label,
              env,
              context,
            }),
          ],
          token: PlaceholderToken,
          initializedAtToken: PlaceholderToken,
          consumedAtToken: undefined,
          isOwningTheRcValue: false,
        },
      });
      env = nextEnv;
    }

    // Add regular parameters with aliases
    for (let i = 0; i < functionType.parameters.length; i++) {
      const anonymousParam = functionType.parameters[i]!;
      const expectedParam = expectedType.parameters[i]!;
      const anonymousParamName = anonymousParam.label;
      const expectedParamName = expectedParam.label;

      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: anonymousParamName,
          type: anonymousParam.type,
          isCompileTimeOnly: anonymousParam.isCompileTimeOnly,
          value: anonymousParam.isCompileTimeOnly
            ? [
                createUnknownValue(anonymousParam.type, {
                  variableName: expectedParamName,
                  env,
                  context,
                }),
              ]
            : undefined,
          token: PlaceholderToken,
          initializedAtToken: PlaceholderToken,
          consumedAtToken: undefined,
          isOwningTheRcValue: anonymousParam.isOwningTheRcValue,
          // Propagate `ref(name) : T` and `inout(name) : T` parameter
          // markings into the env variable so the body's codegen knows the
          // C-level representation is a pointer and reads of the identifier
          // become `(*name)`. Without this, `match(self, ...)` for a
          // `ref(self) : Self`-typed parameter would compile to
          // `switch ((self).tag) { ... self.data.Variant.field ... }`,
          // tripping the C "is not a pointer" error because `self` is
          // `Self*` at the C level (see std/encoding/json.yo Index impl).
          isRef: anonymousParam.isRef || undefined,
          isParameter: true,
          // Set up parameter alias if names differ
          parameterAlias:
            anonymousParamName !== expectedParamName
              ? expectedParamName
              : undefined,
        },
      });
      env = nextEnv;
    }
  } else {
    // No aliasing needed, use the functionType.parametersFrame directly
    env = pushEnvFrame(env, functionType.parametersFrame);
  }
  // const originalEnv = env; // backup the env for later CPS transformation use.

  // Get the parameters frame that was just created
  const parametersFrame = env.frames[env.frames.length - 1]!;

  // Create new function type with the correct parametersFrame
  // Keep the original parameter names (not the expected names) because the
  // function body uses the original parameter names for variable references
  const newFunctionType: FunctionType = {
    ...functionType,
    parametersFrame,
    env: functionType.env,
  };

  // Phase 0 of plans/FORMAL_VERIFICATION.md task #6: splice
  // `assert(P, msg)` / `comptime_assert(P, msg)` calls at the start
  // of the body for each `requires(...)` predicate. Mirrors the
  // wrap call in `evaluateAnonymousFunctionImplementation` —
  // the `name :: (fn(...) -> T)(body)` form lands here, the
  // inline `(x) -> ...` / `(x) => ...` forms land there.
  const effectiveBodyExpr = wrapFunctionBodyWithContracts(
    functionBodyExpr,
    newFunctionType
  );

  // Create the function value
  const functionValue: FunctionValue = {
    tag: ValueTag.Function,
    type: newFunctionType,
    body: effectiveBodyExpr, // Use transformed body
    frameLevel: env.frames.length - 1,
    funcName: undefined,
    funcId: `fn_${randomId(env.modulePath)}`,
    definitionSiteEnclosingFunctionType:
      context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "function-body"
        ? context.isEvaluatingFunctionBodyOrAsyncBlock.type
        : undefined,
    calledComptimeFunctionCaches: [],
    specializedFunctionCaches: [],
  };

  // Check if the function has forall type parameters
  // Re-apply where-clause constraints for this function body evaluation.
  if (newFunctionType.whereClauseExprs?.length) {
    const constraintExprs = newFunctionType.whereClauseExprs.map(
      (whereClauseExpr) => cloneExpr(whereClauseExpr)
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
  // If the function depends on generic type variables, we should NOT evaluate the body
  // at definition time. The body will be evaluated when the function is specialized
  // with concrete type arguments.
  // See note in src/evaluator/values/anonymous-function.ts:
  // an `exn : Exception` / `io : Io` parameter must NOT defer body evaluation —
  // their forall content is only inside type-erased fn-pointer fields.
  const shouldDeferBodyEvaluation =
    newFunctionType.forallParameters.length > 0 ||
    newFunctionType.parameters.some((param) =>
      typeContainsSomeTypeForCodegenParam(param.type)
    ) ||
    (newFunctionType.SelfType &&
      typeContainsSomeType(newFunctionType.SelfType));

  let evaluatedFunctionBody: Expr;
  let evaluationContext: EvaluatorContext;

  if (shouldDeferBodyEvaluation) {
    // Don't evaluate the body for generic functions at definition time.
    // The body will be evaluated when the function is specialized with concrete types.
    // However, we still trial-evaluate to catch return type mismatches.
    checkDeferredGenericReturnType({
      functionBodyExpr,
      functionType: newFunctionType,
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
      capturedVariables: undefined,
    };
    evaluatedFunctionBody = functionBodyExpr;
  } else {
    // Create a mutable context that we can check after evaluation
    // For regular functions (not closures), we clear capturedVariables to prevent
    // outer variables from being incorrectly marked as captured/consumed.
    const ctx = createFunctionBodyEvaluationContext(
      { ...context, capturedVariables: undefined },
      newFunctionType,
      functionValue,
      env
    );
    evaluationContext = ctx.evaluationContext;

    evaluatedFunctionBody = evaluateBeginExpression({
      expr: effectiveBodyExpr, // Use transformed body
      env,
      context: evaluationContext,
      variablesToAdd: [],
      isEvaluatingFunctionBodyBeginBlock: true,
    });
    if (!evaluatedFunctionBody.$) {
      throw formatErrorMessage({
        token: functionBodyExpr.token,
        errorMessage: `Failed to evaluate the function body.`,
      });
    }
    env = evaluatedFunctionBody.$.env;
  }

  // Get captured variables from the evaluation context
  const capturedVariables = evaluationContext.capturedVariables;

  // (Ref-returning functions are banned at signature evaluation — see
  // evaluateFunctionType — so no `-> ref(T)` return enforcement is
  // needed here anymore.)
  if (
    typeRepresentationContainsRawPtr(newFunctionType.return.type) &&
    !newFunctionType.return.isCompileTimeOnly &&
    !isImplicitlyUnsafeCapableFile(functionBodyExpr.token.modulePath)
  ) {
    // plans/SLICE_FLOWABILITY.md Phase C — a function whose return
    // type is value-typed but transitively carries a raw pointer in
    // its representation (e.g. `Slice(T)`, `str`, or any struct that
    // wraps one) must root the returned value in caller-owned storage.
    // Otherwise the returned fat pointer would point into the dying
    // call frame.
    let returnExpr: Expr = evaluatedFunctionBody;
    if (
      exprIsFunctionCall(evaluatedFunctionBody) &&
      exprIsFunctionCallOf(evaluatedFunctionBody, BuiltinKeywords.begin)
    ) {
      const beginCall = evaluatedFunctionBody as FnCallExpr;
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
        errorMessage: `Function returning '${typeToString(newFunctionType.return.type)}' carries a raw pointer in its representation; the returned value must be rooted in caller-owned storage. The body's final expression is not flowable:\n  ${exprToString(returnExpr)}\n\nFlowable sources: a 'ref'-bound parameter; a non-'ref' parameter (caller's value is alive across the call); a 'comptime' constant or string literal; '.field' on a flowable base; a call returning ref or slice with flowable arguments; or a 'cond'/'match' whose arms are all flowable.\n\nFixes:\n  - Take the source as a 'ref(name) : T' parameter and project a slice from it.\n  - Return an owned type ('ArrayList', 'String') instead — heap-allocated, no lifetime concern.\n  - Wrap unsafe construction in 'pragma(Pragma.AllowUnsafe);' at the file top if you genuinely need the raw form.`,
      });
    }
  }

  // Check if the function body type matches the function return type
  const functionBodyReturnType = evaluatedFunctionBody.$?.type;

  // §4 typing rule 1: `unwind` is only valid in a `ctl(...) -> ret`
  // body. See anonymous-function.ts for the rationale and the parallel
  // check at the inline-lambda evaluator.
  if (evaluatedBodyContainsEscape(evaluatedFunctionBody)) {
    if (!newFunctionType.isControl && !newFunctionType.isClosure) {
      throw formatErrorMessage({
        token: functionBodyExpr.token,
        errorMessage: `\`unwind\` is only valid inside a control-function body. This function is declared with \`fn(...) -> ret\`; change the declared type to \`ctl(...) -> ret\` if the body needs to unwind.`,
      });
    }
    functionValue.isControlFunction = true;
  }

  // Regular function: body type must match return type exactly
  // Skip when body uses escape because the escape returns
  // from the enclosing function, not this function.
  //
  // Also skip when the function body's return type is a SomeType (e.g. `ResumeType`
  // from `Exception.throw`) AND the function has implicit parameters whose type
  // contains SomeType (e.g. `using(exn : Exception)`). In that case the body's
  // SomeType result is a forall param of an implicit-parameter method; it will be
  // resolved when the function is specialized at a concrete call site.
  //
  // Phase B/C of plans/ITERATOR_REDESIGN.md — for `-> ref(T)`
  // functions, the body produces `*(T)`; compare against that.
  const finalExpectedReturnForBody: Type = newFunctionType.return.isRef
    ? createPtrType(newFunctionType.return.type)
    : newFunctionType.return.type;
  // For `-> ref(T)` returns, the flowability check above already verified
  // that the body roots back to a ref-bound parameter (R1–R4). At that
  // point the body's `.$.type` is the underlying `T` (auto-deref'd
  // through the ref binding), but codegen will emit the address-taking
  // wrapper at the return site. Skip the strict compatibility check
  // here — comparing `*(T)` vs `T` would spuriously reject every
  // valid `ref_identity :: (fn(ref(p) : i32) -> ref(i32))(p)` shape.
  const skipReturnTypeCheckForRefReturn = newFunctionType.return.isRef;
  if (
    !shouldDeferBodyEvaluation &&
    !functionValue.isControlFunction &&
    !skipReturnTypeCheckForRefReturn &&
    functionBodyReturnType &&
    !areTypesCompatible(
      { type: finalExpectedReturnForBody, env },
      { type: functionBodyReturnType, env }
    )
  ) {
    // console.trace();
    throw formatErrorMessage({
      token: newFunctionType.return.typeExpr.token,
      errorMessage: `Incompatible function return type for:
- Expected: ${typeToString(finalExpectedReturnForBody)}
- Given  : ${typeToString(functionBodyReturnType)}`,
    });
  }

  // If the return type is a SomeType (Impl) without resolvedConcreteType,
  // and the function body returns a concrete type that implements the required modules,
  // set the resolvedConcreteType for proper codegen
  if (
    isSomeType(newFunctionType.return.type) &&
    !newFunctionType.return.type.resolvedConcreteType
  ) {
    if (!isSomeType(functionBodyReturnType)) {
      newFunctionType.return.type.resolvedConcreteType = functionBodyReturnType;
    } else if (
      isSomeType(functionBodyReturnType) &&
      functionBodyReturnType.resolvedConcreteType
    ) {
      // Propagate resolvedConcreteType from delegation wrappers
      // e.g., write_file_cstr delegates to write_file, both return Impl(Future(...))
      newFunctionType.return.type.resolvedConcreteType =
        functionBodyReturnType.resolvedConcreteType;
    }
  }

  if (
    newFunctionType.return.isCompileTimeOnly &&
    evaluatedFunctionBody.$ &&
    !evaluatedFunctionBody.$.value
  ) {
    throw formatErrorMessage({
      token: newFunctionType.return.typeExpr.token,
      errorMessage: `Expected to return a compile-time value, but got runtime value.`,
    });
  }

  // Pop the env frame
  // NOTE: We need to ignore check here because the top frame might contain tempVariable holding the return value.
  //       The check should be handled when evaluating the begin expression.
  env = popEnvFrame(env, true);

  // For closures, consume the captured variables from outer scopes
  let finalCallerEnv = callerEnv;
  if (isInClosureContext && capturedVariables && capturedVariables.size > 0) {
    finalCallerEnv = consumeCapturedVariables({
      capturedVariables,
      env: callerEnv,
      closureToken: expr.token,
    });
  }

  // Reset the cache
  // functionValue.calledComptimeFunctionCaches = [];

  // If we're in CTFE analysis mode OR actually executing a CTFE function
  // (forceCompileTimeBindings is true), also analyze this nested function for CTFE capability.
  // This allows nested functions to be called at compile-time.
  let finalFunctionValue = functionValue;
  let finalFunctionType = newFunctionType;

  if (context.isAnalyzingCtfeCapability || context.forceCompileTimeBindings) {
    const comptimeFunctionValue = analyzeCtfeCapability(
      functionValue,
      finalCallerEnv,
      context
    );
    if (comptimeFunctionValue) {
      // Use the CTFE version so it can be called at compile-time
      finalFunctionValue = comptimeFunctionValue;
      finalFunctionType = comptimeFunctionValue.type;
    }
  }

  // Set the function type and value
  expr.$ = {
    env: finalCallerEnv,
    value: finalFunctionValue,
    type: finalFunctionType,
    pathCollection:
      capturedVariables && capturedVariables.size > 0
        ? buildPathCollectionFromCapturedVariables(capturedVariables)
        : [],
  };

  return expr;
}
