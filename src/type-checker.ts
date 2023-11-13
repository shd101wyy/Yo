// Types

import { AstType, Expr, FunctionPrototype } from "./ast";
import {
  Environment,
  ValueType,
  addEnvValueType,
  getEnvValueTypesByVariableName,
  getEnvVariableId,
  popEnvFrame,
  pushEnvFrame,
} from "./env";
import { formatErrorMessage } from "./error";
import { Token, TokenType } from "./token";

export type TUnit = {
  type: "()";
};

export type TBoolean = {
  type: "boolean";
};

export type TChar = {
  type: "char";
};

export type TU1 = {
  type: "u1";
};

export type TI1 = {
  type: "i1";
};

export type TU8 = {
  type: "u8";
};

export type TI8 = {
  type: "i8";
};

export type TU16 = {
  type: "u16";
};

export type TI16 = {
  type: "i16";
};

export type TU32 = {
  type: "u32";
};

export type TI32 = {
  type: "i32";
};

export type TU64 = {
  type: "u64";
};

export type TI64 = {
  type: "i64";
};

export type TU128 = {
  type: "u128";
};

export type TI128 = {
  type: "i128";
};

export type TF16 = {
  type: "f16";
};

export type TF32 = {
  type: "f32";
};

export type TF64 = {
  type: "f64";
};

// @"symbol"
export type TSymbol = {
  type: "symbol";
};

export type TPrimitive = (
  | TUnit
  | TBoolean
  | TChar
  | TU1
  | TI1
  | TU8
  | TI8
  | TU16
  | TI16
  | TU32
  | TI32
  | TU64
  | TI64
  | TU128
  | TI128
  | TF16
  | TF32
  | TF64
  | TSymbol
) & { tag: "primitive"; value: string };

export type TRecord = {
  type: "Record";
  properties: { name: string; type: Type }[];
};

export type TParameterType = {
  name: string;
  type: Type;
  defaultValue: Expr | null;
};

export type TTypeParameter = {
  type: "TypeParameter";
  name: string;
  typeValue: Type;
  defaultTypeValue: Type | null;
};

export type TFunction = {
  type: "Function";
  id: string;
  typeParameters: Type[]; // FIXME: Remove this
  parameterTypes: TParameterType[];
  returnType: Type;

  /**
   * Right now only ()=>{} is closure
   * function name(a: number) {} is not closure
   * if `freeVariables` is set to `undefined`, then it means it's not a closure
   */
  freeVariables?: ValueType[];
};

export type TUnion = {
  type: "Union";
  types: Type[];
};

export type TIntersection = {
  type: "Intersection";
  types: Type[];
};

export type TUnknown = {
  type: "unknown";
  typeArguments?: Type[];
  typeName?: string; // FIXME: This might be a expression in the future
};

export type TSlice = {
  type: "slice";
  elementType: Type;
  size?: number;
};

/*
export type TTuple = {
  type: "tuple";
  elements: Type[];
};
*/

export type TTypeConstructor = {
  type: "TypeConstructor";
  typeParameters: TTypeParameter[];
  typeValue: Type;
};

export type TInterfaceFunction = {
  name: string;
  func: TFunction;
};

export type TInterface = {
  type: "Interface";
  typeParameters: TTypeParameter[];
  functions: TInterfaceFunction[];
};

/*
export type TDataConstructor = {
  type: "DataConstructor";
  name: string;
  parameterTypes: TParameterType[];
  typeValue: Type;
};
*/

export type Type =
  | TUnit
  | TBoolean
  | TChar
  | TU1
  | TU8
  | TU16
  | TU32
  | TU64
  | TU128
  | TI1
  | TI8
  | TI16
  | TI32
  | TI64
  | TI128
  | TF16
  | TF32
  | TF64
  | TSymbol
  | TRecord
  | TFunction
  | TUnion
  | TIntersection
  | TUnknown
  | TSlice
  //  | TTuple
  | TTypeConstructor
  | TTypeParameter
  | TInterface
  | TPrimitive;

// Type constructors

export const TypeValues = {
  unit: { type: "()" } as TUnit,
  boolean: { type: "boolean" } as TBoolean,
  char: { type: "char" } as TChar,
  u1: { type: "u1" } as TU1,
  u8: { type: "u8" } as TU8,
  u16: { type: "u16" } as TU16,
  u32: { type: "u32" } as TU32,
  u64: { type: "u64" } as TU64,
  u128: { type: "u128" } as TU128,
  i1: { type: "i1" } as TI1,
  i8: { type: "i8" } as TI8,
  i16: { type: "i16" } as TI16,
  i32: { type: "i32" } as TI32,
  i64: { type: "i64" } as TI64,
  i128: { type: "i128" } as TI128,
  f16: { type: "f16" } as TF16,
  f32: { type: "f32" } as TF32,
  f64: { type: "f64" } as TF64,
  unknown: { type: "unknown" } as TUnknown,
};

export type ParserReturn = {
  expr: Expr;
  index: number;
  env: Environment;
};

type ParseExpression = (
  tokens: Token[],
  index: number,
  env: Environment
) => ParserReturn;

export function isSignedIntegerType(type: Type): boolean {
  return (
    type.type === "i1" ||
    type.type === "i8" ||
    type.type === "i16" ||
    type.type === "i32" ||
    type.type === "i64" ||
    type.type === "i128"
  );
}

export function isUnsignedIntegerType(type: Type): boolean {
  return (
    type.type === "u1" ||
    type.type === "u8" ||
    type.type === "u16" ||
    type.type === "u32" ||
    type.type === "u64" ||
    type.type === "u128"
  );
}

export function convertPrimitiveToType(primitive: Type): Type {
  if ("tag" in primitive && primitive.tag === "primitive") {
    const t = primitive.type;
    const type: Type = {
      type: t,
    } as Type;
    return type;
  } else {
    return primitive;
  }
}

export function isFloatType(type: Type): boolean {
  return type.type === "f16" || type.type === "f32" || type.type === "f64";
}

export type VariableTypes = { [key: string]: Type };

