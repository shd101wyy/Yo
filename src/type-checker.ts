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
  getEnvCurrentFrameLevel,
  getEnvValueTypesByVariableName,
  popEnvFrame,
  pushEnvFrame,
} from "./env";
import { formatErrorMessage } from "./error";
import { isUpperCamelCase } from "./naming-checker";
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

export type TChar = {
  type: "char";
  kind: "Free";
};

export type TU1 = {
  type: "u1";
  kind: "Free";
};

export type TI1 = {
  type: "i1";
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

export type TRegionParameter = {
  type: "RegionParameter";
  kind: RegionKind;
  name: string;
  appliedRegion?: TRegion;
};

export type TFunction = {
  type: "Function";
  kind: "Free";
  typeParameters: TTypeParameter[];
  regionParameters: TRegionParameter[];
  parameterTypes: TParameterType[];
  effects: TEffect[];
  hasMoreEffects: boolean;
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
  /**
   * If it's true, then it means the operation uses `resume` or `abort`
   * and might not be tail-resumptive.
   */
  isControlled: boolean;
};

export type TEffect = {
  type: "Effect";
  effectName: string;
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
   * - mo://std
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
  u1: TU1;
  u8: TU8;
  u16: TU16;
  u32: TU32;
  u64: TU64;
  u128: TU128;
  i1: TI1;
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
} = {
  unit: { type: "()", kind: "Free" },
  boolean: { type: "boolean", kind: "Free" },
  char: { type: "char", kind: "Free" },
  u1: { type: "u1", kind: "Free" },
  u8: { type: "u8", kind: "Free" },
  u16: { type: "u16", kind: "Free" },
  u32: { type: "u32", kind: "Free" },
  u64: { type: "u64", kind: "Free" },
  u128: { type: "u128", kind: "Free" },
  i1: { type: "i1", kind: "Free" },
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
    kind: "Linear",
    name: "&!",
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
};

export const emptyFunctionThatHasMoreEffects: TFunction = {
  effects: [],
  hasMoreEffects: true,
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

type ParseExpression = ({
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
    type.type === "i1" ||
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
    type.type === "u1" ||
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
          inputString,
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
            typeValue: propertyType,
            index: nextIndex,
            env: nextEnv,
          } = synthesizeTypeFromTokens({
            tokens,
            index,
            inputString,
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
        inputString,
      });
    } else if (
      userDefinedKind &&
      userDefinedKind === "Linear" &&
      kind === "Type"
    ) {
      throw formatErrorMessage({
        token: tokens[userDefinedKindTokenIndex],
        errorMessage: `Cannot set type as 'Linear' because it contains 'Type' data.`,
        inputString,
      });
    } else if (
      userDefinedKind &&
      userDefinedKind === "Type" &&
      kind === "Linear"
    ) {
      throw formatErrorMessage({
        token: tokens[userDefinedKindTokenIndex],
        errorMessage: `Cannot set type as 'Type' because it contains 'Linear' data.`,
        inputString,
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
              inputString,
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
  } else if (nextTokenType === TokenType.BitwiseAnd) {
    const index = returnValue.index + 1;

    const newReturnValue = synthesizeTypeFromTokens({
      tokens,
      index,
      inputString,
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
        errorMessage: `(1) Mismatched type arguments.
Expected: <${typeParameters
          .map(
            (typeParameter) => `${typeParameter.name}: ${typeParameter.kind}`
          )
          .join(", ")}>
Got:      <${typeArguments.map((type) => typeToString(type)).join(", ")}>`,
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
  } else if (typeValue.type === "Enum") {
    if (typeValue.typeParameters.length !== typeArguments.length) {
      throw formatErrorMessage({
        token: tokens[returnValue.index],
        errorMessage: `(2) Mismatched type arguments.
Expected: <${typeValue.typeParameters
          .map(
            (typeParameter) => `${typeParameter.name}: ${typeParameter.kind}`
          )
          .join(", ")}>
Got:      <${typeArguments.map((type) => typeToString(type)).join(", ")}>`,
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
  console.log("- applyTypeArgumentsToType");
  console.log("  - type: ", type.type);
  console.log("    - typeToString(type): ", typeToString(type));
  console.log(
    "  - typeArguments: ",
    typeArguments.map((type) => typeToString(type))
  );
  console.log(
    "  - typeParameterToTypeArgumentMap: ",
    typeParameterToTypeArgumentMap
  );
  if (type.type === "TypeConstructor") {
    const typeValue = type.typeValue;
    if (type.typeParameters.length !== typeArguments.length) {
      throw new Error(
        `(3) Mismatched type arguments.
  Expected: <${type.typeParameters
    .map((typeParameter) => `${typeParameter.name}: ${typeParameter.kind}`)
    .join(", ")}>
  Got:      <${typeArguments.map((type) => typeToString(type)).join(", ")}>`
      );
    }

    // set typeParameterToTypeArgumentMap
    const newTypeParameters: TTypeParameter[] = [];
    for (let i = 0; i < type.typeParameters.length; i++) {
      const typeParameter = type.typeParameters[i];
      const typeArgument = typeArguments[i];
      typeParameterToTypeArgumentMap[typeParameter.name] = typeArgument;
      newTypeParameters.push({
        ...typeParameter,
        appliedType: typeArgument,
      });
    }

    const newTypeValue = applyTypeArgumentsToType(
      typeValue,
      typeArguments,
      typeParameterToTypeArgumentMap
    );
    return {
      type: "TypeConstructor",
      kind: newTypeValue.kind,
      name: type.name,
      typeParameters: newTypeParameters,
      regionParameters: type.regionParameters,
      typeValue: newTypeValue,
    };
  } else if (type.type === "Enum") {
    // set typeParameterToTypeArgumentMap
    const newTypeParameters: TTypeParameter[] = [];
    for (let i = 0; i < type.typeParameters.length; i++) {
      const typeParameter = type.typeParameters[i];
      const typeArgument = typeArguments[i];
      typeParameterToTypeArgumentMap[typeParameter.name] = typeArgument;
      newTypeParameters.push({
        ...typeParameter,
        appliedType: typeArgument,
      });
    }

    // apply to each of the variants
    const variants: TEnumVariant[] = type.variants.map(
      ({ name, parameterTypes }) => ({
        name,
        parameterTypes: parameterTypes.map((parameterType) => {
          const defaultValue = parameterType.defaultValue;
          const newParameterType: TParameterType = {
            name: parameterType.name,
            isMutable: false, // QUESTION: Is this correct?
            type: applyTypeArgumentsToType(
              parameterType.type,
              typeArguments,
              typeParameterToTypeArgumentMap
            ),
            defaultValue: defaultValue
              ? applyTypeArgumentsToExpr(
                  defaultValue,
                  typeArguments,
                  typeParameterToTypeArgumentMap
                )
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
      regionParameters: type.regionParameters,
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
    if (typeParameters.length !== typeArguments.length) {
      throw new Error(
        `(5) Mismatched type arguments.
  Expected: <${typeParameters
    .map((typeParameter) => `${typeParameter.name}: ${typeParameter.kind}`)
    .join(", ")}>
  Got:      <${typeArguments.map((type) => typeToString(type)).join(", ")}>`
      );
    }

    // set typeParameterToTypeArgumentMap
    const newTypeParameters: TTypeParameter[] = [];
    for (let i = 0; i < type.typeParameters.length; i++) {
      const typeParameter = type.typeParameters[i];
      const typeArgument = typeArguments[i];
      typeParameterToTypeArgumentMap[typeParameter.name] = typeArgument;
      newTypeParameters.push({
        ...typeParameter,
        appliedType: typeArgument,
      });
    }

    const newFunctionType: TFunction = {
      ...type,
      typeParameters: newTypeParameters,
      parameterTypes: type.parameterTypes.map(
        ({ name, type, isMutable, defaultValue }) => ({
          name,
          isMutable,
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
      effects: type.effects.map((effect) =>
        applyTypeArgumentsToEffect(
          effect,
          typeArguments,
          typeParameterToTypeArgumentMap
        )
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
          type: applyTypeArgumentsToType(
            type,
            typeArguments,
            typeParameterToTypeArgumentMap
          ),
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

export function applyTypeArgumentsToEffect(
  effect: TEffect,
  typeArguments: Type[],
  typeParameterToTypeArgumentMap: { [key: string]: Type } = {}
): TEffect {
  const typeParameters = effect.typeParameters;
  if (typeParameters.length !== typeArguments.length) {
    throw new Error(
      `(7) Mismatched type arguments.
Expected: <${typeParameters
        .map((typeParameter) => `${typeParameter.name}: ${typeParameter.kind}`)
        .join(", ")}>
Got:      <${typeArguments.map((type) => typeToString(type)).join(", ")}>`
    );
  }
  // set typeParameterToTypeArgumentMap
  const newTypeParameters: TTypeParameter[] = [];
  for (let i = 0; i < effect.typeParameters.length; i++) {
    const typeParameter = effect.typeParameters[i];
    const typeArgument = typeArguments[i];
    typeParameterToTypeArgumentMap[typeParameter.name] = typeArgument;
    newTypeParameters.push({
      ...typeParameter,
      appliedType: typeArgument,
    });
  }

  const newEffect: TEffect = {
    ...effect,
    typeParameters: newTypeParameters,
    operations: effect.operations.map((operation) => ({
      ...operation,
      func: applyTypeArgumentsToType(
        operation.func,
        typeArguments,
        typeParameterToTypeArgumentMap
      ) as TFunction,
    })),
    isHandler: true,
  };
  return newEffect;
}

export function applyTypeArgumentsToClass(
  class_: TClass,
  typeArguments: Type[],
  typeParameterToTypeArgumentMap: { [key: string]: Type } = {}
): TClass {
  if (class_.typeParameters.length !== typeArguments.length) {
    throw new Error(
      `(4) Mismatched type arguments.
Expected: <${class_.typeParameters
        .map((typeParameter) => `${typeParameter.name}: ${typeParameter.kind}`)
        .join(", ")}>
Got:      <${typeArguments.map((type) => typeToString(type)).join(", ")}>`
    );
  }

  // set typeParameterToTypeArgumentMap
  const newTypeParameters: TTypeParameter[] = [];
  for (let i = 0; i < class_.typeParameters.length; i++) {
    const typeParameter = class_.typeParameters[i];
    const typeArgument = typeArguments[i];
    typeParameterToTypeArgumentMap[typeParameter.name] = typeArgument;
    newTypeParameters.push({
      ...typeParameter,
      appliedType: typeArgument,
    });
  }

  // apply to each of the functions
  const functions: TClassFunction[] = class_.functions.map(
    ({ name, func, functionExpr }) => ({
      name,
      func: applyTypeArgumentsToType(
        func,
        typeArguments,
        typeParameterToTypeArgumentMap
      ),
      functionExpr: functionExpr
        ? applyTypeArgumentsToExpr(
            functionExpr,
            typeArguments,
            typeParameterToTypeArgumentMap
          )
        : undefined,
    })
  ) as TClassFunction[];

  return {
    type: "Class",
    kind: "Free",
    name: class_.name,
    typeParameters: newTypeParameters,
    regionParameters: class_.regionParameters,
    functions: functions,

    isInstance: true, // type.isInstance,
    instanceTypeParameters: class_.instanceTypeParameters,
    instanceRegionParameters: class_.instanceRegionParameters,
  };
}

export function applyTypeArgumentsToFunctionExpr(
  expr: FunctionExpr,
  typeArguments: Type[],
  typeParameterToTypeArgumentMap: { [key: string]: Type } = {}
): FunctionExpr {
  const typeParameters = expr.typeValue.typeParameters;
  if (typeParameters.length !== typeArguments.length) {
    throw new Error(
      `(6) Mismatched type arguments.
Expected: <${typeParameters
        .map((typeParameter) => `${typeParameter.name}: ${typeParameter.kind}`)
        .join(", ")}>
Got:      <${typeArguments.map((type) => typeToString(type)).join(", ")}>`
    );
  }
  // set typeParameterToTypeArgumentMap
  // const typeParameterToTypeArgumentMap: { [key: string]: Type } = {};
  for (let i = 0; i < expr.typeValue.typeParameters.length; i++) {
    const typeParameter = expr.typeValue.typeParameters[i];
    const typeArgument = typeArguments[i];
    typeParameterToTypeArgumentMap[typeParameter.name] = typeArgument;
  }

  const newTypeValue = applyTypeArgumentsToType(
    expr.typeValue,
    typeArguments,
    typeParameterToTypeArgumentMap
  );
  if (newTypeValue.type !== "Function") {
    throw new Error(
      `Expected function type, but got ${typeToString(newTypeValue)}`
    );
  }

  return {
    ...expr,
    typeValue: newTypeValue,
    body: applyTypeArgumentsToExpr(
      expr.body,
      [], // typeArguments,
      typeParameterToTypeArgumentMap
    ) as BlockExpr,
  };
}

export function applyTypeArgumentsToExpr(
  expr: Expr,
  typeArguments: Type[],
  typeParameterToTypeArgumentMap: { [key: string]: Type } = {}
): Expr {
  console.log("- applyTypeArgumentsToExpr");
  console.log("  - expr: ", exprToString(expr));
  console.log(
    "  - typeArguments: ",
    typeArguments.map((type) => typeToString(type))
  );
  console.log(
    "  - typeParameterToTypeArgumentMap: ",
    typeParameterToTypeArgumentMap
  );
  switch (expr.type) {
    case AstType.Value: {
      switch (expr.tag) {
        case "record": {
          return {
            ...expr,
            typeValue: applyTypeArgumentsToType(
              expr.typeValue,
              typeArguments,
              typeParameterToTypeArgumentMap
            ),
            properties: expr.properties.map(({ name, value: expr }) => ({
              name,
              value: applyTypeArgumentsToExpr(
                expr,
                typeArguments,
                typeParameterToTypeArgumentMap
              ),
            })),
          };
        }
        case "slice": {
          return {
            ...expr,
            typeValue: applyTypeArgumentsToType(
              expr.typeValue,
              typeArguments,
              typeParameterToTypeArgumentMap
            ),
            values: expr.values.map((expr) =>
              applyTypeArgumentsToExpr(
                expr,
                typeArguments,
                typeParameterToTypeArgumentMap
              )
            ),
          };
        }
        default:
          return expr;
      }
    }
    case AstType.Function: {
      return applyTypeArgumentsToFunctionExpr(
        expr,
        typeArguments,
        typeParameterToTypeArgumentMap
      );
    }
    case AstType.LetAssignment: {
      return {
        ...expr,
        variableType: applyTypeArgumentsToType(
          expr.variableType,
          typeArguments,
          typeParameterToTypeArgumentMap
        ),
        right: applyTypeArgumentsToExpr(
          expr.right,
          typeArguments,
          typeParameterToTypeArgumentMap
        ),
      };
    }
    case AstType.UnaryOperator: {
      return {
        ...expr,
        typeValue: applyTypeArgumentsToType(
          expr.typeValue,
          typeArguments,
          typeParameterToTypeArgumentMap
        ),
        expr: applyTypeArgumentsToExpr(
          expr.expr,
          typeArguments,
          typeParameterToTypeArgumentMap
        ),
      };
    }
    case AstType.BinaryOperator: {
      return {
        ...expr,
        typeValue: applyTypeArgumentsToType(
          expr.typeValue,
          typeArguments,
          typeParameterToTypeArgumentMap
        ),
        left: applyTypeArgumentsToExpr(
          expr.left,
          typeArguments,
          typeParameterToTypeArgumentMap
        ),
        right: applyTypeArgumentsToExpr(
          expr.right,
          typeArguments,
          typeParameterToTypeArgumentMap
        ),
      };
    }
    case AstType.Variable: {
      return {
        ...expr,
        typeValue: applyTypeArgumentsToType(
          expr.typeValue,
          typeArguments,
          typeParameterToTypeArgumentMap
        ),
      };
    }
    case AstType.PropertyAccess: {
      return {
        ...expr,
        typeValue: applyTypeArgumentsToType(
          expr.typeValue,
          typeArguments,
          typeParameterToTypeArgumentMap
        ),
        expr: applyTypeArgumentsToExpr(
          expr.expr,
          typeArguments,
          typeParameterToTypeArgumentMap
        ),
      };
    }
    case AstType.IndexAccess: {
      return {
        ...expr,
        typeValue: applyTypeArgumentsToType(
          expr.typeValue,
          typeArguments,
          typeParameterToTypeArgumentMap
        ),
        expr: applyTypeArgumentsToExpr(
          expr.expr,
          typeArguments,
          typeParameterToTypeArgumentMap
        ),
        indexes: expr.indexes.map((expr) =>
          applyTypeArgumentsToExpr(
            expr,
            typeArguments,
            typeParameterToTypeArgumentMap
          )
        ),
      };
    }
    case AstType.CallFunction: {
      return {
        ...expr,
        callee: applyTypeArgumentsToExpr(
          expr.callee,
          typeArguments,
          typeParameterToTypeArgumentMap
        ),
        typeArguments: expr.typeArguments.map((typeArgument) =>
          applyTypeArgumentsToType(
            typeArgument,
            typeArguments,
            typeParameterToTypeArgumentMap
          )
        ),
        functionArguments: expr.functionArguments.map((expr) =>
          applyTypeArgumentsToExpr(
            expr,
            typeArguments,
            typeParameterToTypeArgumentMap
          )
        ),
        typeValue: applyTypeArgumentsToType(
          expr.typeValue,
          typeArguments,
          typeParameterToTypeArgumentMap
        ),
      };
    }
    case AstType.If: {
      const newIfExpr: IfExpr = {
        ...expr,
        cases: expr.cases.map(({ condition, body }) => {
          return {
            condition: condition
              ? applyTypeArgumentsToExpr(
                  condition,
                  typeArguments,
                  typeParameterToTypeArgumentMap
                )
              : undefined,
            body: applyTypeArgumentsToExpr(
              body,
              typeArguments,
              typeParameterToTypeArgumentMap
            ) as BlockExpr,
          };
        }),
        typeValue: applyTypeArgumentsToType(
          expr.typeValue,
          typeArguments,
          typeParameterToTypeArgumentMap
        ),
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
          applyTypeArgumentsToExpr(
            expr,
            typeArguments,
            typeParameterToTypeArgumentMap
          )
        ),
        typeValue: applyTypeArgumentsToType(
          expr.typeValue,
          typeArguments,
          typeParameterToTypeArgumentMap
        ),
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
    let token = tokens[index];
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
        inputString,
      });
    }
    const parameterName = token.value;

    // check type
    let userDefinedParamterType: Type = TypeValues.unknown;
    if (tokens[index + 1].type !== TokenType.Colon) {
      // index = index + 1;
      throw formatErrorMessage({
        token: tokens[index + 1],
        errorMessage: "Expected ':' after parameter name",
        inputString,
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
      isMutable,
    });

    parameterTypes.push({
      name: parameterName,
      isMutable,
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

    if (token.type === TokenType.BitwiseShiftRight) {
      // Split this token into two '>' tokens
      tokens.splice(
        index,
        1,
        {
          type: TokenType.GreaterThan,
          value: ">",
          position: {
            line: token.position.line,
            character: token.position.character,
          },
        },
        {
          type: TokenType.GreaterThan,
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

export function synthesizeEffectsFromTokens({
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
}): {
  effects: TEffect[];
  hasMoreEffects: boolean;
  index: number;
} {
  const effects: TEffect[] = [];
  let hasMoreEffects = false;

  if (tokens[index].type !== TokenType.LessThan) {
    throw formatErrorMessage({
      token: tokens[index],
      errorMessage: "Expected '<' in effects declaration",
      inputString,
    });
  }
  index = index + 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!tokens[index]) {
      throw formatErrorMessage({
        token: tokens[index - 1],
        errorMessage: "Expected '}'",
        inputString,
      });
    }
    if (tokens[index].type === TokenType.GreaterThan) {
      index = index + 1;
      break;
    }

    if (tokens[index].type === TokenType.Multiply) {
      hasMoreEffects = true;
      index = index + 1;
    } else {
      if (tokens[index].type !== TokenType.Identifier) {
        throw formatErrorMessage({
          token: tokens[index],
          errorMessage: "Expected identifier as effect name",
          inputString,
        });
      }
      const effectName = tokens[index].value;
      index = index + 1;

      let typeArguments: Type[] = [];
      if (tokens[index].type === TokenType.LessThan) {
        const {
          typeArguments: nextTypeArguments,
          index: nextIndex,
          env: nextEnv,
        } = synthesizeTypeArgumentsFromTokens({
          tokens,
          index,
          inputString,
          env,
          parseExpression,
        });
        typeArguments = nextTypeArguments;
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
          inputString,
        });
      } else if (effectValues.length > 1) {
        throw formatErrorMessage({
          token: tokens[index],
          errorMessage: `Ambiguous effect ${effectName}`,
          inputString,
        });
      } else {
        const effect = effectValues[0].effect;
        if (!effect) {
          throw formatErrorMessage({
            token: tokens[index],
            errorMessage: `Cannot find effect ${effectName}`,
            inputString,
          });
        }
        const newEffect = applyTypeArgumentsToEffect(effect, typeArguments, {});
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
    hasMoreEffects,
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
}): { typeValue: TFunction; index: number; env: Environment } {
  // Type parameters
  let frameLevel = getEnvCurrentFrameLevel(env);
  if (withFunctionBody) {
    frameLevel -= 1;
  }

  let typeParameters: TTypeParameter[] = [];
  let regionParameters: TRegionParameter[] = [];
  if (tokens[index].type === TokenType.LessThan) {
    const {
      typeParameters: nextTypeParameters,
      regionParameters: nextRegionParameters,
      index: nextIndex,
      env: nextEnv,
    } = synthesizeTypeAndRegionParametersFromTokens({
      tokens,
      index,
      env,
      inputString,
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

  if (
    tokens[index].type === TokenType.FatArrow ||
    tokens[index].type === TokenType.FunctionArrow
  ) {
    const isClosure = tokens[index].type === TokenType.FatArrow;
    index = index + 1;

    // Effects
    let effects: TEffect[] = [];
    let hasMoreEffects = false;
    if (tokens[index].type === TokenType.LessThan) {
      const {
        effects: nextEffects,
        hasMoreEffects: nextHasMoreEffects,
        index: nextNextIndex,
      } = synthesizeEffectsFromTokens({
        tokens,
        index,
        inputString,
        env,
        parseExpression,
      });
      effects = nextEffects;
      hasMoreEffects = nextHasMoreEffects;
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
        inputString,
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
        parameterTypes,
        typeParameters,
        regionParameters,
        returnType,
        effects,
        hasMoreEffects,
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
      inputString,
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
function parseTypeAndRegionKind(
  tokens: Token[],
  index: number,
  inputString: string
): TypeKind | RegionKind {
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
  inputString,
}: {
  tokens: Token[];
  index: number;
  env: Environment;
  inputString: string;
}): {
  typeParameters: TTypeParameter[];
  regionParameters: TRegionParameter[];
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
  const regionParameters: TRegionParameter[] = [];
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
    if (!isUpperCamelCase(typeParameterName)) {
      throw formatErrorMessage({
        token,
        errorMessage: `Type parameter name "${typeParameterName}" must be UpperCamelCase`,
        inputString,
      });
    }

    // Check type kind
    let kind: TypeKind | RegionKind | undefined = undefined;
    if (tokens[index + 1].type === TokenType.Colon) {
      index = index + 2;
      kind = parseTypeAndRegionKind(tokens, index, inputString);
      if (!kind) {
        throw formatErrorMessage({
          token: tokens[index],
          errorMessage: `Unknown kind ${tokens[index].value}. Expected 'Type', 'Linear', 'Free', or 'Region'`,
          inputString,
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
      env = addEnvValueType(env, {
        variableName: typeParameterName,
        type: TypeValues.unknown,
        region: regionParameter,
        kind: "region",
      });
    } else {
      const typeParameter: TTypeParameter = {
        type: "TypeParameter",
        kind: kind,
        name: typeParameterName,
      };
      typeParameters.push(typeParameter);

      // Save to env
      env = addEnvValueType(env, {
        variableName: typeParameterName,
        type: typeParameter,
        kind: "type",
      });
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
      return `${typeAndRegionParametersToString(
        type.typeParameters,
        type.regionParameters,
        { hideTypeParameterKind }
      )}(${type.parameterTypes
        .map(
          (parameter) =>
            (parameter.name ? `${parameter.name}: ` : "") +
            typeToString(parameter.type, { hideTypeParameterKind: true })
        )
        .join(", ")})${type.isClosure ? "=>" : "->"} ${effectsToString(
        type.effects,
        type.hasMoreEffects,
        { hideTypeParameterKind: true }
      )}${typeToString(type.returnType, {
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
        expectedType = applyTypeArgumentsToType(realType, typeArguments);
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

export function checkRegion(
  expectedRegion: TRegionParameter,
  givenRegion: TRegionParameter
) {
  if (!expectedRegion.appliedRegion) {
    return true;
  } else {
    return (
      expectedRegion.appliedRegion.regionId ===
      givenRegion.appliedRegion?.regionId
    );
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
  expectedFunction: TFunction,
  givenFunction: TFunction,
  env: Environment
) {
  if (expectedFunction.hasMoreEffects) {
    return true;
  } else if (givenFunction.hasMoreEffects) {
    return false;
  } else if (expectedFunction.effects.length !== givenFunction.effects.length) {
    return false;
  } else {
    return expectedFunction.effects.every((expectedEffect) => {
      return givenFunction.effects.some((givenEffect) => {
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
    }${regionParameters.map((region) =>
      region.appliedRegion
        ? region.appliedRegion.regionId
        : `${region.name}: Region`
    )}>`;
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
  .map(({ func, isControlled, name, functionExpr }) => {
    return `  ${name}: ${isControlled ? "control " : ""}${typeToString(func, {
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
  hasMoreEffects: boolean,
  {
    hideTypeParameterKind,
    extractTypeConstructor,
  }: { hideTypeParameterKind?: boolean; extractTypeConstructor?: boolean } = {}
): string {
  if (effects.length === 0 && !hasMoreEffects) {
    return "";
  } else {
    return `<${effects
      .map((effect) =>
        effectToString(effect, {
          hideTypeParameterKind,
          extractTypeConstructor,
        })
      )
      .join(", ")}${
      hasMoreEffects ? (effects.length > 0 ? ", " : "") + `*` : ""
    }>`;
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
      `  ${name}: ${typeToString(func, { extractTypeConstructor: false })}${
        functionExpr ? ` ${exprToString(functionExpr.body, "  ")}` : ""
      }`
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
 * Get the real functionArgumentsInOrder by matching the functionArguments with the functionType
 * If not match, then return null
 * @param functionArguments
 * @param functionType
 * @returns
 */
export function getFunctionArgumentsInOrder(
  functionArguments: Expr[],
  functionParameterTypes: TParameterType[],
  functionTypeArguments: Type[],
  functionTypeParamters: TTypeParameter[],
  env: Environment
): { functionArguments: Expr[] | null; functionTypeArguments: Type[] | null } {
  console.log("- getFunctionArgumentsInOrder: ");
  console.log(
    "  - functionParameterTypes: ",
    `(${functionParameterTypes
      .map(({ name, type, defaultValue }) => {
        return `${name}: ${typeToString(type)}${
          defaultValue ? ` = ${exprToString(defaultValue)}` : ""
        }`;
      })
      .join(", ")})`
  );
  console.log(
    "  - functionArguments types: ",
    functionArguments.map((expr) => typeToString(expr.typeValue))
  );
  console.log(
    "  - functionTypeArguments: ",
    functionTypeArguments.map((type) => typeToString(type))
  );
  console.log(
    "  - functionTypeParamters: ",
    functionTypeParamters.map((type) => typeToString(type))
  );

  const functionArgumentsInOrder: (Expr | null)[] = functionParameterTypes.map(
    (pt) => pt.defaultValue
  );
  const functionTypeArgumentsInOrder: Type[] = functionTypeParamters.map(
    () => /*pt.defaultTypeValue ??*/ TypeValues.unknown
  );

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
        return { functionArguments: null, functionTypeArguments: null };
      } else {
        functionArgumentsInOrder[argumentPositionIndex] = value;
      }
    } else {
      if (i >= functionArgumentsInOrder.length) {
        return { functionArguments: null, functionTypeArguments: null };
      }
      // Positional argument
      functionArgumentsInOrder[i] = argument;
    }
  }

  // If functionArgumentsInOrder has any null, then it's not a match
  const typeParameterToTypeArgumentMap: { [key: string]: Type } = {};
  if (functionArgumentsInOrder.some((arg) => arg === null)) {
    return { functionArguments: null, functionTypeArguments: null };
  } else {
    // Check if the functionArgumentsInOrder has the same types as the functionParameterTypes
    console.log("  - check functionArgumentsInOrder types");
    for (let i = 0; i < functionArgumentsInOrder.length; i++) {
      const argument = functionArgumentsInOrder[i];
      const parameterType = functionParameterTypes[i];
      console.log("    - argument: ", typeToString(argument!.typeValue!));
      console.log("    - parameterType: ", typeToString(parameterType.type));
      console.log(
        "    - checkType: ",
        checkType(parameterType.type, argument!.typeValue, env)
      );
      if (
        !argument ||
        !checkType(parameterType.type, argument.typeValue, env)
      ) {
        return { functionArguments: null, functionTypeArguments: null };
      }

      if (parameterType.type.type === "TypeParameter") {
        if (parameterType.type.name in typeParameterToTypeArgumentMap) {
          if (
            !checkType(
              typeParameterToTypeArgumentMap[parameterType.type.name],
              argument.typeValue,
              env
            )
          ) {
            return { functionArguments: null, functionTypeArguments: null };
          }
        }

        const argumentType = argument.typeValue;
        // TODO: Handle primitive type
        typeParameterToTypeArgumentMap[parameterType.type.name] =
          convertPrimitiveToType(argumentType);
      }
    }
    console.log(
      "  - typeParameterToTypeArgumentMap: ",
      typeParameterToTypeArgumentMap
    );

    for (let i = 0; i < functionTypeParamters.length; i++) {
      const typeParameter = functionTypeParamters[i];
      const typeArgument = functionTypeArguments[i];
      if (typeParameter.appliedType) {
        functionTypeArgumentsInOrder[i] = typeParameter.appliedType;
      } else if (typeParameter.name in typeParameterToTypeArgumentMap) {
        console.log(typeArgument);
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
          return { functionArguments: null, functionTypeArguments: null };
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
    console.log(
      "  - functionTypeArgumentsInOrder: ",
      functionTypeArgumentsInOrder.map((type) => typeToString(type))
    );

    return {
      functionArguments: functionArgumentsInOrder as Expr[],
      functionTypeArguments: functionTypeArgumentsInOrder,
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
