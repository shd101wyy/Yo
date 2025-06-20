import {
  addVariableToEnv,
  Environment,
  popEnvFrame,
  pushEnvFrame,
} from "../env";
import {
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../expr";
import { Token } from "../token";
import {
  convertComptTypeToRuntimeType,
  createArrayType,
  createEnumType,
  createFunctionType,
  createModuleType,
  createStructType,
  createUnionType,
  createUsizeType,
  EnumVariant,
  getFunctionParameterToken,
  isComptIntType,
  isModuleType,
  isStructType,
  TupleElement,
  typeOfType,
  typeRequiresComptModifier,
  typeToString,
} from "../type-checker";
import { createTypeValue, isTypeValue, isUnknownValue } from "../value";

/**
 * Evaluates function type expressions: (param: Type) -> ReturnType
 */
export function evaluateFunctionType(
  expr: FuncCallExpr,
  env: Environment,
  context: EvaluatorContext,
  formatErrorMessage: (token: Token, message: string) => Error,
  evaluateExpression: (params: {
    expr: Expr;
    env: Environment;
    context: EvaluatorContext;
  }) => Expr,
  evaluateFunctionParameters: (params: {
    parameterExprs: Expr[];
    env: Environment;
    context: EvaluatorContext;
  }) => any
): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, "->", 2)) {
    throw formatErrorMessage(
      expr.token,
      `Expected -> for function type, got:\n${exprToString(expr)}`
    );
  }

  const argListExpr = expr.args[0]!;
  let returnTypeExpr = expr.args[1]!;

  // Handle different forms of parameter lists
  let argList: Expr[] = [];
  if (
    exprIsFunctionCall(argListExpr) &&
    exprIsFunctionCallOf(argListExpr, BuiltinKeywords.tuple)
  ) {
    // Handle tuple-style parameter list: (param1: Type1, param2: Type2)
    argList = argListExpr.args;
  } else {
    argList = [argListExpr];
  }

  // Evaluate the parameter list
  const {
    parameters,
    typeParameters,
    implicitParameters,
    env: nextEnv,
  } = evaluateFunctionParameters({
    parameterExprs: argList,
    env,
    context: {
      ...context,
    },
  });
  env = nextEnv;

  /// Check if the function is returning compile-time only value.
  let isReturnTypeCompileTimeOnly = false;
  if (
    exprIsFunctionCall(returnTypeExpr) &&
    exprIsFunctionCallOf(returnTypeExpr, BuiltinKeywords.compt)
  ) {
    isReturnTypeCompileTimeOnly = true;
    if (returnTypeExpr.args.length !== 1) {
      throw formatErrorMessage(
        returnTypeExpr.token,
        `Expected one argument for "compt" (or "@"), got ${returnTypeExpr.args.length}`
      );
    }
    returnTypeExpr = returnTypeExpr.args[0]!;
  }

  // Evaluate the return type expression
  const evaluatedReturnType = evaluateExpression({
    expr: returnTypeExpr,
    env,
    context: { ...context },
  });

  // Check that the return type is indeed a type
  if (!isTypeValue(evaluatedReturnType.$?.value)) {
    throw formatErrorMessage(
      returnTypeExpr.token,
      `Expected a type for function return type, got:\n${exprToString(
        returnTypeExpr
      )}`
    );
  }

  let returnType = evaluatedReturnType.$?.value.value;
  if (typeRequiresComptModifier(returnType) && !isReturnTypeCompileTimeOnly) {
    // Try converting to runtime type first
    returnType = convertComptTypeToRuntimeType(returnType);
    // If it still requires compt modifier,
    // then throw an error
    if (typeRequiresComptModifier(returnType)) {
      throw formatErrorMessage(
        returnTypeExpr.token,
        `Expected a "compt" (or "@") for return type, like:\n
compt(${exprToString(returnTypeExpr)})

Given type:
${typeToString(returnType)}`
      );
    }
  }

  // If the returnType is compile time only, then
  // we need to make sure all the parameters are compile time only
  if (isReturnTypeCompileTimeOnly) {
    for (const parameter of parameters) {
      if (!parameter.isCompileTimeOnly) {
        throw formatErrorMessage(
          getFunctionParameterToken(parameter),
          `Expected all parameters to be compile time only given the return type is compile time only.`
        );
      }
    }

    // Check if all implicitParameters are compile time only
    for (const parameter of implicitParameters) {
      if (!parameter.isCompileTimeOnly) {
        throw formatErrorMessage(
          getFunctionParameterToken(parameter),
          `Expected all implicit parameters to be compile time only given the return type is compile time only.`
        );
      }
    }
  }

  // Create the function type
  const functionType = createFunctionType({
    parameters,
    typeParameters,
    implicitParameters,
    return_: {
      type: returnType,
      expr: returnTypeExpr,
      isCompileTimeOnly: isReturnTypeCompileTimeOnly,
    },
    env: popEnvFrame(env, true),
    parametersFrame: env.frames[env.frames.length - 1]!,
    SelfType: context.SelfType,
    ModuleType: context.ModuleType,
  });

  // Pop the environment frame
  env = popEnvFrame(env, true);

  // Set the type and value of the expression
  expr.$ = {
    env,
    value: createTypeValue(functionType),
    type: typeOfType(functionType),
    isMutable: false,
    pathCollection: [],
  };
  return expr;
}