export function synthesizeTypeFromTokens({
  tokens,
  index,
  inputString,
  env,
  parseExpression,
}: {
  tokens: Token[];
  index: number;
  inputString: string;
  env: Environment;
  parseExpression: ParseExpression;
}): { typeValue: Type; index: number; env: Environment } {
  let returnValue: {
    typeValue: Type;
    index: number;
    env: Environment;
  } | null = null;

  if (tokens[index].type === TokenType.BitwiseOr) {
    return synthesizeTypeFromTokens({
      tokens,
      index: index + 1,
      inputString,
      env,
      parseExpression,
    });
  }

  // Check if it's unit
  if (tokens[index].value === "(" && tokens[index + 1].value === ")") {
    index = index + 1;
    returnValue = {
      typeValue: TypeValues.unit,
      index: index + 1,
      env,
    };
  }
  // Check if it's tuple
  /*
  if (tokens[index].value === TokenType.LBracket) {
    const typeValue: TTuple = {
      type: "tuple",
      elements: [],
    };
    index = index + 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const token = tokens[index];
      if (!token) {
        throw formatErrorMessage({
          token: tokens[index - 1],
          errorMessage: "Expected ']'",
          inputString,
        });
      }
      if (token.type === TokenType.RBracket) {
        index = index + 1;
        break;
      }
      const {
        typeValue: elementType,
        index: nextIndex,
        env: nextEnv,
      } = synthesizeTypeFromTokens({
        tokens,
        index,
        inputString,
        env,
        parseExpression,
      });
      typeValue.elements.push(elementType);
      index = nextIndex;
      env = nextEnv;

      if (tokens[index].type === TokenType.Comma) {
        index = index + 1;
      }
    }
    returnValue = {
      typeValue: typeValue,
      index: index,
      env,
    };
  }
  */
  // Check if it's anonymouse function
  else if (tokens[index].value === "(") {
    try {
      returnValue = synthesizeFunctionTypeFromTokens({
        tokens,
        index,
        inputString,
        env,
        parseExpression,
        withFunctionBody: false,
      });
    } catch {
      // This means it's not a function type
      const {
        typeValue,
        index: nextIndex,
        env: nextEnv,
      } = synthesizeTypeFromTokens({
        tokens,
        index: index + 1,
        inputString,
        env,
        parseExpression,
      });
      env = nextEnv;

      // Check if ')' is there
      if (tokens[nextIndex].value === ")") {
        returnValue = {
          typeValue: typeValue,
          index: nextIndex + 1,
          env,
        };
      } else {
        throw formatErrorMessage({
          token: tokens[nextIndex],
          errorMessage: "Expected ')'",
          inputString,
        });
      }
    }
  }
  // Check if it's defined in variableTypes
  else if (
    getEnvValueTypesByVariableName(env, tokens[index].value, "type").length > 0
  ) {
    const valueTypes = getEnvValueTypesByVariableName(
      env,
      tokens[index].value,
      "type"
    );
    returnValue = {
      typeValue: valueTypes[valueTypes.length - 1].type,
      index: index + 1,
      env,
    };
  }
  // Check the record type
  else if (tokens[index].type === TokenType.LCurlyBracket) {
    const typeValue: TRecord = {
      type: "Record",
      properties: [],
    };
    index = index + 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const token = tokens[index];
      if (!token) {
        throw formatErrorMessage({
          token: tokens[index - 1],
          errorMessage: "Expected '}'",
          inputString,
        });
      }
      if (token.type === TokenType.RCurlyBracket) {
        index = index + 1;
        break;
      }
      if (token.type === TokenType.Identifier) {
        const name = token.value;
        if (tokens[index + 1].type === TokenType.Colon) {
          index = index + 2;
          const {
            typeValue: type,
            index: nextIndex,
            env: nextEnv,
          } = synthesizeTypeFromTokens({
            tokens,
            index,
            inputString,
            env,
            parseExpression,
          });
          typeValue.properties.push({ name, type });
          index = nextIndex;
          env = nextEnv;

          if (tokens[index].type === TokenType.Comma) {
            index = index + 1;
          }
        } else {
          throw formatErrorMessage({
            token,
            errorMessage: "Expected ':'",
            inputString,
          });
        }
      } else {
        throw formatErrorMessage({
          token,
          errorMessage: "Expected identifier",
          inputString,
        });
      }
    }
    returnValue = {
      typeValue: typeValue,
      index: index,
      env,
    };
  } else {
    let typeValue: Type;
    switch (tokens[index].value) {
      case "boolean": {
        typeValue = TypeValues.boolean;
        break;
      }
      case "char": {
        typeValue = TypeValues.char;
        break;
      }
      case "u1": {
        typeValue = TypeValues.u1;
        break;
      }
      case "u8": {
        typeValue = TypeValues.u8;
        break;
      }
      case "u16": {
        typeValue = TypeValues.u16;
        break;
      }
      case "u32": {
        typeValue = TypeValues.u32;
        break;
      }
      case "u64": {
        typeValue = TypeValues.u64;
        break;
      }
      case "u128": {
        typeValue = TypeValues.u128;
        break;
      }
      case "i1": {
        typeValue = TypeValues.i1;
        break;
      }
      case "i8": {
        typeValue = TypeValues.i8;
        break;
      }
      case "i16": {
        typeValue = TypeValues.i16;
        break;
      }
      case "i32": {
        typeValue = TypeValues.i32;
        break;
      }
      case "i64": {
        typeValue = TypeValues.i64;
        break;
      }
      case "i128": {
        typeValue = TypeValues.i128;
        break;
      }
      case "f16": {
        typeValue = TypeValues.f16;
        break;
      }
      case "f32": {
        typeValue = TypeValues.f32;
        break;
      }
      case "f64": {
        typeValue = TypeValues.f64;
        break;
      }
      case "symbol": {
        typeValue = { type: "symbol" };
        break;
      }
      default: {
        // Check if it's a real value
        const {
          expr,
          index: nextIndex,
          env: nextEnv,
        } = parseExpression(tokens, index, env);
        env = nextEnv;
        if (!expr || expr.type !== AstType.Value || expr.tag !== "primitive") {
          throw formatErrorMessage({
            token: tokens[index],
            errorMessage: `Unknown type ${tokens[index].value}`,
            inputString,
          });
        }

        typeValue = expr.typeValue;
        index = nextIndex - 1;
      }
    }
    returnValue = {
      typeValue: typeValue,
      index: index + 1,
      env,
    };
  }

  const nextTokenType = tokens[returnValue.index]?.type;
  let newTypeValue: Type = returnValue.typeValue;
  // Check if it's slice
  if (nextTokenType === TokenType.LBracket) {
    let index = returnValue.index + 1;
    // TODO: We only support number as size for now
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const token = tokens[index];
      if (!token) {
        throw formatErrorMessage({
          token: tokens[index - 1],
          errorMessage: "Expected ']'",
          inputString,
        });
      }
      if (token.type === TokenType.Integer) {
        const size = parseInt(token.value);
        if (tokens[index + 1].type !== TokenType.RBracket) {
          throw formatErrorMessage({
            token: tokens[index + 1],
            errorMessage: "Expected ']'",
            inputString,
          });
        } else {
          newTypeValue = {
            type: "slice",
            elementType: newTypeValue,
            size,
          };
          index = index + 2;
        }
      } else if (token.type === TokenType.RBracket) {
        newTypeValue = {
          type: "slice",
          elementType: newTypeValue,
          size: undefined,
        };
        index = index + 1;
      } else {
        throw formatErrorMessage({
          token,
          errorMessage: "Expected integer or ']'",
          inputString,
        });
      }

      if (tokens[index].type === TokenType.LBracket) {
        index = index + 1;
        continue;
      } else {
        break;
      }
    }
    returnValue = {
      typeValue: newTypeValue,
      index,
      env,
    };
  }
  // Check if it's union type or intersection type
  else if (nextTokenType === TokenType.BitwiseOr) {
    const index = returnValue.index + 1;

    const newReturnValue = synthesizeTypeFromTokens({
      tokens,
      index,
      inputString,
      env,
      parseExpression,
    });
    if (newReturnValue.typeValue.type === "Union") {
      returnValue = {
        typeValue: {
          type: "Union",
          types: [returnValue.typeValue, ...newReturnValue.typeValue.types],
        },
        index: newReturnValue.index,
        env: newReturnValue.env,
      };
    } else {
      // Check types
      if (returnValue.typeValue.type !== newReturnValue.typeValue.type) {
        throw formatErrorMessage({
          token: tokens[index],
          errorMessage: `Cannot union types: 
${returnValue.typeValue.type}: ${typeToString(returnValue.typeValue)}
${newReturnValue.typeValue.type}: ${typeToString(newReturnValue.typeValue)}`,
          inputString,
        });
      }

      returnValue = {
        typeValue: {
          type: "Union",
          types: [returnValue.typeValue, newReturnValue.typeValue],
        },
        index: newReturnValue.index,
        env: newReturnValue.env,
      };
    }
  } else if (nextTokenType === TokenType.BitwiseAnd) {
    const index = returnValue.index + 1;

    const newReturnValue = synthesizeTypeFromTokens({
      tokens,
      index,
      inputString,
      env,
      parseExpression,
    });
    if (newReturnValue.typeValue.type === "Intersection") {
      returnValue = {
        typeValue: {
          type: "Intersection",
          types: [returnValue.typeValue, ...newReturnValue.typeValue.types],
        },
        index: newReturnValue.index,
        env: newReturnValue.env,
      };
    } else {
      // Check types
      if (returnValue.typeValue.type !== newReturnValue.typeValue.type) {
        throw formatErrorMessage({
          token: tokens[index],
          errorMessage: `Cannot intersect types:
${returnValue.typeValue.type}: ${typeToString(returnValue.typeValue)}
${newReturnValue.typeValue.type}: ${typeToString(newReturnValue.typeValue)}`,
          inputString,
        });
      }

      returnValue = {
        typeValue: {
          type: "Intersection",
          types: [returnValue.typeValue, newReturnValue.typeValue],
        },
        index: newReturnValue.index,
        env: newReturnValue.env,
      };
    }
  }
  // Type arguments
  let typeArguments: Type[] = [];
  if (tokens[returnValue.index]?.type === TokenType.LessThan) {
    const {
      env: nextEnv,
      index: nextIndex,
      typeArguments: nextTypeArguments,
    } = synthesizeTypeArgumentsFromTokens({
      env: returnValue.env,
      index: returnValue.index,
      inputString,
      parseExpression,
      tokens,
    });
    env = nextEnv;
    index = nextIndex;
    typeArguments = nextTypeArguments;
  } else {
    env = returnValue.env;
    index = returnValue.index;
  }

  const typeValue = returnValue.typeValue;
  if (typeValue.type === "TypeConstructor") {
    const typeParameters = typeValue.typeParameters;
    if (typeParameters.length !== typeArguments.length) {
      throw formatErrorMessage({
        token: tokens[returnValue.index],
        errorMessage: `Mismatched type arguments.
Expected: <${typeParameters
          .map(
            (typeParameter) =>
              `${typeParameter.name}: ${typeToString(typeParameter.typeValue)}`
          )
          .join(", ")}>
Got:      <${typeArguments.map(typeToString).join(", ")}>`,
        inputString,
      });
    } else {
      returnValue.index = index;
      returnValue.env = env;
      const typeValue_ = applyTypeArgumentsToType(typeValue, typeArguments);
      returnValue.typeValue = typeValue_;
    }
  } else if (typeValue.type === "unknown") {
    returnValue.index = index;
    returnValue.env = env;
    returnValue.typeValue = {
      ...typeValue,
      typeArguments,
    };
  } else if (typeValue.type === "Interface") {
    if (typeValue.typeParameters.length !== typeArguments.length) {
      throw formatErrorMessage({
        token: tokens[returnValue.index],
        errorMessage: `Mismatched type arguments.
Expected: <${typeValue.typeParameters
          .map(
            (typeParameter) =>
              `${typeParameter.name}: ${typeToString(typeParameter.typeValue)}`
          )
          .join(", ")}>
Got:      <${typeArguments.map(typeToString).join(", ")}>`,
        inputString,
      });
    } else {
      returnValue.index = index;
      returnValue.env = env;
      const typeValue_ = applyTypeArgumentsToType(typeValue, typeArguments);
      returnValue.typeValue = typeValue_;
    }
  } else if (typeArguments.length !== 0) {
    throw formatErrorMessage({
      token: tokens[returnValue.index],
      errorMessage: `Cannot apply type arguments to ${typeToString(typeValue)}`,
      inputString,
    });
  }

  return returnValue;
}

