// Types

import Environment from "./env";
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
  | TFunction
  | TUnion
  | TIntersection
  | TUnknown;

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

export function isFloatType(type: Type): boolean {
  return type.type === "f16" || type.type === "f32" || type.type === "f64";
}

export type VariableTypes = { [key: string]: Type };

export function synthesizeTypeFromTokens(
  tokens: Token[],
  index: number,
  inputString: string,
  env: Environment
): { typeValue: Type; index: number } {
  let returnValue: {
    typeValue: Type;
    index: number;
  } | null = null;

  // Check if it's unit
  if (tokens[index].value === "(" && tokens[index + 1].value === ")") {
    index = index + 1;
    returnValue = {
      typeValue: TypeValues.unit,
      index: index + 1,
    };
  }
  // Check if it's anonymouse function
  else if (tokens[index].value === "(") {
    try {
      returnValue = synthesizeFunctionTypeFromTokens(
        tokens,
        index,
        inputString,
        env
      );
    } catch {
      // This means it's not a function type
      const { typeValue, index: newIndex } = synthesizeTypeFromTokens(
        tokens,
        index + 1,
        inputString,
        env
      );
      // Check if ')' is there
      if (tokens[newIndex].value === ")") {
        returnValue = {
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
  // Check if it's defined in variableTypes
  else if (env.getValueTypesByVariableName(tokens[index].value).length > 0) {
    const valueTypes = env.getValueTypesByVariableName(tokens[index].value);
    returnValue = {
      typeValue: valueTypes[valueTypes.length - 1].type,
      index: index + 1,
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
          const { typeValue: type, index: newIndex } = synthesizeTypeFromTokens(
            tokens,
            index,
            inputString,
            env
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
    returnValue = {
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
    returnValue = {
      typeValue: typeValue,
      index: index + 1,
    };
  }

  // Check if it's union type or intersection type
  const nextTokenType = tokens[returnValue.index]?.type;
  if (nextTokenType === TokenType.BitwiseOr) {
    const index = returnValue.index + 1;

    const newReturnValue = synthesizeTypeFromTokens(
      tokens,
      index,
      inputString,
      env
    );
    if (newReturnValue.typeValue.type === "Union") {
      return {
        typeValue: {
          type: "Union",
          types: [returnValue.typeValue, ...newReturnValue.typeValue.types],
        },
        index: newReturnValue.index,
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

      return {
        typeValue: {
          type: "Union",
          types: [returnValue.typeValue, newReturnValue.typeValue],
        },
        index: newReturnValue.index,
      };
    }
  } else if (nextTokenType === TokenType.BitwiseAnd) {
    const index = returnValue.index + 1;

    const newReturnValue = synthesizeTypeFromTokens(
      tokens,
      index,
      inputString,
      env
    );
    if (newReturnValue.typeValue.type === "Intersection") {
      return {
        typeValue: {
          type: "Intersection",
          types: [returnValue.typeValue, ...newReturnValue.typeValue.types],
        },
        index: newReturnValue.index,
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

      return {
        typeValue: {
          type: "Intersection",
          types: [returnValue.typeValue, newReturnValue.typeValue],
        },
        index: newReturnValue.index,
      };
    }
  } else {
    return returnValue;
  }
}

export function synthesizeFunctionTypeFromTokens(
  tokens: Token[],
  index: number,
  inputString: string,
  env: Environment
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
          inputString,
          env
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
      inputString,
      env
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
export function isSubtype(a: Type, b: Type): boolean {
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
    } else {
      return a.type === b.type;
    }
  }
}

export function typeToString(type: Type): string {
  switch (type.type) {
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
      return "unknown";
    }
    default: {
      throw new Error(`Unknown type ${JSON.stringify(type)}`);
    }
  }
}

export function checkType(expectedType: Type, givenType: Type): boolean {
  if (expectedType.type === givenType.type) {
    if (expectedType.type === "Record") {
      return checkRecordExactMatchType(expectedType, givenType);
    } else {
      return isSubtype(givenType, expectedType);
    }
  } else if (expectedType.type === "Union") {
    if (givenType.type === "Union") {
      return givenType.types.every((type) =>
        expectedType.types.some((expectedType) => checkType(expectedType, type))
      );
    } else {
      return expectedType.types.some((type) => checkType(type, givenType));
    }
  } else if (
    expectedType.type === "Intersection" ||
    givenType.type === "Intersection"
  ) {
    throw new Error("Intersection type is not supported yet");
  } else {
    return false;
  }
}

function checkRecordExactMatchType(
  expectedType: Type,
  givenType: Type
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
    if (!checkType(type1Property.type, type2Property.type)) {
      result = false;
      break;
    }
  }
  return result;
}
