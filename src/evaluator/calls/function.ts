import { Environment, getMethodsByNameFromEnv, popEnvFrame } from "../../env";
import { formatErrorMessage, formatErrorMessages, YoError } from "../../error";
import {
  AtomExpr,
  attachTempVariableToExpr,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { FunctionValue } from "../../function-value";
import { stringIsOperator, TokenType } from "../../token";
import { TypeValue } from "../../type-value";
import {
  ArrayType,
  ClosureType,
  createExprType,
  isArrayType,
  isClosureType,
  isComptListType,
  isEnumType,
  isFunctionType,
  isModuleType,
  isObjectType,
  isSliceType,
  isSomeType,
  isStructType,
  isUnionType,
  Type,
  typeOfType,
  typeToString,
} from "../../types";
import {
  ArrayValue,
  createEnumValue,
  createStructValue,
  createTypeValue,
  isExprValue,
  isTupleValue,
  isTypeValue,
  Value,
  valueToString,
} from "../../value";
import {
  EvaluatorContext,
  FunctionToCall,
  getArrayCallResult,
  getFunctionCallResult,
  getModuleTypeCallResult,
  getTypeCallResult,
} from "../context";
import { evaluateExpression } from "../exprs/expr";
import {
  evaluateArrayFillMethod,
  isArrayTypeFillMethodCall,
} from "../utils/array-utils";
import { evaluateAnonymousStructValue } from "../values/anonymous_struct";
import { tryToCallArrayWithArguments } from "./array";
import { tryToImplementArrayByArrayType } from "./array_type";
import { tryToImplementClosureByClosureType } from "./closure_type";
import { tryToImplementComptListByComptListType } from "./compt_list_type";
import { tryToImplementFunctionByFunctionType } from "./function_type";
import { extractFunctionValue, tryToCallFunctionWithArguments } from "./helper";
import { tryToImplementModuleWithArgumentsByModuleType } from "./module_type";
import {
  isConvertibleNumericType,
  tryToConvertToNumericType,
} from "./numeric_type";
import { tryToCallTypeWithArguments } from "./type";

export function evaluateFunctionCall({
  expr,
  env,
  context,
  givenFunc,
  forMacroExpansion,
}: {
  expr: FuncCallExpr;
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

          // Special case: Array type fill method
          if (isArrayTypeFillMethodCall(receiverArg, methodExpr)) {
            // Type assertion is safe because isArrayTypeFillMethodCall already validated this
            const arrayType = (
              receiverArg.$ as NonNullable<typeof receiverArg.$>
            ).value as TypeValue & { value: ArrayType };

            // Validate we have exactly one argument for the fill value
            if (args.length !== 1) {
              throw formatErrorMessage({
                token: expr.token,
                errorMessage: `Array.fill expects exactly 1 argument (fill value), got ${args.length}`,
              });
            }

            // Use our helper function to handle the array fill logic
            const result = evaluateArrayFillMethod({
              expr,
              arrayType: arrayType.value,
              fillValueArg: args[0]!,
              env,
              context,
            });

            return result.expr;
          }

          // The methodExpr should also be evaluated already
          // so it should have a type
          if (exprIsAtom(methodExpr)) {
            // 1.add(3);
            const methodName = methodExpr.token.value;
            // Get the method with the same name in the interface in the env
            const methods = getMethodsByNameFromEnv(
              env,
              methodName,
              receiverType,
              false // isInfixOperatorCall - property access allows auto pointer conversion
            );
            functions = methods.map((method) => {
              // If pointer conversion is needed, wrap the receiver in &()
              let methodArgs: Expr[];
              if (method.needsPointerConversion) {
                // Create &(receiverArg) expression
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

                const addressOfExpr: FuncCallExpr = {
                  tag: ExprTag.FuncCall,
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
            errorMessage: `Expected type for function call, got ${exprToString(
              functionToCall
            )}`,
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
      const functionName =
        func.token.type === TokenType.BacktickIdentifier
          ? func.token.value.slice(1, -1) // Convert `add` to add
          : func.token.value;

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
        const evaluatedFirstArg = evaluateExpression({
          expr: firstArg,
          env,
          context: {
            ...context,
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
        const moduleMethods = getMethodsByNameFromEnv(
          env,
          methodName,
          receiverType,
          true // isInfixOperatorCall - infix operators don't allow auto pointer conversion
        );
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

  // Find the functions whose parameters match the arguments
  const functionsToCall: FunctionToCall[] = functions.map((functionToCall) => {
    // Use the stored args if available (e.g., with pointer conversion), otherwise use original args
    const argsToUse = functionToCall.args ?? args;

    if (isFunctionType(functionToCall.type)) {
      try {
        const result = tryToCallFunctionWithArguments({
          functionValue: extractFunctionValue(functionToCall.value),
          functionType: functionToCall.type,
          expr,
          functionCalleeExpr: func,
          argExprs: argsToUse,
          callerEnv: env,
          context: { ...context },
          isMethodCall: Boolean(methodExpr),
        });
        return {
          ...functionToCall,
          result: {
            kind: "function",
            result,
          },
        };
      } catch (error) {
        return {
          ...functionToCall,
          result: {
            kind: "error",
            error: error,
          },
        };
      }
    } else if (isClosureType(functionToCall.type)) {
      try {
        // For closures, delegate to the underlying function type
        const closureType = functionToCall.type as ClosureType;
        const result = tryToCallFunctionWithArguments({
          functionValue: extractFunctionValue(functionToCall.value),
          functionType: closureType.callType,
          expr,
          functionCalleeExpr: func,
          argExprs: argsToUse,
          callerEnv: env,
          context: { ...context },
          isMethodCall: Boolean(methodExpr),
        });
        return {
          ...functionToCall,
          result: {
            kind: "function",
            result,
          },
        };
      } catch (error) {
        return {
          ...functionToCall,
          result: {
            kind: "error",
            error: error,
          },
        };
      }
    } else {
      const value = functionToCall.value;

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
              error: error,
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
                error: error,
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
              error: error,
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
              error: error,
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
              error: error,
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
              error: error,
            },
          };
        }
      }
      // compt list type
      else if (isTypeValue(value) && isComptListType(value.value)) {
        const comptListType = value.value;
        try {
          tryToImplementComptListByComptListType({
            expr: expr,
            comptListType: comptListType,
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
              error: error,
            },
          };
        }
      }
      // closure type
      else if (isTypeValue(value) && isClosureType(value.value)) {
        const closureType = value.value;
        try {
          tryToImplementClosureByClosureType({
            expr: expr,
            closureType: closureType,
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
              error: error,
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
          const result = tryToCallArrayWithArguments({
            expr,
            arrayType: functionToCall.type, // Array or Slice
            arrayValue: functionToCall.value as ArrayValue | undefined,
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
              error: error,
            },
          };
        }
      }
      // numeric type conversion (i32, u8, f64, etc.)
      else if (isTypeValue(value) && isConvertibleNumericType(value.value)) {
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
              error: error,
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
  });

  let functionsWithMatchingTypes = functionsToCall.filter(
    (functionToCall) => functionToCall.result.kind !== "error"
  );

  // Check if there is only one compt function call,
  // If yes, then we use that function.
  // Compt function call has higher priority than normal function call.
  // So this way we eagerly evaluate the function call that can be done at the compile-time.
  const comptFunctionCalls = functionsWithMatchingTypes.filter(
    (functionToCall) =>
      isFunctionType(functionToCall.type) &&
      functionToCall.type.return.isCompileTimeOnly // TODO: How about other type calls?
  );
  if (comptFunctionCalls.length === 1) {
    functionsWithMatchingTypes = comptFunctionCalls;
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
        .map((functionsToCall) => {
          const error =
            functionsToCall.result.kind === "error"
              ? functionsToCall.result.error
              : undefined;
          if (error) {
            if (error instanceof YoError) {
              return [
                {
                  token: func.token,
                  errorMessage: `- ${typeToString(functionsToCall.type)}\n`,
                },
                ...error.tokenAndErrorList,
              ];
            } else {
              return {
                token: func.token,
                errorMessage: `- ${typeToString(functionsToCall.type)}\n${error instanceof Error ? error.message : String(error)}`,
              };
            }
          } else {
            return {
              token: func.token,
              errorMessage: `${typeToString(functionsToCall.type)}`,
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
${functionsWithMatchingTypes
  .map((func) => `${typeToString(func.type)}`)
  .join("\n")}
`,
    });
  }

  const functionToCall = functionsWithMatchingTypes[0]!; // Found the only one function to call

  // This function call is for macro expansion.
  // So we just return the expr we expanded.
  if (forMacroExpansion) {
    // It is macro function call
    if (
      isFunctionType(functionToCall.type) &&
      functionToCall.type.return.isUnquote
    ) {
      const {
        returnValue,
        callerEnv,
        pathCollection,
        deferredDropExpressions,
      } = getFunctionCallResult(functionToCall);

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
      } = getFunctionCallResult(functionToCall);

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
    }
    return expr;
  } else if (isClosureType(functionToCall.type)) {
    // Handle closure calls by delegating to the underlying function type
    const closureType = functionToCall.type as ClosureType;
    const {
      returnType,
      returnValue,
      callerEnv,
      pathCollection,
      specializedFunctionValue,
      runtimeArgExprsInOrder,
      deferredDropExpressions,
    } = getFunctionCallResult(functionToCall);

    env = popEnvFrame(callerEnv);

    // Check if it's a macro function call,
    // if yes, then we continue to evaluate the returnValue which should be an Expr value.
    if (closureType.callType.return.isUnquote) {
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
    const value = functionToCall.value;
    // struct value
    if (isTypeValue(value) && isStructType(value.value)) {
      const structType = value.value;
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
      const structValue = memberValues.some((value) => !value)
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
        type: value.type,
        value: value,
        pathCollection: [],
      };
      return expr;
    }
    // enum value
    else if (isTypeValue(value) && isEnumType(value.value)) {
      const enumType = value.value;
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
        type: value.type,
        value: value,
        pathCollection: [],
      };
      return expr;
    }
    // union value
    else if (isTypeValue(value) && isUnionType(value.value)) {
      const unionType = value.value;
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
        type: value.type,
        value: value,
        pathCollection: [],
      };
      return expr;
    }
    // module value
    else if (isTypeValue(value) && isModuleType(value.value)) {
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
        type: value.type,
        value: value,
        pathCollection: [],
      };
      return expr;
    }
    // function value
    else if (isTypeValue(value) && isFunctionType(value.value)) {
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
    else if (isTypeValue(value) && isArrayType(value.value)) {
      // This should already be evaluated by tryToImplementArrayByArrayType
      return expr;
    }
    // compt list type
    else if (isTypeValue(value) && isComptListType(value.value)) {
      // This should already be evaluated by tryToImplementComptListByComptListType
      return expr;
    }
    // closure type
    else if (isTypeValue(value) && isClosureType(value.value)) {
      // This should already be evaluated by tryToImplementClosureByClosureType
      return expr;
    }
    // numeric type conversion (i32, u8, f64, etc.)
    else if (isTypeValue(value) && isConvertibleNumericType(value.value)) {
      // This should already be evaluated by tryToConvertToNumericType
      // The expr has been transformed to __yo_as call if needed
      return expr;
    }
    // array & slice
    else if (
      isArrayType(functionToCall.type) ||
      isSliceType(functionToCall.type)
    ) {
      const { value, index, type, callerEnv } =
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

      expr.$ = {
        env: callerEnv,
        type: type,
        value: value,
        originType: func.$?.originType ?? functionToCall.type, // Array access inherits origin type
        pathCollection: pathCollection,
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