export function applyTypeArgumentsToType(
  type: Type,
  typeArguments: Type[],
  typeParameterToTypeArgumentMap: { [key: string]: Type } = {}
): Type {
  if (type.type === "TypeConstructor") {
    const typeValue = type.typeValue;
    if (type.typeParameters.length !== typeArguments.length) {
      throw new Error(
        `Mismatched type arguments.
  Expected: <${type.typeParameters
    .map(
      (typeParameter) =>
        `${typeParameter.name}: ${typeToString(typeParameter.typeValue)}`
    )
    .join(", ")}>
  Got:      <${typeArguments.map(typeToString).join(", ")}>`
      );
    }
    // set typeParameterToTypeArgumentMap
    for (let i = 0; i < type.typeParameters.length; i++) {
      const typeParameter = type.typeParameters[i];
      const typeArgument = typeArguments[i];
      typeParameterToTypeArgumentMap[typeParameter.name] = typeArgument;
    }

    return applyTypeArgumentsToType(
      typeValue,
      typeArguments,
      typeParameterToTypeArgumentMap
    );
  } else if (type.type === "Interface") {
    if (type.typeParameters.length !== typeArguments.length) {
      throw new Error(
        `Mismatched type arguments.
  Expected: <${type.typeParameters
    .map(
      (typeParameter) =>
        `${typeParameter.name}: ${typeToString(typeParameter.typeValue)}`
    )
    .join(", ")}>
  Got:      <${typeArguments.map(typeToString).join(", ")}>`
      );
    }
    // set typeParameterToTypeArgumentMap
    for (let i = 0; i < type.typeParameters.length; i++) {
      const typeParameter = type.typeParameters[i];
      const typeArgument = typeArguments[i];
      typeParameterToTypeArgumentMap[typeParameter.name] = typeArgument;
    }

    // apply to each of the functions
    const functions: TInterfaceFunction[] = type.functions.map(
      ({ name, func }) => ({
        name,
        func: applyTypeArgumentsToType(
          func,
          typeArguments,
          typeParameterToTypeArgumentMap
        ),
      })
    ) as TInterfaceFunction[];

    return {
      type: "Interface",
      typeParameters: type.typeParameters,
      functions: functions,
    };
  } else {
    switch (type.type) {
      case "TypeParameter": {
        const typeArgument = typeParameterToTypeArgumentMap[type.name];
        if (typeArgument) {
          return typeArgument;
        } else {
          /*
          throw new Error(
            `Cannot find type argument for type parameter ${type.name}`
          );*/
          return type;
        }
      }
      case "Record": {
        return {
          ...type,
          properties: type.properties.map(({ name, type }) => ({
            name,
            type: applyTypeArgumentsToType(
              type,
              typeArguments,
              typeParameterToTypeArgumentMap
            ),
          })),
        };
      }
      case "Function": {
        return {
          ...type,
          parameterTypes: type.parameterTypes.map(
            ({ name, type, defaultValue }) => ({
              name,
              type: applyTypeArgumentsToType(
                type,
                typeArguments,
                typeParameterToTypeArgumentMap
              ),
              defaultValue,
            })
          ),
          returnType: applyTypeArgumentsToType(
            type.returnType,
            typeArguments,
            typeParameterToTypeArgumentMap
          ),
        };
      }
      case "Union": {
        return {
          ...type,
          types: type.types.map((type) =>
            applyTypeArgumentsToType(
              type,
              typeArguments,
              typeParameterToTypeArgumentMap
            )
          ),
        };
      }
      case "Intersection": {
        return {
          ...type,
          types: type.types.map((type) =>
            applyTypeArgumentsToType(
              type,
              typeArguments,
              typeParameterToTypeArgumentMap
            )
          ),
        };
      }
      case "slice": {
        return {
          ...type,
          elementType: applyTypeArgumentsToType(
            type.elementType,
            typeArguments,
            typeParameterToTypeArgumentMap
          ),
        };
      }
      case "unknown": {
        return {
          ...type,
          typeArguments: type.typeArguments
            ? type.typeArguments.map((typeArgument) =>
                applyTypeArgumentsToType(
                  typeArgument,
                  typeArguments,
                  typeParameterToTypeArgumentMap
                )
              )
            : undefined,
        };
      }
      default:
        return type;
    }
  }
}

