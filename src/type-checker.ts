// Types

import {
  AstType,
  BlockExpr,
  Expr,
  FunctionExpr,
  IfExpr,
  exprToString,
} from "./ast";
import {
  Environment,
  ValueType,
  addEnvValueType,
  generateValueTypeId,
  getEnvCurrentFrameLevel,
  getEnvValueTypesByVariableName,
  popEnvFrame,
  pushEnvFrame,
} from "./env";
import { formatErrorMessage } from "./error";
import * as logger from "./logger";
import { isUpperCamelCase } from "./naming-checker";
import { stringIsOperator } from "./operator";
import { Token, TokenType } from "./token";

export type TypeKind = "Type" | "Linear" | "Free";

export type RegionKind = "Region";

export type EffectKind = "Effect" | "LinearEffect" | "ControlledEffect";

export type TUnit = {
  type: "()";
  kind: "Free";
};

export type TBoolean = {
  type: "boolean";
  kind: "Free";
};

/**
 * 4 bytes unicode
 */
export type TChar = {
  type: "char";
  kind: "Free";
};

export type TString = {
  type: "string";
  kind: "Free";
};

export type TIsize = {
  type: "isize";
  kind: "Free";
};

export type TUsize = {
  type: "usize";
  kind: "Free";
};

export type TU8 = {
  type: "u8";
  kind: "Free";
};

export type TI8 = {
  type: "i8";
  kind: "Free";
};

export type TU16 = {
  type: "u16";
  kind: "Free";
};

export type TI16 = {
  type: "i16";
  kind: "Free";
};

export type TU32 = {
  type: "u32";
  kind: "Free";
};

export type TI32 = {
  type: "i32";
  kind: "Free";
};

export type TU64 = {
  type: "u64";
  kind: "Free";
};

export type TI64 = {
  type: "i64";
  kind: "Free";
};

export type TU128 = {
  type: "u128";
  kind: "Free";
};

export type TI128 = {
  type: "i128";
  kind: "Free";
};

export type TF16 = {
  type: "f16";
  kind: "Free";
};

export type TF32 = {
  type: "f32";
  kind: "Free";
};

export type TF64 = {
  type: "f64";
  kind: "Free";
};

// @"symbol"
export type TSymbol = {
  type: "symbol";
  kind: "Free";
};

export type TPrimitive =
  | TUnit
  | TBoolean
  | TChar
  | TString
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
  | TIsize
  | TUsize
  | TF16
  | TF32
  | TF64
  | TSymbol;

export type TPrimitiveWithValue = TPrimitive & {
  tag: "primitive";
  value: string;
};

export type TRecordProperty = {
  name: string;
  type: Type;
};

export type TRecord = {
  type: "Record";
  kind: TypeKind;
  properties: TRecordProperty[];
};

export type TParameterType = {
  name: string;
  parameterId: string;
  isMutable: boolean;
  type: Type;
  defaultValue: Expr | null;
};

export type TTypeParameter = {
  type: "TypeParameter";
  kind: TypeKind;
  name: string;
  appliedType?: Type;
};

export type TRegion = {
  type: "Region";
  kind: RegionKind;
  regionId: string;
};

export const UnknownRegion: TRegion = {
  type: "Region",
  kind: "Region",
  regionId: "'R_Unknown",
};

export type TRegionParameter = {
  type: "RegionParameter";
  kind: RegionKind;
  name: string;
  appliedRegion?: Region;
};

export type TFunction = {
  type: "Function";
  kind: "Free";
  functionId: string;
  typeParameters: TTypeParameter[];
  regionParameters: TRegionParameter[];
  parameterTypes: TParameterType[];
  effects: TEffect[];
  // hasMoreEffects: boolean;
  returnType: Type;

  isClosure: boolean;
  /**
   * Right now only ()=>{} is closure
   * function name(a: number) {} is not closure
   */
  freeVariables?: ValueType[];
  /**
   * At which frame level the function is defined
   */
  frameLevel: number;
};

export type TUnion = {
  type: "Union";
  kind: TypeKind;
  types: Type[];
};

export type TIntersection = {
  type: "Intersection";
  kind: TypeKind;
  types: Type[];
};

export type TUnknown = {
  type: "unknown";
  kind: "Free";
  typeArguments?: Type[];
  typeName?: string; // FIXME: This might be a expression in the future
};

export type TSlice = {
  type: "slice";
  kind: TypeKind;
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
  kind: TypeKind;
  name: string;
  typeConstructorId: string;
  typeParameters: TTypeParameter[];
  regionParameters: TRegionParameter[];
  typeValue: Type;
};

/**
 * NOTE: No free variable (closure) is supported for class function
 */
export type TClassFunction = {
  name: string;
  func: TFunction;
  functionExpr?: FunctionExpr;
};

export type TClass = {
  type: "Class";
  kind: "Free";
  name: string;
  classId: string;
  typeParameters: TTypeParameter[];
  regionParameters: TRegionParameter[];
  functions: TClassFunction[];

  // NOTE: Below are for "instance"
  isInstance: boolean;
  instanceTypeParameters?: TTypeParameter[];
  instanceRegionParameters?: TRegionParameter[];
};

export type TEnumVariant = {
  name: string;
  parameterTypes: TParameterType[];
};

export type TEnum = {
  type: "Enum";
  enumName: string;
  typeParameters: TTypeParameter[];
  regionParameters: TRegionParameter[];
  variants: TEnumVariant[];
  selectedVariantName?: string;
  kind: TypeKind;
};

export type TEffectOperation = {
  name: string;
  func: TFunction;
  functionExpr?: FunctionExpr;
};

export type TEffect = {
  type: "Effect";
  effectName: string;
  effectId: string;
  typeParameters: TTypeParameter[];
  regionParameters: TRegionParameter[];
  operations: TEffectOperation[];

  // NOTE: Below are for "handler"
  isHandler?: boolean;
};

export type TExternType = {
  type: "Extern";
  kind: TypeKind;
};