export function evaluateStructType(
  expr: FuncCallExpr,
  env: Environment,
  context: EvaluatorContext,
  formatErrorMessage: (token: Token, message: string) => Error,
  evaluateExpression: (params: {
    expr: Expr;
    env: Environment;
    context: EvaluatorContext;
  }) => Expr,
  evaluateTupleElementType: (params: {
    expr: Expr;
    env: Environment;
    tupleElementIndex: number;
    context: EvaluatorContext;
    forType: string;
  }) => { type: TupleElement; env: Environment }
): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.struct)) {
    throw formatErrorMessage(
      expr.token,
      `Expected "struct", got:\n${exprToString(expr)}`
    );
  }

  // Create structType with empty elements
  // This is used as the SelfType for the following evaluations.
  const structType = createStructType([]);
  const elements = structType.elements;

  for (let i = 0; i < expr.args.length; i++) {
    const arg = expr.args[i]!;

    // spread operator for extending another struct
    if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "...", 1)) {
      const extendedStructExpr = arg.args[0]!;
      // Evaluate the extended struct expression
      const evaluatedExtendedStruct = evaluateExpression({
        expr: extendedStructExpr,
        env,
        context: {
          ...context,
          SelfType: structType,
        },
      });
      if (!evaluatedExtendedStruct.$) {
        throw formatErrorMessage(
          extendedStructExpr.token,
          `Failed to evaluate the extended struct expression: ${exprToString(extendedStructExpr)}`
        );
      }

      // Check if it's a struct type
      const extendedStructTypeValue = evaluatedExtendedStruct.$.value;
      if (
        !isTypeValue(extendedStructTypeValue) ||
        !extendedStructTypeValue.value ||
        !isStructType(extendedStructTypeValue.value)
      ) {
        throw formatErrorMessage(
          extendedStructExpr.token,
          `Expected a struct type for extending, got ${exprToString(
            extendedStructExpr
          )}`
        );
      }
      const extendedStructType = extendedStructTypeValue.value;

      // Iterate over the elements of the extended struct
      for (const extendedStructElement of extendedStructType.elements) {
        // Check if there is duplicate labels
        // If yes, then override the element
        const duplicateLabelIndex = elements.findIndex(
          (e) => e.label === extendedStructElement.label
        );
        if (duplicateLabelIndex >= 0) {
          // Override the existing one.
          elements[duplicateLabelIndex] = extendedStructElement;
        } else {
          // Add the element to the struct
          elements.push(extendedStructElement);
        }
      }
    }
    // tuple element
    else {
      const { type, env: nextEnv } = evaluateTupleElementType({
        expr: arg,
        env,
        tupleElementIndex: i,
        context: { ...context, SelfType: structType },
        forType: "struct",
      });

      // Check if there is duplicate labels
      const duplicateLabel = elements.find(
        (element) => element.label === type.label
      );
      if (duplicateLabel) {
        throw formatErrorMessage(
          exprIsFunctionCall(arg)
            ? (arg.args[0]?.token ?? arg.token)
            : arg.token,
          `Duplicate label "${type.label}" in struct`
        );
      }

      elements.push(type);
      env = nextEnv;
    }
  }

  const structTypeValue = createTypeValue(structType);
  expr.$ = {
    env,
    value: structTypeValue,
    type: structTypeValue.type,
    isMutable: false,
    pathCollection: [],
  };

  // Append more information to "struct" token.
  expr.func.$ = expr.$;
  return expr;
}

