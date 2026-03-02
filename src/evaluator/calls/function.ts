import {
  cloneEnvForCTFECheck,
  type Environment,
  getReceiverMethodsByNameFromEnv,
  getTypeTraitMethodsByNameFromEnv,
  getVariablesFromEnv,
  popEnvFrame,
  updateExistingVariable,
} from "../../env";
import { formatErrorMessage, formatErrorMessages, YoError } from "../../error";
import {
  type AtomExpr,
  attachTempVariableToExpr,
  cloneExpr,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import type { FunctionValue } from "../../function-value";
import { stringIsOperator, TokenType } from "../../token";
import type { TypeValue } from "../../type-value";
import { areTypesCompatible } from "../../types/compatibility";
import { createExprType } from "../../types/creators";
import type { FunctionType, SomeType, Type } from "../../types/definitions";
import {
  isArrayType,
  isComptimeFloatType,
  isComptimeIntType,
  isComptimeListType,
  isComptimeStringType,
  isDynType,
  isEnumType,
  isFunctionType,
  isIsoType,
  isModuleType,
  isObjectType,
  isPtrType,
  isSliceType,
  isSomeType,
  isStructType,
  isTraitType,
  isTypeHierarchyType,
  isUnionType,
} from "../../types/guards";
import { typeOfType } from "../../types/hierarchy";
import { typeToString } from "../../types/utils";
import { randomId } from "../../utils";
import {
  areValuesEqual,
  createEnumValue,
  createStructValue,
  createTypeValue,
  createUnknownValue,
  isArrayValue,
  isExprValue,
  isFunctionValue,
  isSliceValue,
  isTupleValue,
  isTypeValue,
  type Value,
  valueToString,
} from "../../value";

import {
  type EvaluatorContext,
  type FunctionCallResult,
  type FunctionToCall,
  getArrayCallResult,
  getModuleTypeCallResult,
  getTraitTypeCallResult,
  getTypeCallResult,
} from "../context";
import { evaluateExpression } from "../exprs/expr";
import { extractFnTraitFromType } from "../trait-checking";
import { evaluateFunctionReturnTypeAgain } from "../types/function";
import { evaluateAnonymousStructValue } from "../values/anonymous-struct";
import { tryToCallArrayWithArguments } from "./array";
import { tryToImplementArrayByArrayType } from "./array-type";
import { tryToImplementClosureByFnModuleType } from "./closure-type";
import { tryToImplementComptimeListByComptimeListType } from "./comptime-list-type";
import { tryToImplementFunctionByFunctionType } from "./function-type";
import { extractFunctionValue, tryToCallFunctionWithArguments } from "./helper";
import { evaluateIsoValueCall } from "./iso";
import { tryToImplementModuleWithArgumentsByModuleType } from "./module-type";
import {
  isConvertibleNumericType,
  tryToConvertToNumericType,
} from "./numeric-type";
import { tryToConvertToPointerType } from "./pointer-type";
import { tryToImplementTraitWithArgumentsByTraitType } from "./trait-type";
import { tryToCallTypeWithArguments } from "./type";

/**
 * Resolves a SomeType that was created as a placeholder for a recursive type.
 * When recur is called during compile-time evaluation and hits the temp cache,
 * a SomeType with recursiveTypeRef is returned. This function looks up the
 * actual resolved type from the function's cache.
 *
 * Resolution strategy (in order of preference):
 * 1. Look up the exact matching cache entry with resolved type
 * 2. Use context.SelfType if available (when inside struct/object definition)
 * 3. Use ANY resolved cache entry from the same function (same structure)
 */
function resolveRecursiveTypeRef(
  someType: SomeType,
  callerEnv: Environment,
  context?: EvaluatorContext
): Type | undefined {
  if (!someType.recursiveTypeRef) {
    return undefined;
  }

  const { functionValue, argValues } = someType.recursiveTypeRef;

  // Strategy 1: Look for the exact matching cache entry with resolved type
  const exactCache = functionValue.calledComptimeFunctionCaches.find(
    (cache) => {
      return (
        cache.argValues.length === argValues.length &&
        cache.argValues.every((argValue, index) => {
          const givenArgValue = argValues[index];

          if (isTypeValue(argValue) && isTypeValue(givenArgValue)) {
            return areTypesCompatible(
              { type: argValue.value, env: cache.env },
              { type: givenArgValue.value, env: callerEnv },
              true // requireExactMatch
            );
          }

          return areValuesEqual(
            { value: argValue, env: cache.env },
            { value: givenArgValue, env: callerEnv }
          );
        })
      );
    }
  );

  if (exactCache && isTypeValue(exactCache.value)) {
    // Check if it's not still a placeholder
    if (
      !(
        isSomeType(exactCache.value.value) &&
        exactCache.value.value.recursiveTypeRef
      )
    ) {
      return exactCache.value.value;
    }
  }

  // Strategy 2: Use context.SelfType if available
  if (context?.SelfType && isObjectType(context.SelfType)) {
    return context.SelfType;
  }
  if (context?.SelfType && isStructType(context.SelfType)) {
    return context.SelfType;
  }

  // Strategy 3: Look for ANY resolved cache entry from the same function
  // All instantiations of the same type-generating function produce the same structure
  const anyResolvedCache = functionValue.calledComptimeFunctionCaches.find(
    (cache) => {
      if (!isTypeValue(cache.value)) return false;
      // Skip if still a placeholder
      if (isSomeType(cache.value.value) && cache.value.value.recursiveTypeRef) {
        return false;
      }
      // Found a resolved type
      return true;
    }
  );

  if (anyResolvedCache && isTypeValue(anyResolvedCache.value)) {
    return anyResolvedCache.value.value;
  }

  return undefined;
}

export function evaluateFunctionCall({
  expr,
  env,
  context,
  givenFunc,
  forMacroExpansion,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
  givenFunc?: { type: Type; value: TypeValue | FunctionValue | undefined };
  forMacroExpansion?: boolean;
}): Expr {
  let func = expr.func;
  let args = expr.args;

  // For module method call
  let methodExpr: Expr | undefined = undefined;

  let functions: {
    type: Type;
    value?: Value;
    error?: Error | YoError;
    needsPointerConversion?: boolean;
    args?: Expr[]; // Store potentially modified args for this specific function
  }[] = [];
  if (givenFunc) {
    functions = [givenFunc];
  } else {
    if (exprIsFunctionCall(func)) {
      const functionToCall = evaluateExpression({
        expr: func,
        env,
        context: {
          ...context,
        },
      });
      func = functionToCall;

      // Check if . property access for module method call
      if (!functionToCall.$?.type) {
        if (
          exprIsFunctionCall(functionToCall) &&
          exprIsFunctionCallOf(functionToCall, ".", 2)
        ) {
          const receiverArg = functionToCall.args[0]!;
          methodExpr = functionToCall.args[1]!;

          // The receiverArg should already be evaluated in the previous step
          // so it should have a type
          const receiverType = receiverArg.$?.type;
          if (!receiverType) {
            throw formatErrorMessage({
              token: receiverArg.token,
              errorMessage: `Expected to be evaluated.`,
            });
          }

          // Check if the receiver is a TypeValue (e.g., EvenNumber.try_from(...)),
          // which indicates a static method call on a type.
          const receiverValue = receiverArg.$?.value;
          const isStaticMethodCall = isTypeValue(receiverValue);

          // The methodExpr should also be evaluated already
          // so it should have a type
          if (exprIsAtom(methodExpr)) {
            // 1.add(3);
            const methodName = methodExpr.token.value;

            if (isStaticMethodCall) {
              // Static method call (e.g., EvenNumber.try_from(...))
              // Use getTypeTraitMethodsByNameFromEnv to find methods from impl'd traits
              const innerType = receiverValue.value;
              const methods = getTypeTraitMethodsByNameFromEnv({
                env,
                context,
                methodName,
                type: innerType,
              });

              functions = methods.map((method) => {
                // Static methods don't have a receiver argument - just pass the call args
                return {
                  type: method.type,
                  value: method.value,
                  args: args,
                };
              });
            } else {
              // Instance method call (e.g., value.add(...))

              // Get the method with the same name in the interface in the env
              const methods = getReceiverMethodsByNameFromEnv({
                env,
                context,
                methodName,
                receiverType,
                isInfixOperatorCall: false, // isInfixOperatorCall - property access allows auto pointer conversion
              });

              functions = methods.map((method) => {
                // If pointer conversion is needed, wrap the receiver in &()
                let methodArgs: Expr[];
                if (method.needsPointerConversion) {
                  // Create &(receiverArg) expression
                  // Note: The comptime type to runtime type conversion is handled
                  // in evaluateAddressCall (ptr_fns.ts) when &() is evaluated
                  const ampersandExpr: AtomExpr = {
                    tag: ExprTag.Atom,
                    token: receiverArg.token,
                    $: undefined,
                  };
                  ampersandExpr.token = {
                    ...receiverArg.token,
                    value: "&",
                    type: TokenType.Identifier,
                  };

                  const addressOfExpr: FnCallExpr = {
                    tag: ExprTag.FnCall,
                    func: ampersandExpr,
                    args: [receiverArg],
                    token: receiverArg.token,
                    $: undefined,
                  };

                  methodArgs = [addressOfExpr, ...args];
                } else {
                  methodArgs = [receiverArg, ...args];
                }

                return {
                  type: method.type,
                  value: method.value,
                  needsPointerConversion: method.needsPointerConversion,
                  args: methodArgs,
                };
              });
            }
          } else {
            // 1.(Add.add)(3);
            // Try to evaluate the methodExpr
            const nextExpr = evaluateExpression({
              expr: methodExpr,
              env,
              context: {
                ...context,
              },
            });
            if (nextExpr.$?.env) {
              env = nextExpr.$?.env;
            }
            methodExpr = nextExpr;

            const methodType = methodExpr.$?.type;
            const methodValue = methodExpr.$?.value;
            if (!methodType) {
              throw formatErrorMessage({
                token: methodExpr.token,
                errorMessage: `Expected to be a function.`,
              });
            }
            functions = [
              {
                type: methodType,
                value: methodValue,
              },
            ];
            // TODO: Autocase to reference/immutable reference
            args = [receiverArg, ...args];
          }
        } else {
          throw formatErrorMessage({
            token: func.token,
            errorMessage: `Expected type for function call, got ${exprToString(functionToCall)}`,
          });
        }
      } else {
        functions = [
          {
            type: functionToCall.$.type,
            value: functionToCall.$.value,
          },
        ];
      }
    } else {
      const functionName = func.token.value;

      // Check _ function
      if (functionName === "_") {
        const expectedType = context.expectedType;
        if (!expectedType || isSomeType(expectedType.type)) {
          // throw formatErrorMessage(
          //   func.token,
          //   `Failed to infer type for _ function`
          // );

          // Make it as an anonymous struct
          return evaluateAnonymousStructValue({
            expr,
            env,
            context,
          });
        }
        functions = [
          {
            type: typeOfType(expectedType.type),
            value: createTypeValue(expectedType.type),
          },
        ];

        // Add info to the func token
        func.$ = {
          env,
          type: functions[0]!.type,
          value: functions[0]!.value,
          pathCollection: [],
        };
      }
      // Infix operator is taken as an method call
      else if (stringIsOperator(functionName) && expr.isInfix) {
        const firstArg = args[0];
        if (!firstArg) {
          throw formatErrorMessage({
            token: func.token,
            errorMessage: `Expected first argument for operator, got:\n${exprToString(func)}`,
          });
        }
        // Evaluate the first argument to get its type
        // NOTE: We clear expectedType here because the operand type should be
        // determined by the operand itself, not by the return type expected from
        // the outer context (e.g., when `a == b` is used as argument to a function
        // expecting boolean, we shouldn't force the operands to be boolean)
        const evaluatedFirstArg = evaluateExpression({
          expr: firstArg,
          env,
          context: {
            ...context,
            expectedType: undefined,
          },
        });
        const receiverType = evaluatedFirstArg.$?.type;
        if (!receiverType) {
          throw formatErrorMessage({
            token: firstArg.token,
            errorMessage: `Expected to be evaluated.`,
          });
        }
        const methodName = functionName;
        methodExpr = func;
        // Get the method with the same name in the module/type in the env
        const moduleMethods = getReceiverMethodsByNameFromEnv({
          env,
          context,
          methodName,
          receiverType,
          isInfixOperatorCall: true, // isInfixOperatorCall - infix operators don't allow auto pointer conversion
        });
        functions = moduleMethods.map((method) => ({
          type: method.type,
          value: method.value,
          needsPointerConversion: method.needsPointerConversion,
        }));
        // No need to change the args
      }
      // Self function call
      else if (functionName === "Call" && context.SelfType) {
        const value = createTypeValue(context.SelfType);
        functions = [
          {
            type: value.type,
            value: value,
          },
        ];
      }
      // Normal function call
      else {
        const functionToCall = evaluateExpression({
          expr: func,
          env,
          context: {
            ...context,
          },
        });
        func = functionToCall;

        if (!functionToCall.$) {
          throw formatErrorMessage({
            token: func.token,
            errorMessage: `Failed to evaluate the callee:`,
          });
        }

        // Check if func is a module value,
        // If yes, then we extract the Self from it.
        if (isModuleType(functionToCall.$.type)) {
          const moduleType = functionToCall.$.type;
          const selfIndex = moduleType.fields.findIndex(
            (e) => e.label === "Call"
          );
          if (selfIndex < 0) {
            throw formatErrorMessage({
              token: func.token,
              errorMessage: `Calling a module value which does not have "Call" element is not allowed.`,
            });
          }
          const selfType = moduleType.fields[selfIndex]!;
          if (selfType.assignedValue) {
            const selfValue = selfType.assignedValue;
            if (isTupleValue(selfValue)) {
              functions = selfValue.fields.map((element) => {
                return {
                  type: element.type,
                  value: element,
                };
              });
            } else {
              functions = [
                {
                  type: selfValue.type,
                  value: selfValue,
                },
              ];
            }
          } else {
            throw formatErrorMessage({
              token: func.token,
              errorMessage: `Calling a module value whose "Call" element doesn't have assigned value is not allowed.`,
            });
          }
        } else {
          /**
           * functionVariables might be of FunctionType, StructType, UnionType, and EnumVariant
           */
          functions = [
            {
              type: functionToCall.$.type,
              value: functionToCall.$.value,
            },
          ];
        }
      }
    }
  }

  // NOTE: Automatic CTFE candidate addition has been removed.
  // Use `comptime_fn(fn)` to explicitly create compile-time versions of functions.
  // This makes the behavior predictable - functions are called at runtime unless
  // explicitly declared as compile-time via comptime_fn().

  // Optimization: Skip the checking phase when there is exactly one callable
  // function-like candidate (plain function type or Impl/Dyn(Fn(...))).
  //
  // Why this is safe:
  // - There is no overload ambiguity to resolve.
  // - The real execution call still performs full argument/type validation.
  // - We avoid doing a clone-based dry run + real run for the same candidate.
  //
  // Why this is important:
  // - Function call checking currently invokes tryToCallFunctionWithArguments
  //   once in checking mode and again in execution mode.
  // - In call-heavy code (e.g., std collections), this doubles hot-path work.
  const isNonTypeCtfeFunction =
    functions.length === 1 &&
    isFunctionType(functions[0]!.type) &&
    functions[0]!.type.return.isCompileTimeOnly &&
    !functions[0]!.type.return.isUnquote &&
    !isTypeHierarchyType(functions[0]!.type.return.type) &&
    functions[0]!.type.forallParameters.length === 0;

  const hasSingleFunctionLikeCandidate =
    functions.length === 1 &&
    (isFunctionType(functions[0]!.type) ||
      ((isSomeType(functions[0]!.type) || isDynType(functions[0]!.type)) &&
        !!extractFnTraitFromType(functions[0]!.type)));

  const canSkipCheckingPhase = hasSingleFunctionLikeCandidate;

  // Find the functions whose parameters match the arguments
  const functionsToCall: FunctionToCall[] = canSkipCheckingPhase
    ? functions.map((functionToCall) => ({
        ...functionToCall,
        result: {
          kind: "function" as const,
          result: undefined as unknown as FunctionCallResult, // Will be computed during execution phase
        },
      }))
    : functions.map((functionToCall) => {
        // Use the stored args if available (e.g., with pointer conversion), otherwise use original args
        const argsToUse = functionToCall.args ?? args;

        if (isFunctionType(functionToCall.type)) {
          try {
            // NOTE: We need to pass the cloneExpr expr and argExprs here because
            // we might modify the expressions during the tryToCallFunctionWithArguments
            // We will call tryToCallFunctionWithArguments again later with the original expr and argExprs when we actually call the function
            // We pass skipSpecialization: true to avoid polluting the specialization cache during this checking phase.
            // See docs/SPECIALIZATION_CACHE_PITFALL.md for details.
            // We also clone the env to prevent CTFE pointer mutations from affecting
            // the real environment (which would cause double mutations).
            // We pass skipCtfeExecution: true to avoid executing CTFE functions during checking.
            // We set isInFunctionCallCheckingPhase: true so nested function calls also skip CTFE execution.
            const result = tryToCallFunctionWithArguments({
              functionValue: extractFunctionValue(functionToCall.value),
              functionType: functionToCall.type,
              expr: cloneExpr(expr),
              functionCalleeExpr: func,
              argExprs: argsToUse.map((arg) => cloneExpr(arg)),
              callerEnv: cloneEnvForCTFECheck(env),
              context: {
                ...context,
                isInFunctionCallCheckingPhase: true,
              },
              isMethodCall: Boolean(methodExpr),
              skipSpecialization: true,
              skipCtfeExecution: true,
            });
            return {
              ...functionToCall,
              result: {
                kind: "function",
                result,
              },
            };
          } catch (error) {
            // Re-throw overflow errors immediately - they should not be caught
            if (error instanceof YoError && error.kind === "overflow") {
              throw formatErrorMessages(
                [
                  {
                    token: expr.token,
                    errorMessage: `Failed to call the function:\n`,
                  },
                  ...error.tokenAndErrorList,
                ],
                error.isAssertionError
              );
            }
            return {
              ...functionToCall,
              result: {
                kind: "error",
                error: error as Error | YoError,
              },
            };
          }
        } else if (
          (isSomeType(functionToCall.type) || isDynType(functionToCall.type)) &&
          extractFnTraitFromType(functionToCall.type)
        ) {
          // Handle calling a SomeType or DynType that implements Fn (e.g., Impl(Fn(...) -> ...) or Dyn(Fn(...) -> ...))
          const fnModuleType = extractFnTraitFromType(functionToCall.type)!;
          try {
            // NOTE: We need to pass the cloneExpr expr and argExprs here because
            // we might modify the expressions during the tryToCallFunctionWithArguments
            // We will call tryToCallFunctionWithArguments again later with the original expr and argExprs when we actually call the function
            // We pass skipSpecialization: true to avoid polluting the specialization cache during this checking phase.
            // See docs/SPECIALIZATION_CACHE_PITFALL.md for details.
            // We also clone the env to prevent CTFE pointer mutations from affecting
            // the real environment (which would cause double mutations).
            // We pass skipCtfeExecution: true to avoid executing CTFE functions during checking.
            // We set isInFunctionCallCheckingPhase: true so nested function calls also skip CTFE execution.
            const result = tryToCallFunctionWithArguments({
              functionValue: extractFunctionValue(functionToCall.value),
              functionType: fnModuleType.isFn.callType,
              expr: cloneExpr(expr),
              functionCalleeExpr: func,
              argExprs: argsToUse.map((arg) => cloneExpr(arg)),
              callerEnv: cloneEnvForCTFECheck(env),
              context: {
                ...context,
                isInFunctionCallCheckingPhase: true,
              },
              isMethodCall: Boolean(methodExpr),
              skipSpecialization: true,
              skipCtfeExecution: true,
            });
            return {
              ...functionToCall,
              result: {
                kind: "function",
                result,
              },
            };
          } catch (error) {
            // Re-throw overflow errors immediately - they should not be caught
            if (error instanceof YoError && error.kind === "overflow") {
              throw formatErrorMessages(
                [
                  {
                    token: expr.token,
                    errorMessage: `Failed to call the function:\n`,
                  },
                  ...error.tokenAndErrorList,
                ],
                error.isAssertionError
              );
            }
            return {
              ...functionToCall,
              result: {
                kind: "error",
                error: error as Error | YoError,
              },
            };
          }
        } else {
          let value = functionToCall.value;

          // Resolve recursive type references before type checking
          if (
            isTypeValue(value) &&
            isSomeType(value.value) &&
            value.value.recursiveTypeRef
          ) {
            const resolvedType = resolveRecursiveTypeRef(
              value.value,
              env,
              context
            );
            if (resolvedType) {
              value = createTypeValue(resolvedType);
              functionToCall.value = value;
              functionToCall.type = value.type;
            }
          }

          // struct value
          if (isTypeValue(value) && isStructType(value.value)) {
            try {
              const result = tryToCallTypeWithArguments({
                typeFields: value.value.fields,
                functionCalleeExpr: func,
                argExprs: argsToUse,
                callerEnv: env,
                context: { ...context },
              });
              return {
                ...functionToCall,
                result: {
                  kind: "type",
                  result,
                },
              };
            } catch (error) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: error as Error | YoError,
                },
              };
            }
          }
          // enum value
          else if (isTypeValue(value) && isEnumType(value.value)) {
            const enumType = value.value;
            const selectedVariant = enumType.variants.find(
              (variant) => variant.name === enumType.selectedVariantName
            );
            if (!selectedVariant) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: formatErrorMessage({
                    token: expr.token,
                    errorMessage: `Enum variant not selected for enum type`,
                  }),
                },
              };
            } else {
              try {
                const result = tryToCallTypeWithArguments({
                  typeFields: selectedVariant.fields || [],
                  functionCalleeExpr: func,
                  argExprs: argsToUse,
                  callerEnv: env,
                  context: { ...context },
                });
                return {
                  ...functionToCall,
                  result: {
                    kind: "type",
                    result,
                  },
                };
              } catch (error) {
                return {
                  ...functionToCall,
                  result: {
                    kind: "error",
                    error: error as Error | YoError,
                  },
                };
              }
            }
          }
          // union value
          else if (isTypeValue(value) && isUnionType(value.value)) {
            try {
              const result = tryToCallTypeWithArguments({
                typeFields: value.value.fields,
                functionCalleeExpr: func,
                argExprs: argsToUse,
                callerEnv: env,
                context: { ...context },
                isUnionType: true,
              });
              return {
                ...functionToCall,
                result: {
                  kind: "type",
                  result,
                },
              };
            } catch (error) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: error as Error | YoError,
                },
              };
            }
          }
          // module value
          else if (isTypeValue(value) && isModuleType(value.value)) {
            const moduleType = value.value;
            try {
              const result = tryToImplementModuleWithArgumentsByModuleType({
                moduleExpr: func,
                moduleType: moduleType,
                argExprs: argsToUse,
                callerEnv: env,
                context: { ...context },
              });
              return {
                ...functionToCall,
                result: {
                  kind: "module-type",
                  result,
                },
              };
            } catch (error) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: error as Error | YoError,
                },
              };
            }
          }
          // trait value
          else if (isTypeValue(value) && isTraitType(value.value)) {
            const traitType = value.value;
            try {
              const result = tryToImplementTraitWithArgumentsByTraitType({
                traitExpr: func,
                traitType: traitType,
                argExprs: argsToUse,
                callerEnv: env,
                context: { ...context },
              });
              return {
                ...functionToCall,
                result: {
                  kind: "trait-type",
                  result,
                },
              };
            } catch (error) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: error as Error | YoError,
                },
              };
            }
          }
          // function
          else if (isTypeValue(value) && isFunctionType(value.value)) {
            const functionType = value.value;
            try {
              tryToImplementFunctionByFunctionType({
                expr: expr,
                functionType: functionType,
                callerEnv: env,
                context: { ...context },
              });
              return {
                ...functionToCall,
                result: {
                  kind: "function-type",
                },
              };
            } catch (error) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: error as Error | YoError,
                },
              };
            }
          }
          // array type
          else if (isTypeValue(value) && isArrayType(value.value)) {
            const arrayType = value.value;
            try {
              tryToImplementArrayByArrayType({
                expr: expr,
                arrayType: arrayType,
                argExprs: argsToUse,
                callerEnv: env,
                context: { ...context },
              });
              return {
                ...functionToCall,
                result: {
                  kind: "array-type",
                },
              };
            } catch (error) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: error as Error | YoError,
                },
              };
            }
          }
          // comptime list type
          else if (isTypeValue(value) && isComptimeListType(value.value)) {
            const comptimeListType = value.value;
            try {
              tryToImplementComptimeListByComptimeListType({
                expr: expr,
                comptimeListType: comptimeListType,
                argExprs: argsToUse,
                callerEnv: env,
                context: { ...context },
              });
              return {
                ...functionToCall,
                result: {
                  kind: "array-type",
                },
              };
            } catch (error) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: error as Error | YoError,
                },
              };
            }
          }
          // SomeType or DynType that implements Fn (e.g., Impl(Fn(...) -> ...) or Dyn(Fn(...) -> ...))
          else if (
            isTypeValue(value) &&
            (isSomeType(value.value) || isDynType(value.value))
          ) {
            const wrapperType = value.value;
            const fnModuleType = extractFnTraitFromType(wrapperType);
            if (fnModuleType) {
              try {
                tryToImplementClosureByFnModuleType({
                  expr: expr,
                  fnModuleType: fnModuleType,
                  wrapperType: wrapperType,
                  callerEnv: env,
                  context: { ...context },
                });
                return {
                  ...functionToCall,
                  result: {
                    kind: "closure-type",
                  },
                };
              } catch (error) {
                return {
                  ...functionToCall,
                  result: {
                    kind: "error",
                    error: error as Error | YoError,
                  },
                };
              }
            } else if (
              isSomeType(wrapperType) &&
              wrapperType.recursiveTypeRef
            ) {
              // This is a recursive type reference that couldn't be resolved yet.
              // Allow it to be used as a constructor - the type will be resolved later.
              // We treat this as if calling an object constructor with no field validation.
              try {
                // Evaluate the arguments to type-check them
                const runtimeArgExprsInOrder: Expr[] = [];
                for (const argExpr of argsToUse) {
                  const evaluatedArg = evaluateExpression({
                    expr: argExpr,
                    env: env,
                    context: { ...context },
                  });
                  if (!evaluatedArg.$) {
                    throw formatErrorMessage({
                      token: argExpr.token,
                      errorMessage: `Failed to evaluate argument`,
                    });
                  }
                  env = evaluatedArg.$.env;
                  runtimeArgExprsInOrder.push(evaluatedArg);
                }

                return {
                  ...functionToCall,
                  result: {
                    kind: "type",
                    result: {
                      values: runtimeArgExprsInOrder.map((e) => e.$!.value),
                      pathCollection: [],
                      runtimeArgExprsInOrder,
                      callerEnv: env,
                    },
                  },
                };
              } catch (error) {
                return {
                  ...functionToCall,
                  result: {
                    kind: "error",
                    error: error as Error | YoError,
                  },
                };
              }
            } else {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: formatErrorMessage({
                    token: func.token,
                    errorMessage: `Invalid function call on type:
${isTypeValue(value) ? typeToString(value.value) : typeToString(functionToCall.type)}`,
                  }),
                },
              };
            }
          }
          // array or slice
          else if (
            // array
            isArrayType(functionToCall.type) ||
            // slice
            isSliceType(functionToCall.type)
          ) {
            try {
              const functionToCallValue = functionToCall.value;
              const arrayValue = isArrayValue(functionToCallValue)
                ? functionToCallValue
                : undefined;
              const sliceValue = isSliceValue(functionToCallValue)
                ? functionToCallValue
                : undefined;
              const result = tryToCallArrayWithArguments({
                expr,
                arrayType: functionToCall.type, // Array or Slice
                arrayValue,
                sliceValue,
                argExprs: argsToUse,
                callerEnv: env,
                context: { ...context },
              });
              return {
                ...functionToCall,
                result: {
                  kind: "array",
                  result,
                },
              };
            } catch (error) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: error as Error | YoError,
                },
              };
            }
          }
          // numeric type conversion (i32, u8, f64, etc.)
          else if (
            isTypeValue(value) &&
            isConvertibleNumericType(value.value)
          ) {
            const targetType = value.value;
            // Numeric types expect exactly one argument
            if (argsToUse.length !== 1) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: formatErrorMessage({
                    token: func.token,
                    errorMessage: `Numeric type conversion expects exactly 1 argument, got ${argsToUse.length}`,
                  }),
                },
              };
            }
            try {
              const result = tryToConvertToNumericType({
                targetType,
                argExpr: argsToUse[0]!,
                expr,
                callerEnv: env,
                context: { ...context },
              });
              if (result) {
                return {
                  ...functionToCall,
                  result: {
                    kind: "numeric-type",
                    result,
                  },
                };
              } else {
                return {
                  ...functionToCall,
                  result: {
                    kind: "error",
                    error: formatErrorMessage({
                      token: func.token,
                      errorMessage: `Failed to convert to numeric type ${typeToString(targetType)}`,
                    }),
                  },
                };
              }
            } catch (error) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: error as Error | YoError,
                },
              };
            }
          }
          // pointer type casting (*(T))
          else if (isTypeValue(value) && isPtrType(value.value)) {
            const targetType = value.value;
            // Pointer type casting expects exactly one argument
            if (argsToUse.length !== 1) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: formatErrorMessage({
                    token: func.token,
                    errorMessage: `Pointer type casting expects exactly 1 argument, got ${argsToUse.length}`,
                  }),
                },
              };
            }
            try {
              const result = tryToConvertToPointerType({
                targetType,
                argExpr: argsToUse[0]!,
                expr,
                callerEnv: env,
                context: { ...context },
              });
              if (result) {
                return {
                  ...functionToCall,
                  result: {
                    kind: "pointer-type",
                    result,
                  },
                };
              } else {
                return {
                  ...functionToCall,
                  result: {
                    kind: "error",
                    error: formatErrorMessage({
                      token: func.token,
                      errorMessage: `Failed to cast to pointer type ${typeToString(targetType)}`,
                    }),
                  },
                };
              }
            } catch (error) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: error as Error | YoError,
                },
              };
            }
          }
          // Iso value constructor: Iso(T)(value)
          else if (isTypeValue(value) && isIsoType(value.value)) {
            const isoType = value.value;
            // Iso value constructor expects exactly one argument
            if (argsToUse.length !== 1) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: formatErrorMessage({
                    token: func.token,
                    errorMessage: `Iso value constructor expects exactly 1 argument, got ${argsToUse.length}`,
                  }),
                },
              };
            }
            try {
              const result = evaluateIsoValueCall({
                expr,
                env,
                context: { ...context },
                isoType,
              });
              return {
                ...functionToCall,
                result: {
                  kind: "iso-value",
                  result,
                },
              };
            } catch (error) {
              return {
                ...functionToCall,
                result: {
                  kind: "error",
                  error: error as Error | YoError,
                },
              };
            }
          } else {
            return {
              ...functionToCall,
              result: {
                kind: "error",
                error: formatErrorMessage({
                  token: func.token,
                  errorMessage: `Invalid function call on type:
${isTypeValue(value) ? typeToString(value.value) : typeToString(functionToCall.type)}`,
                }),
              },
            };
          }
        }
      }); // End of the checking phase map

  let functionsWithMatchingTypes = functionsToCall.filter(
    (functionToCall) => functionToCall.result.kind !== "error"
  );

  // Check if there is only one comptime function call,
  // If yes, then we use that function.
  // Comptime function call has higher priority than normal function call.
  // So this way we eagerly evaluate the function call that can be done at the compile-time.
  const comptimeFunctionCalls = functionsWithMatchingTypes.filter(
    (functionToCall) =>
      isFunctionType(functionToCall.type) &&
      functionToCall.type.return.isCompileTimeOnly // TODO: How about other type calls?
  );

  if (comptimeFunctionCalls.length === 1) {
    functionsWithMatchingTypes = comptimeFunctionCalls;
  }

  // When there are still multiple matches and multiple are comptime functions,
  // prefer the one with comptime parameter types over runtime parameter types.
  // For example, when calling `3 > 4`:
  // - Prefer fn(comptime_int, comptime_int) -> bool over fn(i32, i32) -> bool
  // This ensures that compile-time operations stay at compile-time when possible.
  if (functionsWithMatchingTypes.length > 1) {
    const functionsWithComptimeParams = functionsWithMatchingTypes.filter(
      (functionToCall) => {
        if (!isFunctionType(functionToCall.type)) return false;
        const params = functionToCall.type.parameters;
        // Check if any parameter is a comptime type (comptime_int, comptime_float, comptime_string)
        return params.some(
          (param) =>
            isComptimeIntType(param.type) ||
            isComptimeFloatType(param.type) ||
            isComptimeStringType(param.type)
        );
      }
    );
    if (functionsWithComptimeParams.length === 1) {
      functionsWithMatchingTypes = functionsWithComptimeParams;
    }
  }

  if (functionsWithMatchingTypes.length === 0) {
    if (
      functionsToCall.length === 1 &&
      functionsToCall[0]!.result.kind === "error"
    ) {
      const error = functionsToCall[0]!.result.error;
      if (error instanceof YoError) {
        // console.trace(exprToString(expr));
        throw formatErrorMessages(
          [
            {
              token: expr.token,
              errorMessage: `Failed to call the function:\n
${error.tokenAndErrorList
  .filter(({ token }) => token.modulePath !== expr.token.modulePath)
  .map(({ errorMessage }) => `- ${errorMessage}`)
  .join("\n")}`,
            },
            ...error.tokenAndErrorList.filter(
              ({ token }) => token.modulePath === expr.token.modulePath
            ),
          ],
          error.isAssertionError
        );
      } else {
        // console.log("Error type:", error?.constructor?.name);
        // console.log(
        //   "Error message:",
        //   error instanceof Error ? error.message : String(error)
        // );
        // console.log(
        //   "Error stack:",
        //   error instanceof Error
        //     ? error.stack?.split("\n").slice(0, 10).join("\n")
        //     : "no stack"
        // );
        // console.trace(exprToString(expr));
        throw formatErrorMessages([
          {
            token: expr.token,
            errorMessage: `Failed to call the function:\n`,
          },
          {
            token: expr.token,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          },
        ]);
      }
    }

    throw formatErrorMessages([
      {
        token: func.token,
        errorMessage: `No matching call found with arguments:
${exprToString(expr)}

${functionsToCall.length ? "Available functions:\n" : ""}`,
      },
      ...functionsToCall
        .map((functionToCall) => {
          const error =
            functionToCall.result.kind === "error"
              ? functionToCall.result.error
              : undefined;
          if (error) {
            if (error instanceof YoError) {
              return [
                {
                  token: func.token,
                  errorMessage: `- ${typeToString(functionToCall.type)}\n`,
                },
                ...error.tokenAndErrorList,
              ];
            } else {
              return {
                token: func.token,
                errorMessage: `- ${typeToString(functionToCall.type)}\n${error instanceof Error ? error.message : String(error)}`,
              };
            }
          } else {
            return {
              token: func.token,
              errorMessage: `${typeToString(functionToCall.type)}`,
            };
          }
        })
        .flat(),
    ]);
  }
  if (functionsWithMatchingTypes.length > 1) {
    throw formatErrorMessage({
      token: func.token,
      errorMessage: `Ambiguous call with arguments:
${exprToString(expr)}

Found ${functionsWithMatchingTypes.length} matching calls:
${functionsWithMatchingTypes.map((matchedFunction) => `${typeToString(matchedFunction.type)}`).join("\n")}
`,
    });
  }

  const functionToCall = functionsWithMatchingTypes[0]!; // Found the only one function to call

  // When we're in a checking phase of an outer function call, AND this function is a CTFE function
  // that returns a non-type compile-time value, we should NOT actually execute it - just return
  // a placeholder with the correct type. This prevents exponential blowup when checking recursive
  // CTFE functions like factorial.
  // The actual execution will happen when the outer function call executes.
  //
  // IMPORTANT: We must NOT skip execution for:
  // 1. Type-returning CTFE functions (Box(V), Vec(T)) - need execution to resolve the type
  // 2. Functions with forall parameters - return type may reference unresolved forall params
  const shouldSkipExecutionDuringChecking =
    context.isInFunctionCallCheckingPhase && isNonTypeCtfeFunction;

  if (shouldSkipExecutionDuringChecking) {
    const functionType = functionToCall.type as FunctionType;
    const { returnType } = evaluateFunctionReturnTypeAgain({
      functionType,
      calleeEnv: functionType.env,
      context: { ...context, isEvaluatingFunctionType: true },
      functionCalleeExpr: func,
    });

    env = popEnvFrame(env);

    expr.$ = {
      env,
      type: returnType,
      value: createUnknownValue(returnType, {
        variableName: "checking_phase_placeholder_" + randomId(env.modulePath),
        env,
        context,
      }),
      pathCollection: [],
    };
    return expr;
  }

  // This function call is for macro expansion.
  // So we just return the expr we expanded.
  if (forMacroExpansion) {
    // It is macro function call
    if (
      isFunctionType(functionToCall.type) &&
      functionToCall.type.return.isUnquote
    ) {
      // Evaluate the function again with the real expr and arg exprs
      const {
        returnValue,
        callerEnv,
        pathCollection,
        deferredDropExpressions,
      } = tryToCallFunctionWithArguments({
        functionValue: extractFunctionValue(functionToCall.value),
        functionType: functionToCall.type,
        expr: expr,
        functionCalleeExpr: func,
        argExprs: functionToCall.args ?? args,
        callerEnv: env,
        context,
        isMethodCall: Boolean(methodExpr),
      });

      // const {
      //   returnValue,
      //   callerEnv,
      //   pathCollection,
      //   deferredDropExpressions,
      // } = getFunctionCallResult(functionToCall);

      env = popEnvFrame(callerEnv);

      expr.$ = {
        env,
        type: createExprType(),
        value: returnValue,
        originType: createExprType(), // Macro result's origin type is the expression type
        pathCollection: pathCollection,
        deferredDropExpressions,
      };

      return expr;
    } else {
      throw formatErrorMessage({
        token: func.token,
        errorMessage: `Expected macro function call for macro_expand.`,
      });
    }
  }

  if (isFunctionType(functionToCall.type)) {
    const functionType = functionToCall.type;

    {
      // It's
      // - Function returns runtime value
      // - Function returns comptime value
      // For function returns comptime value, we can evaluate the function body.
      // Evaluate the function again with the real expr and arg exprs
      const {
        returnType,
        returnValue,
        callerEnv,
        // calleeEnv,
        // argValues,
        pathCollection,
        specializedFunctionValue,
        runtimeArgExprsInOrder,
        deferredDropExpressions,
      } = tryToCallFunctionWithArguments({
        functionValue: extractFunctionValue(functionToCall.value),
        functionType: functionToCall.type,
        expr: expr,
        functionCalleeExpr: func,
        argExprs: functionToCall.args ?? args,
        callerEnv: env,
        context,
        isMethodCall: Boolean(methodExpr),
      });

      env = popEnvFrame(callerEnv);

      // Check if it's a macro function call,
      // if yes, then we continue to evaluate the returnValue which should be an Expr value.
      if (functionType.return.isUnquote) {
        if (isExprValue(returnValue)) {
          const expandedExpr = evaluateExpression({
            expr: returnValue.value,
            env,
            context: {
              ...context,
            },
          });

          // Store the expanded expression on the original expr for C codegen
          expr.$ = {
            env: expandedExpr.$?.env || env,
            type: expandedExpr.$?.type || returnType,
            value: expandedExpr.$?.value,
            originType:
              expandedExpr.$?.originType || expandedExpr.$?.type || returnType,
            pathCollection: expandedExpr.$?.pathCollection || [],
            macroExpansion: expandedExpr,
            // IMPORTANT: Copy variableName from expanded expression for ownership tracking
            variableName: expandedExpr.$?.variableName,
          };

          return expr;
        } else {
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `Expected macro function to return an Expr value, got:\n${valueToString(
              returnValue
            )}`,
          });
        }
      }

      // No consumption logic needed anymore

      // Preserve the variableName if it was already set (e.g., from a previous overload attempt)
      const previousVariableName = expr.$?.variableName;

      // For functions returning Impl(Module) (SomeType), set resolvedConcreteType
      // to the concrete type from the function body.  This enables static dispatch
      // for method calls on the return value.
      let finalReturnType = returnType;
      if (
        isSomeType(returnType) &&
        functionToCall.value &&
        isFunctionValue(functionToCall.value)
      ) {
        const functionBody = functionToCall.value.body;
        if (functionBody.$?.type) {
          // If the function body's type is also a SomeType with resolvedConcreteType,
          // use that concrete type directly. This is important for async blocks which
          // return SomeType(Impl(Future)) with resolvedConcreteType set to the capture struct.
          let concreteType = functionBody.$.type;
          if (isSomeType(concreteType) && concreteType.resolvedConcreteType) {
            concreteType = concreteType.resolvedConcreteType;
          }
          // Clone the SomeType and set its resolvedConcreteType
          finalReturnType = {
            ...returnType,
            resolvedConcreteType: concreteType,
          } as SomeType;
        }
      }

      expr.$ = {
        env,
        type: finalReturnType,
        value: returnValue,
        originType: finalReturnType, // Function call result's origin type is its return type
        pathCollection: pathCollection,
        runtimeArgExprsInOrder,
        deferredDropExpressions,
        variableName: previousVariableName,
      };

      // For io.async calls, propagate awaitAnalysis and captureType from the closure
      // argument to the call expression. This enables codegen to generate a state machine
      // instead of a sync future when the closure contains await points.
      if (functionType.ioBuiltin === "io_async" && runtimeArgExprsInOrder[0]) {
        const closureArg = runtimeArgExprsInOrder[0];
        const closureFnValue = closureArg.$?.closureFunctionValue as
          | FunctionValue
          | undefined;
        if (closureFnValue?.body?.$?.awaitAnalysis) {
          expr.$.awaitAnalysis = closureFnValue.body.$.awaitAnalysis;
          expr.$.captureType = closureArg.$?.captureType;
          expr.$.deferredDupExpressions = closureArg.$?.deferredDupExpressions;
          // Clear from closure to prevent the dup/drop optimizer from collecting
          // these dups twice (once on io.async, once on the closure argument).
          if (closureArg.$?.deferredDupExpressions) {
            closureArg.$.deferredDupExpressions = undefined;
          }

          // Mark closure-captured variables as "outer" in the await analysis.
          // These variables live in the __capture struct, not as local SM fields.
          const closureCaptureType = closureArg.$?.captureType;
          if (closureCaptureType && expr.$.awaitAnalysis) {
            const captureFieldNames = new Set(
              closureCaptureType.fields.map((f: { label: string }) => f.label)
            );
            expr.$.awaitAnalysis = {
              ...expr.$.awaitAnalysis,
              capturedVariables: expr.$.awaitAnalysis.capturedVariables.map(
                (v) =>
                  captureFieldNames.has(v.name)
                    ? { ...v, kind: "outer" as const }
                    : v
              ),
            };
          }

          // Mark the closure so codegen skips generating its C function
          // (the body is handled by the state machine's resume function)
          closureFnValue.isIoAsyncStateMachineClosure = true;
        } else {
          // Sync path (no await points in the closure body).
          // The closure's capture struct is stack-allocated (Impl closure),
          // so captures are just borrowed pointers — no RC dups needed.
          // Clear deferredDupExpressions to prevent closures.ts from
          // generating unnecessary dups that would leak (no matching Drop
          // on stack-allocated capture structs).
          if (closureArg.$?.deferredDupExpressions) {
            closureArg.$.deferredDupExpressions = undefined;
          }
        }

        // Mark the closure's temp variable as consumed so it won't get a
        // deferred drop in the parent scope — the capture struct is either
        // owned by the state machine (async path) or stack-allocated (sync path).
        // In either case, the evaluator's temp variable name doesn't correspond
        // to a declared C variable, so a scope-exit drop would reference an
        // undeclared identifier.
        const closureVarName = closureArg.$?.variableName;
        if (closureVarName && expr.$.env) {
          const vars = getVariablesFromEnv(expr.$.env, closureVarName);
          const closureVar = vars[vars.length - 1];
          if (closureVar) {
            expr.$.env = updateExistingVariable(expr.$.env, closureVar, {
              ...closureVar,
              consumedAtToken: expr.token,
            });
          }
        }
      }

      // Set temp variable which holds the result of the function call
      attachTempVariableToExpr(expr, true);

      // Attach necessary info to the func
      func.$ = {
        env,
        type: functionToCall.type,
        value: specializedFunctionValue || functionToCall.value,
        pathCollection: [],
      };
      if (methodExpr) {
        methodExpr.$ = {
          env,
          type: functionToCall.type,
          value: specializedFunctionValue || functionToCall.value,
          pathCollection: [],
        };
      }
    }

    return expr;
  } else if (
    // Check if it's a closure call
    (isSomeType(functionToCall.type) || isDynType(functionToCall.type)) &&
    extractFnTraitFromType(functionToCall.type)
  ) {
    // Handle calling a SomeType or DynType that implements Fn (e.g., Impl(Fn(...) -> ...) or Dyn(Fn(...) -> ...))
    const fnModuleType = extractFnTraitFromType(functionToCall.type)!;

    // Re-call tryToCallFunctionWithArguments with the ORIGINAL args (not clones).
    // The checking phase used cloned args (which get $ annotations but are discarded),
    // so the original arg expressions still lack $ annotations.
    // This real call evaluates the original args in-place, setting their $ fields,
    // which is necessary for codegen (e.g., effect state machine generation needs
    // annotated sub-expressions like arr(i) in callback(arr(i))).
    const {
      returnType,
      returnValue,
      callerEnv,
      pathCollection,
      specializedFunctionValue,
      runtimeArgExprsInOrder,
      deferredDropExpressions,
    } = tryToCallFunctionWithArguments({
      functionValue: extractFunctionValue(functionToCall.value),
      functionType: fnModuleType.isFn.callType,
      expr: expr,
      functionCalleeExpr: func,
      argExprs: functionToCall.args ?? args,
      callerEnv: env,
      context,
      isMethodCall: Boolean(methodExpr),
    });

    env = popEnvFrame(callerEnv);

    // Check if it's a macro function call,
    // if yes, then we continue to evaluate the returnValue which should be an Expr value.
    if (fnModuleType.isFn.callType.return.isUnquote) {
      if (isExprValue(returnValue)) {
        const expandedExpr = evaluateExpression({
          expr: returnValue.value,
          env,
          context: {
            ...context,
          },
        });

        // Store the expanded expression on the original expr for C codegen
        expr.$ = {
          env: expandedExpr.$?.env || env,
          type: expandedExpr.$?.type || returnType,
          value: expandedExpr.$?.value,
          originType:
            expandedExpr.$?.originType || expandedExpr.$?.type || returnType,
          pathCollection: expandedExpr.$?.pathCollection || [],
          macroExpansion: expandedExpr,
        };

        return expr;
      } else {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Expected macro closure to return an Expr value, got:\n${valueToString(
            returnValue
          )}`,
        });
      }
    }

    expr.$ = {
      env,
      type: returnType,
      value: returnValue,
      originType: returnType, // Function call result's origin type is its return type
      pathCollection: pathCollection,
      runtimeArgExprsInOrder,
      deferredDropExpressions,
    };

    // Set temp variable which holds the result of the function call
    attachTempVariableToExpr(expr, true);

    // Attach necessary info to the func
    func.$ = {
      env,
      type: functionToCall.type,
      value: specializedFunctionValue || functionToCall.value,
      pathCollection: [],
    };
    if (methodExpr) {
      methodExpr.$ = {
        env,
        type: functionToCall.type,
        value: specializedFunctionValue || functionToCall.value,
        pathCollection: [],
      };
    }
    return expr;
  } else {
    const functionToCallValue = functionToCall.value;
    // struct value
    if (
      isTypeValue(functionToCallValue) &&
      isStructType(functionToCallValue.value)
    ) {
      const structType = functionToCallValue.value;
      expr.$ = {
        env,
        type: structType,
        originType: structType, // Struct constructor result's origin type is the struct type
        pathCollection: [],
      };

      const {
        values: memberValues,
        pathCollection,
        callerEnv,
        runtimeArgExprsInOrder,
      } = getTypeCallResult(functionToCall);
      env = callerEnv;
      if (!memberValues) {
        throw formatErrorMessage({
          token: func.token,
          errorMessage: `Error evaluating struct call.`,
        });
      }
      const structValue = memberValues.some((memberValue) => !memberValue)
        ? undefined
        : createStructValue(structType, memberValues as Value[]);
      expr.$.value = isObjectType(structType)
        ? undefined // `object` type only supports runtime value
        : structValue;
      expr.$.pathCollection = pathCollection;
      expr.$.env = env;
      expr.$.runtimeArgExprsInOrder = runtimeArgExprsInOrder;

      // Set temp variable which holds the result of the function call
      attachTempVariableToExpr(expr, true);

      // Attach necessary info to the func
      func.$ = {
        env,
        type: functionToCallValue.type,
        value: functionToCallValue,
        pathCollection: [],
      };
      return expr;
    }
    // enum value
    else if (
      isTypeValue(functionToCallValue) &&
      isEnumType(functionToCallValue.value)
    ) {
      const enumType = functionToCallValue.value;
      expr.$ = {
        env,
        type: enumType,
        originType: enumType, // Enum constructor result's origin type is the enum type
        pathCollection: [],
      };
      // FIXME: Support to set value for comptime
      const selectedVariant = enumType.variants.find(
        (variant) => variant.name === enumType.selectedVariantName
      );
      if (!selectedVariant) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Enum variant not selected for enum type`,
        });
      }
      const {
        values: memberValues,
        pathCollection,
        callerEnv,
        runtimeArgExprsInOrder,
      } = getTypeCallResult(functionToCall);
      env = callerEnv;

      if (memberValues.every((v) => !!v)) {
        const enumValue = createEnumValue(
          enumType,
          selectedVariant.name,
          memberValues as Value[]
        );
        expr.$.value = enumValue;
      }
      expr.$.pathCollection = pathCollection;
      expr.$.env = env;
      expr.$.runtimeArgExprsInOrder = runtimeArgExprsInOrder;

      // Set temp variable which holds the result of the function call
      attachTempVariableToExpr(expr, true);

      // Attach necessary info to the func
      func.$ = {
        env,
        type: functionToCallValue.type,
        value: functionToCallValue,
        pathCollection: [],
      };
      return expr;
    }
    // union value
    else if (
      isTypeValue(functionToCallValue) &&
      isUnionType(functionToCallValue.value)
    ) {
      const unionType = functionToCallValue.value;
      expr.$ = {
        env,
        type: unionType,
        originType: unionType, // Union constructor result's origin type is the union type
        pathCollection: [],
      };
      const { pathCollection, callerEnv, runtimeArgExprsInOrder } =
        getTypeCallResult(functionToCall);
      env = callerEnv;
      expr.$.value = undefined;
      expr.$.pathCollection = pathCollection;
      expr.$.env = env;
      expr.$.runtimeArgExprsInOrder = runtimeArgExprsInOrder;

      // Set temp variable which holds the result of the function call
      attachTempVariableToExpr(expr, true);

      // Attach necessary info to the func
      func.$ = {
        env,
        type: functionToCallValue.type,
        value: functionToCallValue,
        pathCollection: [],
      };
      return expr;
    }
    // module value
    else if (
      isTypeValue(functionToCallValue) &&
      isModuleType(functionToCallValue.value)
    ) {
      const { moduleValue, callerEnv } =
        getModuleTypeCallResult(functionToCall);
      env = callerEnv;

      expr.$ = {
        env,
        type: moduleValue.type,
        value: moduleValue,
        originType: moduleValue.type, // Module result's origin type is its type
        pathCollection: [],
      };

      // Attach necessary info to the func
      func.$ = {
        env,
        type: functionToCallValue.type,
        value: functionToCallValue,
        pathCollection: [],
      };
      return expr;
    }
    // trait value
    else if (
      isTypeValue(functionToCallValue) &&
      isTraitType(functionToCallValue.value)
    ) {
      const { traitValue, callerEnv } = getTraitTypeCallResult(functionToCall);
      env = callerEnv;

      expr.$ = {
        env,
        type: traitValue.type,
        value: traitValue,
        originType: traitValue.type, // Module result's origin type is its type
        pathCollection: [],
      };

      // Attach necessary info to the func
      func.$ = {
        env,
        type: functionToCallValue.type,
        value: functionToCallValue,
        pathCollection: [],
      };
      return expr;
    }
    // function value
    else if (
      isTypeValue(functionToCallValue) &&
      isFunctionType(functionToCallValue.value)
    ) {
      // This should already be evaluated.
      /*
        if (!expr.$ || !expr.$.value) {
          throw formatErrorMessage(
            func.token,
            `Expected function value for function call, got:\n${exprToString(
              expr
            )}`
          );
        }
        */
      return expr;
    }
    // array type
    else if (
      isTypeValue(functionToCallValue) &&
      isArrayType(functionToCallValue.value)
    ) {
      // This should already be evaluated by tryToImplementArrayByArrayType
      return expr;
    }
    // comptime list type
    else if (
      isTypeValue(functionToCallValue) &&
      isComptimeListType(functionToCallValue.value)
    ) {
      // This should already be evaluated by tryToImplementComptimeListByComptimeListType
      return expr;
    }
    // SomeType or DynType - check if it was called as a constructor (has "type" result)
    else if (
      isTypeValue(functionToCallValue) &&
      (isSomeType(functionToCallValue.value) ||
        isDynType(functionToCallValue.value))
    ) {
      // Check if this was a constructor call (has "type" result with recursiveTypeRef)
      if (
        functionToCall.result.kind === "type" &&
        isSomeType(functionToCallValue.value) &&
        functionToCallValue.value.recursiveTypeRef
      ) {
        const someType = functionToCallValue.value;
        expr.$ = {
          env,
          type: someType,
          originType: someType,
          pathCollection: [],
        };

        const { pathCollection, callerEnv, runtimeArgExprsInOrder } =
          getTypeCallResult(functionToCall);
        env = callerEnv;
        expr.$.value = undefined; // Runtime value only
        expr.$.pathCollection = pathCollection;
        expr.$.env = env;
        expr.$.runtimeArgExprsInOrder = runtimeArgExprsInOrder;

        // Set temp variable which holds the result of the function call
        attachTempVariableToExpr(expr, true);

        // Attach necessary info to the func
        func.$ = {
          env,
          type: functionToCallValue.type,
          value: functionToCallValue,
          pathCollection: [],
        };
        return expr;
      }
      // Otherwise it was already evaluated in the first pass (e.g., closure call)
      return expr;
    }
    // numeric type conversion (i32, u8, f64, etc.)
    else if (
      isTypeValue(functionToCallValue) &&
      isConvertibleNumericType(functionToCallValue.value)
    ) {
      // This should already be evaluated by tryToConvertToNumericType
      // The expr has been transformed to __yo_as call if needed
      return expr;
    }
    // pointer type casting (*(T))
    else if (
      isTypeValue(functionToCallValue) &&
      isPtrType(functionToCallValue.value)
    ) {
      // This should already be evaluated by tryToConvertToPointerType
      // The expr has been transformed to __yo_as call if needed
      return expr;
    }
    // Iso value constructor: Iso(T)(value)
    else if (
      isTypeValue(functionToCallValue) &&
      isIsoType(functionToCallValue.value)
    ) {
      // This should already be evaluated by evaluateIsoValueCall
      return expr;
    }
    // array & slice
    else if (
      isArrayType(functionToCall.type) ||
      isSliceType(functionToCall.type)
    ) {
      const { value, index, type, arrayElementRef, callerEnv } =
        getArrayCallResult(functionToCall);

      // Build pathCollection for array access
      let pathCollection = func.$?.pathCollection ?? [];
      // If there's a single argument (index), add it to the path for assignment support
      if (args.length === 1 && typeof index === "number") {
        if (pathCollection.length > 0) {
          // Add the index to the existing path
          pathCollection = pathCollection.map((path) => [
            ...path,
            index.toString(),
          ]);
        } else if (func.$?.variableName) {
          // Create a new path with the variable name and index
          pathCollection = [[func.$.variableName, index.toString()]];
        }
      }

      // Pass arrayElementRef through to support &(arr(0))
      expr.$ = {
        env: callerEnv,
        type: type,
        value: value,
        originType: func.$?.originType ?? functionToCall.type, // Array access inherits origin type
        pathCollection: pathCollection,
        sourceVariable: func.$?.sourceVariable,
        arrayElementRef: arrayElementRef,
        /**
         * NOTE: We need to set isAccessingProperty to true here
         * to prevent getting an array element of Linear type.
         */
        isAccessingProperty: true,
      };

      // Attach necessary info to the func
      func.$ = {
        env,
        type: functionToCall.type,
        value: functionToCall.value,
        pathCollection: func.$?.pathCollection ?? [],
        isAccessingProperty: true,
      };

      attachTempVariableToExpr(expr, false); // NOTE: This is like property access, so it doesn't own the value

      return expr;
    }
  }

  throw formatErrorMessage({
    token: expr.token,
    errorMessage: `Function call is not implemented yet:
${exprToString(expr)}`,
  });
}