export type TModule = {
  type: "Module";
  /**
   * `modulePath` is the path of the module with protocol. For example:
   * - file:///home/username/project/src/main.mo
   * - https://github.com/username/project
   * - mo://@mo/std
   */
  modulePath: string;
  ast: Expr[];
  env: Environment;
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
  | TString
  | TU8
  | TU16
  | TU32
  | TU64
  | TU128
  | TI8
  | TI16
  | TI32
  | TI64
  | TI128
  | TF16
  | TF32
  | TF64
  | TIsize
  | TUsize
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
  | TEnum
  | TPrimitiveWithValue
  | TExternType;

export type Region = TRegionParameter | TRegion;

export type Effect = TEffect;

// Type constructors

export const TypeValues: {
  unit: TUnit;
  boolean: TBoolean;
  char: TChar;
  string: TString;
  u8: TU8;
  u16: TU16;
  u32: TU32;
  u64: TU64;
  u128: TU128;
  i8: TI8;
  i16: TI16;
  i32: TI32;
  i64: TI64;
  i128: TI128;
  f16: TF16;
  f32: TF32;
  f64: TF64;
  isize: TIsize;
  usize: TUsize;
  unknown: TUnknown;
  Reference: TTypeConstructor;
  MutableReference: TTypeConstructor;
  Promise: TTypeConstructor;
} = {
  unit: { type: "()", kind: "Free" },
  boolean: { type: "boolean", kind: "Free" },
  char: { type: "char", kind: "Free" },
  string: { type: "string", kind: "Free" },
  u8: { type: "u8", kind: "Free" },
  u16: { type: "u16", kind: "Free" },
  u32: { type: "u32", kind: "Free" },
  u64: { type: "u64", kind: "Free" },
  u128: { type: "u128", kind: "Free" },
  i8: { type: "i8", kind: "Free" },
  i16: { type: "i16", kind: "Free" },
  i32: { type: "i32", kind: "Free" },
  i64: { type: "i64", kind: "Free" },
  i128: { type: "i128", kind: "Free" },
  f16: { type: "f16", kind: "Free" },
  f32: { type: "f32", kind: "Free" },
  f64: { type: "f64", kind: "Free" },
  isize: { type: "isize", kind: "Free" },
  usize: { type: "usize", kind: "Free" },
  unknown: { type: "unknown", kind: "Free" },
  Reference: {
    type: "TypeConstructor",
    kind: "Free",
    name: "&",
    typeConstructorId: "&",
    typeParameters: [
      {
        type: "TypeParameter",
        name: "T",
        kind: "Type",
      },
    ],
    regionParameters: [
      {
        type: "RegionParameter",
        name: "R",
        kind: "Region",
      },
    ],
    typeValue: {
      type: "Extern",
      kind: "Free",
    },
  },
  MutableReference: {
    type: "TypeConstructor",
    kind: "Free",
    name: "&!",
    typeConstructorId: "&!",
    typeParameters: [
      {
        type: "TypeParameter",
        name: "T",
        kind: "Type",
      },
    ],
    regionParameters: [
      {
        type: "RegionParameter",
        name: "R",
        kind: "Region",
      },
    ],
    typeValue: {
      type: "Extern",
      kind: "Free",
    },
  },
  Promise: {
    type: "TypeConstructor",
    kind: "Linear",
    name: "Promise",
    typeConstructorId: "Promise",
    typeParameters: [
      {
        type: "TypeParameter",
        name: "T",
        kind: "Type",
      },
    ],
    regionParameters: [],
    typeValue: {
      type: "Extern",
      kind: "Free",
    },
  },
};

export const emptyFunctionThatHasMoreEffects: TFunction = {
  effects: [],
  functionId: "@emptyFunction",
  // hasMoreEffects: true,
  frameLevel: 0,
  isClosure: false,
  kind: "Free",
  parameterTypes: [],
  regionParameters: [],
  returnType: TypeValues.unit,
  type: "Function",
  typeParameters: [],
};

export type ParserReturn = {
  expr: Expr;
  index: number;
};

export type ParseExpression = ({
  tokens,
  index,
  env,
}: {
  tokens: Token[];
  index: number;
  env: Environment;
}) => ParserReturn;

export function isSignedIntegerType(type: Type): boolean {
  return (
    type.type === "i8" ||
    type.type === "i16" ||
    type.type === "i32" ||
    type.type === "i64" ||
    type.type === "i128" ||
    type.type === "isize"
  );
}

export function isUnsignedIntegerType(type: Type): boolean {
  return (
    type.type === "u8" ||
    type.type === "u16" ||
    type.type === "u32" ||
    type.type === "u64" ||
    type.type === "u128" ||
    type.type === "usize"
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
  env,
  functionName,
  parseExpression,
}: {
  tokens: Token[];
  index: number;
  env: Environment;
  functionName?: string;
  parseExpression: ParseExpression;
}): { typeValue: Type; index: number; env: Environment } {
  let returnValue: {
    typeValue: Type;
    index: number;
    env: Environment;
  } | null = null;

  if (tokens[index].value === "|") {
    return synthesizeTypeFromTokens({
      tokens,
      index: index + 1,
      env,
      parseExpression,
    });
  }

  // Check if it's unit
  if (
    tokens[index].value === "(" &&
    tokens[index + 1].value === ")" &&
    tokens[index + 2].type !== TokenType.FatArrow &&
    tokens[index + 2].type !== TokenType.FunctionArrow
  ) {
    index = index + 1;
    returnValue = {
      typeValue: TypeValues.unit,
      index: index + 1,
      env,
    };
  }
  // Check if it's anonymouse function
  else if (tokens[index].value === "(" || tokens[index].value === "<") {
    try {
      returnValue = synthesizeFunctionTypeFromTokens({
        tokens,
        index,
        env,
        parseExpression,
        withFunctionBody: false,
        functionName,
      });
    } catch (error) {
      // console.error(error);
      // This means it's not a function type
      const {
        typeValue,
        index: nextIndex,
        env: nextEnv,
      } = synthesizeTypeFromTokens({
        tokens,
        index: index + 1,
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
          modulePath: env.modulePath,
          inputString: env.inputString,
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
    const properties: TRecordProperty[] = [];
    index = index + 1;

    // Check user defined kind
    let userDefinedKind: TypeKind | undefined = undefined;
    const userDefinedKindTokenIndex = index + 1;
    if (tokens[index].type === TokenType.Colon) {
      index = index + 1;
      userDefinedKind = parseTypeKind(tokens[index]);
      if (!userDefinedKind) {
        throw formatErrorMessage({
          token: tokens[index],
          errorMessage: "Expected 'Type', 'Linear' or 'Free'",
          modulePath: env.modulePath,
          inputString: env.inputString,
        });
      }
      index = index + 1;
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const token = tokens[index];
      if (!token) {
        throw formatErrorMessage({
          token: tokens[index - 1],
          errorMessage: "Expected '}'",
          modulePath: env.modulePath,
          inputString: env.inputString,
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
            typeValue: propertyType,
            index: nextIndex,
            env: nextEnv,
          } = synthesizeTypeFromTokens({
            tokens,
            index,
            env,
            parseExpression,
          });

          properties.push({ name, type: propertyType });
          index = nextIndex;
          env = nextEnv;

          if (tokens[index].type === TokenType.Comma) {
            index = index + 1;
          }
        } else {
          throw formatErrorMessage({
            token,
            errorMessage: "Expected ':'",
            modulePath: env.modulePath,
            inputString: env.inputString,
          });
        }
      } else {
        throw formatErrorMessage({
          token,
          errorMessage: "Expected identifier",
          modulePath: env.modulePath,
          inputString: env.inputString,
        });
      }
    }

    // Check if userDefinedKind is valid:
    let kind = getRecordTypeKind(properties);
    if (
      userDefinedKind &&
      userDefinedKind === "Free" &&
      (kind === "Linear" || kind === "Type")
    ) {
      throw formatErrorMessage({
        token: tokens[userDefinedKindTokenIndex],
        errorMessage: `Cannot set type as 'Free' because it contains '${kind}' data.`,
        modulePath: env.modulePath,
        inputString: env.inputString,
      });
    } else if (
      userDefinedKind &&
      userDefinedKind === "Linear" &&
      kind === "Type"
    ) {
      throw formatErrorMessage({
        token: tokens[userDefinedKindTokenIndex],
        errorMessage: `Cannot set type as 'Linear' because it contains 'Type' data.`,
        modulePath: env.modulePath,
        inputString: env.inputString,
      });
    } else if (
      userDefinedKind &&
      userDefinedKind === "Type" &&
      kind === "Linear"
    ) {
      throw formatErrorMessage({
        token: tokens[userDefinedKindTokenIndex],
        errorMessage: `Cannot set type as 'Type' because it contains 'Linear' data.`,
        modulePath: env.modulePath,
        inputString: env.inputString,
      });
    } else {
      kind = userDefinedKind ? userDefinedKind : kind;
    }

    const typeValue: TRecord = {
      type: "Record",
      properties,
      kind,
    };

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
      case "string": {
        typeValue = TypeValues.string;
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
      case "isize": {
        typeValue = TypeValues.isize;
        break;
      }
      case "usize": {
        typeValue = TypeValues.usize;
        break;
      }
      case "symbol": {
        typeValue = { type: "symbol", kind: "Free" };
        break;
      }
      case "&": {
        typeValue = TypeValues.Reference;
        break;
      }
      case "&!": {
        typeValue = TypeValues.MutableReference;
        break;
      }
      case "Promise": {
        typeValue = TypeValues.Promise;
        break;
      }
      default: {
        // Check if it's a real value
        const { expr, index: nextIndex } = parseExpression({
          tokens,
          index,
          env,
        });
        env = expr.env;
        if (expr.typeValue.type === "Enum") {
          typeValue = expr.typeValue;
          index = nextIndex - 1;
        } else {
          if (
            !expr ||
            expr.type !== AstType.Value ||
            expr.tag !== "primitive"
          ) {
            throw formatErrorMessage({
              token: tokens[index],
              errorMessage: `Unknown type ${tokens[index].value}`,
              modulePath: env.modulePath,
              inputString: env.inputString,
            });
          }

          typeValue = expr.typeValue;
          index = nextIndex - 1;
        }
      }
    }
    returnValue = {
      typeValue: typeValue,
      index: index + 1,
      env,
    };
  }

  const nextTokenType = tokens[returnValue.index]?.type;
  const nextTokenValue = tokens[returnValue.index]?.value;
  let newTypeValue: Type = returnValue.typeValue;
  const newTypeValueKind = newTypeValue.kind;

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
          modulePath: env.modulePath,
          inputString: env.inputString,
        });
      }
      if (token.type === TokenType.Integer) {
        const size = parseInt(token.value);
        if (tokens[index + 1].type !== TokenType.RBracket) {
          throw formatErrorMessage({
            token: tokens[index + 1],
            errorMessage: "Expected ']'",
            modulePath: env.modulePath,
            inputString: env.inputString,
          });
        } else {
          newTypeValue = {
            type: "slice",
            kind: newTypeValueKind,
            elementType: newTypeValue,
            size,
          };
          index = index + 2;
        }
      } else if (token.type === TokenType.RBracket) {
        newTypeValue = {
          type: "slice",
          kind: newTypeValueKind,
          elementType: newTypeValue,
          size: undefined,
        };
        index = index + 1;
      } else {
        throw formatErrorMessage({
          token,
          errorMessage: "Expected integer or ']'",
          modulePath: env.modulePath,
          inputString: env.inputString,
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
  else if (nextTokenValue === "|") {
    const index = returnValue.index + 1;

    const newReturnValue = synthesizeTypeFromTokens({
      tokens,
      index,
      env,
      parseExpression,
    });
    const newReturnValueTypeKind = newReturnValue.typeValue.kind;

    if (newReturnValue.typeValue.type === "Union") {
      const returnValueTypeKind = returnValue.typeValue.kind;
      returnValue = {
        typeValue: {
          type: "Union",
          kind: mixTypeKind(returnValueTypeKind, newReturnValueTypeKind),
          types: [returnValue.typeValue, ...newReturnValue.typeValue.types],
        },
        index: newReturnValue.index,
        env: newReturnValue.env,
      };
    } else {
      /*
      NOTE: We now allow union of different types
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
      */

      const returnValueTypeKind = returnValue.typeValue.kind;
      returnValue = {
        typeValue: {
          type: "Union",
          kind: mixTypeKind(returnValueTypeKind, newReturnValueTypeKind),
          types: [returnValue.typeValue, newReturnValue.typeValue],
        },
        index: newReturnValue.index,
        env: newReturnValue.env,
      };
    }
  } else if (nextTokenValue === "&") {
    const index = returnValue.index + 1;

    const newReturnValue = synthesizeTypeFromTokens({
      tokens,
      index,
      env,
      parseExpression,
    });
    const newReturnValueTypeKind = newReturnValue.typeValue.kind;
    if (newReturnValue.typeValue.type === "Intersection") {
      const returnValueTypeKind = returnValue.typeValue.kind;
      returnValue = {
        typeValue: {
          type: "Intersection",
          kind: mixTypeKind(returnValueTypeKind, newReturnValueTypeKind),
          types: [returnValue.typeValue, ...newReturnValue.typeValue.types],
        },
        index: newReturnValue.index,
        env: newReturnValue.env,
      };
    } else {
      /*
      NOTE: We now allow intersection of different types
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
      */

      const returnValueTypeKind = returnValue.typeValue.kind;
      returnValue = {
        typeValue: {
          type: "Intersection",
          kind: mixTypeKind(returnValueTypeKind, newReturnValueTypeKind),
          types: [returnValue.typeValue, newReturnValue.typeValue],
        },
        index: newReturnValue.index,
        env: newReturnValue.env,
      };
    }
  }
  // Type arguments
  let typeArguments: Type[] = [];
  let regionArguments: Region[] = [];
  if (tokens[returnValue.index]?.value === "<") {
    const {
      env: nextEnv,
      index: nextIndex,
      typeArguments: nextTypeArguments,
      regionArguments: nextRegionArguments,
    } = synthesizeTypeAndRegionArgumentsFromTokens({
      env: returnValue.env,
      index: returnValue.index,
      parseExpression,
      tokens,
    });
    env = nextEnv;
    index = nextIndex;
    typeArguments = nextTypeArguments;
    regionArguments = nextRegionArguments;
  } else {
    env = returnValue.env;
    index = returnValue.index;
  }

  const typeValue = returnValue.typeValue;
  try {
    if (typeValue.type === "TypeConstructor") {
      returnValue.index = index;
      returnValue.env = env;
      const typeValue_ = applyTypeAndRegionArgumentsToType({
        env,
        type: typeValue,
        typeArguments,
        regionArguments,
        regionParameterToRegionArgumentMap: {},
        typeParameterToTypeArgumentMap: {},
      });
      returnValue.typeValue = typeValue_;
    } else if (typeValue.type === "unknown") {
      returnValue.index = index;
      returnValue.env = env;
      returnValue.typeValue = {
        ...typeValue,
        typeArguments,
      };
    } else if (typeValue.type === "Enum") {
      returnValue.index = index;
      returnValue.env = env;
      const typeValue_ = applyTypeAndRegionArgumentsToType({
        env,
        type: typeValue,
        typeArguments,
        regionArguments,
        regionParameterToRegionArgumentMap: {},
        typeParameterToTypeArgumentMap: {},
      });
      returnValue.typeValue = typeValue_;
    } else if (typeArguments.length !== 0) {
      throw formatErrorMessage({
        token: tokens[returnValue.index - 1],
        errorMessage: `Cannot apply type arguments to ${typeToString(
          typeValue
        )}`,
        modulePath: env.modulePath,
        inputString: env.inputString,
      });
    }

    return returnValue;
  } catch (error) {
    throw formatErrorMessage({
      token: tokens[returnValue.index - 1],
      errorMessage: error.message,
      modulePath: env.modulePath,
      inputString: env.inputString,
    });
  }
}

/**
 * Please note this function will modify `typeParameterToTypeArgumentMap` and `regionParameterToRegionArgumentMap`
 * @param typeArguments
 * @param regionArguments
 * @param typeParameterToTypeArgumentMap
 * @param regionParameterToRegionArgumentMap
 */
function generateNewTypeAndRegionParameters({
  env,
  typeParameters,
  regionParameters,
  typeArguments,
  regionArguments,
  typeParameterToTypeArgumentMap,
  regionParameterToRegionArgumentMap,
}: {
  env: Environment;
  typeParameters: TTypeParameter[];
  regionParameters: TRegionParameter[];
  typeArguments?: Type[];
  regionArguments?: Region[];
  typeParameterToTypeArgumentMap: { [key: string]: Type };
  regionParameterToRegionArgumentMap: { [key: string]: Region };
}): {
  typeParameters: TTypeParameter[];
  regionParameters: TRegionParameter[];
} {
  // set typeParameterToTypeArgumentMap
  const newTypeParameters: TTypeParameter[] = [];
  for (let i = 0; i < typeParameters.length; i++) {
    const typeParameter = typeParameters[i];
    if (typeArguments) {
      const typeArgument = typeArguments[i];

      const existingTypeArgument =
        typeParameterToTypeArgumentMap[typeParameter.name];
      if (
        existingTypeArgument &&
        !checkType(existingTypeArgument, typeArgument, env)
      ) {
        // Check if matches
        throw new Error(
          `Mismatched type arguments.
Expected: ${typeToString(existingTypeArgument)}
Got     : ${typeToString(typeArgument)}`
        );
      }
      typeParameterToTypeArgumentMap[typeParameter.name] = typeArgument;
      newTypeParameters.push({
        ...typeParameter,
        appliedType: typeArgument,
      });
    } else if (typeParameterToTypeArgumentMap[typeParameter.name]) {
      newTypeParameters.push({
        ...typeParameter,
        appliedType: typeParameterToTypeArgumentMap[typeParameter.name],
      });
    } else {
      newTypeParameters.push(typeParameter);
    }
  }

  const newRegionParameters: TRegionParameter[] = [];
  for (let i = 0; i < regionParameters.length; i++) {
    const regionParameter = regionParameters[i];
    if (regionArguments) {
      const regionArgument = regionArguments[i];

      const existingRegionArgument =
        regionParameterToRegionArgumentMap[regionParameter.name];
      if (
        existingRegionArgument &&
        !checkRegion(existingRegionArgument, regionArgument)
      ) {
        // Check if matches
        throw new Error(
          `Mismatched region arguments.
Expected: ${regionToString(existingRegionArgument)}
Got     : ${regionToString(regionArgument)}`
        );
      } else {
        regionParameterToRegionArgumentMap[regionParameter.name] =
          regionArgument;
      }
      newRegionParameters.push({
        ...regionParameter,
        appliedRegion: regionArgument,
      });
    } else if (regionParameterToRegionArgumentMap[regionParameter.name]) {
      newRegionParameters.push({
        ...regionParameter,
        appliedRegion: regionParameterToRegionArgumentMap[regionParameter.name],
      });
    } else {
      newRegionParameters.push(regionParameter);
    }
  }

  return {
    typeParameters: newTypeParameters,
    regionParameters: newRegionParameters,
  };
}

/**
 * If typeArguments or regionArguments is undefined,
 * use the typeParameterToTypeArgumentMap and regionParameterToRegionArgumentMap instead
 * @param type
 * @param typeArguments
 * @param regionArguments
 * @param typeParameterToTypeArgumentMap
 * @param regionParameterToRegionArgumentMap
 * @returns
 */
export function applyTypeAndRegionArgumentsToType({
  env,
  type,
  typeArguments,
  regionArguments,
  typeParameterToTypeArgumentMap,
  regionParameterToRegionArgumentMap,
}: {
  env: Environment;
  type: Type;
  typeArguments?: Type[];
  regionArguments?: Region[];
  typeParameterToTypeArgumentMap: { [key: string]: Type };
  regionParameterToRegionArgumentMap: { [key: string]: Region };
}): Type {
  /*
  logger.debug("- applyTypeAndRegionArgumentsToType");
  logger.debug("  - type: ", type.type);
  logger.debug("    - typeToString(type): ", typeToString(type));
  logger.debug(
    "  - typeParameterToTypeArgumentMap: ",
    typeParameterToTypeArgumentMap
  );
    logger.debug(
    "  - typeArguments: ",
    typeArguments.map((type) => typeToString(type))
  );
  logger.debug(
    "  - regionArguments: ",
    regionArguments.map((region) => regionToString(region))
  );
  */

  if (type.type === "TypeConstructor") {
    const typeValue = type.typeValue;
    logger.debug(
      "  - typeParameters: ",
      type.typeParameters.map((typeParameter) => typeToString(typeParameter))
    );
    logger.debug(
      "  - regionParameters: ",
      type.regionParameters.map((regionParameter) =>
        regionToString(regionParameter)
      )
    );
    if (typeArguments && type.typeParameters.length !== typeArguments.length) {
      throw new Error(
        `(3) Mismatched type arguments.
  Expected: <${type.typeParameters
    .map((typeParameter) => `${typeParameter.name}: ${typeParameter.kind}`)
    .join(", ")}>
  Got:      <${typeArguments.map((type) => typeToString(type)).join(", ")}>`
      );
    }
    if (
      regionArguments &&
      type.regionParameters.length !== regionArguments.length
    ) {
      while (regionArguments.length < type.regionParameters.length) {
        regionArguments.push(UnknownRegion);
      }

      /*
      throw new Error(
        `(4) Mismatched region arguments.
  Expected: <${type.regionParameters
    .map(
      (regionParameter) => `${regionParameter.name}: ${regionParameter.kind}`
    )
    .join(", ")}>
  Got:      <${regionArguments
    .map((region) => regionToString(region))
    .join(", ")}>`
      );
      */
    }

    // set typeParameterToTypeArgumentMap
    const {
      typeParameters: newTypeParameters,
      regionParameters: newRegionParameters,
    } = generateNewTypeAndRegionParameters({
      env,
      typeParameters: type.typeParameters,
      regionParameters: type.regionParameters,
      typeArguments,
      regionArguments,
      typeParameterToTypeArgumentMap,
      regionParameterToRegionArgumentMap,
    });

    const newTypeValue = applyTypeAndRegionArgumentsToType({
      env,
      type: typeValue,
      typeParameterToTypeArgumentMap,
      regionParameterToRegionArgumentMap,
    });
    return {
      type: "TypeConstructor",
      kind: typeValue.type === "Extern" ? type.kind : newTypeValue.kind,
      name: type.name,
      typeConstructorId: generateValueTypeId(env, type.name),
      typeParameters: newTypeParameters,
      regionParameters: newRegionParameters,
      typeValue: newTypeValue,
    };
  } else if (type.type === "Enum") {
    const {
      typeParameters: newTypeParameters,
      regionParameters: newRegionParameters,
    } = generateNewTypeAndRegionParameters({
      env,
      typeParameters: type.typeParameters,
      regionParameters: type.regionParameters,
      typeArguments,
      regionArguments,
      typeParameterToTypeArgumentMap,
      regionParameterToRegionArgumentMap,
    });

    // apply to each of the variants
    const variants: TEnumVariant[] = type.variants.map(
      ({ name, parameterTypes }) => ({
        name,
        parameterTypes: parameterTypes.map((parameterType) => {
          const defaultValue = parameterType.defaultValue;
          const newParameterType: TParameterType = {
            name: parameterType.name,
            parameterId: parameterType.parameterId,
            isMutable: false, // QUESTION: Is this correct?
            type: applyTypeAndRegionArgumentsToType({
              env,
              type: parameterType.type,
              typeParameterToTypeArgumentMap,
              regionParameterToRegionArgumentMap,
            }),
            defaultValue: defaultValue
              ? applyTypeAndRegionArgumentsToExpr({
                  expr: defaultValue,
                  env,
                  typeParameterToTypeArgumentMap,
                  regionParameterToRegionArgumentMap,
                })
              : null,
          };
          return newParameterType;
        }),
      })
    ) as TEnumVariant[];

    const enumType: TEnum = {
      type: "Enum",
      kind: getEnumTypeKind(variants),
      enumName: type.enumName,
      typeParameters: newTypeParameters,
      regionParameters: newRegionParameters,
      variants: variants,
      selectedVariantName: type.selectedVariantName,
    };

    // Update func.returnType of each variants
    /*
    variants.forEach((variant) => {
      if (variant.func && variant.func.returnType.type === "unknown") {
        variant.func.returnType.typeArguments = typeArguments;
      }
    });
    */

    return enumType;
  } else if (type.type === "Function") {
    const typeParameters = type.typeParameters;
    if (typeArguments && typeParameters.length !== typeArguments.length) {
      throw new Error(
        `(5) Mismatched type arguments.
  Expected: <${typeParameters
    .map((typeParameter) => `${typeParameter.name}: ${typeParameter.kind}`)
    .join(", ")}>
  Got:      <${typeArguments.map((type) => typeToString(type)).join(", ")}>`
      );
    }

    const {
      typeParameters: newTypeParameters,
      regionParameters: newRegionParameters,
    } = generateNewTypeAndRegionParameters({
      env,
      typeParameters: type.typeParameters,
      regionParameters: type.regionParameters,
      typeArguments,
      regionArguments,
      typeParameterToTypeArgumentMap,
      regionParameterToRegionArgumentMap,
    });

    const newFunctionType: TFunction = {
      ...type,
      typeParameters: newTypeParameters,
      regionParameters: newRegionParameters,
      parameterTypes: type.parameterTypes.map(
        ({ name, parameterId, type, isMutable, defaultValue }) => ({
          name,
          parameterId,
          isMutable,
          type: applyTypeAndRegionArgumentsToType({
            env,
            type,
            typeParameterToTypeArgumentMap,
            regionParameterToRegionArgumentMap,
          }),
          defaultValue,
        })
      ),
      returnType: applyTypeAndRegionArgumentsToType({
        env,
        type: type.returnType,
        typeParameterToTypeArgumentMap,
        regionParameterToRegionArgumentMap,
      }),
      effects: type.effects.map((effect) =>
        applyTypeAndRegionArgumentsToEffect({
          env,
          effect,
          typeParameterToTypeArgumentMap,
          regionParameterToRegionArgumentMap,
        })
      ),
    };
    return newFunctionType;
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
        const newProperties = type.properties.map(({ name, type }) => ({
          name,
          type: applyTypeAndRegionArgumentsToType({
            env,
            type,
            typeParameterToTypeArgumentMap,
            regionParameterToRegionArgumentMap,
          }),
        }));
        return {
          ...type,
          kind: getRecordTypeKind(newProperties),
          properties: newProperties,
        };
      }
      case "Union": {
        return {
          ...type,
          types: type.types.map((type) =>
            applyTypeAndRegionArgumentsToType({
              env,
              type,
              typeParameterToTypeArgumentMap,
              regionParameterToRegionArgumentMap,
            })
          ),
        };
      }
      case "Intersection": {
        return {
          ...type,
          types: type.types.map((type) =>
            applyTypeAndRegionArgumentsToType({
              env,
              type,
              typeParameterToTypeArgumentMap,
              regionParameterToRegionArgumentMap,
            })
          ),
        };
      }
      case "slice": {
        return {
          ...type,
          elementType: applyTypeAndRegionArgumentsToType({
            env,
            type: type.elementType,
            typeParameterToTypeArgumentMap,
            regionParameterToRegionArgumentMap,
          }),
        };
      }
      case "unknown": {
        return {
          ...type,
          typeArguments: type.typeArguments
            ? type.typeArguments.map((typeArgument) =>
                applyTypeAndRegionArgumentsToType({
                  env,
                  type: typeArgument,
                  typeParameterToTypeArgumentMap,
                  regionParameterToRegionArgumentMap,
                })
              )
            : undefined,
        };
      }
      default:
        return type;
    }
  }
}

export function applyTypeAndRegionArgumentsToEffect({
  env,
  effect,
  typeArguments,
  regionArguments,
  typeParameterToTypeArgumentMap,
  regionParameterToRegionArgumentMap,
}: {
  env: Environment;
  effect: TEffect;
  typeArguments?: Type[];
  regionArguments?: Region[];
  typeParameterToTypeArgumentMap: { [key: string]: Type };
  regionParameterToRegionArgumentMap: { [key: string]: Region };
}): TEffect {
  const typeParameters = effect.typeParameters;
  if (typeArguments && typeParameters.length !== typeArguments.length) {
    throw new Error(
      `(7) Mismatched type arguments.
Expected: <${typeParameters
        .map((typeParameter) => `${typeParameter.name}: ${typeParameter.kind}`)
        .join(", ")}>
Got:      <${typeArguments.map((type) => typeToString(type)).join(", ")}>`
    );
  }

  // set typeParameterToTypeArgumentMap
  const {
    typeParameters: newTypeParameters,
    regionParameters: newRegionParameters,
  } = generateNewTypeAndRegionParameters({
    env,
    typeParameters: effect.typeParameters,
    regionParameters: effect.regionParameters,
    typeArguments,
    regionArguments,
    typeParameterToTypeArgumentMap,
    regionParameterToRegionArgumentMap,
  });

  const newEffect: TEffect = {
    ...effect,
    typeParameters: newTypeParameters,
    regionParameters: newRegionParameters,
    operations: effect.operations.map((operation) => ({
      ...operation,
      func: applyTypeAndRegionArgumentsToType({
        env,
        type: operation.func,
        typeParameterToTypeArgumentMap,
        regionParameterToRegionArgumentMap,
      }) as TFunction,
    })),
    isHandler: true,
  };
  return newEffect;
}

export function applyTypeAndRegionArgumentsToClass({
  env,
  class_,
  typeArguments,
  regionArguments,
  typeParameterToTypeArgumentMap,
  regionParameterToRegionArgumentMap,
}: {
  env: Environment;
  class_: TClass;
  typeArguments?: Type[];
  regionArguments?: Region[];
  typeParameterToTypeArgumentMap: { [key: string]: Type };
  regionParameterToRegionArgumentMap: { [key: string]: Region };
}): TClass {
  if (typeArguments && class_.typeParameters.length !== typeArguments.length) {
    throw new Error(
      `(4) Mismatched type arguments.
Expected: <${class_.typeParameters
        .map((typeParameter) => `${typeParameter.name}: ${typeParameter.kind}`)
        .join(", ")}>
Got:      <${typeArguments.map((type) => typeToString(type)).join(", ")}>`
    );
  }

  // set typeParameterToTypeArgumentMap
  const {
    typeParameters: newTypeParameters,
    regionParameters: newRegionParameters,
  } = generateNewTypeAndRegionParameters({
    env,
    typeParameters: class_.typeParameters,
    regionParameters: class_.regionParameters,
    typeArguments,
    regionArguments,
    typeParameterToTypeArgumentMap,
    regionParameterToRegionArgumentMap,
  });

  // apply to each of the functions
  const functions: TClassFunction[] = class_.functions.map(
    ({ name, func, functionExpr }) => ({
      name,
      func: applyTypeAndRegionArgumentsToType({
        env,
        type: func,
        typeParameterToTypeArgumentMap,
        regionParameterToRegionArgumentMap,
      }),
      functionExpr: functionExpr
        ? applyTypeAndRegionArgumentsToExpr({
            expr: functionExpr,
            env,
            typeParameterToTypeArgumentMap,
            regionParameterToRegionArgumentMap,
          })
        : undefined,
    })
  ) as TClassFunction[];

  return {
    type: "Class",
    kind: "Free",
    name: class_.name,
    classId: class_.classId,
    typeParameters: newTypeParameters,
    regionParameters: newRegionParameters,
    functions: functions,
    isInstance: true, // type.isInstance,
    instanceTypeParameters: class_.instanceTypeParameters,
    instanceRegionParameters: class_.instanceRegionParameters,
  };
}

export function applyTypeAndRegionArgumentsToFunctionExpr({
  env,
  expr,
  typeArguments,
  regionArguments,
  typeParameterToTypeArgumentMap,
  regionParameterToRegionArgumentMap,
}: {
  env: Environment;
  expr: FunctionExpr;
  typeArguments?: Type[];
  regionArguments?: Region[];
  typeParameterToTypeArgumentMap: { [key: string]: Type };
  regionParameterToRegionArgumentMap: { [key: string]: Region };
}): FunctionExpr {
  const type: TFunction = expr.typeValue as TFunction;
  if (typeArguments && type.typeParameters.length !== typeArguments.length) {
    throw new Error(
      `(6) Mismatched type arguments.
Expected: <${type.typeParameters
        .map((typeParameter) => `${typeParameter.name}: ${typeParameter.kind}`)
        .join(", ")}>
Got:      <${typeArguments.map((type) => typeToString(type)).join(", ")}>`
    );
  }

  // set typeParameterToTypeArgumentMap
  /*const {
    typeParameters: newTypeParameters,
    regionParameters: newRegionParameters,
  } =*/ generateNewTypeAndRegionParameters({
    env,
    typeParameters: type.typeParameters,
    regionParameters: type.regionParameters,
    typeArguments,
    regionArguments,
    typeParameterToTypeArgumentMap,
    regionParameterToRegionArgumentMap,
  });

  const newTypeValue = applyTypeAndRegionArgumentsToType({
    type: expr.typeValue,
    env,
    typeParameterToTypeArgumentMap,
    regionParameterToRegionArgumentMap,
  });
  if (newTypeValue.type !== "Function") {
    throw new Error(
      `Expected function type, but got ${typeToString(newTypeValue)}`
    );
  }

  return {
    ...expr,
    typeValue: newTypeValue,
    body: applyTypeAndRegionArgumentsToExpr({
      expr: expr.body,
      env,
      typeParameterToTypeArgumentMap,
      regionParameterToRegionArgumentMap,
    }) as BlockExpr,
  };
}

export function applyTypeAndRegionArgumentsToExpr({
  env,
  expr,
  typeParameterToTypeArgumentMap,
  regionParameterToRegionArgumentMap,
}: {
  env: Environment;
  expr: Expr;
  typeParameterToTypeArgumentMap: { [key: string]: Type };
  regionParameterToRegionArgumentMap: { [key: string]: Region };
}): Expr {
  /*
  logger.debug("- applyTypeAndRegionArgumentsToExpr");
  logger.debug("  - expr: ", exprToString(expr));
  logger.debug(
    "  - typeArguments: ",
    typeArguments.map((type) => typeToString(type))
  );
  logger.debug(
    "  - typeParameterToTypeArgumentMap: ",
    typeParameterToTypeArgumentMap
  );
  */
  switch (expr.type) {
    case AstType.Value: {
      switch (expr.tag) {
        case "record": {
          return {
            ...expr,
            typeValue: applyTypeAndRegionArgumentsToType({
              env,
              type: expr.typeValue,
              typeParameterToTypeArgumentMap,
              regionParameterToRegionArgumentMap,
            }),
            properties: expr.properties.map(({ name, value: expr }) => ({
              name,
              value: applyTypeAndRegionArgumentsToExpr({
                env,
                expr,
                typeParameterToTypeArgumentMap,
                regionParameterToRegionArgumentMap,
              }),
            })),
          };
        }
        case "slice": {
          return {
            ...expr,
            typeValue: applyTypeAndRegionArgumentsToType({
              env,
              type: expr.typeValue,
              typeParameterToTypeArgumentMap,
              regionParameterToRegionArgumentMap,
            }),
            values: expr.values.map((expr) =>
              applyTypeAndRegionArgumentsToExpr({
                env,
                expr,
                typeParameterToTypeArgumentMap,
                regionParameterToRegionArgumentMap,
              })
            ),
          };
        }
        default:
          return expr;
      }
    }
    case AstType.Function: {
      return applyTypeAndRegionArgumentsToFunctionExpr({
        expr,
        env,
        typeParameterToTypeArgumentMap,
        regionParameterToRegionArgumentMap,
      });
    }
    case AstType.LetAssignment: {
      return {
        ...expr,
        variableType: applyTypeAndRegionArgumentsToType({
          env,
          type: expr.variableType,
          typeParameterToTypeArgumentMap,
          regionParameterToRegionArgumentMap,
        }),
        right: applyTypeAndRegionArgumentsToExpr({
          env,
          expr: expr.right,
          typeParameterToTypeArgumentMap,
          regionParameterToRegionArgumentMap,
        }),
      };
    }
    /*
    case AstType.UnaryOperator: {
      return {
        ...expr,
        typeValue: applyTypeAndRegionArgumentsToType({
          env,
          type: expr.typeValue,
          typeParameterToTypeArgumentMap,
          regionParameterToRegionArgumentMap,
        }),
        expr: applyTypeAndRegionArgumentsToExpr({
          env,
          expr: expr.expr,
          typeParameterToTypeArgumentMap,
          regionParameterToRegionArgumentMap,
        }),
      };
    }
    */
    case AstType.Variable: {
      return {
        ...expr,
        typeValue: applyTypeAndRegionArgumentsToType({
          env: env,
          type: expr.typeValue,
          typeParameterToTypeArgumentMap,
          regionParameterToRegionArgumentMap,
        }),
      };
    }
    case AstType.PropertyAccess: {
      return {
        ...expr,
        typeValue: applyTypeAndRegionArgumentsToType({
          type: expr.typeValue,
          env,
          typeParameterToTypeArgumentMap,
          regionParameterToRegionArgumentMap,
        }),
        expr: applyTypeAndRegionArgumentsToExpr({
          expr: expr.expr,
          env,
          typeParameterToTypeArgumentMap,
          regionParameterToRegionArgumentMap,
        }),
      };
    }
    case AstType.IndexAccess: {
      return {
        ...expr,
        typeValue: applyTypeAndRegionArgumentsToType({
          type: expr.typeValue,
          env,
          typeParameterToTypeArgumentMap,
          regionParameterToRegionArgumentMap,
        }),
        expr: applyTypeAndRegionArgumentsToExpr({
          expr: expr.expr,
          env,
          typeParameterToTypeArgumentMap,
          regionParameterToRegionArgumentMap,
        }),
        indexes: expr.indexes.map((expr) =>
          applyTypeAndRegionArgumentsToExpr({
            expr: expr,
            env,
            typeParameterToTypeArgumentMap,
            regionParameterToRegionArgumentMap,
          })
        ),
      };
    }
    case AstType.CallFunction: {
      return {
        ...expr,
        callee: applyTypeAndRegionArgumentsToExpr({
          expr: expr.callee,
          env,
          typeParameterToTypeArgumentMap,
          regionParameterToRegionArgumentMap,
        }),
        functionArguments: expr.functionArguments.map((expr) =>
          applyTypeAndRegionArgumentsToExpr({
            expr,
            env,
            typeParameterToTypeArgumentMap,
            regionParameterToRegionArgumentMap,
          })
        ),
        typeValue: applyTypeAndRegionArgumentsToType({
          type: expr.typeValue,
          env,
          typeParameterToTypeArgumentMap,
          regionParameterToRegionArgumentMap,
        }),
      };
    }
    case AstType.If: {
      const newIfExpr: IfExpr = {
        ...expr,
        cases: expr.cases.map(({ condition, body }) => {
          return {
            condition: condition
              ? applyTypeAndRegionArgumentsToExpr({
                  expr: condition,
                  env,
                  typeParameterToTypeArgumentMap,
                  regionParameterToRegionArgumentMap,
                })
              : undefined,
            body: applyTypeAndRegionArgumentsToExpr({
              expr: body,
              env,
              typeParameterToTypeArgumentMap,
              regionParameterToRegionArgumentMap,
            }) as BlockExpr,
          };
        }),
        typeValue: applyTypeAndRegionArgumentsToType({
          type: expr.typeValue,
          env,
          typeParameterToTypeArgumentMap,
          regionParameterToRegionArgumentMap,
        }),
      };
      return newIfExpr;
    }
    case AstType.Ignore: {
      return expr;
    }
    case AstType.Block: {
      return {
        ...expr,
        exprs: expr.exprs.map((expr) =>
          applyTypeAndRegionArgumentsToExpr({
            expr,
            env,
            typeParameterToTypeArgumentMap,
            regionParameterToRegionArgumentMap,
          })
        ),
        typeValue: applyTypeAndRegionArgumentsToType({
          type: expr.typeValue,
          env,
          typeParameterToTypeArgumentMap,
          regionParameterToRegionArgumentMap,
        }),
      };
    }

    default:
      throw new Error(`Unknown expr type ${expr.type}`);
  }
}

/**
 * Synthesize parameter types (aka row types)
 */
export function synthesizeFunctionParameterTypesFromTokens({
  tokens,
  index,
  env,
  parseExpression,
  withFunctionBody,
}: {
  tokens: Token[];
  index: number;
  env: Environment;
  parseExpression: ParseExpression;
  withFunctionBody: boolean;
}): { parameterTypes: TParameterType[]; index: number; env: Environment } {
  if (tokens[index].type !== TokenType.LParen) {
    throw formatErrorMessage({
      token: tokens[index],
      errorMessage: "Expected '(' in row types declaration",
      modulePath: env.modulePath,
      inputString: env.inputString,
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
    let token = tokens[index];
    if (!token) {
      throw formatErrorMessage({
        token: tokens[index - 1],
        errorMessage: "Expected ')'",
        modulePath: env.modulePath,
        inputString: env.inputString,
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

    let isMutable = false;
    if (token.type === TokenType.Mut) {
      isMutable = true;
      index = index + 1;
      token = tokens[index];
    }

    // TODO: There might be the case that only the type is specified or pattern matching
    if (token.type !== TokenType.Identifier) {
      throw formatErrorMessage({
        token,
        errorMessage: "Expected identifier as parameter name",
        modulePath: env.modulePath,
        inputString: env.inputString,
      });
    }
    const parameterName = token.value;

    // check type
    let userDefinedParamterType: Type = TypeValues.unknown;
    const parameterNameTokenIndex = index;
    if (tokens[index + 1].type !== TokenType.Colon) {
      // index = index + 1;
      throw formatErrorMessage({
        token: tokens[index + 1],
        errorMessage: "Expected ':' after parameter name",
        modulePath: env.modulePath,
        inputString: env.inputString,
      });
    } else {
      index = index + 2;
      const {
        typeValue: newParameterType,
        index: nextIndex,
        env: nextEnv,
      } = synthesizeTypeFromTokens({
        tokens,
        index,
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
      const { expr, index: nextNextIndex } = parseExpression({
        tokens,
        index: index + 1,
        env,
      });
      env = expr.env;

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
              modulePath: env.modulePath,
              inputString: env.inputString,
            });
          }
        }
      }
    } else {
      parameterDefaultValues.push(null);
    }

    // save to env
    const { env: nextEnv, value: parameterValue } = addEnvValueType({
      env,
      valueType: {
        variableName: parameterName,
        type: userDefinedParamterType,
        kind: "value",
        isMutable,
        token: tokens[parameterNameTokenIndex],
      },
    });
    env = nextEnv;

    parameterTypes.push({
      name: parameterName,
      parameterId: parameterValue.id,
      isMutable,
      type: userDefinedParamterType,
      defaultValue: defaultParameterValue,
    });
  }

  if (!withFunctionBody) {
    env = popEnvFrame(env, true);
  }

  return { parameterTypes, index, env };
}

export function synthesizeTypeAndRegionArgumentsFromTokens({
  tokens,
  index,
  env,
  parseExpression,
}: {
  tokens: Token[];
  index: number;
  env: Environment;
  parseExpression: ParseExpression;
}): {
  typeArguments: Type[];
  regionArguments: Region[];
  env: Environment;
  index: number;
} {
  if (tokens[index].value !== "<") {
    throw formatErrorMessage({
      token: tokens[index],
      errorMessage: "Expected '<' in type arguments",
      modulePath: env.modulePath,
      inputString: env.inputString,
    });
  }

  const typeArguments: Type[] = [];
  const regionArguments: Region[] = [];
  index = index + 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const token = tokens[index];
    if (!token) {
      throw formatErrorMessage({
        token: tokens[index - 1],
        errorMessage: "Expected '>'",
        modulePath: env.modulePath,
        inputString: env.inputString,
      });
    }
    if (token.type === TokenType.Comma) {
      index = index + 1;
      continue;
    }

    if (token.value === ">>") {
      // Split this token into two '>' tokens
      tokens.splice(
        index,
        1,
        {
          type: TokenType.Operator,
          value: ">",
          position: {
            line: token.position.line,
            character: token.position.character,
          },
        },
        {
          type: TokenType.Operator,
          value: ">",
          position: {
            line: token.position.line,
            character: token.position.character + 1,
          },
        }
      );
      index = index + 1;
      break;
    }

    if (token.value === ">") {
      index = index + 1;
      break;
    }

    // Check if it's region argument
    if (token.type === TokenType.Identifier) {
      const regionName = token.value;
      const regions = getEnvValueTypesByVariableName(env, regionName, "region");
      if (regions.length === 1 && regions[0].region) {
        const region = regions[0].region;
        regionArguments.push(region);
        index = index + 1;
        continue;
      }
    }

    const {
      typeValue: typeArgument,
      index: nextIndex,
      env: nextEnv,
    } = synthesizeTypeFromTokens({
      tokens,
      index,
      env,
      parseExpression,
    });
    typeArguments.push(typeArgument);
    index = nextIndex;
    env = nextEnv;
  }
  return { typeArguments, regionArguments, index, env };
}

export function synthesizeEffectsFromTokens({
  tokens,
  index,
  env,
  parseExpression,
}: {
  tokens: Token[];
  index: number;
  env: Environment;
  parseExpression: ParseExpression;
}): {
  effects: TEffect[];
  // hasMoreEffects: boolean;
  index: number;
} {
  const effects: TEffect[] = [];
  // let hasMoreEffects = false;

  if (tokens[index].type !== TokenType.LBracket) {
    throw formatErrorMessage({
      token: tokens[index],
      errorMessage: "Expected '[' in effects declaration",
      modulePath: env.modulePath,
      inputString: env.inputString,
    });
  }
  index = index + 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!tokens[index]) {
      throw formatErrorMessage({
        token: tokens[index - 1],
        errorMessage: "Expected '}'",
        modulePath: env.modulePath,
        inputString: env.inputString,
      });
    }
    if (tokens[index].type === TokenType.RBracket) {
      index = index + 1;
      break;
    }

    if (tokens[index].value === "*") {
      // hasMoreEffects = true;
      index = index + 1;
    } else {
      if (tokens[index].type !== TokenType.Identifier) {
        throw formatErrorMessage({
          token: tokens[index],
          errorMessage: "Expected identifier as effect name",
          modulePath: env.modulePath,
          inputString: env.inputString,
        });
      }
      const effectName = tokens[index].value;
      index = index + 1;

      let typeArguments: Type[] = [];
      let regionArguments: Region[] = [];
      if (tokens[index].value === "<") {
        const {
          typeArguments: nextTypeArguments,
          regionArguments: nextRegionArguments,
          index: nextIndex,
          env: nextEnv,
        } = synthesizeTypeAndRegionArgumentsFromTokens({
          tokens,
          index,
          env,
          parseExpression,
        });
        typeArguments = nextTypeArguments;
        regionArguments = nextRegionArguments;
        index = nextIndex;
        env = nextEnv;
      }

      // Find the effect
      const effectValues = getEnvValueTypesByVariableName(
        env,
        effectName,
        "effect"
      );
      if (effectValues.length === 0) {
        throw formatErrorMessage({
          token: tokens[index],
          errorMessage: `Cannot find effect ${effectName}`,
          modulePath: env.modulePath,
          inputString: env.inputString,
        });
      } else if (effectValues.length > 1) {
        throw formatErrorMessage({
          token: tokens[index],
          errorMessage: `Ambiguous effect ${effectName}`,
          modulePath: env.modulePath,
          inputString: env.inputString,
        });
      } else {
        const effect = effectValues[0].effect;
        if (!effect) {
          throw formatErrorMessage({
            token: tokens[index],
            errorMessage: `Cannot find effect ${effectName}`,
            modulePath: env.modulePath,
            inputString: env.inputString,
          });
        }
        const newEffect = applyTypeAndRegionArgumentsToEffect({
          effect,
          env,
          typeArguments,
          regionArguments,
          typeParameterToTypeArgumentMap: {},
          regionParameterToRegionArgumentMap: {},
        });
        effects.push(newEffect);
      }
    }

    if (tokens[index].type === TokenType.Comma) {
      index = index + 1;
      continue;
    }
  }

  return {
    effects,
    // hasMoreEffects,
    index,
  };
}

/**
 * - <...>(...):xx {...}
 * - <...>(...) => {...}
 * @returns
 */
export function synthesizeFunctionTypeFromTokens({
  tokens,
  index,
  env,
  parseExpression,
  withFunctionBody,
  functionName,
}: {
  tokens: Token[];
  index: number;
  env: Environment;
  parseExpression: ParseExpression;
  withFunctionBody: boolean;
  functionName?: string;
}): { typeValue: TFunction; index: number; env: Environment } {
  // Type parameters
  let frameLevel = getEnvCurrentFrameLevel(env);
  if (withFunctionBody) {
    frameLevel -= 1;
  }

  let typeParameters: TTypeParameter[] = [];
  let regionParameters: TRegionParameter[] = [];
  if (tokens[index].value === "<") {
    const {
      typeParameters: nextTypeParameters,
      regionParameters: nextRegionParameters,
      index: nextIndex,
      env: nextEnv,
    } = synthesizeTypeAndRegionParametersFromTokens({
      tokens,
      index,
      env,
    });
    typeParameters = nextTypeParameters;
    regionParameters = nextRegionParameters;
    index = nextIndex;
    env = nextEnv;
  }

  if (tokens[index].type !== TokenType.LParen) {
    throw formatErrorMessage({
      token: tokens[index],
      errorMessage: "Expected '(' in function declaration",
      modulePath: env.modulePath,
      inputString: env.inputString,
    });
  }

  const {
    parameterTypes,
    index: nextIndex,
    env: nextEnv,
  } = synthesizeFunctionParameterTypesFromTokens({
    tokens,
    index,
    env,
    parseExpression,
    withFunctionBody,
  });
  index = nextIndex;
  env = nextEnv;

  if (
    tokens[index].type === TokenType.FatArrow ||
    tokens[index].type === TokenType.FunctionArrow
  ) {
    const isClosure = tokens[index].type === TokenType.FatArrow;
    index = index + 1;

    // Effects
    let effects: TEffect[] = [];
    // let hasMoreEffects = false;
    if (tokens[index].type === TokenType.LBracket) {
      const {
        effects: nextEffects,
        // hasMoreEffects: nextHasMoreEffects,
        index: nextNextIndex,
      } = synthesizeEffectsFromTokens({
        tokens,
        index,
        env,
        parseExpression,
      });
      effects = nextEffects;
      // hasMoreEffects = nextHasMoreEffects;
      index = nextNextIndex;
    }

    let returnType: Type = TypeValues.unit;
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      // Return type
      const {
        typeValue: nextReturnType,
        index: nextIndex,
        env: nextEnv,
      } = synthesizeTypeFromTokens({
        tokens,
        index,
        env,
        parseExpression,
      });
      index = nextIndex;
      env = nextEnv;
      returnType = nextReturnType;
    }

    return {
      typeValue: {
        type: "Function",
        kind: "Free",
        functionId:
          functionName === "main" || functionName?.startsWith("@") // compiletime functions
            ? functionName
            : generateValueTypeId(env, functionName ?? "anonymousFunction"),
        parameterTypes,
        typeParameters,
        regionParameters,
        returnType,
        effects,
        // hasMoreEffects,
        isClosure,
        freeVariables: undefined,
        frameLevel,
      },
      index,
      env,
    };
  } else {
    throw formatErrorMessage({
      token: tokens[index],
      errorMessage: "Expected function return type after '->' or '=>'",
      modulePath: env.modulePath,
      inputString: env.inputString,
    });
  }
}