export function evaluateEnumType(
  expr: FuncCallExpr,
  env: Environment,
  context: EvaluatorContext,
  formatErrorMessage: (token: Token, message: string) => Error,
  evaluateExpression: (params: {
    expr: Expr;
    env: Environment;
    context: EvaluatorContext;
  }) => Expr,
  evaluateTupleElementType: (params: {
    expr: Expr;
    env: Environment;
    tupleElementIndex: number;
    context: EvaluatorContext;
    forType: string;
  }) => { type: TupleElement; env: Environment },
  isValidVariableName: (expr: Expr) => boolean
): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.enum)) {
    throw formatErrorMessage(
      expr.token,
      `Expected "enum", got:\n${exprToString(expr)}`
    );
  }

  // Create enumType with empty elements
  const enumType = createEnumType([], []);

  const comptElements: TupleElement[] = [];
  const variants: EnumVariant[] = [];
  enumType.elements = comptElements;
  enumType.variants = variants;

  const args = expr.args;
  for (let i = 0; i < args.length; i++) {
    const enumArg = args[i]!;

    // enum field that is not a variant
    if (
      exprIsFunctionCall(enumArg) &&
      (exprIsFunctionCallOf(enumArg, "::", 2) ||
        exprIsFunctionCallOf(enumArg, "=", 2) ||
        exprIsFunctionCallOf(enumArg, "?=", 2))
    ) {
      const arg = enumArg;
      const { type, env: nextEnv } = evaluateTupleElementType({
        expr: arg,
        env,
        tupleElementIndex: i,
        context: { ...context, SelfType: enumType },
        forType: "enum",
      });

      // Check if there is duplicate labels
      const duplicateLabel = comptElements.find(
        (element) => element.label === type.label
      );
      if (duplicateLabel) {
        throw formatErrorMessage(
          exprIsFunctionCall(arg)
            ? (arg.args[0]?.token ?? arg.token)
            : arg.token,
          `Duplicate label "${type.label}" in enum`
        );
      }

      // Compile-time field must have an assigned value
      if (type.isCompileTimeOnly && !type.assignedValue) {
        throw formatErrorMessage(
          type.exprs.expr.token,
          `Compile-time only field "${type.label}" must have an assigned value.`
        );
      }

      // Disallow to have the default value for enum type fields.
      if (type.defaultValue) {
        throw formatErrorMessage(
          type.exprs.defaultValueExpr?.token ?? type.exprs.expr.token,
          `Union type cannot have default value for its elements.`
        );
      }

      comptElements.push(type);
      env = nextEnv;
    }

    // Enum variant
    else {
      if (exprIsAtom(enumArg)) {
        const variantName = enumArg.token.value;
        if (!isValidVariableName(enumArg)) {
          throw formatErrorMessage(
            enumArg.token,
            `Expected identifier for enum variant, got:\n${exprToString(
              enumArg
            )}`
          );
        }
        variants.push({
          name: variantName,
        });

        // TODO: Check duplicates
      } else {
        if (exprIsFunctionCallOf(enumArg, ":")) {
          throw formatErrorMessage(
            enumArg.token,
            `Use "->" instead of ":" for enum variant with payload`
          );
        }

        if (exprIsFunctionCallOf(enumArg, "->", 2)) {
          const variantNameExpr = enumArg.args[0]!;
          const variantPayloadExpr = enumArg.args[1]!;

          if (!exprIsAtom(variantNameExpr)) {
            throw formatErrorMessage(
              variantNameExpr.token,
              `Expected identifier for enum variant name, got:\n${exprToString(
                variantNameExpr
              )}`
            );
          }

          const variantName = variantNameExpr.token.value;
          if (!isValidVariableName(variantNameExpr)) {
            throw formatErrorMessage(
              variantNameExpr.token,
              `Expected identifier for enum variant, got:\n${exprToString(
                variantNameExpr
              )}`
            );
          }

          // Evaluate the payload type
          const evaluatedPayloadType = evaluateExpression({
            expr: variantPayloadExpr,
            env,
            context: { ...context, SelfType: enumType },
          });

          if (!evaluatedPayloadType.$) {
            throw formatErrorMessage(
              variantPayloadExpr.token,
              `Failed to evaluate enum variant payload type: ${exprToString(
                variantPayloadExpr
              )}`
            );
          }

          if (!isTypeValue(evaluatedPayloadType.$.value)) {
            throw formatErrorMessage(
              variantPayloadExpr.token,
              `Expected type for enum variant payload, got:\n${exprToString(
                variantPayloadExpr
              )}`
            );
          }

          const payloadType = evaluatedPayloadType.$.value.value;
          variants.push({
            name: variantName,
            payloadType,
          });

          // TODO: Check duplicates
        } else {
          throw formatErrorMessage(
            enumArg.token,
            `Expected enum variant or enum field, got:\n${exprToString(
              enumArg
            )}`
          );
        }
      }
    }
  }

  const enumTypeValue = createTypeValue(enumType);
  expr.$ = {
    env,
    value: enumTypeValue,
    type: enumTypeValue.type,
    isMutable: false,
    pathCollection: [],
  };

  // Append more information to "enum" token.
  expr.func.$ = expr.$;
  return expr;
}

