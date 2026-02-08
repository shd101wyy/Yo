import {
  extractFnTraitFromType,
  typeImplementsFn,
  typeImplementsFuture,
} from "../../evaluator/trait-checking";
import {
  BuiltinFunctions,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import type { ArrayType, SomeType } from "../../types/definitions";
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
import {
  isFunctionValue,
  isNumberValue,
  isTypeValue,
  isUnknownValue,
} from "../../value";
import { BuiltinYoInlineFunctions } from "../constants";
import type { FunctionGenerationContext } from "../functions/context";
import {
  canOptimizeAsNullablePointer,
  canOptimizeAsSimpleEnum,
  type CodeGenContext,
  getDeferredDupTargetAtomName,
  getEnumVariantCName,
  getTypeString,
  getVariableNameForCodegen,
  getVariableTypeString,
  isFunctionValueWithOnlyBuiltinYoInlineFunctionCall,
  sanitizeForCIdentifier,
} from "../utils";
import { checkVariableIsClosureCaptured } from "./closures";
import { generateComptimeValue } from "./comptime-value";
import {
  generateDeferredDropExpressions,
  generateDeferredDupExpressions,
} from "./drop-dup";
import { generateExpr } from "./expr";
import { generateYoInlineFunctionCall } from "./inline-fns";
import {
  generateThreadSpawnCall,
  generateWorkerSpawnCall,
} from "./parallelism";

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

          // Check if this variable is captured by a state machine
          const isStateMachineCapturedVariable =
            functionContext.inStateMachine && argCode.startsWith("sm->");

          // Track whether we emitted a temp variable declaration
          let emittedTempVarDeclaration = false;

          if (
            argCode &&
            argCode !== arg.$.variableName &&
            !isClosureCapturedVariable &&
            !isStateMachineCapturedVariable
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
                  return sanitizeForCIdentifier(
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
              return `${sanitizeForCIdentifier(finalArgVarName, arg.$.type.isExtern === "c")}->data`;
            }
            return `(${sanitizeForCIdentifier(finalArgVarName, arg.$.type.isExtern === "c")}).data`;
          } else {
            // If this is a closure-captured variable, use the generated code (inline access)
            // If this is a state machine variable, use the generated code (sm->var_xxx access)
            // Otherwise use the sanitized variable name (potentially duped)
            return isClosureCapturedVariable || isStateMachineCapturedVariable
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

        // Normal function call
        const cFuncName = context.functions[functionValue.funcId]?.cName;

        if (cFuncName) {
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
                    if (exprIsFunctionCallOf(lastArg, BuiltinFunctions.async)) {
                      funcBody = lastArg;
                    }
                  }
                }

                if (
                  funcBody &&
                  exprIsFunctionCallOf(funcBody, BuiltinFunctions.async) &&
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
                  // Fallback to getTypeString on return type
                  cTypeString = getTypeString(returnType, context);
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
          const funcCode = generateExpr(expr.func, indent, context);
          if (isUnitType(functionType.return.type)) {
            // If the function returns unit, just call it without assignment
            context.emitter.emitLine(`${indent}${funcCode}(${argsList});`);

            // Handle deferred drop expressions if they exist
            if (expr.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(expr, indent, context);
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
                `${indent}${getTypeString(typeToUse, context)} ${tempVar} = ${funcCode}(${argsList});`
              );

              // Handle deferred drop expressions if they exist
              if (expr.$?.deferredDropExpressions) {
                generateDeferredDropExpressions(expr, indent, context);
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

            // Check if this variable is captured by a state machine
            const isStateMachineCapturedVariable =
              functionContext.inStateMachine && argCode.startsWith("sm->");

            if (
              argCode &&
              argCode !== arg.$.variableName &&
              !isClosureCapturedVariable &&
              !isStateMachineCapturedVariable
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
              // Check if this is a state machine variable
              const argCode = generateExpr(arg, indent, context);
              const isStateMachineCapturedVariable =
                functionContext.inStateMachine && argCode.startsWith("sm->");

              // Handle deferred dup expressions for closure call arguments
              let finalArgVarName = arg.$.variableName;
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

              return isStateMachineCapturedVariable ? argCode : finalArgVarName;
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
                      functionContext.inStateMachine &&
                      argCode.startsWith("sm->");

                    let emittedTempVarDeclaration = false;

                    if (
                      argCode &&
                      argCode !== arg.$.variableName &&
                      !isClosureCapturedVariable &&
                      !isStateMachineCapturedVariable
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