/**
 * Synthesize parameter types (aka row types)
 */
export function synthesizeFunctionParameterTypesFromTokens({
  tokens,
  index,
  inputString,
  env,
  parseExpression,
  withFunctionBody,
}: {
  tokens: Token[];
  index: number;
  inputString: string;
  env: Environment;
  parseExpression: ParseExpression;
  withFunctionBody: boolean;
}): { parameterTypes: TParameterType[]; index: number; env: Environment } {
  if (tokens[index].type !== TokenType.LParen) {
    throw formatErrorMessage({
      token: tokens[index],
      errorMessage: "Expected '(' in row types declaration",
      inputString,
    });
  }

  if (!withFunctionBody) {
    env = pushEnvFrame(env);
  }

  // Read the list of parameter names.
  index = index + 1;
  const parameterTypes: TParameterType[] = [];
  const parameterDefaultValues: (Expr | null)[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const token = tokens[index];
    if (!token) {
      throw formatErrorMessage({
        token: tokens[index - 1],
        errorMessage: "Expected ')'",
        inputString,
      });
    }
    if (token.type === TokenType.Comma) {
      index = index + 1;
      continue;
    }
    if (token.type === TokenType.RParen) {
      index = index + 1;
      break;
    }

    // TODO: There might be the case that only the type is specified or pattern matching
    if (token.type !== TokenType.Identifier) {
      throw formatErrorMessage({
        token,
        errorMessage: "Expected identifier as parameter name",
        inputString,
      });
    }
    const parameterName = token.value;

    // check type
    let userDefinedParamterType: Type = TypeValues.unknown;
    if (tokens[index + 1].type !== TokenType.Colon) {
      index = index + 1;
    } else {
      index = index + 2;
      const {
        typeValue: newParameterType,
        index: nextIndex,
        env: nextEnv,
      } = synthesizeTypeFromTokens({
        tokens,
        index,
        inputString,
        env,
        parseExpression,
      });
      userDefinedParamterType = newParameterType;
      env = nextEnv;
      index = nextIndex;

      if (
        userDefinedParamterType.type === "Function" &&
        userDefinedParamterType.freeVariables === undefined
      ) {
        // NOTE: This means we are passing a function as parameter
        // We set .freeVariables to empty not undefined to show that it's a closure
        userDefinedParamterType.freeVariables = [];
      }
    }

    // check parameter default value
    let defaultParameterValue: Expr | null = null;
    if (tokens[index].type === TokenType.Assign) {
      const {
        expr,
        index: nextNextIndex,
        env: nextEnv,
      } = parseExpression(tokens, index + 1, env);
      env = nextEnv;

      parameterDefaultValues.push(expr);
      defaultParameterValue = expr;
      index = nextNextIndex;

      if (defaultParameterValue) {
        // Check if the type of the default value is the same as the parameter type
        const defaultValueType = defaultParameterValue.typeValue;
        if (userDefinedParamterType.type === "unknown") {
          userDefinedParamterType = defaultValueType;
        } else {
          if (!checkType(userDefinedParamterType, defaultValueType, env)) {
            throw formatErrorMessage({
              token: tokens[index],
              errorMessage: `Mismatched paramter types for ${parameterName} 
  Expected: ${typeToString(userDefinedParamterType)}
  Got:      ${typeToString(defaultValueType)})}`,
              inputString,
            });
          }
        }
      }
    } else {
      parameterDefaultValues.push(null);
    }

    // save to env
    env = addEnvValueType(env, {
      variableName: parameterName,
      type: userDefinedParamterType,
      kind: "value",
    });

    parameterTypes.push({
      name: parameterName,
      type: userDefinedParamterType,
      defaultValue: defaultParameterValue,
    });
  }

  if (!withFunctionBody) {
    env = popEnvFrame(env);
  }

  return { parameterTypes, index, env };
}