export function evaluateUnionType(
  expr: FuncCallExpr,
  env: Environment,
  context: EvaluatorContext,
  formatErrorMessage: (token: Token, message: string) => Error,
  evaluateTupleElementType: (params: {
    expr: Expr;
    env: Environment;
    tupleElementIndex: number;
    context: EvaluatorContext;
    forType: string;
  }) => { type: TupleElement; env: Environment }
): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.union)) {
    throw formatErrorMessage(
      expr.token,
      `Expected "union", got:\n${exprToString(expr)}`
    );
  }

  // Create unionType with empty elements
  const unionType = createUnionType([]);

  const elements: TupleElement[] = [];
  unionType.elements = elements;

  const args = expr.args;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    const { type, env: nextEnv } = evaluateTupleElementType({
      expr: arg,
      env,
      tupleElementIndex: i,
      context: { ...context, SelfType: unionType },
      forType: "union",
    });

    // Check if there is duplicate labels
    const duplicateLabel = elements.find(
      (element) => element.label === type.label
    );
    if (duplicateLabel) {
      throw formatErrorMessage(
        exprIsFunctionCall(arg) ? (arg.args[0]?.token ?? arg.token) : arg.token,
        `Duplicate label "${type.label}" in tuple`
      );
    }

    // Compile-time field must have an assigned value
    if (type.isCompileTimeOnly && !type.assignedValue) {
      throw formatErrorMessage(
        type.exprs.expr.token,
        `Compile-time only field "${type.label}" must have an assigned value.`
      );
    }

    // Disallow to have the default value for union type fields.
    if (type.defaultValue) {
      throw formatErrorMessage(
        type.exprs.defaultValueExpr?.token ?? type.exprs.expr.token,
        `Union type cannot have default value for its elements.`
      );
    }

    elements.push(type);
    env = nextEnv;
  }

  const unionTypeValue = createTypeValue(unionType);
  expr.$ = {
    env,
    value: unionTypeValue,
    type: unionTypeValue.type,
    isMutable: false,
    pathCollection: [],
  };

  // Append more information to "union" token.
  expr.func.$ = expr.$;
  return expr;
}