/**
 * @param tokens
 * @param index
 * @param inputString
 * @returns
 */
export function parseTypeKind(token: Token): TypeKind | undefined {
  if (token.value === "Type") {
    return "Type";
  } else if (token.value === "Linear") {
    return "Linear";
  } else if (token.value === "Free") {
    return "Free";
  } else {
    return undefined;
  }
}

/**
 * @param tokens
 * @param index
 * @param inputString
 * @returns
 */
function parseTypeAndRegionKind({
  tokens,
  index,
  modulePath,
  inputString,
}: {
  tokens: Token[];
  index: number;
  modulePath: string;
  inputString: string;
}): TypeKind | RegionKind {
  if (tokens[index].value === "Type") {
    return "Type";
  } else if (tokens[index].value === "Linear") {
    return "Linear";
  } else if (tokens[index].value === "Free") {
    return "Free";
  } else if (tokens[index].value === "Region") {
    return "Region";
  } else {
    throw formatErrorMessage({
      token: tokens[index],
      errorMessage: `Unknown kind ${tokens[index].value}`,
      modulePath,
      inputString,
    });
  }
}

function getRecordTypeKind(properties: TRecordProperty[]): TypeKind {
  let kind: TypeKind = "Free";
  properties.forEach((property) => {
    if (kind === "Free") {
      const propertyKind = property.type.kind;
      kind = propertyKind;
    }
  });
  return kind;
}