export function synthesizeTypeArgumentsFromTokens({
  tokens,
  index,
  inputString,
  env,
  parseExpression,
}: {
  tokens: Token[];
  index: number;
  inputString: string;
  env: Environment;
  parseExpression: ParseExpression;
}): { typeArguments: Type[]; env: Environment; index: number } {
  if (tokens[index].type !== TokenType.LessThan) {
    throw formatErrorMessage({
      token: tokens[index],
      errorMessage: "Expected '<' in type arguments",
      inputString,
    });
  }

  const typeArguments: Type[] = [];
  index = index + 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const token = tokens[index];
    if (!token) {
      throw formatErrorMessage({
        token: tokens[index - 1],
        errorMessage: "Expected '>'",
        inputString,
      });
    }
    if (token.type === TokenType.Comma) {
      index = index + 1;
      continue;
    }
    if (token.type === TokenType.GreaterThan) {
      index = index + 1;
      break;
    }

    const {
      typeValue: typeArgument,
      index: nextIndex,
      env: nextEnv,
    } = synthesizeTypeFromTokens({
      tokens,
      index,
      inputString,
      env,
      parseExpression,
    });
    typeArguments.push(typeArgument);
    index = nextIndex;
    env = nextEnv;
  }
  return { typeArguments, index, env };
}

/**
 * - <...>(...):xx {...}
 * - <...>(...) => {...}
 * @returns
 */
export function synthesizeFunctionTypeFromTokens({
  tokens,
  index,
  inputString,
  env,
  parseExpression,
  withFunctionBody,
  functionName,
}: {
  tokens: Token[];
  index: number;
  inputString: string;
  env: Environment;
  parseExpression: ParseExpression;
  withFunctionBody: boolean;
  functionName?: string;
}): { typeValue: TFunction; index: number; env: Environment } {
  // Type parameters
  let typeParameters: TTypeParameter[] = [];
  if (tokens[index].type === TokenType.LessThan) {
    const {
      typeParameters: nextTypeParameters,
      index: nextIndex,
      env: nextEnv,
    } = synthesizeTypeParametersFromTokens({
      tokens,
      index,
      env,
      inputString,
      parseExpression,
    });
    typeParameters = nextTypeParameters;
    index = nextIndex;
    env = nextEnv;
  }

  if (tokens[index].type !== TokenType.LParen) {
    throw formatErrorMessage({
      token: tokens[index],
      errorMessage: "Expected '(' in function declaration",
      inputString,
    });
  }

  const {
    parameterTypes,
    index: nextIndex,
    env: nextEnv,
  } = synthesizeFunctionParameterTypesFromTokens({
    tokens,
    index,
    inputString,
    env,
    parseExpression,
    withFunctionBody,
  });
  index = nextIndex;
  env = nextEnv;

  if (!withFunctionBody) {
    if (tokens[index].type === TokenType.LambdaArrow) {
      index = index + 1;
      const {
        typeValue: returnType,
        index: nextIndex,
        env: nextEnv,
      } = synthesizeTypeFromTokens({
        tokens,
        index,
        inputString,
        env,
        parseExpression,
      });
      index = nextIndex;
      env = nextEnv;
      return {
        typeValue: {
          type: "Function",
          id: getEnvVariableId(functionName ?? "lambda"),
          parameterTypes,
          typeParameters,
          returnType,
          freeVariables: undefined,
        },
        index,
        env,
      };
    } else {
      throw formatErrorMessage({
        token: tokens[index],
        errorMessage: "Expected '=>' for function return type",
        inputString,
      });
    }
  } else {
    if (tokens[index].type === TokenType.Colon) {
      index = index + 1;
      const {
        typeValue: returnType,
        index: nextIndex,
        env: nextEnv,
      } = synthesizeTypeFromTokens({
        tokens,
        index,
        inputString,
        env,
        parseExpression,
      });
      index = nextIndex;
      env = nextEnv;
      return {
        typeValue: {
          type: "Function",
          id: getEnvVariableId(functionName ?? "lambda"),
          parameterTypes,
          typeParameters,
          returnType,
          freeVariables: undefined,
        },
        index,
        env,
      };
    } else {
      return {
        typeValue: {
          type: "Function",
          id: getEnvVariableId(functionName ?? "lambda"),
          parameterTypes,
          typeParameters,
          returnType: {
            type: "unknown",
          },
          freeVariables: undefined,
        },
        index,
        env,
      };
    }
  }
}