export function evaluateModuleType(
  expr: FuncCallExpr,
  env: Environment,
  context: EvaluatorContext,
  formatErrorMessage: (token: Token, message: string) => Error,
  evaluateExpression: (params: {
    expr: Expr;
    env: Environment;
    context: EvaluatorContext;
  }) => Expr,
  evaluateModuleElementType: (params: {
    expr: Expr;
    env: Environment;
    tupleElementIndex: number;
    context: EvaluatorContext;
  }) => { type: TupleElement; env: Environment }
): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.module)) {
    throw formatErrorMessage(
      expr.token,
      `Expected "module", got:\n${exprToString(expr)}`
    );
  }

  // Create moduleType with empty elements
  const moduleType = createModuleType([], env);
  const elements: TupleElement[] = [];
  moduleType.elements = elements;

  // Push env frame
  env = pushEnvFrame(env);

  const args = expr.args;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    // NOTE: Type methods are not allowed in module types.
    // spread operator for extending another module
    if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "...", 1)) {
      const extendedStructExpr = arg.args[0]!;
      // Evaluate the extended struct expression
      const evaluatedExtendedModuleExpr = evaluateExpression({
        expr: extendedStructExpr,
        env,
        context: {
          ...context,
          SelfType: undefined, // No SelfType in module context
          ModuleType: moduleType,
        },
      });
      if (!evaluatedExtendedModuleExpr.$) {
        throw formatErrorMessage(
          extendedStructExpr.token,
          `Failed to evaluate the extended struct expression: ${exprToString(extendedStructExpr)}`
        );
      }

      // Check if it's a module type
      const extendedModuleTypeValue = evaluatedExtendedModuleExpr.$.value;
      if (
        !isTypeValue(extendedModuleTypeValue) ||
        !extendedModuleTypeValue.value ||
        !isModuleType(extendedModuleTypeValue.value)
      ) {
        throw formatErrorMessage(
          extendedStructExpr.token,
          `Expected a struct type for extending, got ${exprToString(
            extendedStructExpr
          )}`
        );
      }
      const extendedModuleType = extendedModuleTypeValue.value;

      // Iterate over the elements of the extended struct
      for (const extendedModuleElement of extendedModuleType.elements) {
        // Check if there is duplicate labels
        // If yes, then throw an error
        const duplicateLabelIndex = elements.findIndex(
          (e) => e.label === extendedModuleElement.label
        );
        if (duplicateLabelIndex >= 0) {
          throw formatErrorMessage(
            extendedStructExpr.token,
            `Duplicate label "${extendedModuleElement.label}" in module`
          );
        } else {
          // Add the element to the struct
          elements.push(extendedModuleElement);

          // Add the element to the environment
          const { env: nextEnv } = addVariableToEnv({
            env,
            variable: {
              name: extendedModuleElement.label,
              type: extendedModuleElement.type,
              value: extendedModuleElement.isCompileTimeOnly
                ? (extendedModuleElement.assignedValue ??
                  createUnknownValue(
                    extendedModuleElement.type,
                    extendedModuleElement.label
                  ))
                : undefined,
              isCompileTimeOnly: extendedModuleElement.isCompileTimeOnly,
              isImplicit: extendedModuleElement.isImplicit,
              isMutable: false,
              isUndefined: false,
              token: extendedModuleElement.exprs.expr.token,
            },
          });
          env = nextEnv;
        }
      }
    }
    // tuple element
    else {
      const { type: element, env: nextEnv } = evaluateModuleElementType({
        expr: arg,
        env,
        tupleElementIndex: i,
        context: {
          ...context,
          SelfType: undefined, // No SelfType in module context
          ModuleType: moduleType,
        },
      });

      // Check if there is duplicate labels
      const duplicateLabel = elements.find(
        (elem) => elem.label === element.label
      );
      if (duplicateLabel) {
        throw formatErrorMessage(
          exprIsFunctionCall(arg)
            ? (arg.args[0]?.token ?? arg.token)
            : arg.token,
          `Duplicate label "${element.label}" in module`
        );
      }

      elements.push(element);
      env = nextEnv;

      // Expect element to be compile-time only
      if (!element.isCompileTimeOnly) {
        throw formatErrorMessage(
          arg.token,
          `Expected compile-time only element in module. All module elements are compile-time only by default.`
        );
      }
    }
  }

  env = popEnvFrame(env);

  const moduleTypeValue = createTypeValue(moduleType);
  expr.$ = {
    env,
    value: moduleTypeValue,
    type: moduleTypeValue.type,
    isMutable: false,
    pathCollection: [],
  };

  // Append more information to "module" token.
  expr.func.$ = expr.$;
  return expr;
}

