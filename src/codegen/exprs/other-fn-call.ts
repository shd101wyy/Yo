import { getVariablesFromEnv } from "../../env";
import { isIoAsyncCall } from "../../evaluator/async/await-analysis";
import {
  extractFnTraitFromType,
  typeImplementsFn,
  typeImplementsFuture,
} from "../../evaluator/trait-checking";
import {
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import type { FunctionValue } from "../../function-value";
import type {
  ArrayType,
  FunctionType,
  SomeType,
} from "../../types/definitions";
import {
  isArrayType,
  isDynType,
  isEnumType,
  isFunctionType,
  isPtrType,
  isSliceType,
  isSomeType,
  isStructType,
  isTupleType,
  isUnionType,
  isUnitType,
} from "../../types/guards";
import { typeContainsRcType } from "../../types/utils";
import {
  isFunctionValue,
  isModuleValue,
  isNumberValue,
  isTypeValue,
  isUnknownValue,
} from "../../value";
import { BuiltinYoInlineFunctions } from "../constants";
import {
  generateEffectCallSite,
  generateMultiEffectCallSite,
  handlerBodyContainsExplicitReturn,
  type EffectCallSiteHandler,
  type EffectStateMachineInfo,
} from "../effects/effect-state-machine";
import type { FunctionGenerationContext } from "../functions/context";
import {
  getEvidenceParameters,
  type EvidenceParameter,
} from "../functions/declarations";
import {
  canOptimizeAsNullablePointer,
  canOptimizeAsSimpleEnum,
  getDeferredDupTargetAtomName,
  getEnumVariantCName,
  getTypeString,
  getVariableNameForCodegen,
  getVariableTypeString,
  isFunctionValueWithOnlyBuiltinYoInlineFunctionCall,
  sanitizeForCIdentifier,
  type CodeGenContext,
} from "../utils";
import { emitAsyncFutureEscape } from "./async-completion";
import { checkVariableIsClosureCaptured } from "./closures";
import { generateComptimeValue } from "./comptime-value";
import {
  generateDeferredDropExpressions,
  generateDeferredDupExpressions,
  generateDropCodeForValue,
} from "./drop-dup";
import { generateExpr } from "./expr";
import { generateYoInlineFunctionCall } from "./inline-fns";
import {
  generateThreadSpawnCall,
  generateWorkerSpawnCall,
} from "./parallelism";

/**
 * In async state machine context, stores a local temp variable to its
 * corresponding sm->var_xxx field. This ensures deferred drops in the final
 * state can access a valid value instead of the zero-initialized struct field.
 */
function storeTempVarToStateMachineIfNeeded(
  tempVar: string,
  indent: string,
  context: CodeGenContext
): void {
  const functionContext = context as FunctionGenerationContext;
  if (
    !(
      functionContext.inAsyncStateMachine ||
      functionContext.inEffectStateMachine
    ) ||
    !functionContext.stateMachineVariables
  ) {
    return;
  }

  let capturedVar = functionContext.stateMachineVariables.get(tempVar);
  if (!capturedVar) {
    for (const [, cv] of functionContext.stateMachineVariables) {
      if (cv.name === tempVar) {
        capturedVar = cv;
        break;
      }
    }
  }
  if (capturedVar && capturedVar.kind !== "outer") {
    // Skip Future-typed temps — their lifecycle is managed by the await logic
    // (await_future_X fields), and the deferred drops already have NULL checks.
    // Storing them here would cause double-free.
    if (capturedVar.type && typeImplementsFuture(capturedVar.type)) {
      return;
    }
    const smFieldName = `var_${capturedVar.id}`;
    const sanitizedTempVar = sanitizeForCIdentifier(tempVar);
    context.emitter.emitLine(
      `${indent}sm->${smFieldName} = ${sanitizedTempVar};`
    );
  }
}

/**
 * Other function call
 */
export function generateOtherFunctionCall(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string | undefined {
  // If the expression has a compile-time value (not UnknownValue), generate it directly.
  // This handles CTFE functions, compile-time evaluated calls like `assert(true)`, etc.
  if (expr.$?.value !== undefined && !isUnknownValue(expr.$.value)) {
    // Handle deferred drop expressions if they exist
    if (expr.$?.deferredDropExpressions) {
      generateDeferredDropExpressions(expr, indent, context);
    }
    // For unit type, no code needed
    if (isUnitType(expr.$.type)) {
      return "";
    }
    // For non-unit types, generate the compile-time value
    return generateComptimeValue(expr.$.value, context, expr);
  }

  const functionType = expr.func.$?.type;
  const functionValue = expr.func.$?.value;

  if (isFunctionType(functionType)) {
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;

    if (runtimeArgExprs) {
      // Check if this is a method call on a dyn object
      let isDynMethodCall = false;
      if (
        exprIsFunctionCall(expr.func) &&
        exprIsFunctionCallOf(expr.func, ".", 2)
      ) {
        const objectExpr = expr.func.args[0];
        const objectType = objectExpr?.$?.type;
        if (objectType && isDynType(objectType)) {
          isDynMethodCall = true;
        }
      }

      // Generate arg list with special handling for dyn method calls
      const args = runtimeArgExprs.map((arg, index) => {
        // First, check if this argument needs a temporary variable
        if (arg.$?.variableName && arg.$?.type) {
          const functionContext = context as FunctionGenerationContext;

          // Check if this variable is captured by a closure
          const isClosureCapturedVariable =
            functionContext.currentClosureCaptures &&
            functionContext.currentClosureCaptures.includes(
              arg.$.variableName
            ) &&
            exprIsAtom(arg) &&
            arg.$.env &&
            functionContext.currentClosureCaptureFrameLevel !== undefined &&
            checkVariableIsClosureCaptured(
              arg.token.value,
              arg.$.env,
              functionContext.currentClosureCaptureFrameLevel
            );

          // Generate the argument expression and declare it as a temp variable
          const argCode = generateExpr(arg, indent, context);

          // Check if this is a compile-time-only constant (e.g., AF_INET :: i32(2)).
          // In that case, generateExpr already inlined the value (e.g., "2"),
          // so we must NOT create a temp variable with the original name because
          // it could conflict with C preprocessor macros (e.g., AF_INET from <sys/socket.h>).
          let isComptimeOnlyArg = false;
          if (exprIsAtom(arg) && arg.$.env && arg.$.variableName) {
            const variables = getVariablesFromEnv(
              arg.$.env,
              arg.$.variableName
            );
            if (
              variables.length > 0 &&
              variables[variables.length - 1]!.isCompileTimeOnly
            ) {
              isComptimeOnlyArg = true;
            }
          }

          // Check if this variable is captured by a state machine
          const isStateMachineCapturedVariable =
            (functionContext.inAsyncStateMachine ||
              functionContext.inEffectStateMachine) &&
            argCode.startsWith("sm->");

          // Track whether we emitted a temp variable declaration
          let emittedTempVarDeclaration = false;

          if (
            argCode &&
            argCode !== arg.$.variableName &&
            !isClosureCapturedVariable &&
            !isStateMachineCapturedVariable &&
            !isComptimeOnlyArg
          ) {
            // Only emit declaration if:
            // 1. The expression doesn't already handle it
            // 2. It's not a closure-captured variable (those are accessed inline from closure_context->data)
            // 3. It's not a state machine variable (those are accessed via sm->var_xxx)
            // 4. It's not a redundant self-assignment (e.g., int32_t errno_ = errno_)
            const sanitizedVarName = getVariableNameForCodegen(
              arg.$.variableName,
              arg.$.env
            );
            if (argCode !== sanitizedVarName) {
              // Use convertedRuntimeType if available (e.g., comptime_string -> str)
              const effectiveType = arg.$.convertedRuntimeType || arg.$.type;
              const varTypeAndName = getVariableTypeString(
                effectiveType,
                arg.$.variableName,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${argCode};`
              );
              emittedTempVarDeclaration = true;
              storeTempVarToStateMachineIfNeeded(
                arg.$.variableName,
                indent,
                context
              );
            }
          }

          // Handle deferred dup expressions for function arguments
          // After generating the argument temp variable, check if we need to dup it
          // Start with argCode (which may be aliased) instead of arg.$.variableName
          let finalArgVarName = emittedTempVarDeclaration
            ? arg.$.variableName
            : argCode;
          if (
            arg.$?.deferredDupExpressions &&
            arg.$.deferredDupExpressions.length > 0
          ) {
            // Only treat deferred dup as a replacement for the argument value
            // when it actually targets this argument. For example, closure
            // construction may carry deferred dups for captured variables; those
            // must be applied during capture initialization, not substituted as
            // the call argument.
            const argTargets = new Set<string>();
            if (arg.$?.variableName) {
              argTargets.add(
                getVariableNameForCodegen(arg.$.variableName, arg.$.env)
              );
            }
            if (argCode) {
              argTargets.add(argCode);
            }
            if (exprIsAtom(arg)) {
              argTargets.add(
                getVariableNameForCodegen(arg.token.value, arg.$.env)
              );
            }

            const matchingDupExpr = arg.$.deferredDupExpressions.find((e) => {
              const target = getDeferredDupTargetAtomName(e);
              if (!target) return false;
              return argTargets.has(
                getVariableNameForCodegen(target, e.$?.env)
              );
            });

            if (matchingDupExpr) {
              generateDeferredDupExpressions(arg, indent, functionContext);
              if (
                exprIsFunctionCall(matchingDupExpr) &&
                matchingDupExpr.$?.variableName
              ) {
                finalArgVarName = getVariableNameForCodegen(
                  matchingDupExpr.$.variableName,
                  matchingDupExpr.$.env
                );
              }
            }
          }

          // For dyn method calls, transform the first argument (self) from dyn object to data pointer
          // EXCEPT for dyn object's own methods (which are in the dyn type's .trait)
          if (isDynMethodCall && index === 0) {
            // Check if this method exists in the dyn type's own trait
            if (
              exprIsFunctionCall(expr.func) &&
              exprIsFunctionCallOf(expr.func, ".", 2)
            ) {
              const objectExpr = expr.func.args[0];
              const dynType = objectExpr?.$?.type;
              const methodExpr = expr.func.args[1];

              if (exprIsAtom(methodExpr) && isDynType(dynType)) {
                const methodName = methodExpr.token.value;
                // Check if this method exists in the dyn type's trait
                const dynMethod = dynType.trait.fields.find(
                  (field) => field.label === methodName
                );

                if (dynMethod) {
                  // This is a dyn object's own method, pass the dyn object directly
                  return isStateMachineCapturedVariable
                    ? argCode
                    : sanitizeForCIdentifier(
                        finalArgVarName,
                        arg.$.type.isExtern === "c"
                      );
                }
              }
            }

            // For all other methods (wrapped object methods), pass the wrapped object data
            // Dyn is a value type, but callers may pass a borrow (pointer) depending on the method signature.
            const argType = arg.$?.type;
            if (argType && isPtrType(argType)) {
              return isStateMachineCapturedVariable
                ? `${argCode}->data`
                : `${sanitizeForCIdentifier(finalArgVarName, arg.$.type.isExtern === "c")}->data`;
            }
            return isStateMachineCapturedVariable
              ? `(${argCode}).data`
              : `(${sanitizeForCIdentifier(finalArgVarName, arg.$.type.isExtern === "c")}).data`;
          } else {
            // If this is a closure-captured variable, use the generated code (inline access)
            // If this is a state machine variable, use the generated code (sm->var_xxx access)
            // If this is a compile-time-only constant, use the generated code (inlined literal)
            // Otherwise use the sanitized variable name (potentially duped)
            return isClosureCapturedVariable ||
              isStateMachineCapturedVariable ||
              isComptimeOnlyArg
              ? argCode
              : sanitizeForCIdentifier(
                  finalArgVarName,
                  arg.$.type.isExtern === "c"
                );
          }
        } else {
          // For dyn method calls, transform the first argument (self) from dyn object to data pointer
          // EXCEPT for dyn object's own methods (which are in the dyn type's .trait)
          if (isDynMethodCall && index === 0) {
            const dynObjectCode = generateExpr(arg, indent, context);

            // Check if this method exists in the dyn type's own trait
            if (
              exprIsFunctionCall(expr.func) &&
              exprIsFunctionCallOf(expr.func, ".", 2)
            ) {
              const objectExpr = expr.func.args[0];
              const dynType = objectExpr?.$?.type;
              const methodExpr = expr.func.args[1];

              if (exprIsAtom(methodExpr) && isDynType(dynType)) {
                const methodName = methodExpr.token.value;
                // Check if this method exists in the dyn type's trait
                const dynMethod = dynType.trait.fields.find(
                  (field) => field.label === methodName
                );

                if (dynMethod) {
                  // This is a dyn object's own method, pass the dyn object directly
                  return dynObjectCode;
                }
              }
            }

            // For all other methods (wrapped object methods), pass the wrapped object data
            const argType = arg.$?.type;
            if (argType && isPtrType(argType)) {
              return `(${dynObjectCode})->data`;
            }
            return `(${dynObjectCode}).data`;
          } else {
            return generateExpr(arg, indent, context);
          }
        }
      });
      const argsList = args.join(", ");

      // Check if this is an extern "yo" function - handle these first before regular function values
      if (functionType.isExtern === "yo" && functionType.externName) {
        const externFuncName = functionType.externName;

        if (BuiltinYoInlineFunctions.includes(externFuncName)) {
          return generateYoInlineFunctionCall(
            externFuncName,
            args,
            expr,
            context,
            indent
          );
        } else if (externFuncName === "__yo_thread_spawn") {
          // Special handling for __yo_thread_spawn(cb : Impl(Fn() -> unit, Send))
          // We need to:
          // 1. Find the closure function from implClosureCallMap
          // 2. Heap-allocate the closure data (since thread needs it after function returns)
          // 3. Call __yo_thread_spawn(closure_fn, heap_closure_data)
          return generateThreadSpawnCall(expr, indent, context);
        } else if (externFuncName === "__yo_worker_spawn") {
          // Special handling for __yo_worker_spawn(cb : Impl(Fn() -> unit, Send))
          // Similar to __yo_thread_spawn but spawns on the worker pool
          return generateWorkerSpawnCall(expr, indent, context);
        } else if (isUnitType(functionType.return.type)) {
          // If the function returns unit, just call it without assignment
          context.emitter.emitLine(`${indent}${externFuncName}(${argsList});`);

          // Handle deferred drop expressions if they exist
          if (expr.$?.deferredDropExpressions) {
            generateDeferredDropExpressions(expr, indent, context);
          }

          return ""; // No return value
        } else {
          return `${externFuncName}(${argsList})`;
        }
      }

      if (isFunctionValue(functionValue)) {
        // Check if it's function vaue whose body only contains Yo operator
        const operatorFunctionName =
          isFunctionValueWithOnlyBuiltinYoInlineFunctionCall(functionValue);
        if (operatorFunctionName) {
          return generateYoInlineFunctionCall(
            operatorFunctionName,
            args,
            expr,
            context,
            indent
          );
        }

        // Get new function type, which might be specialized.
        const functionValueType =
          functionValue.specializedType ?? functionValue.type;

        // Evidence passing: if we're inside a function with evidence params and
        // this call is to a module effect member, call through the evidence fn ptr
        // instead of inlining the handler body.
        const functionContext = context as FunctionGenerationContext;
        if (
          functionContext.currentEvidenceParams &&
          functionValue.isModuleEffectMember
        ) {
          // Find the matching evidence parameter for this function value by
          // navigating each evidence param's module field path in the given
          // binding environment and comparing funcIds.
          let matchedEp: EvidenceParameter | undefined;
          const callEnv = expr.func.$?.env ?? expr.$?.env;
          if (callEnv) {
            for (const ep of functionContext.currentEvidenceParams.values()) {
              const givenVars = getVariablesFromEnv(callEnv, ep.implicitLabel);
              const givenVar = givenVars[givenVars.length - 1];
              const moduleVal = givenVar?.value?.[0];
              if (moduleVal && isModuleValue(moduleVal)) {
                // Navigate fieldPath through potentially nested modules
                let currentModule = moduleVal;
                let navigated = true;
                for (let i = 0; i < ep.fieldPath.length - 1; i++) {
                  const pathSegment = ep.fieldPath[i]!;
                  const idx = currentModule.type.fields.findIndex(
                    (f) => f.label === pathSegment
                  );
                  if (
                    idx >= 0 &&
                    currentModule.fields[idx] &&
                    isModuleValue(currentModule.fields[idx])
                  ) {
                    currentModule = currentModule.fields[
                      idx
                    ] as import("../../value").ModuleValue;
                  } else {
                    navigated = false;
                    break;
                  }
                }
                if (navigated) {
                  const lastLabel = ep.fieldPath[ep.fieldPath.length - 1]!;
                  const fieldIdx = currentModule.type.fields.findIndex(
                    (f) => f.label === lastLabel
                  );
                  if (fieldIdx >= 0) {
                    const fieldVal = currentModule.fields[fieldIdx];
                    if (
                      fieldVal &&
                      isFunctionValue(fieldVal) &&
                      fieldVal.funcId === functionValue.funcId
                    ) {
                      matchedEp = ep;
                      break;
                    }
                  }
                }
              }
            }
          }
          const funcCode =
            matchedEp?.cParamName ?? generateExpr(expr.func, indent, context);
          return generateEvidenceFnPtrCall(
            funcCode,
            functionValueType,
            args,
            runtimeArgExprs,
            expr,
            indent,
            functionContext
          );
        }

        // Direct ctl function call (handler invoked in same scope as given binding).
        // In this case the function value itself IS the handler. There is no intermediate
        // function with `using(raise)`, so no state machine was generated. Instead we
        // inline the handler body directly at the call site.
        // NOTE: This check must be BEFORE the cFuncName check because ctl handler functions
        // may not be collected as standalone functions (they're inlined at call sites).
        if (functionValue.isControlFunction && functionValue.body) {
          return generateDirectCtlCall(
            functionValue,
            functionValueType,
            args,
            indent,
            context as FunctionGenerationContext
          );
        }

        // Normal function call
        const cFuncName = context.functions[functionValue.funcId]?.cName;

        if (cFuncName) {
          // Check if this is an effectful function call (has effect state machine)
          const funcEntry = context.functions[functionValue.funcId];
          const effectSmInfo = funcEntry?.effectStateMachineInfo as
            | EffectStateMachineInfo
            | undefined;

          if (effectSmInfo) {
            // Effectful function call — generate call-site dispatch with handler inlining
            const effectAnalysis = functionValue.body?.$?.effectAnalysis;

            // Check for multi-effect (multiple effect handler infos)
            if (
              effectAnalysis?.effectHandlerInfos &&
              effectAnalysis.effectHandlerInfos.length > 1
            ) {
              const handlers: EffectCallSiteHandler[] = [];
              for (
                let eIdx = 0;
                eIdx < effectAnalysis.effectHandlerInfos.length;
                eIdx++
              ) {
                const hi = effectAnalysis.effectHandlerInfos[eIdx]!;
                const hv = hi.handlerValue as FunctionValue | undefined;
                if (hv && isFunctionValue(hv)) {
                  const hType = hv.specializedType ?? hv.type;
                  const hBody = hv.body;
                  const hHasResume = hBody
                    ? !hv.isControlFunction ||
                      handlerBodyContainsExplicitReturn(hBody)
                    : false;
                  handlers.push({
                    handlerBody: hBody!,
                    handlerType: hType,
                    hasResume: hHasResume,
                    effectIndex: eIdx,
                  });
                }
              }
              if (handlers.length > 0) {
                const tempVar = expr.$?.variableName;
                return generateMultiEffectCallSite(
                  effectSmInfo,
                  args,
                  functionValueType,
                  handlers,
                  tempVar,
                  indent,
                  context as FunctionGenerationContext
                );
              }
            }

            // Single-effect: use original single-handler call site
            const handlerValue = effectAnalysis?.handlerValue as
              | FunctionValue
              | undefined;

            if (handlerValue && isFunctionValue(handlerValue)) {
              const handlerType =
                handlerValue.specializedType ?? handlerValue.type;
              const handlerBody = handlerValue.body;
              const handlerHasResume = handlerBody
                ? !handlerValue.isControlFunction ||
                  handlerBodyContainsExplicitReturn(handlerBody)
                : false;

              const tempVar = expr.$?.variableName;
              const callerReturnType = expr.$?.type;

              return generateEffectCallSite(
                effectSmInfo,
                args,
                functionValueType,
                handlerBody!,
                handlerType,
                handlerHasResume,
                callerReturnType,
                tempVar,
                indent,
                context as FunctionGenerationContext
              );
            }
          }

          // Evidence passing call site: callee has module-type implicit params
          // that compile to extra C function pointer parameters.
          // Use functionValue.type (not specializedType) because implicit
          // parameters are stripped during specialization.
          const calleeEvidenceParams = getEvidenceParameters(
            functionValue.type
          );
          if (calleeEvidenceParams.length > 0) {
            const evidenceArgNames = resolveEvidenceArgsForCallSite(
              calleeEvidenceParams,
              functionValue,
              expr,
              context as FunctionGenerationContext
            );
            if (evidenceArgNames.length > 0) {
              const fullArgs = argsList
                ? `${argsList}, ${evidenceArgNames.join(", ")}`
                : evidenceArgNames.join(", ");
              return generateEvidenceCallSite(
                cFuncName,
                fullArgs,
                functionValueType,
                expr,
                runtimeArgExprs,
                indent,
                context as FunctionGenerationContext
              );
            }
          }

          // Generate function call
          if (isUnitType(functionValueType.return.type)) {
            // If the function returns unit, just call it without assignment
            context.emitter.emitLine(`${indent}${cFuncName}(${argsList});`);

            // Handle deferred drop expressions if they exist
            if (expr.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(expr, indent, context);
            }

            return ""; // No return value
          } else {
            // If it returns a value, assign to a temp variable
            const tempVar = expr.$?.variableName;
            if (tempVar) {
              // For Impl(Future(...)), use the actual function return type to get the correct state machine type
              const returnType =
                functionValue.specializedType?.return.type ??
                functionValueType.return.type;
              const exprType = expr.$?.type;

              // Check if both types implement Future
              const exprIsFuture = exprType && typeImplementsFuture(exprType);
              const returnIsFuture =
                returnType && typeImplementsFuture(returnType);

              let cTypeString: string;
              if (exprIsFuture && returnIsFuture) {
                // For Future types, we need to get the correct state machine struct name
                // The function's body should have an async block with the correct struct name
                // The body might be wrapped in a begin() block, so we need to unwrap it
                let funcBody = functionValue.body;

                // If body is begin(async(...)), unwrap to get the async block
                if (funcBody && exprIsFunctionCallOf(funcBody, "begin")) {
                  const beginArgs = (funcBody as FnCallExpr).args;
                  if (beginArgs.length > 0) {
                    const lastArg = beginArgs[beginArgs.length - 1]!;
                    if (isIoAsyncCall(lastArg)) {
                      funcBody = lastArg;
                    }
                  }
                }

                if (
                  funcBody &&
                  isIoAsyncCall(funcBody) &&
                  funcBody.$?.asyncStateMachineStructName
                ) {
                  // Use the async block's registered struct name directly
                  const asyncStructName =
                    funcBody.$.asyncStateMachineStructName;
                  cTypeString = `${asyncStructName}*`;

                  // Store the mapping for variable binding later
                  if (!context.tempVarAsyncStructNames) {
                    context.tempVarAsyncStructNames = new Map();
                  }
                  context.tempVarAsyncStructNames.set(tempVar, asyncStructName);
                } else {
                  // Fallback: function delegates to another Future-returning function
                  // (e.g., File.open calls File.open_with). Use exprType if it has
                  // resolvedConcreteType, otherwise fall back to returnType.
                  if (
                    exprType &&
                    isSomeType(exprType) &&
                    exprType.resolvedConcreteType
                  ) {
                    cTypeString = getTypeString(exprType, context);
                  } else {
                    cTypeString = getTypeString(returnType, context);
                  }
                }
              } else {
                // cTypeString = getTypeString(exprType ?? returnType, context);
                // Use returnType (from function signature) instead of exprType (from expression metadata)
                // because exprType might have unresolved type parameters from nested generic calls
                cTypeString = getTypeString(returnType ?? exprType, context);
              }

              context.emitter.emitLine(
                `${indent}${cTypeString} ${tempVar} = ${cFuncName}(${argsList});`
              );
              storeTempVarToStateMachineIfNeeded(tempVar, indent, context);

              // Handle deferred drop expressions if they exist
              if (expr.$?.deferredDropExpressions) {
                generateDeferredDropExpressions(expr, indent, context);
              }

              return tempVar; // Return the temp variable name
            } else {
              // Error: regular function call returns non-unit type but no temp variable assigned
              return `// Error: Regular function call returns ${getTypeString(functionValue.specializedType?.return.type ?? functionValueType.return.type, context)} but no temp variable assigned`;
            }
          }
        }
      } else {
        const externFunction = context.externFunctions[functionType.id];
        if (externFunction) {
          // Generate regular extern function call
          const cFuncName = externFunction.cName;

          // Handle deferred drop expressions if they exist
          if (expr.$?.deferredDropExpressions) {
            generateDeferredDropExpressions(expr, indent, context);
          }

          return `${cFuncName}(${argsList})`;
        } else {
          // Function parameter call (e.g., callback(x))
          // When calling through a void* (e.g., a captured function-typed variable),
          // we need to cast it to the proper function pointer type.
          const funcCode = generateExpr(expr.func, indent, context);
          // Use the call expression's resolved type when available (handles forall monomorphization)
          const resolvedReturnType = expr.$?.type ?? functionType.return.type;
          const returnTypeStr = getTypeString(resolvedReturnType, context);
          const paramTypeStrs = functionType.parameters
            .filter((p) => !p.isCompileTimeOnly)
            .map((p) => getTypeString(p.type, context));
          const fnPtrCast = `((${returnTypeStr} (*)(${paramTypeStrs.join(", ")}))${funcCode})`;

          // Detect module effect member calls in async SM context
          // (e.g., sm->__capture.throw(arg) — handler may escape)
          const functionContext = context as FunctionGenerationContext;
          const isModuleEffectCapture =
            funcCode.includes("__capture.") &&
            !!functionContext.inAsyncStateMachine;

          if (isModuleEffectCapture) {
            context.emitter.emitLine(`${indent}__yo_effect_escaped = 0;`);
          }

          if (isUnitType(functionType.return.type)) {
            // If the function returns unit, just call it without assignment
            context.emitter.emitLine(`${indent}${fnPtrCast}(${argsList});`);

            // Handle deferred drop expressions if they exist
            if (expr.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(expr, indent, context);
            }

            if (isModuleEffectCapture) {
              context.emitter.emitLine(`${indent}if (__yo_effect_escaped) {`);
              // Drop RC-typed arguments that won't be dropped by the escaped handler
              if (runtimeArgExprs) {
                for (const arg of runtimeArgExprs) {
                  if (
                    arg.$?.variableName &&
                    arg.$?.type &&
                    typeContainsRcType(arg.$.type)
                  ) {
                    const argVarName = sanitizeForCIdentifier(
                      arg.$.variableName
                    );
                    const dropCode = generateDropCodeForValue(
                      argVarName,
                      arg.$.type,
                      context
                    );
                    if (dropCode) {
                      context.emitter.emitLine(`${indent}  ${dropCode};`);
                    }
                  }
                }
              }
              emitAsyncFutureEscape({
                emitter: context.emitter,
                indent: indent + "  ",
                resultCode: undefined,
                debugLabel: undefined,
              });
              context.emitter.emitLine(`${indent}}`);
            }

            return ""; // No return value
          } else {
            // If it returns a value, assign to a temp variable or return directly
            const tempVar = expr.$?.variableName;
            if (tempVar) {
              // For Impl(Future(...)), use the actual function return type to get the correct state machine type
              const returnType = functionType.return.type;
              const exprType = expr.$?.type;
              const typeToUse =
                exprType &&
                returnType &&
                typeImplementsFuture(exprType) &&
                typeImplementsFuture(returnType)
                  ? returnType // Use function's return type for correct state machine
                  : (exprType ?? returnType); // Otherwise use expr type or fallback to return type

              context.emitter.emitLine(
                `${indent}${getTypeString(typeToUse, context)} ${tempVar} = ${fnPtrCast}(${argsList});`
              );
              storeTempVarToStateMachineIfNeeded(tempVar, indent, context);

              // Handle deferred drop expressions if they exist
              if (expr.$?.deferredDropExpressions) {
                generateDeferredDropExpressions(expr, indent, context);
              }

              if (isModuleEffectCapture) {
                context.emitter.emitLine(`${indent}if (__yo_effect_escaped) {`);
                // Drop RC-typed arguments that won't be dropped by the escaped handler
                if (runtimeArgExprs) {
                  for (const arg of runtimeArgExprs) {
                    if (
                      arg.$?.variableName &&
                      arg.$?.type &&
                      typeContainsRcType(arg.$.type)
                    ) {
                      const argVarName = sanitizeForCIdentifier(
                        arg.$.variableName
                      );
                      const dropCode = generateDropCodeForValue(
                        argVarName,
                        arg.$.type,
                        context
                      );
                      if (dropCode) {
                        context.emitter.emitLine(`${indent}  ${dropCode};`);
                      }
                    }
                  }
                }
                emitAsyncFutureEscape({
                  emitter: context.emitter,
                  indent: indent + "  ",
                  resultCode: undefined,
                  debugLabel: undefined,
                });
                context.emitter.emitLine(`${indent}}`);
              }

              return tempVar; // Return the temp variable name
            } else {
              // Error: function parameter call returns non-unit type but no temp variable assigned
              return `// Error: Function parameter call returns ${getTypeString(functionType.return.type, context)} but no temp variable assigned`;
            }
          }
        }
      }
    }
  } else if (functionType && typeImplementsFn(functionType)) {
    const closureValueType = functionType;
    const fnModule = extractFnTraitFromType(closureValueType)!;
    // Check if this is a Dyn closure (uses vtable) or Impl closure (static dispatch)
    const isDynClosure = isDynType(closureValueType);
    {
      const callSig = fnModule.isFn.callType;
      // Handle closure calls with dynamic dispatch through vtable
      const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;

      if (runtimeArgExprs) {
        // First, handle arguments that need temporary variables
        const functionContext = context as FunctionGenerationContext;
        for (const arg of runtimeArgExprs) {
          if (arg.$?.variableName && arg.$?.type) {
            // Check if this variable is captured by a closure
            const isClosureCapturedVariable =
              functionContext.currentClosureCaptures &&
              functionContext.currentClosureCaptures.includes(
                arg.$.variableName
              ) &&
              exprIsAtom(arg) &&
              arg.$.env &&
              functionContext.currentClosureCaptureFrameLevel !== undefined &&
              checkVariableIsClosureCaptured(
                arg.token.value,
                arg.$.env,
                functionContext.currentClosureCaptureFrameLevel
              );

            // Generate the argument expression and declare it as a temp variable
            const argCode = generateExpr(arg, indent, context);

            // Check if this is a compile-time-only constant - skip temp variable creation
            let isComptimeOnlyArg = false;
            if (exprIsAtom(arg) && arg.$.env && arg.$.variableName) {
              const variables = getVariablesFromEnv(
                arg.$.env,
                arg.$.variableName
              );
              if (
                variables.length > 0 &&
                variables[variables.length - 1]!.isCompileTimeOnly
              ) {
                isComptimeOnlyArg = true;
              }
            }

            // Check if this variable is captured by a state machine
            const isStateMachineCapturedVariable =
              (functionContext.inAsyncStateMachine ||
                functionContext.inEffectStateMachine) &&
              argCode.startsWith("sm->");

            if (
              argCode &&
              argCode !== arg.$.variableName &&
              !isClosureCapturedVariable &&
              !isStateMachineCapturedVariable &&
              !isComptimeOnlyArg
            ) {
              // Only emit declaration if:
              // 1. The expression doesn't already handle it
              // 2. It's not a closure-captured variable (those are accessed inline from closure_context->data)
              // 3. It's not a state machine variable (those are accessed via sm->var_xxx)
              // Use convertedRuntimeType if available (e.g., comptime_string -> str)
              const effectiveType = arg.$.convertedRuntimeType || arg.$.type;
              const varTypeAndName = getVariableTypeString(
                effectiveType,
                arg.$.variableName,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${argCode};`
              );
              storeTempVarToStateMachineIfNeeded(
                arg.$.variableName,
                indent,
                context
              );
            }
          }
        }

        // Generate closure value and function arguments
        const closureCode = generateExpr(expr.func, indent, context);
        const args = runtimeArgExprs.map((arg) => {
          if (arg.$?.variableName && arg.$?.type) {
            // Check if this is a closure-captured variable - if so, use the full access expression
            const isClosureCapturedVariable =
              functionContext.currentClosureCaptures &&
              functionContext.currentClosureCaptures.includes(
                arg.$.variableName
              ) &&
              exprIsAtom(arg) &&
              arg.$.env &&
              functionContext.currentClosureCaptureFrameLevel !== undefined &&
              checkVariableIsClosureCaptured(
                arg.token.value,
                arg.$.env,
                functionContext.currentClosureCaptureFrameLevel
              );

            if (isClosureCapturedVariable) {
              // Return the inline access expression
              return generateExpr(arg, indent, context);
            } else {
              // The pre-processing loop above already called generateExpr to emit
              // temp variable declarations. Use the variable name directly to avoid
              // re-generating the same code.
              const argVarName = getVariableNameForCodegen(
                arg.$.variableName,
                arg.$.env
              );
              const isStateMachineCapturedVariable =
                (functionContext.inAsyncStateMachine ||
                  functionContext.inEffectStateMachine) &&
                argVarName.startsWith("sm->");

              // Handle deferred dup expressions for closure call arguments
              let finalArgVarName = argVarName;
              if (
                arg.$?.deferredDupExpressions &&
                arg.$.deferredDupExpressions.length > 0
              ) {
                generateDeferredDupExpressions(arg, indent, functionContext);
                // Use the dup result variable instead of the original
                const dupExpr = arg.$.deferredDupExpressions[0]!;
                if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                  finalArgVarName = getVariableNameForCodegen(
                    dupExpr.$.variableName,
                    dupExpr.$.env
                  );
                }
              }

              return isStateMachineCapturedVariable
                ? argVarName
                : finalArgVarName;
            }
          } else {
            return generateExpr(arg, indent, context);
          }
        });

        // Dispatch:
        // - Dyn(Fn(...)) uses vtable: closure.vtable->call(closure.data, args...)
        // - Impl(Fn(...)) uses static dispatch: closure_impl(&closure, args...)
        let closureCall: string;
        if (isDynClosure) {
          const allArgs = [`(${closureCode}).data`, ...args];
          closureCall = `(${closureCode}).vtable->call(${allArgs.join(", ")})`;
        } else {
          // For Impl closures, the value is the concrete capture struct.
          // Find the corresponding generated implementation function.
          let concreteTypeId: string | undefined;
          if (isSomeType(closureValueType)) {
            const someType = closureValueType as SomeType;
            if (someType.resolvedConcreteType) {
              concreteTypeId = someType.resolvedConcreteType.id;
            }
          }

          const mapped = concreteTypeId
            ? context.implClosureCallMap.get(concreteTypeId)
            : undefined;

          // Check if the closure body function has an effect state machine
          if (mapped) {
            const closureFuncEntry = Object.values(
              functionContext.functions
            ).find((f) => f.cName === mapped.functionCName);
            const effectSmInfo = closureFuncEntry?.effectStateMachineInfo as
              | EffectStateMachineInfo
              | undefined;
            if (effectSmInfo && closureFuncEntry) {
              // Find the handler value from the given binding in the enclosing scope.
              // The effect analysis knows the ctl parameter name (e.g., "log").
              const analysis = effectSmInfo.analysis;
              const effectParamName = analysis.effectParameterName;
              const callEnv = expr.func.$?.env ?? expr.$?.env;
              if (effectParamName && callEnv) {
                const givenVars = getVariablesFromEnv(callEnv, effectParamName);
                const givenVar = givenVars[givenVars.length - 1];
                const handlerVal = givenVar?.value?.[0];
                if (handlerVal && isFunctionValue(handlerVal)) {
                  const handlerType =
                    (handlerVal as FunctionValue).specializedType ??
                    (handlerVal as FunctionValue).type;
                  const handlerHasResume = (handlerVal as FunctionValue).body
                    ? !(handlerVal as FunctionValue).isControlFunction ||
                      handlerBodyContainsExplicitReturn(
                        (handlerVal as FunctionValue).body!
                      )
                    : false;
                  const tempVar = expr.$?.variableName;
                  const closureContextCode = `&(${closureCode})`;
                  const result = generateEffectCallSite(
                    effectSmInfo,
                    args,
                    effectSmInfo.functionType,
                    (handlerVal as FunctionValue).body!,
                    handlerType,
                    handlerHasResume,
                    functionContext.currentFunctionType?.return.type,
                    tempVar,
                    indent,
                    functionContext,
                    closureContextCode
                  );
                  if (expr.$?.deferredDropExpressions) {
                    generateDeferredDropExpressions(
                      expr,
                      indent,
                      functionContext
                    );
                  }
                  return result;
                }
              }
            }
          }

          if (!mapped) {
            // Fallback to old representation if mapping is missing.
            const allArgs = [`(${closureCode}).data`, ...args];
            closureCall = `(${closureCode}).call(${allArgs.join(", ")})`;
          } else {
            const allArgs = [`&(${closureCode})`, ...args];
            closureCall = `${mapped.functionCName}(${allArgs.join(", ")})`;
          }
        }

        // Get return type from the closure's function signature
        const returnType = callSig.return.type;

        if (isUnitType(returnType)) {
          // If the closure returns unit, just call it without assignment
          context.emitter.emitLine(`${indent}${closureCall};`);

          // Handle deferred drop expressions if they exist
          if (expr.$?.deferredDropExpressions) {
            generateDeferredDropExpressions(expr, indent, context);
          }

          return ""; // No return value
        } else {
          // If it returns a value, assign to a temp variable or return directly
          const tempVar = expr.$?.variableName;
          if (tempVar) {
            context.emitter.emitLine(
              `${indent}${getTypeString(returnType, context)} ${tempVar} = ${closureCall};`
            );
            storeTempVarToStateMachineIfNeeded(tempVar, indent, context);

            // Handle deferred drop expressions if they exist
            if (expr.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(expr, indent, context);
            }

            return tempVar; // Return the temp variable name
          } else {
            // Error: closure returns non-unit type but no temp variable assigned
            return `// Error: Closure call returns ${getTypeString(returnType, context)} but no temp variable assigned`;
          }
        }
      } else {
        // Note: Closure construction is now handled in the isTypeValue(functionValue) branch below
        // by checking for expr.$?.closureFunctionValue
        return `// Error: No runtime args found for closure call`;
      }
    }
  } else if (isTypeValue(functionValue)) {
    // struct
    if (isStructType(functionValue.value)) {
      const structType = functionValue.value;
      const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
      const cName = context.types[structType.id]?.cName;
      const labels = structType.fields.map((field) => field.label);
      const tempVar = expr.$?.variableName;

      if (
        runtimeArgExprs &&
        cName &&
        labels.length === runtimeArgExprs.length
      ) {
        // Handle newtype as zero-cost abstraction
        if (structType.isNewtype && structType.fields.length === 1) {
          // For newtype, just use the underlying value directly (with cast for type safety)
          const argExpr = runtimeArgExprs[0]!;
          const argCode = generateExpr(argExpr, indent, context);

          // Handle deferred dup expressions for newtype constructor arguments
          // This is important because newtype shares the same RC as its inner type,
          // so if the inner value is passed to the newtype, we need to dup it
          // to avoid double-free (both newtype and original will try to drop).
          let finalArgCode = argCode;
          if (
            argExpr.$?.deferredDupExpressions &&
            argExpr.$.deferredDupExpressions.length > 0
          ) {
            const functionContext = context as FunctionGenerationContext;

            // If the arg has a variable name but generateExpr didn't create a declaration,
            // we need to create it now so the dup call can reference it
            if (argExpr.$?.variableName && argExpr.$?.type) {
              const argVarName = getVariableNameForCodegen(
                argExpr.$.variableName,
                argExpr.$.env
              );
              // Only emit the declaration if argCode is different from the variable name
              if (argCode !== argVarName) {
                const argType = argExpr.$.type;
                const argTypeStr = getTypeString(argType, context);
                context.emitter.emitLine(
                  `${indent}${argTypeStr} ${argVarName} = ${argCode};`
                );
              }
            }

            generateDeferredDupExpressions(argExpr, indent, functionContext);
            // Use the dup result variable instead of the original
            const dupExpr = argExpr.$.deferredDupExpressions[0]!;
            if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
              finalArgCode = getVariableNameForCodegen(
                dupExpr.$.variableName,
                dupExpr.$.env
              );
            }
          }

          const newtypeValue = `((${cName})(${finalArgCode}))`;

          // If this newtype has a temporary variable name, declare it
          if (tempVar && expr.$?.type) {
            const varTypeAndName = getVariableTypeString(
              expr.$.type,
              tempVar,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${newtypeValue};`
            );
            storeTempVarToStateMachineIfNeeded(tempVar, indent, context);
            return tempVar;
          } else {
            return newtypeValue;
          }
        }

        if (structType.isReferenceSemantics) {
          // For object, call the constructor function
          const functionContext = context as FunctionGenerationContext;

          const argsList = runtimeArgExprs
            .map((arg) => {
              const argCode = generateExpr(arg, indent, context);

              // Handle deferred dup expressions for constructor arguments
              if (
                arg.$?.deferredDupExpressions &&
                arg.$.deferredDupExpressions.length > 0
              ) {
                // If the arg has a variable name but generateExpr didn't create a declaration,
                // we need to create it now so the dup call can reference it
                if (arg.$?.variableName && arg.$?.type) {
                  const argVarName = getVariableNameForCodegen(
                    arg.$.variableName,
                    arg.$.env
                  );
                  // Only emit the declaration if argCode is different from the variable name
                  // to avoid generating code like: prev_opt = prev_opt;
                  if (argCode !== argVarName) {
                    const argType = arg.$.type;
                    const argTypeStr = getTypeString(argType, context);
                    // Emit the variable declaration and assignment
                    context.emitter.emitLine(
                      `${indent}${argTypeStr} ${argVarName} = ${argCode};`
                    );
                  }
                }

                generateDeferredDupExpressions(arg, indent, functionContext);
                // Use the dup result variable instead of the original
                const dupExpr = arg.$.deferredDupExpressions[0]!;
                if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                  return getVariableNameForCodegen(
                    dupExpr.$.variableName,
                    dupExpr.$.env
                  );
                }
              }

              return argCode;
            })
            .join(", ");

          const constructorName = `__yo_new_${cName}`;
          const structValue = `${constructorName}(${argsList})`;

          // If this struct has a temporary variable name, declare it
          if (tempVar && expr.$?.type) {
            const varTypeAndName = getVariableTypeString(
              expr.$.type,
              tempVar,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${structValue};`
            );
            storeTempVarToStateMachineIfNeeded(tempVar, indent, context);
            return tempVar;
          } else {
            return structValue;
          }
        } else {
          // For regular struct, generate struct initialization as before
          const functionContext = context as FunctionGenerationContext;

          const argsList = runtimeArgExprs
            .map((arg, index) => {
              const argCode = generateExpr(arg, indent, context);
              // For tuples, always use numeric field names _0, _1, _2...
              // For regular structs, use the actual field labels
              const fieldName = isTupleType(structType)
                ? `_${index}`
                : sanitizeForCIdentifier(
                    labels[index]!,
                    structType.isExtern === "c"
                  );

              // Handle deferred dup expressions for struct fields
              let finalArgValue = argCode;
              if (
                arg.$?.deferredDupExpressions &&
                arg.$.deferredDupExpressions.length > 0
              ) {
                // If the arg has a variable name but generateExpr didn't create a declaration,
                // we need to create it now so the dup call can reference it
                if (arg.$?.variableName && arg.$?.type) {
                  const argVarName = getVariableNameForCodegen(
                    arg.$.variableName,
                    arg.$.env
                  );
                  const argType = arg.$.type;
                  const argTypeStr = getTypeString(argType, context);
                  // Only emit the variable declaration if argCode is different from argVarName
                  // to prevent self-assignment like: var = var;
                  if (argCode !== argVarName) {
                    context.emitter.emitLine(
                      `${indent}${argTypeStr} ${argVarName} = ${argCode};`
                    );
                  }
                }

                generateDeferredDupExpressions(arg, indent, functionContext);
                // Use the dup result variable instead of the original
                const dupExpr = arg.$.deferredDupExpressions[0]!;
                if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                  finalArgValue = getVariableNameForCodegen(
                    dupExpr.$.variableName,
                    dupExpr.$.env
                  );
                }
              }

              return `.${fieldName} = ` + finalArgValue;
            })
            .join(", ");
          const structValue = `(${cName}){ ${argsList} }`;

          // If this struct has a temporary variable name, declare it
          if (tempVar && expr.$?.type) {
            const varTypeAndName = getVariableTypeString(
              expr.$.type,
              tempVar,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${structValue};`
            );
            storeTempVarToStateMachineIfNeeded(tempVar, indent, context);
            return tempVar;
          } else {
            return structValue;
          }
        }
      }
    }
    // closure type - closure construction
    // Note: This is now handled at the top of generateFuncCall by checking expr.$.closureFunctionValue
    else if (typeImplementsFn(functionValue.value)) {
      return `// Error: Closure construction should have been handled by closureFunctionValue check at top of generateFuncCall`;
    }
    // union
    // union is supposed to have only one member initialized
    else if (isUnionType(functionValue.value)) {
      const tempVar = expr.$?.variableName;
      const arg = expr.args[0]!;
      if (arg && exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, ":", 2)) {
        const labelExpr = arg.args[0]!;
        const fieldExpr = arg.args[1]!;
        const cName = context.types[functionValue.value.id]?.cName;
        if (cName && exprIsAtom(labelExpr) && fieldExpr) {
          const functionContext = context as FunctionGenerationContext;
          const label = labelExpr.token.value;
          const sanitizedLabel = getVariableNameForCodegen(
            label,
            labelExpr.$?.env
          );
          const fieldCode = generateExpr(fieldExpr, indent, context);

          // Handle deferred dup expressions for union field
          let finalFieldValue = fieldCode;
          if (
            fieldExpr.$?.deferredDupExpressions &&
            fieldExpr.$.deferredDupExpressions.length > 0
          ) {
            generateDeferredDupExpressions(fieldExpr, indent, functionContext);
            // Use the dup result variable instead of the original
            const dupExpr = fieldExpr.$.deferredDupExpressions[0]!;
            if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
              finalFieldValue = getVariableNameForCodegen(
                dupExpr.$.variableName,
                dupExpr.$.env
              );
            }
          }

          const unionValue = `(${cName}){ .${sanitizedLabel} = ${finalFieldValue} }`;

          // If this union has a temporary variable name, declare it
          if (tempVar && expr.$?.type) {
            const varTypeAndName = getVariableTypeString(
              expr.$.type,
              tempVar,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${unionValue};`
            );
            storeTempVarToStateMachineIfNeeded(tempVar, indent, context);
            return tempVar;
          } else {
            return unionValue;
          }
        }
      }
    }
    // enum
    else if (isEnumType(functionValue.value)) {
      const enumType = functionValue.value;
      const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
      const cName = context.types[enumType.id]?.cName;
      const tempVar = expr.$?.variableName;

      if (enumType.selectedVariantName && runtimeArgExprs && cName) {
        // Check if this enum can be optimized as a nullable pointer
        const nullablePointerType = canOptimizeAsNullablePointer(enumType);
        if (nullablePointerType) {
          const variantName = enumType.selectedVariantName;
          const variant = enumType.variants.find((v) => v.name === variantName);

          if (variant) {
            if (!variant.fields || variant.fields.length === 0) {
              // This is the "None" case - return NULL
              const enumValue = "NULL";
              if (tempVar && expr.$?.type) {
                const varTypeAndName = getVariableTypeString(
                  expr.$.type,
                  tempVar,
                  context
                );
                context.emitter.emitLine(
                  `${indent}${varTypeAndName} = ${enumValue};`
                );
                storeTempVarToStateMachineIfNeeded(tempVar, indent, context);
                return tempVar;
              } else {
                return enumValue;
              }
            } else if (variant.fields.length === 1) {
              // This is the "Some" case - return the pointer value directly
              const pointerValue = generateExpr(
                runtimeArgExprs[0]!,
                indent,
                context
              );
              if (tempVar && expr.$?.type) {
                const varTypeAndName = getVariableTypeString(
                  expr.$.type,
                  tempVar,
                  context
                );
                context.emitter.emitLine(
                  `${indent}${varTypeAndName} = ${pointerValue};`
                );
                storeTempVarToStateMachineIfNeeded(tempVar, indent, context);
                return tempVar;
              } else {
                return pointerValue;
              }
            }
          }
        }

        // Check if this enum can be optimized as a simple C enum
        const simpleEnumOptimizable = canOptimizeAsSimpleEnum(enumType);
        if (simpleEnumOptimizable) {
          const variantName = enumType.selectedVariantName;
          // For simple enums, just return the enum constant
          const enumValue = getEnumVariantCName(enumType, variantName, context);
          if (tempVar && expr.$?.type) {
            const varTypeAndName = getVariableTypeString(
              expr.$.type,
              tempVar,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${enumValue};`
            );
            storeTempVarToStateMachineIfNeeded(tempVar, indent, context);
            return tempVar;
          } else {
            return enumValue;
          }
        }

        // Generate enum initialization (fallback for non-optimized enums)
        const variantName = enumType.selectedVariantName;
        const variant = enumType.variants.find((v) => v.name === variantName);
        if (variant) {
          // Filter out unit type arguments - they don't need to be stored
          const nonUnitElements =
            variant.fields?.filter((field) => !isUnitType(field.type)) || [];

          const functionContext = context as FunctionGenerationContext;

          const argsList = runtimeArgExprs
            .map((arg, index) => {
              if (variant.fields) {
                const field = variant.fields[index];
                if (field && !isUnitType(field.type)) {
                  const argCode = generateExpr(arg, indent, context);
                  const sanitizedLabel = getVariableNameForCodegen(
                    field.label,
                    arg.$?.env
                  );

                  // Declare temp variable for enum field arguments when needed
                  let finalArgValue = argCode;
                  if (arg.$?.variableName && arg.$?.type) {
                    const isClosureCapturedVariable =
                      functionContext.currentClosureCaptures &&
                      functionContext.currentClosureCaptures.includes(
                        arg.$.variableName
                      ) &&
                      exprIsAtom(arg) &&
                      arg.$.env &&
                      functionContext.currentClosureCaptureFrameLevel !==
                        undefined &&
                      checkVariableIsClosureCaptured(
                        arg.token.value,
                        arg.$.env,
                        functionContext.currentClosureCaptureFrameLevel
                      );

                    const isStateMachineCapturedVariable =
                      (functionContext.inAsyncStateMachine ||
                        functionContext.inEffectStateMachine) &&
                      argCode.startsWith("sm->");

                    let isComptimeOnlyArg = false;
                    if (exprIsAtom(arg) && arg.$.env && arg.$.variableName) {
                      const variables = getVariablesFromEnv(
                        arg.$.env,
                        arg.$.variableName
                      );
                      if (
                        variables.length > 0 &&
                        variables[variables.length - 1]!.isCompileTimeOnly
                      ) {
                        isComptimeOnlyArg = true;
                      }
                    }

                    let emittedTempVarDeclaration = false;

                    if (
                      argCode &&
                      argCode !== arg.$.variableName &&
                      !isClosureCapturedVariable &&
                      !isStateMachineCapturedVariable &&
                      !isComptimeOnlyArg
                    ) {
                      const sanitizedVarName = getVariableNameForCodegen(
                        arg.$.variableName,
                        arg.$.env
                      );
                      if (argCode !== sanitizedVarName) {
                        const varTypeAndName = getVariableTypeString(
                          arg.$.type,
                          arg.$.variableName,
                          context
                        );
                        context.emitter.emitLine(
                          `${indent}${varTypeAndName} = ${argCode};`
                        );
                        emittedTempVarDeclaration = true;
                        storeTempVarToStateMachineIfNeeded(
                          arg.$.variableName,
                          indent,
                          context
                        );
                      }
                    }

                    if (emittedTempVarDeclaration) {
                      finalArgValue = getVariableNameForCodegen(
                        arg.$.variableName,
                        arg.$.env
                      );
                    }
                  }

                  // Handle deferred dup expressions for enum variant fields
                  if (
                    arg.$?.deferredDupExpressions &&
                    arg.$.deferredDupExpressions.length > 0
                  ) {
                    generateDeferredDupExpressions(
                      arg,
                      indent,
                      functionContext
                    );
                    // Use the dup result variable instead of the original
                    const dupExpr = arg.$.deferredDupExpressions[0]!;
                    if (
                      exprIsFunctionCall(dupExpr) &&
                      dupExpr.$?.variableName
                    ) {
                      finalArgValue = getVariableNameForCodegen(
                        dupExpr.$.variableName,
                        dupExpr.$.env
                      );
                    }
                  }

                  return `.${sanitizedLabel} = ` + finalArgValue;
                }
                return ""; // Skip if no field matches or if it's unit type
              } else {
                return "";
              }
            })
            .filter((s) => s) // Remove empty strings
            .join(", ");

          // If there are no non-unit fields, we only need the tag
          const enumValue =
            nonUnitElements.length > 0
              ? `(${cName}){ .tag = ${getEnumVariantCName(enumType, variantName, context)}, .data = { .${variantName} = { ${argsList} } } }`
              : `(${cName}){ .tag = ${getEnumVariantCName(enumType, variantName, context)} }`;
          if (tempVar && expr.$?.type) {
            const varTypeAndName = getVariableTypeString(
              expr.$.type,
              tempVar,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${enumValue};`
            );
            storeTempVarToStateMachineIfNeeded(tempVar, indent, context);
            return tempVar;
          } else {
            return enumValue;
          }
        }
      }
    }
  } else if (isArrayType(functionType)) {
    const firstArg = expr.args[0];

    // Check if this is a slicing operation: arr(start:end) or arr(:)
    if (
      firstArg &&
      exprIsFunctionCall(firstArg) &&
      exprIsFunctionCallOf(firstArg, ":")
    ) {
      // arr(start:end) -> create slice value
      const arrayCode = generateExpr(expr.func!, indent, context);
      const startCode = generateExpr(firstArg.args[0]!, indent, context);
      const endCode = generateExpr(firstArg.args[1]!, indent, context);

      const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString((functionType as ArrayType).childType, context))}`;
      // Register the slice type
      if (!context.sliceStructTypes.has(sliceTypeName)) {
        context.sliceStructTypes.set(sliceTypeName, {
          childType: getTypeString(
            (functionType as ArrayType).childType,
            context
          ),
        });
      }
      return `(${sliceTypeName}){ .data = &${arrayCode}.data[${startCode}], .length = (${endCode}) - (${startCode}) }`;
    } else if (
      firstArg &&
      exprIsAtom(firstArg) &&
      firstArg.token.value === ":"
    ) {
      // arr(:) -> create slice value for whole array
      const arrayCode = generateExpr(expr.func!, indent, context);
      const arrayType = functionType as ArrayType;
      const childType = arrayType.childType;

      const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(childType, context))}`;
      // Register the slice type
      if (!context.sliceStructTypes.has(sliceTypeName)) {
        context.sliceStructTypes.set(sliceTypeName, {
          childType: getTypeString(childType, context),
        });
      }

      if (isNumberValue(arrayType.length)) {
        return `(${sliceTypeName}){ .data = &${arrayCode}.data[0], .length = ${arrayType.length.value} }`;
      } else {
        return `/* Error: Cannot slice array with non-compile-time length */`;
      }
    }

    // Array access by index: arr[index] or arr(index)
    const arrayCode = generateExpr(expr.func!, indent, context);
    const indexCode = generateExpr(firstArg!, indent, context);
    // Generate array access with struct wrapper
    return `${arrayCode}.data[${indexCode}]`; // Access the element at the index
  } else if (isSliceType(functionType)) {
    const firstArg = expr.args[0];

    // Check if this is a sub-slicing operation: slice(start:end) or slice(:)
    if (
      firstArg &&
      exprIsFunctionCall(firstArg) &&
      exprIsFunctionCallOf(firstArg, ":")
    ) {
      // slice(start:end) -> create sub-slice
      const sliceCode = generateExpr(expr.func!, indent, context);
      const startCode = generateExpr(firstArg.args[0]!, indent, context);
      const endCode = generateExpr(firstArg.args[1]!, indent, context);

      const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(functionType.childType, context))}`;
      // Register the slice type
      if (!context.sliceStructTypes.has(sliceTypeName)) {
        context.sliceStructTypes.set(sliceTypeName, {
          childType: getTypeString(functionType.childType, context),
        });
      }
      return `(${sliceTypeName}){ .data = &${sliceCode}.data[${startCode}], .length = (${endCode}) - (${startCode}) }`;
    } else if (
      firstArg &&
      exprIsAtom(firstArg) &&
      firstArg.token.value === ":"
    ) {
      // slice(:) -> create slice copy of whole slice
      const sliceCode = generateExpr(expr.func!, indent, context);

      const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(functionType.childType, context))}`;
      // Register the slice type
      if (!context.sliceStructTypes.has(sliceTypeName)) {
        context.sliceStructTypes.set(sliceTypeName, {
          childType: getTypeString(functionType.childType, context),
        });
      }
      return `(${sliceTypeName}){ .data = ${sliceCode}.data, .length = ${sliceCode}.length }`;
    }

    // Slice access by index: slice.data[index]
    const sliceCode = generateExpr(expr.func!, indent, context);
    const indexCode = generateExpr(firstArg!, indent, context);
    return `${sliceCode}.data[${indexCode}]`; // Access the element at the index in the slice
  } else if (
    functionType &&
    isPtrType(functionType) &&
    isSliceType(functionType.childType)
  ) {
    // This case should no longer exist since slices are no longer behind pointers
    // But keep it for backward compatibility during migration
    const sliceCode = generateExpr(expr.func!, indent, context);
    const indexCode = generateExpr(expr.args[0]!, indent, context);
    return `${sliceCode}.data[${indexCode}]`; // Access the element at the index in the slice
  }
}
/**
 * Generate an inline invocation of a ctl function when it is called directly
 * in the same scope that provides the `given` handler (i.e. there is no
 * intermediate function with `using(ctl)` that would create a state machine).
 *
 * The ctl function IS the handler. We bind call arguments to handler parameters
 * as local C variables and generate the body inline. `escape(val)` inside the
 * body becomes `return val;` which exits the enclosing C function (the handler
 * scope). `return(val)` inside the body treats `val` as the result of the call.
 */
let directCtlCallSiteCounter = 0;

function generateDirectCtlCall(
  functionValue: FunctionValue,
  functionType: FunctionType,
  argCodes: string[],
  indent: string,
  context: FunctionGenerationContext
): string {
  const emitter = context.emitter;
  const callSiteId = directCtlCallSiteCounter++;

  const runtimeParams = functionType.parameters.filter(
    (p) => !p.isCompileTimeOnly
  );

  const handlerHasResume = functionValue.body
    ? !functionValue.isControlFunction ||
      handlerBodyContainsExplicitReturn(functionValue.body!)
    : false;

  // For the resume case, declare the result variable BEFORE the inner block so that
  // it stays in scope after the block closes and can be used as the call expression.
  const resultType = handlerHasResume ? functionValue.body!.$?.type : undefined;
  const isUnitReturn = !resultType || isUnitType(resultType);
  const tmpResultVar = `__ctl_direct_result_${callSiteId}`;
  if (handlerHasResume && !isUnitReturn) {
    const resultTypeCName = getTypeString(resultType!, context);
    emitter.emitLine(`${indent}${resultTypeCName} ${tmpResultVar};`);
  }

  const innerIndent = `${indent}  `;
  emitter.emitLine(`${indent}{`);

  const paramDropCodes: string[] = [];
  for (let i = 0; i < runtimeParams.length && i < argCodes.length; i++) {
    const param = runtimeParams[i]!;
    const paramTypeCName = getTypeString(param.type, context);
    const paramCName = sanitizeForCIdentifier(param.label);
    emitter.emitLine(
      `${innerIndent}${paramTypeCName} ${paramCName} = ${argCodes[i]};`
    );
    if (typeContainsRcType(param.type)) {
      const dropCode = generateDropCodeForValue(
        paramCName,
        param.type,
        context
      );
      if (dropCode) {
        paramDropCodes.push(dropCode);
      }
    }
  }

  if (handlerHasResume) {
    // Resume case: intercept `return(value)` to assign into tmpResultVar.
    // The params are aliases of the caller's args (borrowed, not moved) because
    // execution continues past the call site. The CALLER is responsible for
    // dropping the args at end of its own scope — don't drop them here.
    //
    // Also create an exit label so nested escape handlers can `goto` here
    // instead of using `return` (which would exit the C function entirely).
    const exitLabel = `__ctl_direct_exit_${callSiteId}`;

    const prevContinuationVars = context.continuationVariables;
    const continuationVars = new Map(prevContinuationVars);
    continuationVars.set("resume", {
      directReturnVar: isUnitReturn ? "" : tmpResultVar,
      directExitLabel: exitLabel,
      isUnitReturn,
    });
    context.continuationVariables = continuationVars;

    // Save and clear pendingDeferredDrops so that `return()` inside the handler
    // body only sees drops from the handler's own scopes, not from the caller's
    // outer scope. The caller's drops should persist after the call site.
    const savedPendingDrops = context.pendingDeferredDrops;
    context.pendingDeferredDrops = undefined;

    const bodyCode = generateExpr(functionValue.body!, innerIndent, context);
    if (bodyCode) {
      emitter.emitLine(`${innerIndent}${bodyCode};`);
    }
    // No paramDropCodes here: params are borrowed from the outer scope.

    context.pendingDeferredDrops = savedPendingDrops;
    context.continuationVariables = prevContinuationVars;
    emitter.emitLine(`${indent}}`);
    // Emit the exit label after the block for nested abort goto targets
    emitter.emitLine(`${indent}${exitLabel}:;`);
    return isUnitReturn ? "" : tmpResultVar;
  } else {
    // Escape case: `escape(value)` in the body generates `return value;` in C,
    // exiting the enclosing C function. Use effectHandlerParamDrops so that
    // param cleanup runs before the escape return.
    const prevHandlerDrops = context.effectHandlerParamDrops;
    context.effectHandlerParamDrops = paramDropCodes;

    // Track RC-type arg C names as consumed — handler param drops already free
    // these pointers (params are aliases of argCodes, no dup). Pending deferred
    // drops must skip them to avoid double-free.
    const prevConsumedArgs = context.effectSmConsumedArgCNames;
    const consumedArgs = new Set<string>();
    for (let i = 0; i < runtimeParams.length && i < argCodes.length; i++) {
      const param = runtimeParams[i]!;
      if (typeContainsRcType(param.type)) {
        consumedArgs.add(argCodes[i]!);
      }
    }
    if (consumedArgs.size > 0) {
      context.effectSmConsumedArgCNames = consumedArgs;
    }

    const bodyCode = generateExpr(functionValue.body!, innerIndent, context);
    if (bodyCode) {
      emitter.emitLine(`${innerIndent}${bodyCode};`);
    }
    context.effectSmConsumedArgCNames = prevConsumedArgs;
    context.effectHandlerParamDrops = prevHandlerDrops;
  }

  emitter.emitLine(`${indent}}`);
  return "";
}

/**
 * Generate a call through an evidence fn ptr parameter.
 * Used inside functions with evidence passing when calling module effect members.
 *
 * Generates:
 *   result = evidence_fn_ptr(args);
 *   if (__yo_effect_escaped) { return dummy; }
 */
function generateEvidenceFnPtrCall(
  funcCode: string,
  functionType: FunctionType,
  args: string[],
  runtimeArgExprs: import("../../expr").Expr[] | undefined,
  expr: FnCallExpr,
  indent: string,
  context: FunctionGenerationContext
): string {
  const argsList = args.join(", ");
  const returnType = functionType.return.type;
  const emitter = context.emitter;

  if (isUnitType(returnType)) {
    emitter.emitLine(`${indent}${funcCode}(${argsList});`);

    // Handle deferred drop expressions
    if (expr.$?.deferredDropExpressions) {
      generateDeferredDropExpressions(expr, indent, context);
    }

    // Check escape flag — propagate early return if handler escaped
    emitter.emitLine(`${indent}if (__yo_effect_escaped) {`);
    // Drop RC-typed arguments that won't be dropped by the escaped handler
    if (runtimeArgExprs) {
      for (const arg of runtimeArgExprs) {
        if (
          arg.$?.variableName &&
          arg.$?.type &&
          typeContainsRcType(arg.$.type)
        ) {
          const argVarName = sanitizeForCIdentifier(arg.$.variableName);
          const dropCode = generateDropCodeForValue(
            argVarName,
            arg.$.type,
            context
          );
          if (dropCode) {
            emitter.emitLine(`${indent}  ${dropCode};`);
          }
        }
      }
    }
    emitter.emitLine(`${indent}  return;`);
    emitter.emitLine(`${indent}}`);
    return "";
  } else {
    const tempVar = expr.$?.variableName;
    if (tempVar) {
      const cTypeString = getTypeString(returnType, context);
      emitter.emitLine(
        `${indent}${cTypeString} ${tempVar} = ${funcCode}(${argsList});`
      );

      // Handle deferred drop expressions
      if (expr.$?.deferredDropExpressions) {
        generateDeferredDropExpressions(expr, indent, context);
      }

      // Check escape flag — propagate early return if handler escaped
      emitter.emitLine(`${indent}if (__yo_effect_escaped) {`);
      // Drop RC-typed arguments
      if (runtimeArgExprs) {
        for (const arg of runtimeArgExprs) {
          if (
            arg.$?.variableName &&
            arg.$?.type &&
            typeContainsRcType(arg.$.type)
          ) {
            const argVarName = sanitizeForCIdentifier(arg.$.variableName);
            const dropCode = generateDropCodeForValue(
              argVarName,
              arg.$.type,
              context
            );
            if (dropCode) {
              emitter.emitLine(`${indent}  ${dropCode};`);
            }
          }
        }
      }
      // Return type for escape propagation must match the CALLER's return type, not the callee's
      const callerReturnType = context.currentFunctionType?.return.type;
      if (callerReturnType && !isUnitType(callerReturnType)) {
        const callerCType = getTypeString(callerReturnType, context);
        emitter.emitLine(`${indent}  return (${callerCType}){0};`);
      } else {
        emitter.emitLine(`${indent}  return;`);
      }
      emitter.emitLine(`${indent}}`);
      return tempVar;
    } else {
      return `${funcCode}(${argsList})`;
    }
  }
}

/**
 * Resolve evidence fn ptr arguments for a call site, using the callee's
 * evidence parameters (from its function type). This works for both
 * escape and resume handlers.
 *
 * Resolution order for each evidence param:
 * 1. Transitive: if caller has matching evidence params, forward them
 * 2. From effectAnalysis: look up handler function values (escape or resume)
 * 3. From given binding: look up the module value in the call environment
 */
function resolveEvidenceArgsForCallSite(
  calleeEvidenceParams: EvidenceParameter[],
  functionValue: FunctionValue,
  expr: FnCallExpr,
  context: FunctionGenerationContext
): string[] {
  const result: string[] = [];
  const effectAnalysis = functionValue.body?.$?.effectAnalysis;

  for (const ep of calleeEvidenceParams) {
    const key = `${ep.implicitLabel}.${ep.fieldLabel}`;
    let resolved = false;

    // 1. Transitive: forward from caller's own evidence params
    if (context.currentEvidenceParams) {
      const callerEp = context.currentEvidenceParams.get(key);
      if (callerEp) {
        result.push(callerEp.cParamName);
        resolved = true;
      }
    }

    if (resolved) continue;

    // 2. From effectAnalysis handler values
    if (effectAnalysis) {
      // Check effectHandlerInfos first (multi-effect or single with handler infos)
      if (effectAnalysis.effectHandlerInfos) {
        for (const hi of effectAnalysis.effectHandlerInfos) {
          const handlerValue = hi.handlerValue as FunctionValue | undefined;
          if (handlerValue && isFunctionValue(handlerValue)) {
            const cName = context.functions[handlerValue.funcId]?.cName;
            if (cName) {
              result.push(cName);
              resolved = true;
              break;
            }
          }
        }
      }

      // Fall back to single handler value
      if (!resolved && effectAnalysis.handlerValue) {
        const handlerValue = effectAnalysis.handlerValue as
          | FunctionValue
          | undefined;
        if (handlerValue && isFunctionValue(handlerValue)) {
          const cName = context.functions[handlerValue.funcId]?.cName;
          if (cName) {
            result.push(cName);
            resolved = true;
          }
        }
      }
    }

    // 3. From given binding in the call environment
    if (!resolved) {
      const callEnv = expr.func.$?.env ?? expr.$?.env;
      if (callEnv) {
        const givenVars = getVariablesFromEnv(callEnv, ep.implicitLabel);
        const givenVar = givenVars[givenVars.length - 1];
        const moduleVal = givenVar?.value?.[0];
        if (moduleVal && isModuleValue(moduleVal)) {
          // Navigate the field path through potentially nested modules
          let currentModule = moduleVal;
          let navigated = true;
          for (let i = 0; i < ep.fieldPath.length - 1; i++) {
            const pathSegment = ep.fieldPath[i]!;
            const idx = currentModule.type.fields.findIndex(
              (f) => f.label === pathSegment
            );
            if (
              idx >= 0 &&
              currentModule.fields[idx] &&
              isModuleValue(currentModule.fields[idx])
            ) {
              currentModule = currentModule.fields[
                idx
              ] as import("../../value").ModuleValue;
            } else {
              navigated = false;
              break;
            }
          }
          if (navigated) {
            const lastLabel = ep.fieldPath[ep.fieldPath.length - 1]!;
            const fieldIndex = currentModule.type.fields.findIndex(
              (f) => f.label === lastLabel
            );
            if (fieldIndex >= 0) {
              const fieldValue = currentModule.fields[fieldIndex];
              if (fieldValue && isFunctionValue(fieldValue)) {
                const cName = context.functions[fieldValue.funcId]?.cName;
                if (cName) {
                  result.push(cName);
                  resolved = true;
                }
              }
            }
          }
        }
      }
    }

    if (!resolved) {
      break;
    }
  }

  return result;
}

/**
 * Generate an evidence passing call site.
 * Emits: __yo_effect_escaped = 0; result = callee(args, evidence...); if (__yo_effect_escaped) { return; }
 */
function generateEvidenceCallSite(
  cFuncName: string,
  fullArgsList: string,
  functionType: FunctionType,
  expr: FnCallExpr,
  runtimeArgExprs: import("../../expr").Expr[] | undefined,
  indent: string,
  context: FunctionGenerationContext
): string {
  const emitter = context.emitter;
  const returnType = functionType.return.type;

  emitter.emitLine(`${indent}__yo_effect_escaped = 0;`);

  if (isUnitType(returnType)) {
    emitter.emitLine(`${indent}${cFuncName}(${fullArgsList});`);

    if (expr.$?.deferredDropExpressions) {
      generateDeferredDropExpressions(expr, indent, context);
    }

    emitter.emitLine(`${indent}if (__yo_effect_escaped) {`);
    // Drop RC-typed arguments
    if (runtimeArgExprs) {
      for (const arg of runtimeArgExprs) {
        if (
          arg.$?.variableName &&
          arg.$?.type &&
          typeContainsRcType(arg.$.type)
        ) {
          const argVarName = sanitizeForCIdentifier(arg.$.variableName);
          const dropCode = generateDropCodeForValue(
            argVarName,
            arg.$.type,
            context
          );
          if (dropCode) {
            emitter.emitLine(`${indent}  ${dropCode};`);
          }
        }
      }
    }
    emitter.emitLine(`${indent}  return;`);
    emitter.emitLine(`${indent}}`);
    return "";
  } else {
    const tempVar = expr.$?.variableName;
    if (tempVar) {
      const cTypeString = getTypeString(returnType, context);
      emitter.emitLine(
        `${indent}${cTypeString} ${tempVar} = ${cFuncName}(${fullArgsList});`
      );
      storeTempVarToStateMachineIfNeeded(tempVar, indent, context);

      if (expr.$?.deferredDropExpressions) {
        generateDeferredDropExpressions(expr, indent, context);
      }

      emitter.emitLine(`${indent}if (__yo_effect_escaped) {`);
      // Drop RC-typed arguments
      if (runtimeArgExprs) {
        for (const arg of runtimeArgExprs) {
          if (
            arg.$?.variableName &&
            arg.$?.type &&
            typeContainsRcType(arg.$.type)
          ) {
            const argVarName = sanitizeForCIdentifier(arg.$.variableName);
            const dropCode = generateDropCodeForValue(
              argVarName,
              arg.$.type,
              context
            );
            if (dropCode) {
              emitter.emitLine(`${indent}  ${dropCode};`);
            }
          }
        }
      }
      // Return type for escape propagation must match the CALLER's return type, not the callee's
      const callerReturnType = context.currentFunctionType?.return.type;
      if (callerReturnType && !isUnitType(callerReturnType)) {
        const callerCType = getTypeString(callerReturnType, context);
        emitter.emitLine(`${indent}  return (${callerCType}){0};`);
      } else {
        emitter.emitLine(`${indent}  return;`);
      }
      emitter.emitLine(`${indent}}`);
      return tempVar;
    } else {
      return `${cFuncName}(${fullArgsList})`;
    }
  }
}