/**
 * Check type parameters declaration <...>
 * For example: <T> in `fn<T>(a: T) {}`
 */
export function synthesizeTypeParametersFromTokens({
  tokens,
  index,
  env,
  inputString,
  parseExpression,
}: {
  tokens: Token[];
  index: number;
  env: Environment;
  inputString: string;
  parseExpression: ParseExpression;
}): {
  typeParameters: TTypeParameter[];
  index: number;
  env: Environment;
} {
  if (tokens[index].type !== TokenType.LessThan) {
    throw formatErrorMessage({
      token: tokens[index],
      errorMessage: "Expected '<' in type parameters declaration",
      inputString,
    });
  }

  index = index + 1;
  const typeParameters: TTypeParameter[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const token = tokens[index];
    if (!token) {
      throw formatErrorMessage({
        token: tokens[index - 1],
        errorMessage: "Expected '>'",
        inputString,
      });
    }
    if (token.type === TokenType.Comma) {
      index = index + 1;
      continue;
    }
    if (token.type === TokenType.GreaterThan) {
      index = index + 1;
      break;
    }

    if (token.type !== TokenType.Identifier) {
      throw formatErrorMessage({
        token,
        errorMessage: "Expected identifier as type parameter name",
        inputString,
      });
    }
    const typeParameterName = token.value;
    let typeParameterType: Type = TypeValues.unknown;
    if (tokens[index + 1].type === TokenType.Colon) {
      index = index + 2;
      const {
        typeValue: newTypeParameterType,
        index: nextIndex,
        env: nextEnv,
      } = synthesizeTypeFromTokens({
        tokens,
        index,
        inputString,
        env,
        parseExpression: parseExpression,
      });
      typeParameterType = newTypeParameterType;
      env = nextEnv;
      index = nextIndex;
    } else {
      index = index + 1;
    }

    // check type parameter default value
    let defaultTypeValue: Type | null = null;
    if (tokens[index].type === TokenType.Assign) {
      const {
        typeValue: nextDefaultTypeValue,
        index: nextIndex,
        env: nextEnv,
      } = synthesizeTypeFromTokens({
        tokens,
        index: index + 1,
        inputString,
        env,
        parseExpression,
      });
      index = nextIndex;
      env = nextEnv;
      defaultTypeValue = nextDefaultTypeValue;
    }

    const typeParameter: TTypeParameter = {
      type: "TypeParameter",
      name: typeParameterName,
      typeValue: typeParameterType,
      defaultTypeValue: defaultTypeValue,
    };
    typeParameters.push(typeParameter);

    // Save to env
    env = addEnvValueType(env, {
      variableName: typeParameterName,
      type: typeParameter,
      kind: "type",
    });
  }

  return {
    env,
    index,
    typeParameters,
  };
}

/**
 * Check if `a` is subtype of `b`.
 * For example,
 * {
 *   upperLeft: { label: string, x: number, y: number },
 *   lowerRight: { label: string, x: number, y: number },
 * }
 * is subtype of
 * {
 *   upperLeft: { x: number, y: number },
 *   lowerRight: { x: number, y: number },
 * }
 * @param a
 * @param b
 * @returns
 */
function isSubtype(a: Type, b: Type): boolean {
  if (a.type === "Record" && b.type === "Record") {
    return b.properties.every(({ name: bName, type: bType }) => {
      const aProperty = a.properties.find(({ name: aName }) => aName === bName);
      if (aProperty) {
        const aType = aProperty.type;
        return isSubtype(aType, bType);
      } else {
        return false;
      }
    });
  } else {
    // TPrimitive
    if ("value" in b) {
      if (!("value" in a)) {
        return false;
      } else {
        return a.type === b.type && a.value === b.value;
      }
    }

    if (
      (isSignedIntegerType(a) && isSignedIntegerType(b)) ||
      (isUnsignedIntegerType(a) && isUnsignedIntegerType(b)) ||
      (isFloatType(a) && isFloatType(b))
    ) {
      const aSize = parseInt(a.type.slice(1));
      const bSize = parseInt(b.type.slice(1));
      return aSize <= bSize;
    } else if (a.type === "Function" && b.type === "Function") {
      return (
        a.parameterTypes.length === b.parameterTypes.length &&
        a.parameterTypes.every((aParameter, i) =>
          isSubtype(aParameter.type, b.parameterTypes[i].type)
        ) &&
        isSubtype(a.returnType, b.returnType)
      );
    } else if (b.type === "Union") {
      if (a.type === "Union") {
        return a.types.every((type) => isSubtype(type, b));
      } else {
        return b.types.some((type) => isSubtype(a, type));
      }
    } else if (b.type === "Intersection" || a.type === "Intersection") {
      throw new Error("Intersection type is not supported yet");
    } else if (a.type === "slice" && b.type === "slice") {
      if (a.size !== undefined && b.size !== undefined) {
        return a.size <= b.size && isSubtype(a.elementType, b.elementType);
      } else {
        return isSubtype(a.elementType, b.elementType);
      }
    } else {
      return a.type === b.type;
    }
  }
}