export function evaluateArrayType(
  expr: FuncCallExpr,
  env: Environment,
  context: EvaluatorContext,
  formatErrorMessage: (token: Token, message: string) => Error,
  evaluateExpression: (params: {
    expr: Expr;
    env: Environment;
    context: EvaluatorContext;
  }) => Expr
): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.Array, 2)) {
    throw formatErrorMessage(
      expr.token,
      `Expected "Array(@(Type), @(usize))" with 2 arguments, like "Array(i32, 10)"
Got:\n${exprToString(expr)}`
    );
  }

  const elementTypeExpr = expr.args[0]!;
  const lengthExpr = expr.args[1]!;

  // Evaluate the element type expression
  const evaluatedElementTypeExpr = evaluateExpression({
    expr: elementTypeExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedElementTypeExpr.$) {
    throw formatErrorMessage(
      elementTypeExpr.token,
      `Failed to evaluate the element type expression:\n${exprToString(
        elementTypeExpr
      )}`
    );
  }
  if (!isTypeValue(evaluatedElementTypeExpr.$.value)) {
    throw formatErrorMessage(
      elementTypeExpr.token,
      `Expected type for element type, got:\n${exprToString(elementTypeExpr)}`
    );
  }
  const elementType = evaluatedElementTypeExpr.$.value.value;

  // Evaluate the length expression
  const evaluatedLengthExpr = evaluateExpression({
    expr: lengthExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedLengthExpr.$) {
    throw formatErrorMessage(
      lengthExpr.token,
      `Failed to evaluate the length expression:\n${exprToString(lengthExpr)}`
    );
  }

  let lengthValue = evaluatedLengthExpr.$.value;
  if (!lengthValue) {
    throw formatErrorMessage(
      lengthExpr.token,
      `Expected compile-time known value for array length, got:\n${exprToString(
        lengthExpr
      )}`
    );
  }

  // Check if the length is a number
  if (
    lengthValue.tag !== ValueTag.Number &&
    !isComptIntType(lengthValue.type)
  ) {
    throw formatErrorMessage(
      lengthExpr.token,
      `Expected a number for array length, got:\n${exprToString(lengthExpr)}`
    );
  }

  if (isUnknownValue(lengthValue)) {
    // QUESTION: Should we do it this way?
    // Change its type to usize
    lengthValue.type = createUsizeType();
  }

  const arrayType = createArrayType(elementType, lengthValue);
  const arrayValue = createTypeValue(arrayType);

  expr.$ = {
    env: evaluatedLengthExpr.$.env,
    type: arrayValue.type,
    value: arrayValue,
    isMutable: false,
    pathCollection: [],
  };
  return expr;
}
