import {
  addVariableToEnv,
  type Environment,
  getVariablesFromEnv,
  getVariablesFromEnvByFilter,
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
  isSliceType,
  isArrayType,
  isIsoType,
  isSomeType,
  isStructType,
} from "../../types/guards";
import {
  convertComptimeTypeToRuntimeType,
  typeContainsSomeType,
  typeToString,
} from "../../types/utils";
import {
  createPtrType,
  createSliceType,
  createArrayType,
  createEffectsRowType,
  createFnTraitType,
  createSomeType,
  createType0,
} from "../../types/creators";
import type {
  EffectsRowType,
  FnTraitType,
  FunctionImplicitParameter,
  FunctionType,
  SourceNamespaceType,
  SomeType,
  StructType,
  Type,
} from "../../types/definitions";
import { randomId } from "../../utils";
import {
  createUnknownValue,
  isFunctionValue,
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
 *   fold :: (forall(A, Acc, F), self, init: Acc, f: F, where(F <: Fn(acc: Acc, item: A) -> Acc)) -> Acc
 * and called as `fold(0, (acc, x) => acc + x.*)`, the Fn trait's callType
 * still references the unresolved forall SomeTypes `Acc` and `A`. By the time
 * the lambda is being evaluated, these forall variables have been bound to
 * concrete types in the callee's env (e.g., `Acc -> i32, A -> *(i32)`).
 *
 * This helper walks `type` and substitutes any SomeType whose `name` matches a
 * comptime variable in `env` whose value is a TypeValue. This ensures that the
 * lambda parameter bindings and downstream codegen see concrete types instead
 * of unresolved forall SomeTypes.
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

  if (isSliceType(type)) {
    const childSub = substituteSomeTypesFromEnv(type.childType, env, visited);
    if (childSub === type.childType) return type;
    return createSliceType(childSub);
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
      // Substitute forall SomeTypes (e.g., `Acc`, `A` from a generic
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

  // Parse parameter expressions to separate forall and regular parameters
  // REMOVED: `using` keyword is gone. All non-forall params are regular.
  let forallParamExprs: Expr[] = [];
  const usingParamExprs: Expr[] = [];
  const regularParamExprs: Expr[] = [];

  for (let i = 0; i < parameterExprs.length; i++) {
    const paramExpr = parameterExprs[i]!;

    if (
      exprIsFunctionCall(paramExpr) &&
      exprIsFunctionCallOf(paramExpr, BuiltinKeywords.forall)
    ) {
      if (i !== 0) {
        throw formatErrorMessage({
          token: paramExpr.token,
          errorMessage: `forall(...) must be the first parameter expression`,
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
      errorMessage: `Expected ${functionType.forallParameters.length} forall parameters, got ${forallParamExprs.length}`,
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

  // Validate parameter names for comptime parameters (forall, implicit, and comptime regular parameters)
  // Check forall parameters (always comptime)
  for (let i = 0; i < forallParamExprs.length; i++) {
    const paramExpr = forallParamExprs[i]!;
    const expectedParam = functionType.forallParameters[i]!;

    if (!exprIsAtom(paramExpr)) {
      throw formatErrorMessage({
        token: paramExpr.token,
        errorMessage: `Expected parameter name for forall parameter, got ${exprToString(paramExpr)}`,
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
    // Add forall parameter to environment.
    // Allow variable shadowing because in nested ctl handlers, the inner handler's
    // forall T needs to shadow the outer handler's T that exists in the env chain
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

  // Check implicit parameters from using(...)
  // When the function type has effect row spreads (e.g., ...(E)), and the user
  // provides using(...) params, we need to expand the effect row by resolving
  // each user-provided param name from the outer (pre-stripped) environment.
  //
  // Simplified syntax rules:
  //   using(name1, name2)           — plain atoms, resolve types from outer env
  //   using(name : Type, name2)     — typed declarations mixed with atoms
  //   using(...(E)) in fn types     — effect row spread (forall var only, NOT in closures)
  const hasEffectRowSpread = functionType.implicitParameters.some(
    (p) => p.isEffectRowSpread
  );

  let resolvedImplicitParameters: FunctionImplicitParameter[];
  let inlineEffectsRow: EffectsRowType | undefined;
  if (hasEffectRowSpread && usingParamExprs.length > 0) {
    // The function type has an unexpanded effect row spread like ...(E).
    // Closure provides concrete effects directly: using(io : IO) or using(_yield, _log)
    resolvedImplicitParameters = [];
    for (const paramExpr of usingParamExprs) {
      if (
        exprIsFunctionCall(paramExpr) &&
        exprIsFunctionCallOf(paramExpr, ":", 2)
      ) {
        // Typed: yield : Yield
        const nameExpr = paramExpr.args[0]!;
        const typeExpr = paramExpr.args[1]!;
        if (!exprIsAtom(nameExpr)) {
          throw formatErrorMessage({
            token: nameExpr.token,
            errorMessage: `Expected identifier for effect name, got ${exprToString(nameExpr)}`,
          });
        }
        const paramName = nameExpr.token.value;
        const evaluatedTypeExpr = evaluateExpression({
          expr: cloneExpr(typeExpr),
          env: outerEnv,
          context: { ...context, isEvaluatingFunctionType: true },
        });
        if (
          !evaluatedTypeExpr.$?.value ||
          !isTypeValue(evaluatedTypeExpr.$.value)
        ) {
          throw formatErrorMessage({
            token: typeExpr.token,
            errorMessage: `Expected a type for effect parameter "${paramName}", got ${exprToString(typeExpr)}`,
          });
        }
        const paramType = evaluatedTypeExpr.$.value.value;
        resolvedImplicitParameters.push({
          label: paramName,
          type: paramType,
          isCompileTimeOnly: true,
          isImplicit: true,
          isOwningTheRcValue: false,
          isQuote: false,
          exprs: {
            expr: paramExpr,
            labelExpr: nameExpr,
            typeExpr: typeExpr,
            defaultValueExpr: undefined,
          },
        });
      } else if (exprIsAtom(paramExpr)) {
        // Plain atom: _yield — resolve type from outer env
        const paramName = paramExpr.token.value;
        const outerVariables = getVariablesFromEnv(outerEnv, paramName);
        const outerVar = outerVariables.at(-1);
        if (!outerVar) {
          throw formatErrorMessage({
            token: paramExpr.token,
            errorMessage: `Variable "${paramName}" not found. Cannot infer type for using() parameter.`,
          });
        }
        resolvedImplicitParameters.push({
          label: paramName,
          type: outerVar.type,
          isCompileTimeOnly: true,
          isImplicit: true,
          isOwningTheRcValue: false,
          isQuote: false,
          exprs: {
            expr: paramExpr,
            labelExpr: paramExpr,
            typeExpr: paramExpr,
            defaultValueExpr: undefined,
          },
        });
      } else {
        throw formatErrorMessage({
          token: paramExpr.token,
          errorMessage: `Expected "name : Type" or identifier in using(), got ${exprToString(paramExpr)}`,
        });
      }
    }
    // Create an EffectsRowType and bind it to the E variable(s) in the env
    // so that the anonymous function's type has E resolved.
    inlineEffectsRow = createEffectsRowType(resolvedImplicitParameters);
    for (const implicitParam of functionType.implicitParameters) {
      if (!implicitParam.isEffectRowSpread) continue;
      if (isSomeType(implicitParam.type) && implicitParam.type.isEffectsRow) {
        (implicitParam.type as SomeType).resolvedConcreteType =
          inlineEffectsRow;
      }
    }
  } else {
    // No effect row spread, or no user-provided using() params.
    if (usingParamExprs.length > 0) {
      // Closure declares effects with types or renames — verify they match
      const inlineParams: {
        name: string;
        type: Type | undefined;
        nameExpr: Expr;
      }[] = [];
      for (const paramExpr of usingParamExprs) {
        if (
          exprIsFunctionCall(paramExpr) &&
          exprIsFunctionCallOf(paramExpr, ":", 2)
        ) {
          // Typed: yield : Yield
          const nameExpr = paramExpr.args[0]!;
          const typeExpr = paramExpr.args[1]!;
          if (!exprIsAtom(nameExpr)) {
            throw formatErrorMessage({
              token: nameExpr.token,
              errorMessage: `Expected identifier for effect name, got ${exprToString(nameExpr)}`,
            });
          }
          const evaluatedTypeExpr = evaluateExpression({
            expr: cloneExpr(typeExpr),
            env: outerEnv,
            context: { ...context, isEvaluatingFunctionType: true },
          });
          if (
            !evaluatedTypeExpr.$?.value ||
            !isTypeValue(evaluatedTypeExpr.$.value)
          ) {
            throw formatErrorMessage({
              token: typeExpr.token,
              errorMessage: `Expected a type for effect parameter "${nameExpr.token.value}", got ${exprToString(typeExpr)}`,
            });
          }
          inlineParams.push({
            name: nameExpr.token.value,
            type: evaluatedTypeExpr.$.value.value,
            nameExpr,
          });
        } else if (exprIsAtom(paramExpr)) {
          // Plain atom: _yield — no explicit type, will just rename
          inlineParams.push({
            name: paramExpr.token.value,
            type: undefined,
            nameExpr: paramExpr,
          });
        } else {
          throw formatErrorMessage({
            token: paramExpr.token,
            errorMessage: `Expected "name : Type" or identifier in using(), got ${exprToString(paramExpr)}`,
          });
        }
      }

      const hasTypedInline = inlineParams.some((p) => p.type !== undefined);
      if (hasTypedInline) {
        // Compare inline declaration with already-resolved implicit params
        if (inlineParams.length !== functionType.implicitParameters.length) {
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `Effect row mismatch: closure declares ${inlineParams.length} effects, but call site resolved ${functionType.implicitParameters.length} effects.`,
          });
        }
        // Match inline params to resolved params by type compatibility,
        // not by position. This allows the closure to declare effects
        // in a different order than the Future type annotation.
        const used = new Set<number>();
        const reorderedResolved: FunctionImplicitParameter[] = [];
        for (let j = 0; j < inlineParams.length; j++) {
          const inlineParam = inlineParams[j]!;
          if (!inlineParam.type) {
            // No explicit type — match by position as fallback
            reorderedResolved.push({
              ...functionType.implicitParameters[j]!,
              label: inlineParam.name,
              exprs: {
                ...functionType.implicitParameters[j]!.exprs,
                expr: inlineParam.nameExpr,
                labelExpr: inlineParam.nameExpr,
              },
            });
            used.add(j);
            continue;
          }
          let matched = false;
          for (let k = 0; k < functionType.implicitParameters.length; k++) {
            if (used.has(k)) continue;
            const resolvedParam = functionType.implicitParameters[k]!;
            if (
              areTypesCompatible(
                { type: inlineParam.type, env: outerEnv },
                { type: resolvedParam.type, env: outerEnv }
              )
            ) {
              reorderedResolved.push({
                ...resolvedParam,
                label: inlineParam.name,
                exprs: {
                  ...resolvedParam.exprs,
                  expr: inlineParam.nameExpr,
                  labelExpr: inlineParam.nameExpr,
                },
              });
              used.add(k);
              matched = true;
              break;
            }
          }
          if (!matched) {
            throw formatErrorMessage({
              token: inlineParam.nameExpr.token,
              errorMessage: `Effect row type mismatch for "${inlineParam.name}": closure declares ${typeToString(inlineParam.type)}, but no matching resolved effect found.`,
            });
          }
        }
        resolvedImplicitParameters = reorderedResolved;
        // Mark as inline for the newFunctionType builder
        inlineEffectsRow = createEffectsRowType(resolvedImplicitParameters);
      } else {
        // Plain identifiers: validate count matches
        if (usingParamExprs.length !== functionType.implicitParameters.length) {
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `Expected ${functionType.implicitParameters.length} implicit parameters in using(...), got ${usingParamExprs.length}`,
          });
        }
        resolvedImplicitParameters = functionType.implicitParameters;
      }
    } else {
      resolvedImplicitParameters = functionType.implicitParameters;
    }
  }

  // Track effect params for io.async closures — these will be added to the
  // capture struct so they can be injected at io.spawn/io.await time.
  const effectParamEntries: Array<{
    name: string;
    type: Type;
    token: Token;
  }> = [];

  for (let i = 0; i < resolvedImplicitParameters.length; i++) {
    const expectedParam = resolvedImplicitParameters[i]!;
    // For inline ...(name : Type) declarations, get the individual param expr from
    // the resolvedImplicitParameters entry itself. For plain using(_yield, _log), use usingParamExprs[i].
    const paramExpr = inlineEffectsRow
      ? expectedParam.exprs?.labelExpr
      : usingParamExprs[i];

    // Determine the parameter name: from the using() expr if provided, otherwise from expected
    let paramName = expectedParam.label;
    if (paramExpr && exprIsAtom(paramExpr)) {
      paramName = paramExpr.token.value;
    }

    // For function-typed implicit parameters, try to resolve the actual handler
    // value from the outer env (before implicit variables were stripped).
    // This allows the codegen to resolve calls like `_yield(v)` to direct
    // C function calls when the handler is a non-control function (no abort),
    // and allows the codegen third pass to check `isControlFunction` on control
    // function handlers for proper state machine registration.
    let resolvedHandlerValue: Value | undefined;
    if (isFunctionType(expectedParam.type)) {
      // Try lookup by the current label first, then fall back to the original
      // label from functionType.implicitParameters. This handles the case where
      // the closure renames the parameter (e.g., _yield -> yield in outer env).
      const originalLabel = functionType.implicitParameters[i]?.label;
      const labelsToTry = [expectedParam.label];
      if (originalLabel && originalLabel !== expectedParam.label) {
        labelsToTry.push(originalLabel);
      }
      for (const label of labelsToTry) {
        const handlerVars = getVariablesFromEnv(outerEnv, label);
        const handlerVar = handlerVars[handlerVars.length - 1];
        if (handlerVar?.value && handlerVar.value.length > 0) {
          const hv = handlerVar.value[0];
          if (hv && isFunctionValue(hv)) {
            resolvedHandlerValue = hv;
            break;
          }
        }
      }
      // Fallback: search by type compatibility among given (implicit) variables.
      // This handles the case where the effect label from the Future type annotation
      // (e.g., "Log") doesn't match the given handler name (e.g., "log").
      if (!resolvedHandlerValue) {
        const givenByType = getVariablesFromEnvByFilter(
          outerEnv,
          (v) =>
            v.isImplicit === true &&
            v.isCompileTimeOnly === true &&
            isFunctionValue(v.value?.[0]) &&
            areTypesCompatible(
              { type: expectedParam.type, env: outerEnv },
              { type: v.type, env: outerEnv }
            )
        );
        const byTypeVar = givenByType.at(-1);
        if (byTypeVar?.value?.[0] && isFunctionValue(byTypeVar.value[0])) {
          resolvedHandlerValue = byTypeVar.value[0];
        }
      }
    }

    const paramValue = resolvedHandlerValue
      ? resolvedHandlerValue
      : createUnknownValue(expectedParam.type, {
          variableName: paramName,
          env,
          context,
        });

    // Add implicit parameter to environment.
    // For io.async closures, function-typed effect params are runtime values
    // so they get captured in the closure's capture struct and can be injected
    // at io.spawn/io.await time. Non-function-typed params (e.g., IO module)
    // remain compile-time only.
    // However, if the handler is already resolved from the outer scope (via
    // given bindings), it's compile-time known and doesn't need runtime injection.
    // Forall function types (e.g., Raise :: fn(forall(T), msg: String) -> T)
    // are also captured — they are passed as void* and cast at each call site.
    const isEffectParamInAsyncClosure =
      context.isInsideIoAsyncCall &&
      isCreatingClosure &&
      isFunctionType(expectedParam.type) &&
      !resolvedHandlerValue;
    if (isEffectParamInAsyncClosure) {
      effectParamEntries.push({
        name: paramName,
        type: expectedParam.type,
        token: paramExpr?.token ?? PlaceholderToken,
      });
    }

    // Handle record-typed effects (e.g., Exception :: struct(throw : fn(...))
    // or IO :: struct(async : fn(...))) in async closures. Effect records need
    // their function members decomposed and captured individually for runtime
    // injection at io.spawn/io.await.
    const isRecordEffectInAsyncClosure =
      !isEffectParamInAsyncClosure &&
      context.isInsideIoAsyncCall &&
      isCreatingClosure &&
      (isSourceNamespaceType(expectedParam.type) ||
        isStructType(expectedParam.type)) &&
      !resolvedHandlerValue;
    if (isRecordEffectInAsyncClosure) {
      const recordType = expectedParam.type as SourceNamespaceType | StructType;
      for (const field of recordType.fields) {
        if (isFunctionType(field.type)) {
          effectParamEntries.push({
            name: field.label,
            type: field.type,
            token: paramExpr?.token ?? PlaceholderToken,
          });
        }
      }
    }

    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: paramName,
        type: expectedParam.type,
        isCompileTimeOnly: !isEffectParamInAsyncClosure,
        isImplicit: true,
        value: isEffectParamInAsyncClosure ? undefined : [paramValue],
        token: paramExpr?.token ?? PlaceholderToken,
        initializedAtToken: paramExpr?.token ?? PlaceholderToken,
        consumedAtToken: undefined,
        isOwningTheRcValue: false,
        isEffectParam: isEffectParamInAsyncClosure || undefined,
      },
      allowVariableShadowing: true,
    });
    env = nextEnv;

    if (paramExpr) {
      paramExpr.$ = {
        env: env,
        type: expectedParam.type,
        value: isEffectParamInAsyncClosure ? undefined : paramValue,
        pathCollection: [],
      };
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
    const anonymousParamName = paramExpr.token.value;
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
        // If anonymous function uses different parameter name than expected,
        // store the expected name as alias for C codegen
        parameterAlias:
          anonymousParamName !== expectedParamName
            ? expectedParamName
            : undefined,
      },
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

  // Create new function type using expected forall/implicit parameters and mixing anonymous + expected regular parameters
  const newFunctionType: FunctionType = {
    ...functionType,
    // forall parameters must use expected names/types entirely (they're always comptime)
    forallParameters: functionType.forallParameters,
    // Use the resolved implicit parameters (expanded from effect row if applicable)
    // For inline ...(name : Type) declarations, labels are already set correctly.
    // For plain identifier using() params, update labels to match user-provided names.
    implicitParameters: inlineEffectsRow
      ? resolvedImplicitParameters
      : resolvedImplicitParameters.map((param, index) => {
          const paramExpr = usingParamExprs[index];
          if (paramExpr && exprIsAtom(paramExpr)) {
            const userLabel = paramExpr.token.value;
            if (userLabel !== param.label) {
              return { ...param, label: userLabel };
            }
          }
          return param;
        }),
    // For regular parameters: use expected types but allow anonymous names for non-comptime parameters
    parameters: functionType.parameters.map((expectedParam, index) => {
      if (expectedParam.isCompileTimeOnly) {
        // Comptime parameters must use expected name and type
        return expectedParam;
      } else {
        // Non-comptime parameters can use anonymous function's name with expected type
        const paramExpr = regularParamExprs[index]!;
        return {
          ...expectedParam,
          label: exprIsAtom(paramExpr)
            ? paramExpr.token.value
            : expectedParam.label,
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

  // Create the function value BEFORE evaluating the function body (fixing FIXME)
  const functionValue: FunctionValue = {
    tag: ValueTag.Function,
    type: newFunctionType,
    body: functionBodyExpr,
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

  // Check if the function depends on generic type variables (forall parameters or SomeType in Self/params).
  // If so, we should NOT evaluate the body at definition time because we can't
  // execute code that uses unresolved type variables. The body will be evaluated
  // when the function is specialized with concrete type arguments.
  //
  // Only defer when the lambda explicitly declares forall parameters in its source.
  // When the expected type has forall params but the lambda doesn't declare them
  // (e.g., a concrete throw handler for Exception module), evaluate the body now —
  // the forall type polymorphism is handled by void* erasure at runtime.
  const shouldDeferBodyEvaluation =
    forallParamExprs.length > 0 ||
    functionType.parameters.some((param) => typeContainsSomeType(param.type)) ||
    (functionType.SelfTraitType &&
      functionType.SelfType &&
      typeContainsSomeType(functionType.SelfType));

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
      expr: functionBodyExpr,
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

  // For functions with using(IO) implicit parameters or io.async closures,
  // run await analysis on the body to detect io.await calls and mark as async.
  // This enables the codegen to generate the function as a state machine.
  if (
    evaluatedBody.$ &&
    (functionType.implicitParameters.some((p) =>
      isSourceNamespaceType(p.type)
    ) ||
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

  // For closures with SomeType return type (from forall parameters, e.g., T : Type),
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
  // it sets resolvedConcreteType on the SomeType (enabling forall inference in helper.ts).
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
      });
    }

    // IMPORTANT: When wrapperType is a forall SomeType (e.g., F from `forall(F:Type)`)
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