export function typeToString(type: Type): string {
  if ("tag" in type) {
    if (type.type === "symbol") {
      return `@${JSON.stringify(type.value)}`;
    }
    return type.value; // + "::" + type.type;
  }

  switch (type.type) {
    case "()": {
      return "()";
    }
    case "boolean": {
      return "boolean";
    }
    case "char": {
      return "char";
    }
    case "u1": {
      return "u1";
    }
    case "u8": {
      return "u8";
    }
    case "u16": {
      return "u16";
    }
    case "u32": {
      return "u32";
    }
    case "u64": {
      return "u64";
    }
    case "u128": {
      return "u128";
    }
    case "i1": {
      return "i1";
    }
    case "i8": {
      return "i8";
    }
    case "i16": {
      return "i16";
    }
    case "i32": {
      return "i32";
    }
    case "i64": {
      return "i64";
    }
    case "i128": {
      return "i128";
    }
    case "f16": {
      return "f16";
    }
    case "f32": {
      return "f32";
    }
    case "f64": {
      return "f64";
    }
    case "symbol": {
      return "symbol";
    }
    case "Record": {
      return `{ ${type.properties
        .map(({ name, type }) => `${name}: ${typeToString(type)}`)
        .join(", ")} }`;
    }
    case "Function": {
      return `(${type.parameterTypes
        .map(
          (parameter) =>
            (parameter.name ? `${parameter.name}: ` : "") +
            typeToString(parameter.type)
        )
        .join(", ")})=> ${typeToString(type.returnType)}`;
    }
    case "Union": {
      return `(${type.types.map(typeToString).join(" | ")})`;
    }
    case "Intersection": {
      return `(${type.types.map(typeToString).join(" & ")})`;
    }
    case "unknown": {
      return `unknown${type.typeName ? ` ${type.typeName}` : ""}${
        type.typeArguments
          ? `<${type.typeArguments.map(typeToString).join(", ")}>`
          : ""
      }`;
    }
    case "slice": {
      return `${typeToString(type.elementType)}[${type.size ?? ""}]`;
    }
    /*
    case "tuple": {
      return `[${type.elements.map(typeToString).join(", ")}]`;
    }*/
    case "TypeParameter": {
      return `${type.name}:${typeToString(type.typeValue)}`;
    }
    case "TypeConstructor": {
      return `<${type.typeParameters
        .map((typeParameter) => typeToString(typeParameter))
        .join(", ")}>${typeToString(type.typeValue)}`;
    }
    case "Interface": {
      return `interface${
        type.typeParameters.length
          ? `<${type.typeParameters.map(typeToString).join(",")}>`
          : ""
      } {
  ${type.functions
    .map(({ name, func }) => `${name}: ${typeToString(func)}`)
    .join("\n  ")}
}`;
    }
    default: {
      throw new Error(`Unknown type ${JSON.stringify(type)}`);
    }
  }
}

export function checkType(
  expectedType: Type,
  givenType: Type,
  env: Environment
): boolean {
  if (expectedType.type === "unknown") {
    if (expectedType.typeName) {
      // Get real type from env
      const valueTypes = getEnvValueTypesByVariableName(
        env,
        expectedType.typeName,
        "type"
      );
      if (valueTypes.length === 0) {
        throw new Error(
          `Cannot find type ${expectedType.typeName} in the environment`
        );
      }
      const realType = valueTypes[valueTypes.length - 1].type;
      // apply type arguments
      const typeArguments = expectedType.typeArguments;
      if (typeArguments) {
        expectedType = applyTypeArgumentsToType(realType, typeArguments);
      } else {
        expectedType = realType;
      }
    } else {
      return true;
    }
  } else if (expectedType.type === "TypeParameter") {
    if (expectedType.typeValue.type === "unknown") {
      return true;
    } else {
      return checkType(expectedType.typeValue, givenType, env);
    }
  } else if (expectedType.type === "Interface") {
    // Check if the givenType implements the functions defined in the interface
    const interfaceFunctions = expectedType.functions;
    const allImplemented = interfaceFunctions.every(({ name, func }) => {
      const matchedFunctions = getFunctionsOfCallerFromEnv(
        givenType,
        name,
        env
      );
      if (matchedFunctions.length === 0) {
        return false;
      }
      // Find the function in matchedFunctions that matches the func
      return !!matchedFunctions.some((matchedFunction) =>
        checkType(func, matchedFunction.type, env)
      );
    });
    return allImplemented;
  }

  const expectedTypeType = expectedType.type;
  const givenTypeType = givenType.type;
  if (expectedTypeType === givenTypeType) {
    if (expectedTypeType === "Record") {
      return checkRecordExactMatchType(expectedType, givenType, env);
    } else if (
      expectedTypeType === "Function" &&
      givenTypeType === "Function"
    ) {
      return (
        expectedType.parameterTypes.length ===
          givenType.parameterTypes.length &&
        expectedType.parameterTypes.every((parameterType, i) =>
          checkType(parameterType.type, givenType.parameterTypes[i].type, env)
        ) &&
        checkType(expectedType.returnType, givenType.returnType, env)
      );
    } else {
      return isSubtype(givenType, expectedType);
    }
  } else if (expectedTypeType === "Union") {
    const expectedTypeTypes = expectedType.types;
    if (givenTypeType === "Union") {
      const givenTypeTypes = givenType.types;
      return givenTypeTypes.every((type) =>
        expectedTypeTypes.some((expectedType) =>
          checkType(expectedType, type, env)
        )
      );
    } else {
      return expectedTypeTypes.some((type) => checkType(type, givenType, env));
    }
  } else if (
    expectedTypeType === "Intersection" ||
    givenTypeType === "Intersection"
  ) {
    throw new Error("Intersection type is not supported yet");
  } else {
    return false;
  }
}

