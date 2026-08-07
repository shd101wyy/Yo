import { type Environment, popEnvFrame, pushEnvFrame } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  cloneExpr,
  type Expr,
  type FnCallExpr,
} from "../../expr";
import { evaluatedBodyContainsEscape } from "../../expr-traversal";
import type { FunctionValue } from "../../function-value";
import { areTypesCompatible } from "../../types/compatibility";
import { synthesizeTypes } from "../types/synthesizer";
import type {
  DynType,
  FnTraitType,
  SomeType,
  Type,
} from "../../types/definitions";
import { isDynType, isSomeType } from "../../types/guards";
import { typeIsControlBound, typeToString } from "../../types/utils";
import { randomId } from "../../utils";
import { ValueTag } from "../../value-tag";
import type { EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "../exprs/begin";
import { applyWhereClauseConstraints } from "../types/function";
import {
  buildPathCollectionFromCapturedVariables,
  createCaptureTypeAndValue,
  enrichCapturedVariables,
  generateCapturedVariableDupExpressions,
  validateCaptureTraitRequirements,
} from "../utils/closure";
import { createFunctionBodyEvaluationContext } from "./function-type";

/**
 * Handle calling a closure type to create a closure value.
 * expr should be: WrapperType(closureBody) where WrapperType is SomeType or DynType containing a FnTraitType
 */
export function tryToImplementClosureByFnTraitType({
  expr,
  fnTraitType,
  wrapperType,
  callerEnv,
  context,
}: {
  expr: FnCallExpr;
  fnTraitType: FnTraitType;
  wrapperType: SomeType | DynType;
  callerEnv: Environment;
  context: EvaluatorContext;
}): Expr {
  const fnTraitTypeExpr = expr.func;
  const argExprs = expr.args;

  if (argExprs.length !== 1) {
    throw formatErrorMessage({
      token: fnTraitTypeExpr.token,
      errorMessage: `Fn trait type expects exactly 1 argument (the closure body), got ${argExprs.length}`,
    });
  }

  // NOTE: Don't cloneExpr here. It will affect the vscode extension.
  const closureBodyExpr = argExprs[0]!;

  // Add parameters to the env new frame
  // For closures, we keep the full caller environment to enable variable capturing
  let env = pushEnvFrame(callerEnv, fnTraitType.isFn.callType.parametersFrame);
  // const originalEnv = env; // backup the env for later CPS transformation use.

  // Re-apply where-clause constraints for this closure body evaluation.
  if (fnTraitType.isFn.callType.whereClauseExprs?.length) {
    const constraintExprs = fnTraitType.isFn.callType.whereClauseExprs.map(
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

  // Create the function value for the closure
  const functionValue: FunctionValue = {
    tag: ValueTag.Function,
    type: fnTraitType.isFn.callType, // The function value uses the isFn type
    body: closureBodyExpr,
    frameLevel: env.frames.length - 1,
    funcName: undefined,
    funcId: `closure_${randomId(env.modulePath)}`,
    definitionSiteEnclosingFunctionType:
      context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "function-body"
        ? context.isEvaluatingFunctionBodyOrAsyncBlock.type
        : undefined,
    calledComptimeFunctionCaches: [],
    specializedFunctionCaches: [],
  };

  // Create evaluation context using helper function
  const { evaluationContext } = createFunctionBodyEvaluationContext(
    context,
    fnTraitType.isFn.callType,
    functionValue,
    env
  );

  // Evaluate the closure body
  const evaluatedClosureBody = evaluateBeginExpression({
    expr: closureBodyExpr,
    env,
    context: evaluationContext,
    variablesToAdd: [],
    isEvaluatingFunctionBodyBeginBlock: true,
  });

  if (!evaluatedClosureBody.$) {
    throw formatErrorMessage({
      token: closureBodyExpr.token,
      errorMessage: `Failed to evaluate the closure body.`,
    });
  }
  env = evaluatedClosureBody.$.env;

  // §4 typing rule 3: closure body cannot contain `unwind`. A closure
  // is a heap-allocated value designed to be passed around / stored /
  // called later; this is incompatible with the frame-bound discipline
  // of control functions. Handlers must be bare anonymous functions
  // (`ctl(...) -> ret`), not closures.
  if (evaluatedBodyContainsEscape(evaluatedClosureBody)) {
    throw formatErrorMessage({
      token: closureBodyExpr.token,
      errorMessage: `Closure bodies cannot contain \`unwind\`. Closures are heap-allocated values that may be stored or passed around and outlive their enclosing frame; \`unwind\` requires a frame-bound \`ctl(...) -> ret\` function.

If you need a handler, define a bare anonymous function:
  (raise : Raise) = ((msg) -> { unwind(...); });`,
    });
  }

  // Get captured variables from the evaluation context
  const capturedVariables = evaluationContext.capturedVariables;

  // §4 typing rule 4: closure cannot capture a value of control-bound
  // type. The closure value carries the captured value in its env;
  // closures may escape (return, heap-store), and the captured CF
  // would escape with them. If a handler needs to be threaded through
  // closure-like code, take it as a regular function parameter
  // instead.
  if (capturedVariables && capturedVariables.size > 0) {
    for (const [varName, captureInfo] of capturedVariables.entries()) {
      if (captureInfo.frameLevel < callerEnv.frames.length) {
        const frame = callerEnv.frames[captureInfo.frameLevel]!;
        const variable = frame.variables.find((v) => v.name === varName);
        if (
          variable &&
          !variable.isCompileTimeOnly &&
          typeIsControlBound(variable.type)
        ) {
          throw formatErrorMessage({
            token: captureInfo.token,
            errorMessage: `Closures cannot capture a value of control-bound type. The captured value \`${varName}\` has type \`${typeToString(
              variable.type
            )}\` which transitively contains a \`ctl(...) -> ret\` function. Closures can escape their enclosing frame, taking the captured control function with them — which would unwind to a dead install frame.

Pass \`${varName}\` as a regular function parameter instead of capturing it in a closure.`,
          });
        }
      }
    }
  }

  // Check if the closure body type matches the closure return type
  const closureBodyReturnType = evaluatedClosureBody.$.type;
  // Synthesize the return-type generic vars from the closure body's
  // actual return type. The closure's `fnTraitType` is the EXPECTED
  // Fn(e : E) -> T pulled from the surrounding call site (e.g.
  // `io.async`'s `action : Impl(Fn(e : E) -> T)` where E and T are
  // async's outer generic vars). After body evaluation we know what
  // T concretely is — synthesize against the trait's return type so
  // the outer generic(T) gets bound and the io.async call can derive
  // `Impl(Future(T, E))` correctly. Without this, the compatibility
  // check below silently accepts the SomeType match but leaves T (and
  // by extension E, when the closure body uses other fields of E)
  // unbound, propagating "Given Impl(Future(i32, E))" up to the
  // enclosing function's return-type check.
  try {
    synthesizeTypes(
      { type: fnTraitType.isFn.callType.return.type, env },
      { type: closureBodyReturnType, env }
    );
  } catch {
    // synthesizeTypes is best-effort here — if it fails (e.g. the
    // return is unrelated to any generic) the compatibility check
    // below still gates correctness.
  }
  if (
    !areTypesCompatible(
      { type: fnTraitType.isFn.callType.return.type, env },
      { type: closureBodyReturnType, env }
    )
  ) {
    throw formatErrorMessage({
      token: fnTraitType.isFn.callType.return.typeExpr.token,
      errorMessage: `Incompatible closure return type:
- Expected: ${typeToString(fnTraitType.isFn.callType.return.type)}
- Given  : ${typeToString(closureBodyReturnType)}`,
    });
  }

  if (
    fnTraitType.isFn.callType.return.isCompileTimeOnly &&
    !evaluatedClosureBody.$.value
  ) {
    throw formatErrorMessage({
      token: fnTraitType.isFn.callType.return.typeExpr.token,
      errorMessage: `Expected to return a compile-time value, but got runtime value.`,
    });
  }

  // Pop the env frame
  // NOTE: We need to ignore check here because the top frame might contain tempVariable holding the return value.
  //       The check should be handled when evaluating the begin expression.
  env = popEnvFrame(env, true);

  // Update the function value with captured variables (if any)
  // NOTE: Use callerEnv (BEFORE consumption) so we can access the variables
  const capturedVariablesWithValues =
    capturedVariables && capturedVariables.size > 0
      ? enrichCapturedVariables({ capturedVariables, env: callerEnv })
      : undefined;

  // Generate ___dup expressions for captured ARC variables
  // The closure gets its own copy through the dup, the original variable remains usable
  let finalCallerEnv = callerEnv;
  const { capturedVariableDupExpressions, env: updatedEnv } =
    generateCapturedVariableDupExpressions({
      capturedVariablesWithValues,
      env: callerEnv,
      context,
    });
  finalCallerEnv = updatedEnv;

  // Create the proper capture type based on captured variables using helper function
  // We don't need the captureValue since closures are runtime-only
  const { captureType: inferredCaptureType } = createCaptureTypeAndValue({
    expectedCaptureType: undefined, // Capture type is no longer part of ClosureType
    capturedVariablesWithValues,
    env: finalCallerEnv,
    closureToken: expr.token,
    context: { ...context },
  });

  // Set the closure info on the function value for easy codegen access
  const consumedCaptureNames = evaluationContext.ownConsumedCaptures
    ? Array.from(evaluationContext.ownConsumedCaptures)
    : undefined;
  functionValue.closureInfo = {
    closureType: fnTraitType,
    captureType: inferredCaptureType,
    consumedCaptures: consumedCaptureNames?.length
      ? consumedCaptureNames
      : undefined,
  };

  // Validate that the capture struct implements all required non-Fn traits (e.g., Send)
  if (isSomeType(wrapperType) && inferredCaptureType) {
    validateCaptureTraitRequirements({
      wrapperType,
      captureType: inferredCaptureType,
      env: finalCallerEnv,
      errorToken: expr.token,
      capturedVariablesWithValues,
    });
  }

  // Determine the final type based on the wrapper type (SomeType or DynType)
  let finalType: Type;
  if (isSomeType(wrapperType)) {
    // IMPORTANT: Mutate the wrapper SomeType in-place so downstream generic specialization
    // can observe the concrete capture struct type.
    //
    // This mutation is safe because we use `skipSpecialization: true` during the "checking phase"
    // of function call resolution (when tryToCallFunctionWithArguments is called with cloned
    // expressions to test if parameters match). This prevents cache pollution from intermediate
    // capture structs created during checking. The actual specialization only happens during
    // the real call phase with the final capture struct.
    //
    // See issues/SPECIALIZATION_CACHE_PITFALL.md for details on the bug this pattern caused.
    wrapperType.resolvedConcreteType = inferredCaptureType;
    finalType = {
      ...wrapperType,
      resolvedConcreteType: inferredCaptureType,
    } as SomeType;
  } else if (isDynType(wrapperType)) {
    // For DynType (Dyn(Fn(...))), no need to do anything
    finalType = wrapperType;
  } else {
    // Fallback (should not happen)
    finalType = fnTraitType;
  }

  // Set the result with the wrapper type (SomeType or DynType)
  expr.$ = {
    env: finalCallerEnv,
    value: undefined,
    type: finalType,
    pathCollection:
      capturedVariables && capturedVariables.size > 0
        ? buildPathCollectionFromCapturedVariables(capturedVariables)
        : [],
    deferredDupExpressions:
      capturedVariableDupExpressions &&
      capturedVariableDupExpressions.length > 0
        ? capturedVariableDupExpressions
        : undefined,
    captureType: inferredCaptureType, // Store the capture struct type for codegen (used for both closures and async blocks)
    closureFunctionValue: functionValue,
  };

  // Attach a temp variable to the expr to hold the ARC value for closure
  // Only attach for DynType since SomeType is a value type (not reference counted)
  if (isDynType(wrapperType)) {
    attachTempVariableToExpr(expr, true);
  }

  return expr;
}
