// Types

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

export type TString = {
  type: "string";
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

export type TRecord = {
  type: "Record";
  properties: { name: string; type: Type }[];
};

export type ParameterType = {
  name?: string;
  type: Type;
};

export type TFunction = {
  type: "Function";
  parameterTypes: ParameterType[];
  returnType: Type;
};

export type Type =
  | TUnit
  | TBoolean
  | TString
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
  | TRecord
  | TFunction;

// Type constructors

export const TypeValues = {
  unit: { type: "()" } as TUnit,
  boolean: { type: "boolean" } as TBoolean,
  string: { type: "string" } as TString,
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
};

export function synthesizeTypeFromTokens(
  tokens: Token[],
  index: number,
  inputString: string
): { typeValue: Type; index: number } {
  // Check if it's unit
  if (tokens[index].value === "(" && tokens[index + 1].value === ")") {
    index = index + 1;
    return {
      typeValue: TypeValues.unit,
      index: index + 1,
    };
  }
  // Check if it's anonymouse function
  else if (tokens[index].value === "(") {
    try {
      return synthesizeFunctionTypeFromTokens(tokens, index, inputString);
    } catch {
      // This means it's not a function type
      const { typeValue, index: newIndex } = synthesizeTypeFromTokens(
        tokens,
        index + 1,
        inputString
      );
      // Check if ')' is there
      if (tokens[newIndex].value === ")") {
        return {
          typeValue: typeValue,
          index: newIndex + 1,
        };
      } else {
        throw formatErrorMessage({
          token: tokens[newIndex],
          errorMessage: "Expected ')'",
          inputString,
        });
      }
    }
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
          const { typeValue: type, index: newIndex } = synthesizeTypeFromTokens(
            tokens,
            index,
            inputString
          );
          typeValue.properties.push({ name, type });
          index = newIndex;

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
    return {
      typeValue: typeValue,
      index: index,
    };
  } else {
    let typeValue: Type;
    switch (tokens[index].value) {
      case "boolean": {
        typeValue = TypeValues.boolean;
        break;
      }
      case "string": {
        typeValue = TypeValues.string;
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
      default: {
        throw formatErrorMessage({
          token: tokens[index],
          errorMessage: `Unknown type ${tokens[index].value}`,
          inputString,
        });
      }
    }
    return {
      typeValue: typeValue,
      index: index + 1,
    };
  }
}

export function synthesizeFunctionTypeFromTokens(
  tokens: Token[],
  index: number,
  inputString: string
): { typeValue: Type; index: number } {
  if (tokens[index].type !== TokenType.LParen) {
    throw formatErrorMessage({
      token: tokens[index],
      errorMessage: "Expected '('",
      inputString,
    });
  }

  const parameterTypes: ParameterType[] = [];
  index = index + 1;
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
    if (token.type === TokenType.RParen) {
      index = index + 1;
      break;
    }
    if (token.type === TokenType.Identifier) {
      const name = token.value;
      if (tokens[index + 1].type === TokenType.Colon) {
        index = index + 2;
        const { typeValue: type, index: newIndex } = synthesizeTypeFromTokens(
          tokens,
          index,
          inputString
        );
        parameterTypes.push({ name, type });
        index = newIndex;

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
  if (tokens[index].type === TokenType.LambdaArrow) {
    index = index + 1;
    const { typeValue: returnType, index: newIndex } = synthesizeTypeFromTokens(
      tokens,
      index,
      inputString
    );
    index = newIndex;
    return {
      typeValue: {
        type: "Function",
        parameterTypes,
        returnType,
      },
      index: index,
    };
  } else {
    throw formatErrorMessage({
      token: tokens[index],
      errorMessage: "Expected '->'",
      inputString,
    });
  }
}

/**
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
export function isSubtype(a: Type, b: Type): boolean {
  if (a.type === "Record" && b.type === "Record") {
    return b.properties.every(({ name: bName, type: bType }) => {
      if (bName in a.properties) {
        const aType = a.properties[bName];
        return isSubtype(aType, bType);
      } else {
        return false;
      }
    });
  } else {
    return a.type === b.type;
  }
}

export function typeToString(tpye: Type): string {
  switch (tpye.type) {
    case "()": {
      return "()";
    }
    case "boolean": {
      return "boolean";
    }
    case "string": {
      return "string";
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
    case "Record": {
      return `{ ${tpye.properties
        .map(({ name, type }) => `${name}: ${typeToString(type)}`)
        .join(", ")} }`;
    }
    case "Function": {
      return `(${tpye.parameterTypes
        .map(
          (parameter) =>
            (parameter.name ? `${parameter.name}: ` : "") +
            typeToString(parameter.type)
        )
        .join(", ")}) => ${typeToString(tpye.returnType)}`;
    }
  }
}