function checkRecordExactMatchType(
  expectedType: Type,
  givenType: Type,
  env: Environment
): boolean {
  if (givenType.type !== "Record") {
    throw new Error("Cannot check type of non-record");
  }
  if (expectedType.type !== "Record") {
    throw new Error("Cannot check type of non-record");
  }
  const expectedTypeProperties = expectedType.properties.sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const givenTypeProperties = givenType.properties.sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  if (expectedTypeProperties.length !== givenTypeProperties.length) {
    return false;
  }

  let result = true;
  for (let i = 0; i < expectedTypeProperties.length; i++) {
    const type1Property = expectedTypeProperties[i];
    const type2Property = givenTypeProperties[i];
    if (type1Property.name !== type2Property.name) {
      result = false;
      break;
    }
    if (!checkType(type1Property.type, type2Property.type, env)) {
      result = false;
      break;
    }
  }
  return result;
}

/**
 * Get the real functionArgumentsInOrder by matching the functionArguments with the functionType
 * If not match, then return null
 * @param functionArguments
 * @param functionType
 * @returns
 */
export function getFunctionArgumentsInOrder(
  functionArguments: Expr[],
  functionType: TFunction,
  env: Environment
): Expr[] | null {
  const functionArgumentsInOrder: (Expr | null)[] =
    functionType.parameterTypes.map((pt) => pt.defaultValue);
  const functionParameterTypes = functionType.parameterTypes;

  for (let i = 0; i < functionArguments.length; i++) {
    const argument = functionArguments[i];
    if (Array.isArray(argument)) {
      return null;
    }

    // Keyword argument
    if (argument.type === AstType.ConstantAssigment) {
      const keyword = argument.variableName;
      const value = argument.right;
      const argumentPositionIndex = functionParameterTypes.findIndex(
        (pt) => pt.name === keyword
      );
      if (argumentPositionIndex < 0) {
        return null;
      } else {
        functionArgumentsInOrder[argumentPositionIndex] = value;
      }
    } else {
      if (i >= functionArgumentsInOrder.length) {
        return null;
      }
      // Positional argument
      functionArgumentsInOrder[i] = argument;
    }
  }

  // If functionArgumentsInOrder has any null, then it's not a match
  if (functionArgumentsInOrder.some((arg) => arg === null)) {
    return null;
  } else {
    // Check if the functionArgumentsInOrder has the same types as the functionParameterTypes
    for (let i = 0; i < functionArgumentsInOrder.length; i++) {
      const argument = functionArgumentsInOrder[i];
      const parameterType = functionParameterTypes[i];
      if (
        !argument ||
        Array.isArray(argument) ||
        !checkType(parameterType.type, argument.typeValue, env)
      ) {
        return null;
      }
    }

    return functionArgumentsInOrder as Expr[];
  }
}

export function getFunctionsOfCallerFromEnv(
  callerType: Type,
  functionName: string,
  env: Environment
) {
  const functionTypes = getEnvValueTypesByVariableName(env, functionName);
  // Find the functions that takes `expr` as the first argument
  let matchedFunctions = functionTypes.filter((functionType) => {
    if (functionType.type.type !== "Function") {
      return false;
    }
    const firstArgumentType = functionType.type.parameterTypes[0];
    if (!firstArgumentType) {
      return false;
    }
    return checkType(firstArgumentType.type, callerType, env);
  });

  // Check if there any function that matches the functionName
  if (callerType.type === "Interface") {
    const matchedFunctionsInInterface: ValueType[] = callerType.functions.map(
      ({ func, name }) => {
        const valueType: ValueType = {
          type: func,
          variableName: name,
          id: func.id,
          frameLevel: 0,
          kind: "value",
        };
        return valueType;
      }
    );
    matchedFunctions = matchedFunctions.concat(matchedFunctionsInInterface);
  }

  return matchedFunctions;
}

export function getFunctionFromEnv(
  functionName: string,
  functionArguments: Expr[],
  env: Environment
) {
  const functionsInEnv = getEnvValueTypesByVariableName(env, functionName);
  if (functionsInEnv.length === 0) {
    throw new Error(`Cannot find function '${functionName}'`);
  } else {
    // Find the function that matches the signature
    const matchedFunctions = functionsInEnv.filter((functionInEnv) => {
      if (functionInEnv.type.type !== "Function") {
        return false;
      }

      const functionArgumentsInOrder = getFunctionArgumentsInOrder(
        functionArguments,
        functionInEnv.type,
        env
      );
      return !!functionArgumentsInOrder;
    });
    if (matchedFunctions.length > 1) {
      throw new Error(
        `Ambiguous function call ${functionName} with arguments ${JSON.stringify(
          functionArguments
        )}
Found possible functions:
- ${matchedFunctions
          .map((func) => `${func.variableName}: ${typeToString(func.type)}`)
          .join("\n- ")}
        `
      );
    }
    const matchedFunction = matchedFunctions[0];
    if (!matchedFunction || matchedFunction.type.type !== "Function") {
      throw new Error(`Function "${functionName}" not found`);
    } else {
      return matchedFunction;
    }
  }
}

/**
 * NOTE: We allow the function overloading by checking the first argument type.
 * @param prototype
 * @param env
 */
export function getMatchedOverloadingFunction(
  prototype: FunctionPrototype,
  env: Environment
): ValueType[] {
  if (!prototype.functionName) {
    // Anonymous function
    return [];
  }

  const functionsInEnv = getEnvValueTypesByVariableName(
    env,
    prototype.functionName
  );

  if (
    prototype.typeValue.parameterTypes.length === 0 &&
    functionsInEnv.length !== 0
  ) {
    // Function without parameter is not allowed to be overloaded
    return functionsInEnv;
  }

  // Find the functions that takes `expr` as the first argument
  const matchedFunctions = functionsInEnv.filter((functionInEnv) => {
    if (functionInEnv.type.type !== "Function") {
      return false;
    }
    const firstArgumentType = functionInEnv.type.parameterTypes[0];
    if (!firstArgumentType) {
      return false;
    }
    return checkType(
      firstArgumentType.type,
      prototype.typeValue.parameterTypes[0].type,
      env
    );
  });

  return matchedFunctions;
}