export function getEnumTypeKind(variants: TEnumVariant[]): TypeKind {
  let kind: TypeKind = "Free";
  variants.forEach((variant) => {
    if (kind === "Free") {
      kind = getRecordTypeKind(variant.parameterTypes);
    }
  });
  return kind;
}

/**
 * Check type parameters declaration <...>
 * For example: <T> in `fn<T>(a: T) {}`
 */
export function synthesizeTypeAndRegionParametersFromTokens({
  tokens,
  index,
  env,
}: {
  tokens: Token[];
  index: number;
  env: Environment;
}): {
  typeParameters: TTypeParameter[];
  regionParameters: TRegionParameter[];
  index: number;
  env: Environment;
} {
  if (tokens[index].value !== "<") {
    throw formatErrorMessage({
      token: tokens[index],
      errorMessage: "Expected '<' in type parameters declaration",
      modulePath: env.modulePath,
      inputString: env.inputString,
    });
  }

  index = index + 1;
  const typeParameters: TTypeParameter[] = [];
  const regionParameters: TRegionParameter[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const token = tokens[index];
    if (!token) {
      throw formatErrorMessage({
        token: tokens[index - 1],
        errorMessage: "Expected '>'",
        modulePath: env.modulePath,
        inputString: env.inputString,
      });
    }
    if (token.type === TokenType.Comma) {
      index = index + 1;
      continue;
    }
    if (token.value === ">") {
      index = index + 1;
      break;
    }
    // Split the tokens
    if (token.type === TokenType.Operator && token.value.startsWith(">")) {
      const operator = token.value;
      tokens.splice(
        index,
        1,
        {
          type: TokenType.Operator,
          value: ">",
          position: {
            line: token.position.line,
            character: token.position.character,
          },
        },
        operator.slice(1) === ":"
          ? {
              type: TokenType.Colon,
              value: ":",
              position: {
                line: token.position.line,
                character: token.position.character + 1,
              },
            }
          : {
              type: TokenType.Operator,
              value: operator.slice(1),
              position: {
                line: token.position.line,
                character: token.position.character + 1,
              },
            }
      );
      index = index + 1;
      break;
    }

    if (token.type !== TokenType.Identifier) {
      throw formatErrorMessage({
        token,
        errorMessage: `Expected identifier as type parameter name, but got "${token.value}"`,
        modulePath: env.modulePath,
        inputString: env.inputString,
      });
    }
    const typeParameterName = token.value;
    if (!isUpperCamelCase(typeParameterName)) {
      throw formatErrorMessage({
        token,
        errorMessage: `Type parameter name "${typeParameterName}" must be UpperCamelCase`,
        modulePath: env.modulePath,
        inputString: env.inputString,
      });
    }

    // Check type kind
    let kind: TypeKind | RegionKind | undefined = undefined;
    const parameterKindTokenIndex = index + 2;
    if (tokens[index + 1].type === TokenType.Colon) {
      index = index + 2;
      kind = parseTypeAndRegionKind({
        tokens,
        index,
        modulePath: env.modulePath,
        inputString: env.inputString,
      });
      if (!kind) {
        throw formatErrorMessage({
          token: tokens[index],
          errorMessage: `Unknown kind ${tokens[index].value}. Expected 'Type', 'Linear', 'Free', or 'Region'`,
          modulePath: env.modulePath,
          inputString: env.inputString,
        });
      }
      index = index + 1;
    } else {
      kind = "Type";
      index = index + 1;
    }

    /*
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
    */

    if (kind === "Region") {
      const regionParameter: TRegionParameter = {
        type: "RegionParameter",
        kind: "Region",
        name: typeParameterName,
      };
      regionParameters.push(regionParameter);

      // Save to env
      const { env: nextEnv } = addEnvValueType({
        env,
        valueType: {
          variableName: typeParameterName,
          type: TypeValues.unknown,
          region: regionParameter,
          kind: "region",
          token: tokens[parameterKindTokenIndex],
        },
      });
      env = nextEnv;
    } else {
      const typeParameter: TTypeParameter = {
        type: "TypeParameter",
        kind: kind,
        name: typeParameterName,
      };
      typeParameters.push(typeParameter);

      // Save to env
      const { env: nextEnv } = addEnvValueType({
        env,
        valueType: {
          variableName: typeParameterName,
          type: typeParameter,
          kind: "type",
          token: tokens[parameterKindTokenIndex],
        },
      });
      env = nextEnv;
    }
  }

  return {
    env,
    index,
    typeParameters,
    regionParameters,
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

export function typeToString(
  type: Type,
  {
    extractTypeConstructor,
    hideTypeParameterKind,
  }: {
    extractTypeConstructor?: boolean | "all";
    hideTypeParameterKind?: boolean;
  } = {}
): string {
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
    case "string": {
      return "string";
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
    case "usize": {
      return "usize";
    }
    case "symbol": {
      return "symbol";
    }
    case "Record": {
      return `{ ${type.properties
        .map(
          ({ name, type }) =>
            `${name}: ${typeToString(type, {
              extractTypeConstructor,
              hideTypeParameterKind,
            })}`
        )
        .join(", ")} }`;
    }
    case "Function": {
      const effectsString = effectsToString(type.effects, {
        hideTypeParameterKind: true,
      });
      return `${typeAndRegionParametersToString(
        type.typeParameters,
        type.regionParameters,
        { hideTypeParameterKind: false }
      )}(${type.parameterTypes
        .map(
          (parameter) =>
            (parameter.name ? `${parameter.name}: ` : "") +
            typeToString(parameter.type, { hideTypeParameterKind: true }) +
            `${
              parameter.defaultValue
                ? ` = ${exprToString(parameter.defaultValue)}`
                : ""
            }`
        )
        .join(", ")})${type.isClosure ? "=>" : "->"} ${
        effectsString.length > 0 ? `${effectsString} ` : ""
      }${typeToString(type.returnType, {
        hideTypeParameterKind: true,
      })}`;
    }
    case "Union": {
      return `(${type.types.map((type) => typeToString(type)).join(" | ")})`;
    }
    case "Intersection": {
      return `(${type.types.map((type) => typeToString(type)).join(" & ")})`;
    }
    case "unknown": {
      return `unknown${type.typeName ? ` ${type.typeName}` : ""}${
        type.typeArguments
          ? `<${type.typeArguments
              .map((type) => typeToString(type))
              .join(", ")}>`
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
      if (type.appliedType) {
        return typeToString(type.appliedType, {
          hideTypeParameterKind,
          extractTypeConstructor,
        });
      } else if (hideTypeParameterKind) {
        return type.name;
      } else {
        return `${type.name}: ${type.kind}`;
      }
    }
    case "TypeConstructor": {
      if (extractTypeConstructor) {
        if (extractTypeConstructor === "all") {
          return `${type.name}${typeAndRegionParametersToString(
            type.typeParameters,
            type.regionParameters,
            { hideTypeParameterKind }
          )}: ${type.kind}${
            type.typeValue.type === "Extern"
              ? ";"
              : ` = ${typeToString(type.typeValue, {
                  extractTypeConstructor: false,
                  hideTypeParameterKind: true,
                })}`
          }`;
        } else {
          return typeToString(type.typeValue, {
            extractTypeConstructor,
            hideTypeParameterKind,
          });
        }
      } else {
        return `${type.name}${typeAndRegionParametersToString(
          type.typeParameters,
          type.regionParameters,
          { hideTypeParameterKind }
        )}`;
      }
    }
    case "Enum": {
      if (extractTypeConstructor) {
        return `enum ${type.enumName}${typeAndRegionParametersToString(
          type.typeParameters,
          type.regionParameters,
          { hideTypeParameterKind }
        )}: ${type.kind} {
${type.variants
  .map(({ name, parameterTypes }) => {
    return `  ${name}${
      parameterTypes.length
        ? `(${parameterTypes
            .map(
              (parameter) =>
                (parameter.name ? `${parameter.name}: ` : "") +
                typeToString(parameter.type, { hideTypeParameterKind: true })
            )
            .join(", ")})`
        : ""
    }`;
  })
  .join(",\n")}
}`;
      } else {
        return `${type.enumName}${typeAndRegionParametersToString(
          type.typeParameters,
          type.regionParameters,
          { hideTypeParameterKind }
        )}${
          type.selectedVariantName && !hideTypeParameterKind
            ? `.${type.selectedVariantName}`
            : ""
        }`;
      }
    }
    case "Extern": {
      return "";
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
  if (
    expectedType.type === "TypeConstructor" &&
    givenType.type === "TypeConstructor"
  ) {
    return checkTypeConstructorExactMatch(expectedType, givenType, env);
  } else if (expectedType.type === "TypeConstructor") {
    return checkType(expectedType.typeValue, givenType, env);
  } else if (givenType.type === "TypeConstructor") {
    return checkType(expectedType, givenType.typeValue, env);
  }

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
        expectedType = applyTypeAndRegionArgumentsToType({
          type: realType,
          env,
          typeArguments,
          regionArguments: [], // regionArguments
          regionParameterToRegionArgumentMap: {},
          typeParameterToTypeArgumentMap: {},
        });
      } else {
        expectedType = realType;
      }
    } else {
      return true;
    }
  } else if (expectedType.type === "TypeParameter") {
    if (!expectedType.appliedType) {
      return true;
    } else if (givenType.type === "TypeParameter") {
      if (!givenType.appliedType) {
        return false;
      }
      return checkType(expectedType.appliedType, givenType.appliedType, env);
    } else {
      return checkType(expectedType.appliedType, givenType, env);
    }
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
        expectedType.isClosure === givenType.isClosure &&
        expectedType.parameterTypes.length ===
          givenType.parameterTypes.length &&
        expectedType.parameterTypes.every((parameterType, i) =>
          checkType(parameterType.type, givenType.parameterTypes[i].type, env)
        ) &&
        checkType(expectedType.returnType, givenType.returnType, env) &&
        checkFunctionEffects(expectedType, givenType, env)
      );
    } else if (expectedTypeType === "Enum" && givenTypeType === "Enum") {
      return checkEnumExactMatchType(expectedType, givenType, env);
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

export function checkRegion(expectedRegion: Region, givenRegion: Region) {
  if (expectedRegion.type === "RegionParameter") {
    if (!expectedRegion.appliedRegion) {
      return true;
    } else {
      return checkRegion(expectedRegion.appliedRegion, givenRegion);
    }
  } else if (givenRegion.type === "RegionParameter") {
    if (givenRegion.appliedRegion) {
      return checkRegion(expectedRegion, givenRegion.appliedRegion);
    } else {
      return false;
    }
  } else {
    return expectedRegion.regionId === givenRegion.regionId;
  }
}

export function checkEffect(
  expectedEffect: TEffect,
  givenEffect: TEffect,
  env: Environment
): boolean {
  // FIXME: Let's check ID in the future.
  if (expectedEffect.effectName !== givenEffect.effectName) {
    return false;
  }
  if (
    expectedEffect.typeParameters.length !==
      givenEffect.typeParameters.length ||
    expectedEffect.regionParameters.length !==
      givenEffect.regionParameters.length
  ) {
    return false;
  }

  for (let i = 0; i < expectedEffect.typeParameters.length; i++) {
    const expectedTypeParameter = expectedEffect.typeParameters[i];
    const givenTypeParameter = givenEffect.typeParameters[i];
    if (!checkType(expectedTypeParameter, givenTypeParameter, env)) {
      return false;
    }
  }
  for (let i = 0; i < expectedEffect.regionParameters.length; i++) {
    const expectedRegionParameter = expectedEffect.regionParameters[i];
    const givenRegionParameter = givenEffect.regionParameters[i];
    if (!checkRegion(expectedRegionParameter, givenRegionParameter)) {
      return false;
    }
  }

  /*
  // NOTE: No need to check operations.  
  if (expectedEffect.operations.length !== givenEffect.operations.length) {
    return false;
  }
  */

  return true;
}

export function checkFunctionEffects(
  calleeType: TFunction,
  callerType: TFunction,
  env: Environment
) {
  /*if (calleeType.hasMoreEffects) {
    return true;
  } else if (callerType.hasMoreEffects) {
    return false;
  } else */ {
    return calleeType.effects.every((expectedEffect) => {
      return callerType.effects.some((givenEffect) => {
        return checkEffect(expectedEffect, givenEffect, env);
      });
    });
  }
}

export function typeAndRegionParametersToString(
  typeParameters: TTypeParameter[],
  regionParameters: TRegionParameter[],
  { hideTypeParameterKind }: { hideTypeParameterKind?: boolean } = {}
) {
  if (typeParameters.length + regionParameters.length === 0) {
    return "";
  } else {
    return `<${typeParameters
      .map((type) => typeToString(type, { hideTypeParameterKind }))
      .join(", ")}${
      typeParameters.length > 0 && regionParameters.length > 0 ? ", " : ""
    }${regionParameters
      .map((region) => regionToString(region, { hideTypeParameterKind }))
      .join(", ")}>`;
  }
}

export function regionToString(
  region: Region,
  { hideTypeParameterKind }: { hideTypeParameterKind?: boolean } = {}
) {
  if (region.type === "RegionParameter") {
    return region.appliedRegion
      ? regionToString(region.appliedRegion, { hideTypeParameterKind })
      : `${region.name}${hideTypeParameterKind ? "" : ": Region"}`;
  } else {
    return region.regionId;
  }
}

export function effectToString(
  effect: TEffect,
  {
    extractTypeConstructor,
    hideTypeParameterKind,
  }: {
    extractTypeConstructor?: boolean | "all";
    hideTypeParameterKind?: boolean;
  } = {}
): string {
  if (extractTypeConstructor) {
    return `${effect.isHandler ? "" : "effect "}${
      effect.effectName
    }${typeAndRegionParametersToString(
      effect.typeParameters,
      effect.regionParameters,
      { hideTypeParameterKind }
    )} {
${effect.operations
  .map(({ func, name, functionExpr }) => {
    return `  ${name}: ${typeToString(func, {
      extractTypeConstructor: false,
    })}${functionExpr ? ` ${exprToString(functionExpr.body, "  ")}` : ""}`;
  })
  .join(";\n")};
}`;
  } else {
    return `${effect.effectName}${typeAndRegionParametersToString(
      effect.typeParameters,
      effect.regionParameters,
      { hideTypeParameterKind }
    )}`;
  }
}

export function effectsToString(
  effects: TEffect[],
  // hasMoreEffects: boolean,
  {
    hideTypeParameterKind,
    extractTypeConstructor,
  }: { hideTypeParameterKind?: boolean; extractTypeConstructor?: boolean } = {}
): string {
  if (effects.length === 0 /*&& !hasMoreEffects*/) {
    return "";
  } else {
    return `[${effects
      .map((effect) =>
        effectToString(effect, {
          hideTypeParameterKind,
          extractTypeConstructor,
        })
      )
      .join(", ")}${
      /*
      hasMoreEffects ? (effects.length > 0 ? ", " : "") + `*` : ""
      */ ""
    }]`;
  }
}

export function classToString(type: TClass): string {
  return `${
    type.isInstance
      ? `instance${typeAndRegionParametersToString(
          type.instanceTypeParameters ?? [],
          type.instanceRegionParameters ?? []
        )}`
      : "class"
  } ${type.name}${typeAndRegionParametersToString(
    type.typeParameters,
    type.regionParameters,
    { hideTypeParameterKind: type.isInstance }
  )} {
${type.functions
  .map(
    ({ name, func, functionExpr }) =>
      `  ${stringIsOperator(name) ? `(${name})` : name}: ${typeToString(func, {
        extractTypeConstructor: false,
      })}${functionExpr ? ` ${exprToString(functionExpr.body, "  ")}` : ""}`
  )
  .join(";\n")};
}`;
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

function checkTypeConstructorExactMatch(
  expectedType: TTypeConstructor,
  givenType: TTypeConstructor,
  env: Environment
) {
  if (expectedType.name !== givenType.name) {
    return false;
  }
  if (
    expectedType.typeParameters.length !== givenType.typeParameters.length ||
    expectedType.regionParameters.length !== givenType.regionParameters.length
  ) {
    return false;
  }
  for (let i = 0; i < expectedType.typeParameters.length; i++) {
    if (
      !checkType(
        expectedType.typeParameters[i],
        givenType.typeParameters[i],
        env
      )
    ) {
      return false;
    }
  }
  for (let i = 0; i < expectedType.regionParameters.length; i++) {
    if (
      !checkRegion(
        expectedType.regionParameters[i],
        givenType.regionParameters[i]
      )
    ) {
      return false;
    }
  }
  return true;
}

function checkEnumExactMatchType(
  expectedType: TEnum,
  givenType: TEnum,
  env: Environment
): boolean {
  if (expectedType.enumName !== givenType.enumName) {
    return false;
  }
  if (
    expectedType.variants.length !== givenType.variants.length ||
    expectedType.typeParameters.length !== givenType.typeParameters.length ||
    expectedType.regionParameters.length !== givenType.regionParameters.length
  ) {
    return false;
  }

  for (let i = 0; i < expectedType.typeParameters.length; i++) {
    if (
      !checkType(
        expectedType.typeParameters[i],
        givenType.typeParameters[i],
        env
      )
    ) {
      return false;
    }
  }

  for (let i = 0; i < expectedType.regionParameters.length; i++) {
    if (
      !checkRegion(
        expectedType.regionParameters[i],
        givenType.regionParameters[i]
      )
    ) {
      return false;
    }
  }

  for (let i = 0; i < expectedType.variants.length; i++) {
    const expectedVariant = expectedType.variants[i];
    const givenVariant = givenType.variants[i];
    if (expectedVariant.name !== givenVariant.name) {
      return false;
    }
    if (
      expectedVariant.parameterTypes.length !==
      givenVariant.parameterTypes.length
    ) {
      return false;
    }
    for (let j = 0; j < expectedVariant.parameterTypes.length; j++) {
      if (
        !checkType(
          expectedVariant.parameterTypes[j].type,
          givenVariant.parameterTypes[j].type,
          env
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * This function will modify the `typeParameterToTypeArgumentMap` and `regionParameterToRegionArgumentMap`.
 * If the check failed, it will return false.
 * @param parameterType
 * @param argumentType
 * @param typeParameterToTypeArgumentMap
 * @param regionParameterToRegionArgumentMap
 */
function checkTypeAndRegionParametersAndArguments(
  env: Environment,
  parameterType: Type,
  argumentType: Type,
  typeParameterToTypeArgumentMap: { [key: string]: Type } = {},
  regionParameterToRegionArgumentMap: { [key: string]: Region } = {}
): boolean {
  // .debug("- checkTypeAndRegionParametersAndArguments");
  // logger.debug("  - parameterType: ", typeToString(parameterType));
  // logger.debug("  - argumentType:  ", typeToString(argumentType));
  if (argumentType.type === "TypeParameter" && argumentType.appliedType) {
    return checkTypeAndRegionParametersAndArguments(
      env,
      parameterType,
      argumentType.appliedType,
      typeParameterToTypeArgumentMap,
      regionParameterToRegionArgumentMap
    );
  }
  if (parameterType.type === "TypeParameter") {
    if (parameterType.name in typeParameterToTypeArgumentMap) {
      if (
        !checkType(
          typeParameterToTypeArgumentMap[parameterType.name],
          argumentType,
          env
        )
      ) {
        return false;
      }
    }
    if (parameterType.appliedType) {
      checkTypeAndRegionParametersAndArguments(
        env,
        parameterType.appliedType,
        argumentType,
        typeParameterToTypeArgumentMap,
        regionParameterToRegionArgumentMap
      );
    } else {
      typeParameterToTypeArgumentMap[parameterType.name] = argumentType;
    }
  } else if (
    parameterType.type === "TypeConstructor" &&
    argumentType.type === "TypeConstructor"
  ) {
    const parameterTypeParameters = parameterType.typeParameters;
    const parameterRegionParameters = parameterType.regionParameters;
    const argumentTypeParameters = argumentType.typeParameters;
    const argumentRegionParameters = argumentType.regionParameters;
    if (
      parameterTypeParameters.length !== argumentTypeParameters.length ||
      parameterRegionParameters.length !== argumentRegionParameters.length
    ) {
      return false;
    }
    for (let i = 0; i < parameterTypeParameters.length; i++) {
      const parameterTypeParameter = parameterTypeParameters[i];
      const argumentTypeParameter = argumentTypeParameters[i];
      if (
        !checkTypeAndRegionParametersAndArguments(
          env,
          parameterTypeParameter,
          argumentTypeParameter,
          typeParameterToTypeArgumentMap,
          regionParameterToRegionArgumentMap
        )
      ) {
        return false;
      } /* else {
        typeParameterToTypeArgumentMap[parameterTypeParameter.name] =
          argumentTypeParameter;
      } */
    }
    for (let i = 0; i < parameterRegionParameters.length; i++) {
      const parameterRegionParameter = parameterRegionParameters[i];
      const argumentRegionParameter = argumentRegionParameters[i];
      if (!checkRegion(parameterRegionParameter, argumentRegionParameter)) {
        return false;
      } else {
        let p: TRegionParameter = parameterRegionParameter;
        while (p.type === "RegionParameter") {
          if (p.appliedRegion && p.appliedRegion.type === "RegionParameter") {
            p = p.appliedRegion;
          } else {
            break;
          }
        }

        let a: Region = argumentRegionParameter;
        if (a.appliedRegion) {
          a = a.appliedRegion;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            if (
              a.type === "RegionParameter" &&
              a.appliedRegion &&
              a.appliedRegion.type === "RegionParameter"
            ) {
              a = a.appliedRegion;
            } else {
              break;
            }
          }
        }

        const existingRegionArgument =
          regionParameterToRegionArgumentMap[p.name];
        if (
          existingRegionArgument &&
          existingRegionArgument !== UnknownRegion &&
          !checkRegion(existingRegionArgument, a)
        ) {
          return false;
        }

        regionParameterToRegionArgumentMap[p.name] = a;
      }
    }
  }

  return true;
}

/**
 * Get the real functionArgumentsInOrder by matching the functionArguments with the functionType
 * If not match, then return null
 * @param functionArguments
 * @param functionType
 * @returns
 */
export function getFunctionArgumentsInOrder(
  calleeType: TFunction | TEnum,
  functionParameterTypes: TParameterType[],
  functionArguments: Expr[],
  functionTypeArguments: Type[],
  env: Environment
): {
  functionArguments: Expr[] | null;
  functionTypeArguments: Type[] | null;
  functionRegionArguments: Region[] | null;
} {
  const functionTypeParamters: TTypeParameter[] = calleeType.typeParameters;
  const functionRegionParameters: TRegionParameter[] =
    calleeType.regionParameters;
  logger.debug("- getFunctionArgumentsInOrder: ");
  logger.debug(
    "  - functionParameterTypes: ",
    `(${functionParameterTypes
      .map(({ name, type, defaultValue }) => {
        return `${name}: ${typeToString(type)}${
          defaultValue ? ` = ${exprToString(defaultValue)}` : ""
        }`;
      })
      .join(", ")})`
  );
  logger.debug(
    "  - functionArguments types: ",
    functionArguments.map((expr) => typeToString(expr.typeValue))
  );
  logger.debug(
    "  - functionTypeArguments: ",
    functionTypeArguments.map((type) => typeToString(type))
  );
  logger.debug(
    "  - functionTypeParamters: ",
    functionTypeParamters.map((type) => typeToString(type))
  );
  logger.debug(
    "  - functionRegionParameters: ",
    functionRegionParameters.map((region) => regionToString(region))
  );

  const functionArgumentsInOrder: (Expr | null)[] = functionParameterTypes.map(
    (pt) => pt.defaultValue
  );
  const functionTypeArgumentsInOrder: Type[] = functionTypeParamters.map(
    () => TypeValues.unknown
  );
  const functionRegionArgumentsInOrder: TRegion[] =
    functionRegionParameters.map(() => UnknownRegion);

  for (let i = 0; i < functionArguments.length; i++) {
    const argument = functionArguments[i];

    // Keyword argument
    if (argument.type === AstType.LetAssignment) {
      const keyword = argument.variableName;
      const value = argument.right;
      const argumentPositionIndex = functionParameterTypes.findIndex(
        (pt) => pt.name === keyword
      );
      if (argumentPositionIndex < 0) {
        return {
          functionArguments: null,
          functionTypeArguments: null,
          functionRegionArguments: null,
        };
      } else {
        functionArgumentsInOrder[argumentPositionIndex] = value;
      }
    } else {
      if (i >= functionArgumentsInOrder.length) {
        return {
          functionArguments: null,
          functionTypeArguments: null,
          functionRegionArguments: null,
        };
      }
      // Positional argument
      functionArgumentsInOrder[i] = argument;
    }
  }

  // If functionArgumentsInOrder has any null, then it's not a match
  const typeParameterToTypeArgumentMap: { [key: string]: Type } = {};
  const regionParameterToRegionArgumentMap: { [key: string]: TRegion } = {};
  if (functionArgumentsInOrder.some((arg) => arg === null)) {
    return {
      functionArguments: null,
      functionTypeArguments: null,
      functionRegionArguments: null,
    };
  } else {
    // Check if the functionArgumentsInOrder has the same types as the functionParameterTypes
    logger.debug("  - check functionArgumentsInOrder types");
    for (let i = 0; i < functionArgumentsInOrder.length; i++) {
      const argument = functionArgumentsInOrder[i];
      const parameterType = functionParameterTypes[i];

      logger.debug("    - argument: ", typeToString(argument!.typeValue!));
      logger.debug("    - parameterType: ", typeToString(parameterType.type));
      logger.debug(
        "    - checkType: ",
        checkType(parameterType.type, argument!.typeValue, env)
      );

      if (
        !argument ||
        !checkType(parameterType.type, argument.typeValue, env)
      ) {
        return {
          functionArguments: null,
          functionTypeArguments: null,
          functionRegionArguments: null,
        };
      }

      if (
        !checkTypeAndRegionParametersAndArguments(
          env,
          parameterType.type,
          argument.typeValue,
          typeParameterToTypeArgumentMap,
          regionParameterToRegionArgumentMap
        )
      ) {
        return {
          functionArguments: null,
          functionTypeArguments: null,
          functionRegionArguments: null,
        };
      }
    }

    logger.debug(
      "  - typeParameterToTypeArgumentMap: ",
      typeParameterToTypeArgumentMap
    );
    logger.debug(
      "  - regionParameterToRegionArgumentMap: ",
      regionParameterToRegionArgumentMap
    );

    for (let i = 0; i < functionTypeParamters.length; i++) {
      const typeParameter = functionTypeParamters[i];
      const typeArgument = functionTypeArguments[i];
      if (typeParameter.appliedType) {
        functionTypeArgumentsInOrder[i] = typeParameter.appliedType;
      } else if (typeParameter.name in typeParameterToTypeArgumentMap) {
        // logger.debug(typeArgument);
        // Check type
        if (!typeArgument || typeArgument.type === "unknown") {
          functionTypeArgumentsInOrder[i] =
            typeParameterToTypeArgumentMap[typeParameter.name];
        } else if (
          !checkType(
            typeArgument,
            typeParameterToTypeArgumentMap[typeParameter.name],
            env
          )
        ) {
          return {
            functionArguments: null,
            functionTypeArguments: null,
            functionRegionArguments: null,
          };
        }
      } else if (typeArgument) {
        functionTypeArgumentsInOrder[i] = typeArgument;
      } /* else {
        return {
          functionArguments: functionArgumentsInOrder as Expr[],
          functionTypeArguments: null,
        };
      } */
    }

    for (let i = 0; i < functionRegionParameters.length; i++) {
      const regionParameter = functionRegionParameters[i];
      if (regionParameter.name in regionParameterToRegionArgumentMap) {
        const existingRegionArgument = functionRegionArgumentsInOrder[i];
        logger.debug("existingRegionArgument: ", existingRegionArgument);
        if (
          existingRegionArgument &&
          existingRegionArgument !== UnknownRegion &&
          !checkRegion(
            existingRegionArgument,
            regionParameterToRegionArgumentMap[regionParameter.name]
          )
        ) {
          return {
            functionArguments: null,
            functionTypeArguments: null,
            functionRegionArguments: null,
          };
        }

        functionRegionArgumentsInOrder[i] =
          regionParameterToRegionArgumentMap[regionParameter.name];
      }
    }

    logger.debug(
      "  - functionTypeArgumentsInOrder: ",
      functionTypeArgumentsInOrder.map((type) => typeToString(type))
    );
    logger.debug(
      "  - functionRegionArgumentsInOrder: ",
      functionRegionArgumentsInOrder.map((region) => regionToString(region))
    );

    return {
      functionArguments: functionArgumentsInOrder as Expr[],
      functionTypeArguments: functionTypeArgumentsInOrder,
      functionRegionArguments: functionRegionArgumentsInOrder,
    };
  }
}

export function getFunctionsOfCallerFromEnv(
  callerType: Type,
  functionName: string,
  env: Environment
) {
  const functionTypes = getEnvValueTypesByVariableName(env, functionName);
  // Find the functions that takes `expr` as the first argument
  const matchedFunctions = functionTypes.filter((functionType) => {
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
  /*
  if (callerType.type === "Interface") {
    const matchedFunctionsInInterface: ValueType[] = callerType.functions
      .map(({ func, name }) => {
        const valueType: ValueType = {
          type: func,
          variableName: name,
          id: func.id,
          frameLevel: 0,
          kind: "value",
        };
        if (functionName === name) {
          return valueType;
        } else {
          return null;
        }
      })
      .filter((func) => func !== null) as ValueType[];
    matchedFunctions = matchedFunctions.concat(matchedFunctionsInInterface);
  }
  */

  return matchedFunctions;
}

export function getEnumTagSize(enumType: TEnum): 8 | 16 | 32 {
  if (enumType.variants.length <= Math.pow(2, 8)) {
    return 8;
  } else if (enumType.variants.length <= Math.pow(2, 16)) {
    return 16;
  } else {
    return 32;
  }
}

function mixTypeKind(kind1: TypeKind, kind2: TypeKind): TypeKind {
  if (kind1 === "Type" || kind2 === "Type") {
    return "Type";
  } else if (kind1 === "Linear" || kind2 === "Linear") {
    return "Linear";
  } else {
    return "Free";
  }
}

export function typeIsReferenceOrMutableReference(
  type: Type
): "&" | "&!" | null {
  if (type.type === "TypeConstructor") {
    if (type.name === "&" || type.name === "&!") {
      return type.name;
    }
  }
  return null;
}

export function typeIsFunctionTypeThatReturnsPromise(
  type: Type
): TTypeConstructor | null {
  if (
    type.type === "Function" &&
    type.returnType.type === "TypeConstructor" &&
    type.returnType.name === "Promise"
  ) {
    return type.returnType;
  } else {
    return null;
  }
}

export function typeIsPromise(type: Type): TTypeConstructor | null {
  if (type.type === "TypeConstructor" && type.name === "Promise") {
    return type;
  } else {
    return null;
  }
}

function synthesizeTypeAndRegionParameters({
  typeParameters,
  regionParameters,
  givenTypeParameters,
  givenRegionParameters,
  typeParameterToTypeArgumentMap,
  regionParameterToRegionArgumentMap,
}: {
  typeParameters: TTypeParameter[];
  regionParameters: TRegionParameter[];
  givenTypeParameters: TTypeParameter[];
  givenRegionParameters: TRegionParameter[];
  typeParameterToTypeArgumentMap: { [key: string]: Type };
  regionParameterToRegionArgumentMap: { [key: string]: Region };
}): void {
  for (let i = 0; i < typeParameters.length; i++) {
    const typeParameter = typeParameters[i];
    if (
      !typeParameter.appliedType ||
      typeParameter.appliedType.type === "unknown"
    ) {
      typeParameter.appliedType = givenTypeParameters[i].appliedType;
      if (typeParameter.appliedType) {
        typeParameterToTypeArgumentMap[typeParameter.name] =
          typeParameter.appliedType;
      }
    }
  }
  for (let i = 0; i < regionParameters.length; i++) {
    const regionParameter = regionParameters[i];
    if (
      !regionParameter.appliedRegion ||
      regionParameter.appliedRegion === UnknownRegion
    ) {
      regionParameter.appliedRegion = givenRegionParameters[i].appliedRegion;
      if (regionParameter.appliedRegion) {
        regionParameterToRegionArgumentMap[regionParameter.name] =
          regionParameter.appliedRegion;
      }
    }
  }
}

/**
 * This function is used in parser.ts parseLetAssignment
 * @param userDefinedType
 * @param givenType
 * @returns
 */
export function synthesizeTypes({
  userDefinedType,
  givenType,
  typeParameterToTypeArgumentMap,
  regionParameterToRegionArgumentMap,
}: {
  userDefinedType: Type;
  givenType: Type;
  typeParameterToTypeArgumentMap;
  regionParameterToRegionArgumentMap;
}): {
  userDefinedType: Type;
  givenType: Type;
  typeParameterToTypeArgumentMap: { [key: string]: Type };
  regionParameterToRegionArgumentMap: { [key: string]: Region };
} {
  // Type inference for enum type
  if (
    userDefinedType.type === "Enum" &&
    givenType.type === "Enum" &&
    userDefinedType.enumName === givenType.enumName &&
    (userDefinedType.selectedVariantName === undefined ||
      userDefinedType.selectedVariantName === givenType.selectedVariantName)
  ) {
    synthesizeTypeAndRegionParameters({
      typeParameters: userDefinedType.typeParameters,
      regionParameters: userDefinedType.regionParameters,
      givenTypeParameters: givenType.typeParameters,
      givenRegionParameters: givenType.regionParameters,
      typeParameterToTypeArgumentMap,
      regionParameterToRegionArgumentMap,
    });
    userDefinedType.selectedVariantName = givenType.selectedVariantName;
  }

  if (userDefinedType.type === "slice") {
    let userType = userDefinedType;
    let valueType = givenType as TSlice;
    // Assign size to the slice if it's undefined
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (userType.size === undefined) {
        userType.size = valueType.size;
      } else if (valueType.size && valueType.size < userType.size) {
        valueType.size = userType.size;
      }

      if (userType.elementType.type === "slice") {
        userType = userType.elementType;
        valueType = valueType.elementType as TSlice;
      } else {
        break;
      }
    }
  }

  // userDefinedVariableType = variableType;
  // Assign region to userDefinedVariableType if it's not set
  if (userDefinedType.type === "TypeConstructor") {
    if (givenType.type === "TypeConstructor") {
      synthesizeTypeAndRegionParameters({
        typeParameters: userDefinedType.typeParameters,
        regionParameters: userDefinedType.regionParameters,
        givenTypeParameters: givenType.typeParameters,
        givenRegionParameters: givenType.regionParameters,
        typeParameterToTypeArgumentMap,
        regionParameterToRegionArgumentMap,
      });
    } else {
      synthesizeTypes({
        userDefinedType: userDefinedType.typeValue,
        givenType,
        typeParameterToTypeArgumentMap,
        regionParameterToRegionArgumentMap,
      });
      for (let i = 0; i < userDefinedType.typeParameters.length; i++) {
        const typeParameter = userDefinedType.typeParameters[i];
        if (
          (!typeParameter.appliedType ||
            typeParameter.appliedType.type === "unknown") &&
          typeParameter.name in typeParameterToTypeArgumentMap
        ) {
          typeParameter.appliedType =
            typeParameterToTypeArgumentMap[typeParameter.name];
        }
      }
      for (let i = 0; i < userDefinedType.regionParameters.length; i++) {
        const regionParameter = userDefinedType.regionParameters[i];
        if (
          (!regionParameter.appliedRegion ||
            regionParameter.appliedRegion === UnknownRegion) &&
          regionParameter.name in regionParameterToRegionArgumentMap
        ) {
          regionParameter.appliedRegion =
            regionParameterToRegionArgumentMap[regionParameter.name];
        }
      }
    }
  }

  if (userDefinedType.type === "Function" && givenType.type === "Function") {
    synthesizeTypeAndRegionParameters({
      typeParameters: userDefinedType.typeParameters,
      regionParameters: userDefinedType.regionParameters,
      givenTypeParameters: givenType.typeParameters,
      givenRegionParameters: givenType.regionParameters,
      typeParameterToTypeArgumentMap,
      regionParameterToRegionArgumentMap,
    });
    givenType.functionId = userDefinedType.functionId;
  }

  if (userDefinedType.type === "Record" && givenType.type === "Record") {
    if (userDefinedType.properties.length !== givenType.properties.length) {
      throw new Error(
        `Cannot synthesize types for record with different number of properties`
      );
    }
    for (let i = 0; i < userDefinedType.properties.length; i++) {
      const userDefinedTypeProperty = userDefinedType.properties[i];
      const givenTypeProperty = givenType.properties[i];
      if (userDefinedTypeProperty.name !== givenTypeProperty.name) {
        throw new Error(
          `Cannot synthesize types for record with different property names`
        );
      }
      if (
        !userDefinedTypeProperty.type ||
        userDefinedTypeProperty.type.type === "unknown"
      ) {
        userDefinedTypeProperty.type = givenTypeProperty.type;
      } /*else if (
        !givenTypeProperty.type ||
        givenTypeProperty.type.type === "unknown"
      ) {
        givenTypeProperty.type = userDefinedTypeProperty.type;
      }*/ else {
        synthesizeTypes({
          userDefinedType: userDefinedTypeProperty.type,
          givenType: givenTypeProperty.type,
          typeParameterToTypeArgumentMap,
          regionParameterToRegionArgumentMap,
        });
      }
    }
  }

  return {
    userDefinedType,
    givenType,
    typeParameterToTypeArgumentMap,
    regionParameterToRegionArgumentMap,
  };
}
