// Types

import {
  AssignmentExpr,
  AstType,
  BlockExpr,
  CallEnumExpr,
  CallTypeConstructorExpr,
  DereferenceExpr,
  Expr,
  FunctionExpr,
  IfExpr,
  MatchExpr,
  RecurExpr,
  ReferenceExpr,
  exprToString,
} from "./ast";
import {
  Environment,
  VariableValue,
  addEnvVariableValue,
  checkIfTypeConstraintsAreSatisfied,
  emptyToken,
  generateVarialeValueId,
  getEnvCurrentFrameLevel,
  getEnvVariableValueByVariableName,
  popEnvFrame,
  pushEnvFrame,
} from "./env";
import { formatErrorMessage } from "./error";
import * as logger from "./logger";
import { isUpperCamelCase } from "./naming-checker";
import { stringIsOperator } from "./operator";
import { Token, TokenType } from "./token";

export type TypeKind = "Type" | "Linear" | "Free";

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

/*
export type TIsize = {
  type: "isize";
  kind: "Free";
  permission: "own";
};
*/

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

/*
export type TU128 = {
  type: "u128";
  kind: "Free";
  permission: "own";
};

export type TI128 = {
  type: "i128";
  kind: "Free";
  permission: "own";
};
*/

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

// "symbol"
export type TSymbol = {
  type: "symbol";
  kind: "Free";
};

export type TPrimitive =
  | TUnit
  | TBoolean
  | TChar
  | TU8
  | TI8
  | TU16
  | TI16
  | TU32
  | TI32
  | TU64
  | TI64
  /*
  | TU128
  | TI128
  | TIsize
  */
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
  typeParameterName: string;
  typeParameterId: string;
  appliedType?: Type;
};

export type ClosureCaptureMode =
  | "&" // read
  | "&mut" // write
  | "=" // own
  | "none"; // not closure

export type TFunction = {
  type: "Function";
  kind: TypeKind;
  functionId: string;
  typeParameters: TTypeParameter[];
  typeConstraints: TTrait[];
  parameterTypes: TParameterType[];
  returnType: Type;

  closureCaptureMode: ClosureCaptureMode;

  hasNoImplementation?: boolean;
  ignoreAmbiguityCheck?: boolean;

  /**
   * The id of the trait under which the function is defined
   * Note this is not the `traitId` of `impl`, but the `traitId` of `trait`.
   */
  ownerTraitId?: string;

  /**
   * Right now only ()=>{} is closure
   * function name(a: number) {} is not closure
   */
  freeVariables?: VariableValue[];
  /**
   * At which frame level the function is defined
   */
  frameLevel: number;

  traitFunctionImplementations: TImplementationFunction[];
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
  // NOTE: `typeName` and `typeArguments` This is for recursive type alias. Check parser.ts
};

export type TArray = {
  type: "Array";
  kind: TypeKind;
  elementType: Type;
  size?: number;
};

export type TTuple = {
  type: "Tuple";
  kind: TypeKind;
  elements: Type[];
};

/*
export type TTuple = {
  type: "tuple";
  elements: Type[];
};
*/

export type TTypeConstructor = {
  type: "TypeConstructor";
  typeConstructorName: string;
  typeConstructorId: string;
  kind: TypeKind;
  typeParameters: TTypeParameter[];
  typeConstraints: TTrait[];
  typeValue: Type;
};

/**
 * NOTE: No free variable (closure) is supported for class function
 */
export type TImplementationFunction = {
  name: string;
  func: TFunction;
  functionExpr?: FunctionExpr;
};

export type TTrait = {
  type: "Trait";
  traitName: string;
  traitId: string;
  typeParameters: TTypeParameter[];
  typeConstraints: TTrait[];
  functions: TImplementationFunction[];

  // NOTE: Below are for "impl" for this trait
  // implementations: TTrait[];

  // NOTE: Below are for "impl"
  isImplementation: boolean;
  implementationTypeParameters?: TTypeParameter[];
  implementationTypeConstraints?: TTrait[];
};

export type TEnumVariant = {
  name: string;
  parameterTypes: TParameterType[];
};

export type TEnum = {
  type: "Enum";
  enumId: string;
  enumName: string;
  typeParameters: TTypeParameter[];
  typeConstraints: TTrait[];
  variants: TEnumVariant[];
  selectedVariantName?: string;
  kind: TypeKind;
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
  | TU8
  | TU16
  | TU32
  | TU64
  // | TU128
  | TI8
  | TI16
  | TI32
  | TI64
  // | TI128
  | TF16
  | TF32
  | TF64
  // | TIsize
  | TUsize
  | TSymbol
  | TRecord
  | TFunction
  | TUnion
  | TIntersection
  | TUnknown
  | TArray
  | TTuple
  | TTypeConstructor
  | TTypeParameter
  | TEnum
  | TPrimitiveWithValue
  | TExternType;

export const ImmutableReferenceOperator = "&";
export const MutableReferenceOperator = "&mut";
export const DereferenceOperator = "*";

export const TypeValues: {
  unit: TUnit;
  boolean: TBoolean;
  char: TChar;
  u8: TU8;
  u16: TU16;
  u32: TU32;
  u64: TU64;
  // u128: TU128;
  i8: TI8;
  i16: TI16;
  i32: TI32;
  i64: TI64;
  // i128: TI128;
  f16: TF16;
  f32: TF32;
  f64: TF64;
  // isize: TIsize;
  usize: TUsize;
  unknown: TUnknown;
  MutableReference: TTypeConstructor;
  ImmutableReference: TTypeConstructor;
  Pointer: TTypeConstructor;
} = {
  unit: { type: "()", kind: "Free" },
  boolean: { type: "boolean", kind: "Free" },
  char: { type: "char", kind: "Free" },
  u8: { type: "u8", kind: "Free" },
  u16: { type: "u16", kind: "Free" },
  u32: { type: "u32", kind: "Free" },
  u64: { type: "u64", kind: "Free" },
  // u128: { type: "u128", kind: "Free" },
  i8: { type: "i8", kind: "Free" },
  i16: { type: "i16", kind: "Free" },
  i32: { type: "i32", kind: "Free" },
  i64: { type: "i64", kind: "Free" },
  // i128: { type: "i128", kind: "Free" },
  f16: { type: "f16", kind: "Free" },
  f32: { type: "f32", kind: "Free" },
  f64: { type: "f64", kind: "Free" },
  // isize: { type: "isize", kind: "Free" },
  usize: { type: "usize", kind: "Free" },
  unknown: { type: "unknown", kind: "Free" },
  MutableReference: {
    type: "TypeConstructor",
    kind: "Free",
    typeConstructorName: MutableReferenceOperator,
    typeConstructorId: "MutableReference",
    typeParameters: [
      {
        type: "TypeParameter",
        typeParameterName: "T",
        typeParameterId: "T&mut",
        kind: "Type",
      },
    ],
    typeConstraints: [],
    typeValue: {
      type: "Extern",
      kind: "Free",
    },
  },
  ImmutableReference: {
    type: "TypeConstructor",
    kind: "Free",
    typeConstructorName: ImmutableReferenceOperator,
    typeConstructorId: "ImmutableReference",
    typeParameters: [
      {
        type: "TypeParameter",
        typeParameterName: "T",
        typeParameterId: "T&",
        kind: "Type",
      },
    ],
    typeConstraints: [],
    typeValue: {
      type: "Extern",
      kind: "Free",
    },
  },
  Pointer: {
    type: "TypeConstructor",
    kind: "Free",
    typeConstructorName: "^",
    typeConstructorId: "Pointer",
    typeParameters: [
      {
        type: "TypeParameter",
        typeParameterName: "T",
        typeParameterId: "T^",
        kind: "Type",
      },
    ],
    typeConstraints: [],
    typeValue: {
      type: "Extern",
      kind: "Free",
    },
  },
};

export const emptyFunction: TFunction = {
  functionId: "@emptyFunction",
  frameLevel: 0,
  closureCaptureMode: "none",
  kind: "Free",
  parameterTypes: [],
  returnType: TypeValues.unit,
  type: "Function",
  typeParameters: [],
  typeConstraints: [],
  traitFunctionImplementations: [],
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
    type.type === "i64" // ||
    // type.type === "i128" ||
    // type.type === "isize"
  );
}

export function isUnsignedIntegerType(type: Type): boolean {
  return (
    type.type === "u8" ||
    type.type === "u16" ||
    type.type === "u32" ||
    type.type === "u64" // ||
    // type.type === "u128" ||
    // type.type === "usize"
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

  if (tokens[index].type === TokenType.Underscore) {
    return {
      typeValue: TypeValues.unknown,
      index: index + 1,
      env,
    };
  }

  // FIXME: Support && like
  // Check if it's ImmutableReference, MutableReference
  if (tokens[index].value === "&" || tokens[index].value === "&mut") {
    const wrapperType =
      tokens[index].value === "&"
        ? TypeValues.ImmutableReference
        : TypeValues.MutableReference;
    const {
      typeValue,
      env: nextEnv,
      index: nextIndex,
    } = synthesizeTypeFromTokens({
      tokens,
      index: index + 1,
      env,
      parseExpression,
    });
    return {
      typeValue: {
        ...wrapperType,
        typeParameters: [
          {
            type: "TypeParameter",
            typeParameterName: "T",
            typeParameterId: "T",
            kind: "Type",
            appliedType: typeValue,
          },
        ],
      },
      index: nextIndex,
      env: nextEnv,
    };
  }

  // Check if it's unit
  if (
    tokens[index].value === "(" &&
    tokens[index + 1].value === ")" &&
    // tokens[index + 2].type !== TokenType.FatArrow &&
    // tokens[index + 2].type !== TokenType.MoveFatArrow &&
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
  else if (
    tokens[index].value === "(" ||
    tokens[index].value === "<" ||
    isClosureCaptureMode(tokens, index)
  ) {
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
      // It could be the case that it's a tuple type
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
        // Could be the tuple
        // Parse tuple
        const tupleElements: Type[] = [typeValue];
        let index = nextIndex;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (!tokens[index]) {
            throw formatErrorMessage({
              token: tokens[index - 1],
              errorMessage: "Expected ')'",
              modulePath: env.modulePath,
              inputString: env.inputString,
            });
          }
          if (tokens[index].type === TokenType.Comma) {
            index = index + 1;
          }
          if (tokens[index].type === TokenType.RParen) {
            break;
          }
          const {
            typeValue,
            index: nextIndex,
            env: nextEnv,
          } = synthesizeTypeFromTokens({
            tokens,
            index: index,
            env,
            parseExpression,
          });
          env = nextEnv;
          index = nextIndex;
          tupleElements.push(typeValue);
        }

        returnValue = {
          typeValue: {
            type: "Tuple",
            kind: unifyTypeKinds(tupleElements.map((element) => element.kind)),
            elements: tupleElements,
          },
          index: index + 1,
          env,
        };
      }
    }
  }
  // Check if it's defined in variableTypes
  else if (
    getEnvVariableValueByVariableName(env, tokens[index].value, "type").length >
    0
  ) {
    const valueTypes = getEnvVariableValueByVariableName(
      env,
      tokens[index].value,
      "type"
    );

    returnValue = {
      typeValue: {
        ...valueTypes[valueTypes.length - 1].type,
      },
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

          if (
            tokens[index].type === TokenType.Comma ||
            tokens[index].type === TokenType.Semicolon
          ) {
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
      /*
      case "u128": {
        typeValue = TypeValues.u128;
        break;
      }
      */
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
      /*
      case "i128": {
        typeValue = TypeValues.i128;
        break;
      }
      */
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
      /*
      case "isize": {
        typeValue = TypeValues.isize;
        break;
      }
      */
      case "usize": {
        typeValue = TypeValues.usize;
        break;
      }
      case "symbol": {
        typeValue = {
          type: "symbol",
          kind: "Free",
        };
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
      typeValue: { ...typeValue },
      index: index + 1,
      env,
    };
  }

  const nextTokenType = tokens[returnValue.index]?.type;
  const nextTokenValue = tokens[returnValue.index]?.value;
  let newTypeValue: Type = returnValue.typeValue;
  const newTypeValueKind = newTypeValue.kind;

  // Check if it's array
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
            type: "Array",
            kind: newTypeValueKind,
            elementType: newTypeValue,
            size,
          };
          index = index + 2;
        }
      } else if (token.type === TokenType.RBracket) {
        newTypeValue = {
          type: "Array",
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
      const kind = unifyTypeKinds([
        returnValueTypeKind,
        newReturnValueTypeKind,
      ]);
      returnValue = {
        typeValue: {
          type: "Union",
          kind: kind,
          types: [returnValue.typeValue, ...newReturnValue.typeValue.types],
        },
        index: newReturnValue.index,
        env: newReturnValue.env,
      };
    } else {
      const returnValueTypeKind = returnValue.typeValue.kind;
      const kind = unifyTypeKinds([
        returnValueTypeKind,
        newReturnValueTypeKind,
      ]);
      returnValue = {
        typeValue: {
          type: "Union",
          kind: kind,
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
      const kind = unifyTypeKinds([
        returnValueTypeKind,
        newReturnValueTypeKind,
      ]);
      returnValue = {
        typeValue: {
          type: "Intersection",
          kind: kind,
          types: [returnValue.typeValue, ...newReturnValue.typeValue.types],
        },
        index: newReturnValue.index,
        env: newReturnValue.env,
      };
    } else {
      const returnValueTypeKind = returnValue.typeValue.kind;
      const kind = unifyTypeKinds([
        returnValueTypeKind,
        newReturnValueTypeKind,
      ]);
      returnValue = {
        typeValue: {
          type: "Intersection",
          kind: kind,
          types: [returnValue.typeValue, newReturnValue.typeValue],
        },
        index: newReturnValue.index,
        env: newReturnValue.env,
      };
    }
  }
  // Type arguments
  let typeArguments: Type[] = [];
  if (tokens[returnValue.index]?.value === "<") {
    const {
      env: nextEnv,
      index: nextIndex,
      typeArguments: nextTypeArguments,
    } = synthesizeTypeArgumentsFromTokens({
      env: returnValue.env,
      index: returnValue.index,
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
  try {
    if (typeValue.type === "TypeConstructor") {
      returnValue.index = index;
      returnValue.env = env;
      const typeValue_ = applyTypeArgumentsToType({
        env,
        type: typeValue,
        typeArguments,
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
      const typeValue_ = applyTypeArgumentsToType({
        env,
        type: typeValue,
        typeArguments,
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

    /*
    // NOTE: We shouldn't set it to Free. 2024-03-12
    // NOTE: If it's "read" or "write" permission, we set its kind to "Free"
    if (
      returnValue.typeValue.permission === "read" ||
      returnValue.typeValue.permission === "write"
    ) {
      returnValue.typeValue.kind = "Free";
    }
    */

    // Check if the type constraints are satisfied
    if ("typeConstraints" in returnValue.typeValue) {
      const typeConstraints = returnValue.typeValue.typeConstraints;
      checkIfTypeConstraintsAreSatisfied({
        env,
        typeConstraints,
        token: tokens[returnValue.index - 1],
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
 * Please note this function will modify `typeParameterToTypeArgumentMap`
 */
function generateNewTypeParameters({
  env,
  typeParameters,
  typeArguments,
  typeParameterToTypeArgumentMap,
}: {
  env: Environment;
  typeParameters: TTypeParameter[];
  typeArguments?: Type[];
  typeParameterToTypeArgumentMap: { [key: string]: Type };
}): {
  typeParameters: TTypeParameter[];
} {
  /*
  const r = Math.random();
  logger.debug("- generateNewTypeParameters");
  logger.debug(
    "  - typeParameters: ",
    typeParameters.map(
      (t) => `${t.typeParameterName} of type ${typeToString(t)}`
    )
  );
  logger.debug(
    "  - typeArguments: ",
    typeArguments?.map((t) => typeToString(t))
  );
  logger.debug(
    "  - typeParameterToTypeArgumentMap: ",
    r,
    typeParameterToTypeArgumentMap
  );
  */

  // set typeParameterToTypeArgumentMap
  const newTypeParameters: TTypeParameter[] = [];
  for (let i = 0; i < typeParameters.length; i++) {
    const typeParameter = typeParameters[i];
    if (typeArguments && typeArguments[i]) {
      let typeArgument = typeArguments[i];
      while (
        typeArgument.type === "TypeParameter" &&
        typeArgument.appliedType
      ) {
        typeArgument = typeArgument.appliedType;
      }

      const typeParameterAppliedType = typeParameter.appliedType;
      if (
        typeParameterAppliedType &&
        "typeParameters" in typeParameterAppliedType &&
        typeArgument &&
        "typeParameters" in typeArgument
      ) {
        generateNewTypeParameters({
          env,
          typeParameters: typeParameterAppliedType.typeParameters,
          typeArguments: typeArgument.typeParameters,
          typeParameterToTypeArgumentMap,
        });
      } else if (
        typeParameterAppliedType &&
        typeParameterAppliedType.type === "TypeParameter" &&
        typeArgument
      ) {
        generateNewTypeParameters({
          env,
          typeParameters: [typeParameterAppliedType],
          typeArguments: [typeArgument],
          typeParameterToTypeArgumentMap,
        });
      }

      const existingTypeArgument =
        typeParameterToTypeArgumentMap[typeParameter.typeParameterId];
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
      if (
        !(
          typeArgument.type === "TypeParameter" &&
          typeArgument.typeParameterId === typeParameter.typeParameterId
        )
      ) {
        typeParameterToTypeArgumentMap[typeParameter.typeParameterId] =
          typeArgument;
      }

      if (
        typeArgument &&
        "typeParameterId" in typeArgument &&
        typeArgument.typeParameterId === typeParameter.typeParameterId
      ) {
        newTypeParameters.push(typeArgument);
      } else {
        newTypeParameters.push({
          ...typeParameter,
          appliedType: typeArgument,
        });
      }
    } else if (typeParameterToTypeArgumentMap[typeParameter.typeParameterId]) {
      const typeArgument =
        typeParameterToTypeArgumentMap[typeParameter.typeParameterId];
      if (
        "typeParameterId" in typeArgument &&
        typeArgument.typeParameterId === typeParameter.typeParameterId
      ) {
        newTypeParameters.push(typeArgument);
      } else {
        newTypeParameters.push({
          ...typeParameter,
          appliedType:
            typeParameterToTypeArgumentMap[typeParameter.typeParameterId],
        });
      }
    } else {
      newTypeParameters.push(
        applyTypeArgumentsToType({
          env,
          type: typeParameter,
          typeArguments,
          typeParameterToTypeArgumentMap,
        }) as TTypeParameter
      );
    }
  }

  /*
  logger.debug(
    "  - end typeParameterToTypeArgumentMap: ",
    r,
    typeParameterToTypeArgumentMap
  );
  */

  return {
    typeParameters: newTypeParameters,
  };
}

/**
 * If typeArguments is undefined,
 * use the typeParameterToTypeArgumentMap instead
 */
export function applyTypeArgumentsToType({
  env,
  type,
  typeArguments,
  typeParameterToTypeArgumentMap,
}: {
  env: Environment;
  type: Type;
  typeArguments?: Type[];
  typeParameterToTypeArgumentMap: { [key: string]: Type };
}): Type {
  /*
  logger.debug("- applyTypeArgumentsToType");
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
  */

  if (type.type === "TypeConstructor") {
    // logger.debug("- applyTypeArgumentsToType TypeConstructor");
    const typeValue = type.typeValue;
    /*
    logger.debug(
      "  - typeParameters: ",
      type.typeParameters.map((typeParameter) => typeToString(typeParameter))
    );
    */
    if (typeArguments && type.typeParameters.length !== typeArguments.length) {
      throw new Error(
        `(3) Mismatched type arguments.
  Expected: <${type.typeParameters
    .map(
      (typeParameter) =>
        `${typeParameter.typeParameterName}: ${typeParameter.kind}`
    )
    .join(", ")}>
  Got:      <${typeArguments.map((type) => typeToString(type)).join(", ")}>`
      );
    }

    // set typeParameterToTypeArgumentMap
    const { typeParameters: newTypeParameters } = generateNewTypeParameters({
      env,
      typeParameters: type.typeParameters,
      typeArguments,
      typeParameterToTypeArgumentMap,
    });

    const newTypeValue = applyTypeArgumentsToType({
      env,
      type: typeValue,
      typeParameterToTypeArgumentMap,
    });
    const kind = typeValue.type === "Extern" ? type.kind : newTypeValue.kind;
    return {
      type: "TypeConstructor",
      kind: kind,
      typeConstructorName: type.typeConstructorName,
      typeConstructorId: type.typeConstructorId,
      typeParameters: newTypeParameters,
      typeConstraints: type.typeConstraints.map((typeConstraint) =>
        applyTypeArgumentsToTrait({
          env,
          trait: typeConstraint,
          typeParameterToTypeArgumentMap,
        })
      ),
      typeValue: newTypeValue,
    };
  } else if (type.type === "Enum") {
    logger.debug("- applyTypeArgumentsToType Enum");
    logger.debug("  - typeParameters: ", JSON.stringify(type.typeParameters));
    const { typeParameters: newTypeParameters } = generateNewTypeParameters({
      env,
      typeParameters: type.typeParameters,
      typeArguments,
      typeParameterToTypeArgumentMap,
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
            type: applyTypeArgumentsToType({
              env,
              type: parameterType.type,
              typeParameterToTypeArgumentMap,
            }),
            defaultValue: defaultValue
              ? applyTypeArgumentsToExpr({
                  expr: defaultValue,
                  env,
                  typeParameterToTypeArgumentMap,
                })
              : null,
          };
          return newParameterType;
        }),
      })
    ) as TEnumVariant[];

    const kind = getEnumTypeKind(variants);
    const enumType: TEnum = {
      type: "Enum",
      kind: kind,
      enumId: type.enumId,
      enumName: type.enumName,
      typeParameters: newTypeParameters,
      typeConstraints: type.typeConstraints.map((typeConstraint) =>
        applyTypeArgumentsToTrait({
          env,
          trait: typeConstraint,
          typeParameterToTypeArgumentMap,
        })
      ),
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
    // logger.debug("- applyTypeArgumentsToType Function");

    const typeParameters = type.typeParameters;
    if (typeArguments && typeParameters.length !== typeArguments.length) {
      throw new Error(
        `(5) Mismatched type arguments.
  Expected: <${typeParameters
    .map(
      (typeParameter) =>
        `${typeParameter.typeParameterName}: ${typeParameter.kind}`
    )
    .join(", ")}>
  Got:      <${typeArguments.map((type) => typeToString(type)).join(", ")}>`
      );
    }

    const { typeParameters: newTypeParameters } = generateNewTypeParameters({
      env,
      typeParameters: type.typeParameters,
      typeArguments,
      typeParameterToTypeArgumentMap,
    });

    const newFunctionType: TFunction = {
      ...type,
      typeParameters: newTypeParameters,
      typeConstraints: type.typeConstraints.map((typeConstraint) =>
        applyTypeArgumentsToTrait({
          env,
          trait: typeConstraint,
          typeParameterToTypeArgumentMap,
        })
      ),
      parameterTypes: type.parameterTypes.map(
        ({ name, parameterId, type, isMutable, defaultValue }) => ({
          name,
          parameterId,
          isMutable,
          type: applyTypeArgumentsToType({
            env,
            type,
            typeParameterToTypeArgumentMap,
          }),
          defaultValue,
        })
      ),
      returnType: applyTypeArgumentsToType({
        env,
        type: type.returnType,
        typeParameterToTypeArgumentMap,
      }),
      // NOTE: traitFunctionImplementations is not updated
    };
    return newFunctionType;
  } else {
    switch (type.type) {
      case "TypeParameter": {
        const typeParameter = type;
        const typeArgument =
          typeParameterToTypeArgumentMap[typeParameter.typeParameterId];
        if (typeParameter.appliedType) {
          const returnType: TTypeParameter = {
            ...typeParameter,
            appliedType: applyTypeArgumentsToType({
              type: typeParameter.appliedType,
              env,
              typeArguments,
              typeParameterToTypeArgumentMap,
            }),
          };
          return returnType;
        } else if (typeArgument) {
          /*
          const returnType: TTypeParameter = {
            ...typeParameter,
            appliedType: {
              ...typeArgument,
              permission: typeParameter.permission,
            },
          };
          return returnType;
          */
          return typeArgument;
        } else {
          return typeParameter;
        }
      }
      case "Record": {
        const newProperties = type.properties.map(({ name, type }) => ({
          name,
          type: applyTypeArgumentsToType({
            env,
            type,
            typeParameterToTypeArgumentMap,
          }),
        }));
        return {
          ...type,
          kind: getRecordTypeKind(newProperties),
          properties: newProperties,
        };
      }
      case "Union": {
        const types = type.types.map((type) =>
          applyTypeArgumentsToType({
            env,
            type,
            typeParameterToTypeArgumentMap,
          })
        );
        return {
          ...type,
          types: types,
          kind: unifyTypeKinds(types.map((type) => type.kind)),
        };
      }
      case "Intersection": {
        const types = type.types.map((type) =>
          applyTypeArgumentsToType({
            env,
            type,
            typeParameterToTypeArgumentMap,
          })
        );
        return {
          ...type,
          types: types,
          kind: unifyTypeKinds(types.map((type) => type.kind)),
        };
      }
      case "Array": {
        const elementType = applyTypeArgumentsToType({
          env,
          type: type.elementType,
          typeParameterToTypeArgumentMap,
        });
        return {
          ...type,
          elementType: elementType,
          kind: elementType.kind,
        };
      }
      case "Tuple": {
        const elements = type.elements.map((element) => {
          return applyTypeArgumentsToType({
            env,
            type: element,
            typeParameterToTypeArgumentMap,
          });
        });
        return {
          ...type,
          type: "Tuple",
          elements: elements,
          kind: unifyTypeKinds(elements.map((element) => element.kind)),
        };
      }
      case "unknown": {
        return {
          ...type,
          typeArguments: type.typeArguments
            ? type.typeArguments.map((typeArgument) =>
                applyTypeArgumentsToType({
                  env,
                  type: typeArgument,
                  typeParameterToTypeArgumentMap,
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

export function applyTypeArgumentsToTrait({
  env,
  trait,
  typeArguments,
  typeParameterToTypeArgumentMap,
}: {
  env: Environment;
  trait: TTrait;
  typeArguments?: Type[];
  typeParameterToTypeArgumentMap: { [key: string]: Type };
}): TTrait {
  // logger.debug("- applyTypeArgumentsToTrait");
  /*
  // NOTE: Adding the code below will cause ./examples/classes/use_id3.mo failed to parse
  if (
    typeArguments &&
    trait.typeParameters.length !== typeArguments.length
  ) {
    throw new Error(
      `(4) Mismatched type arguments.
Expected: <${trait.typeParameters
        .map(
          (typeParameter) =>
            `${typeParameter.typeParameterName}: ${typeParameter.kind}`
        )
        .join(", ")}>
Got:      <${typeArguments.map((type) => typeToString(type)).join(", ")}>`
    );
  }
  */

  // set typeParameterToTypeArgumentMap
  const { typeParameters: newTypeParameters } = generateNewTypeParameters({
    env,
    typeParameters: trait.typeParameters,
    typeArguments,
    typeParameterToTypeArgumentMap,
  });

  // apply to each of the functions
  const functions: TImplementationFunction[] = trait.functions.map(
    ({ name, func, functionExpr }) => ({
      name,
      func: applyTypeArgumentsToType({
        env,
        type: func,
        typeParameterToTypeArgumentMap,
      }),
      functionExpr: functionExpr
        ? applyTypeArgumentsToExpr({
            expr: functionExpr,
            env,
            typeParameterToTypeArgumentMap,
          })
        : undefined,
    })
  ) as TImplementationFunction[];

  return {
    type: "Trait",
    traitName: trait.traitName,
    traitId: trait.traitId,
    typeParameters: newTypeParameters,
    typeConstraints: trait.typeConstraints.map((typeConstraint) =>
      applyTypeArgumentsToTrait({
        env,
        trait: typeConstraint,
        typeArguments,
        typeParameterToTypeArgumentMap,
      })
    ),
    functions: functions,
    isImplementation: true, // type.isImplementation,
    implementationTypeParameters: trait.implementationTypeParameters, // QUESTION: Is this correct?
    implementationTypeConstraints: trait.implementationTypeConstraints, // QUESTION: Is this correct?
  };
}

export function applyTypeArgumentsToFunctionExpr({
  env,
  expr,
  typeArguments,
  typeParameterToTypeArgumentMap,
}: {
  env: Environment;
  expr: FunctionExpr;
  typeArguments?: Type[];
  typeParameterToTypeArgumentMap: { [key: string]: Type };
}): FunctionExpr {
  const type: TFunction = expr.typeValue as TFunction;
  if (typeArguments && type.typeParameters.length !== typeArguments.length) {
    throw new Error(
      `(6) Mismatched type arguments.
Expected: <${type.typeParameters
        .map(
          (typeParameter) =>
            `${typeParameter.typeParameterName}: ${typeParameter.kind}`
        )
        .join(", ")}>
Got:      <${typeArguments.map((type) => typeToString(type)).join(", ")}>`
    );
  }

  // logger.debug("- applyTypeArgumentsToFunctionExpr");
  // set typeParameterToTypeArgumentMap
  /*const {
    typeParameters: newTypeParameters,
  } =*/ generateNewTypeParameters({
    env,
    typeParameters: type.typeParameters,
    typeArguments,
    typeParameterToTypeArgumentMap,
  });

  const newTypeValue = applyTypeArgumentsToType({
    type: expr.typeValue,
    env,
    typeParameterToTypeArgumentMap,
  });
  if (newTypeValue.type !== "Function") {
    throw new Error(
      `Expected function type, but got ${typeToString(newTypeValue)}`
    );
  }

  return {
    ...expr,
    typeValue: newTypeValue,
    body: applyTypeArgumentsToExpr({
      expr: expr.body,
      env,
      typeParameterToTypeArgumentMap,
    }) as BlockExpr,
  };
}

export function applyTypeArgumentsToExpr({
  env,
  expr,
  typeParameterToTypeArgumentMap,
}: {
  env: Environment;
  expr: Expr;
  typeParameterToTypeArgumentMap: { [key: string]: Type };
}): Expr {
  /*
  logger.debug("- applyTypeArgumentsToExpr");
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
            typeValue: applyTypeArgumentsToType({
              env,
              type: expr.typeValue,
              typeParameterToTypeArgumentMap,
            }),
            properties: expr.properties.map(({ name, value: expr }) => ({
              name,
              value: applyTypeArgumentsToExpr({
                env,
                expr,
                typeParameterToTypeArgumentMap,
              }),
            })),
          };
        }
        case "array": {
          return {
            ...expr,
            typeValue: applyTypeArgumentsToType({
              env,
              type: expr.typeValue,
              typeParameterToTypeArgumentMap,
            }),
            values: expr.values.map((expr) =>
              applyTypeArgumentsToExpr({
                env,
                expr,
                typeParameterToTypeArgumentMap,
              })
            ),
          };
        }
        default:
          return expr;
      }
    }
    case AstType.Function: {
      return applyTypeArgumentsToFunctionExpr({
        expr,
        env,
        typeParameterToTypeArgumentMap,
      });
    }
    case AstType.LetAssignment: {
      return {
        ...expr,
        variableType: applyTypeArgumentsToType({
          env,
          type: expr.variableType,
          typeParameterToTypeArgumentMap,
        }),
        right: applyTypeArgumentsToExpr({
          env,
          expr: expr.right,
          typeParameterToTypeArgumentMap,
        }),
      };
    }
    case AstType.Assignment: {
      const e: AssignmentExpr = {
        ...expr,
        right: applyTypeArgumentsToExpr({
          env,
          expr: expr.right,
          typeParameterToTypeArgumentMap,
        }),
        left: applyTypeArgumentsToExpr({
          env,
          expr: expr.left,
          typeParameterToTypeArgumentMap,
        }),
        typeValue: applyTypeArgumentsToType({
          env,
          type: expr.typeValue,
          typeParameterToTypeArgumentMap,
        }),
      };
      return e;
    }
    case AstType.Variable: {
      return {
        ...expr,
        typeValue: applyTypeArgumentsToType({
          env: env,
          type: expr.typeValue,
          typeParameterToTypeArgumentMap,
        }),
      };
    }
    case AstType.PropertyAccess: {
      return {
        ...expr,
        typeValue: applyTypeArgumentsToType({
          type: expr.typeValue,
          env,
          typeParameterToTypeArgumentMap,
        }),
        expr: applyTypeArgumentsToExpr({
          expr: expr.expr,
          env,
          typeParameterToTypeArgumentMap,
        }),
      };
    }
    case AstType.IndexAccess: {
      return {
        ...expr,
        typeValue: applyTypeArgumentsToType({
          type: expr.typeValue,
          env,
          typeParameterToTypeArgumentMap,
        }),
        expr: applyTypeArgumentsToExpr({
          expr: expr.expr,
          env,
          typeParameterToTypeArgumentMap,
        }),
        indexes: expr.indexes.map((expr) =>
          applyTypeArgumentsToExpr({
            expr: expr,
            env,
            typeParameterToTypeArgumentMap,
          })
        ),
      };
    }
    case AstType.CallFunction: {
      return {
        ...expr,
        function: applyTypeArgumentsToExpr({
          expr: expr.function,
          env,
          typeParameterToTypeArgumentMap,
        }),
        functionArguments: expr.functionArguments.map((expr) =>
          applyTypeArgumentsToExpr({
            expr,
            env,
            typeParameterToTypeArgumentMap,
          })
        ),
        typeValue: applyTypeArgumentsToType({
          type: expr.typeValue,
          env,
          typeParameterToTypeArgumentMap,
        }),
      };
    }
    case AstType.CallEnum: {
      const e: CallEnumExpr = {
        ...expr,
        typeValue: applyTypeArgumentsToType({
          type: expr.typeValue,
          env,
          typeParameterToTypeArgumentMap,
        }) as TEnum,
        variantArguments: expr.variantArguments.map((expr) =>
          applyTypeArgumentsToExpr({
            expr,
            env,
            typeParameterToTypeArgumentMap,
          })
        ),
      };
      return e;
    }
    case AstType.CallTypeConstructor: {
      const e: CallTypeConstructorExpr = {
        ...expr,
        expr: applyTypeArgumentsToExpr({
          expr: expr.expr,
          env,
          typeParameterToTypeArgumentMap,
        }),
        typeValue: applyTypeArgumentsToType({
          type: expr.typeValue,
          env,
          typeParameterToTypeArgumentMap,
        }) as TTypeConstructor,
      };
      return e;
    }
    case AstType.If: {
      const newIfExpr: IfExpr = {
        ...expr,
        cases: expr.cases.map(({ condition, body }) => {
          return {
            condition: condition
              ? applyTypeArgumentsToExpr({
                  expr: condition,
                  env,
                  typeParameterToTypeArgumentMap,
                })
              : undefined,
            body: applyTypeArgumentsToExpr({
              expr: body,
              env,
              typeParameterToTypeArgumentMap,
            }) as BlockExpr,
          };
        }),
        typeValue: applyTypeArgumentsToType({
          type: expr.typeValue,
          env,
          typeParameterToTypeArgumentMap,
        }),
      };
      return newIfExpr;
    }
    case AstType.Match: {
      const e: MatchExpr = {
        ...expr,
        matchedEnum: applyTypeArgumentsToExpr({
          expr: expr.matchedEnum,
          env,
          typeParameterToTypeArgumentMap,
        }),
        cases: expr.cases.map(({ case: case_, variantName, body }) => {
          return {
            case: case_
              ? applyTypeArgumentsToExpr({
                  expr: case_,
                  env,
                  typeParameterToTypeArgumentMap,
                })
              : undefined,
            variantName,
            body: applyTypeArgumentsToExpr({
              expr: body,
              env,
              typeParameterToTypeArgumentMap,
            }) as BlockExpr,
          };
        }),
        typeValue: applyTypeArgumentsToType({
          type: expr.typeValue,
          env,
          typeParameterToTypeArgumentMap,
        }),
      };
      return e;
    }
    case AstType.Ignore: {
      return expr;
    }
    case AstType.Block: {
      // FIXME: Check if the return value
      // contains the "read" or "write" fields.
      return {
        ...expr,
        exprs: expr.exprs.map((expr) =>
          applyTypeArgumentsToExpr({
            expr,
            env,
            typeParameterToTypeArgumentMap,
          })
        ),
        typeValue: applyTypeArgumentsToType({
          type: expr.typeValue,
          env,
          typeParameterToTypeArgumentMap,
        }),
      };
    }
    case AstType.Recur: {
      const e: RecurExpr = {
        ...expr,
        functionArguments: expr.functionArguments.map((expr) =>
          applyTypeArgumentsToExpr({
            expr,
            env,
            typeParameterToTypeArgumentMap,
          })
        ),
        typeValue: applyTypeArgumentsToType({
          type: expr.typeValue,
          env,
          typeParameterToTypeArgumentMap,
        }),
      };
      return e;
    }
    case AstType.Dereference: {
      const e: DereferenceExpr = {
        ...expr,
        expr: applyTypeArgumentsToExpr({
          expr: expr.expr,
          env,
          typeParameterToTypeArgumentMap,
        }),
        typeValue: applyTypeArgumentsToType({
          type: expr.typeValue,
          env,
          typeParameterToTypeArgumentMap,
        }),
      };
      return e;
    }
    case AstType.Reference: {
      const e: ReferenceExpr = {
        ...expr,
        expr: applyTypeArgumentsToExpr({
          expr: expr.expr,
          env,
          typeParameterToTypeArgumentMap,
        }),
        typeValue: applyTypeArgumentsToType({
          type: expr.typeValue,
          env,
          typeParameterToTypeArgumentMap,
        }),
      };
      return e;
    }
    default:
      throw new Error(
        `applyTypeArgumentsToExpr: Unknown expr type ${expr.type}`
      );
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
  expectedFunctionType,
}: {
  tokens: Token[];
  index: number;
  env: Environment;
  parseExpression: ParseExpression;
  withFunctionBody: boolean;
  expectedFunctionType?: TFunction;
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
  const parameterTypes: (TParameterType & { token: Token })[] = [];
  const parameterDefaultValues: (Expr | null)[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!tokens[index]) {
      throw formatErrorMessage({
        token: tokens[index - 1],
        errorMessage: "Expected ')'",
        modulePath: env.modulePath,
        inputString: env.inputString,
      });
    }
    if (tokens[index].type === TokenType.Comma) {
      index = index + 1;
      continue;
    }
    if (tokens[index].type === TokenType.RParen) {
      index = index + 1;
      break;
    }

    let isMutable = false;
    if (tokens[index].type === TokenType.Mut) {
      isMutable = true;
      index = index + 1;
    }

    // TODO: There might be the case that only the type is specified or pattern matching
    if (tokens[index].type !== TokenType.Identifier) {
      throw formatErrorMessage({
        token: tokens[index],
        errorMessage: "Expected identifier as parameter name",
        modulePath: env.modulePath,
        inputString: env.inputString,
      });
    }
    const parameterName = tokens[index].value;

    // Check if labelName matches the expectedFunctionType
    if (expectedFunctionType) {
      const expectedParameterType =
        expectedFunctionType.parameterTypes[parameterTypes.length];
      if (!expectedParameterType) {
        throw formatErrorMessage({
          token: tokens[index],
          errorMessage: `Number of parameters mismatched. Expected ${expectedFunctionType.parameterTypes.length} parameters.`,
          modulePath: env.modulePath,
          inputString: env.inputString,
        });
      }

      if (expectedParameterType.name !== parameterName) {
        throw formatErrorMessage({
          token: tokens[index],
          errorMessage: `Mismatched parameter name.
Expected: ${expectedParameterType.name}
Got:      ${parameterName}`,
          modulePath: env.modulePath,
          inputString: env.inputString,
        });
      }
    }

    // check type
    let userDefinedParamterType: Type = TypeValues.unknown;
    const parameterNameTokenIndex = index;
    if (tokens[index + 1].type !== TokenType.Colon) {
      if (!expectedFunctionType) {
        throw formatErrorMessage({
          token: tokens[index + 1],
          errorMessage:
            "Expected parameter type after ':' after parameter name",
          modulePath: env.modulePath,
          inputString: env.inputString,
        });
      } else {
        userDefinedParamterType =
          expectedFunctionType.parameterTypes[parameterTypes.length]?.type;
        if (!userDefinedParamterType) {
          throw formatErrorMessage({
            token: tokens[index + 1],
            errorMessage: `Number of parameters mismatched (1). Expected ${expectedFunctionType.parameterTypes.length} parameters.`,
            modulePath: env.modulePath,
            inputString: env.inputString,
          });
        }
      }
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

      if (userDefinedParamterType.type === "unknown" && expectedFunctionType) {
        userDefinedParamterType =
          expectedFunctionType.parameterTypes[parameterTypes.length]?.type;
        if (!userDefinedParamterType) {
          throw formatErrorMessage({
            token: tokens[index - 1],
            errorMessage: `Number of parameters mismatched (2). Expected ${expectedFunctionType.parameterTypes.length} parameters.`,
            modulePath: env.modulePath,
            inputString: env.inputString,
          });
        }
      }
    }

    // check parameter default value
    let defaultParameterValue: Expr | null = null;
    if (tokens[index].type === TokenType.Assign) {
      if (!withFunctionBody) {
        throw formatErrorMessage({
          token: tokens[index],
          errorMessage:
            "A parameter initializer is only allowed in a function implementation.",
          modulePath: env.modulePath,
          inputString: env.inputString,
        });
      }

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

    parameterTypes.push({
      name: parameterName,
      parameterId: "", // parameterValue.id, // NOTE: We update parameterId later
      isMutable,
      type: userDefinedParamterType,
      defaultValue: defaultParameterValue,
      token: tokens[parameterNameTokenIndex],
    });
  }

  const sortedParameterTypes = [...parameterTypes];
  for (let i = 0; i < sortedParameterTypes.length; i++) {
    const parameterType = sortedParameterTypes[i];
    const { env: nextEnv, value: parameterValue } = addEnvVariableValue({
      env,
      variableValue: {
        variableName: parameterType.name,
        type: parameterType.type,
        kind: "value",
        isMutable: parameterType.isMutable,
        token: parameterType.token,
      },
    });
    env = nextEnv;

    // Update the parameterId
    parameterType.parameterId = parameterValue.id;
  }

  if (!withFunctionBody) {
    env = popEnvFrame(env, true);
  }

  return { parameterTypes, index, env };
}

export function synthesizeRecordType(
  properties: {
    name: string;
    value: Expr;
  }[]
): Type {
  let kind: TypeKind = "Free";
  properties.forEach(({ value }) => {
    if (kind === "Free") {
      kind = value.typeValue.kind as TypeKind;
    }
  });

  return {
    type: "Record",
    kind,
    properties: properties.map(({ name, value }) => {
      return {
        name,
        type: value.typeValue,
      };
    }),
  };
}

export function synthesizeTypeArgumentsFromTokens({
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

    if (token.value.startsWith(">") && token.value.length > 1) {
      const rest = token.value.slice(1);

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
          type: rest === "." ? TokenType.Dot : TokenType.Operator,
          value: rest,
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

    if (typeArgument.type === "unknown") {
      // Create new type parameter without appliedType as the type argument
      const id = generateVarialeValueId(env, "unknown");
      const typeParameter: TTypeParameter = {
        type: "TypeParameter",
        typeParameterName: id,
        typeParameterId: id,
        kind: "Type", // QUESTION: What should be this?
        appliedType: undefined,
      };
      typeArguments.push(typeParameter);
    } else {
      typeArguments.push(typeArgument);
    }
    index = nextIndex;
    env = nextEnv;
  }
  return { typeArguments, index, env };
}

export function synthesizeTypeConstraintsFromTokens({
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
  typeConstraints: TTrait[];
  index: number;
  env: Environment;
} {
  const typeConstraints: TTrait[] = [];
  if (tokens[index].type !== TokenType.Impl) {
    throw formatErrorMessage({
      token: tokens[index],
      errorMessage: "Expected 'impl' before declaring type constraints.",
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
        errorMessage: "Expected '>'",
        modulePath: env.modulePath,
        inputString: env.inputString,
      });
    }
    if (tokens[index].value === ">") {
      index = index + 1;
      break;
    }

    if (tokens[index].type !== TokenType.Identifier) {
      throw formatErrorMessage({
        token: tokens[index],
        errorMessage: "Expected identifier as type constraint name",
        modulePath: env.modulePath,
        inputString: env.inputString,
      });
    }
    const typeConstraintName = tokens[index].value;
    index = index + 1;

    let typeArguments: Type[] = [];
    if (tokens[index].value === "<") {
      const {
        typeArguments: nextTypeArguments,
        index: nextIndex,
        env: nextEnv,
      } = synthesizeTypeArgumentsFromTokens({
        tokens,
        index,
        env,
        parseExpression,
      });
      typeArguments = nextTypeArguments;
      index = nextIndex;
      env = nextEnv;
    }

    // Find the traits
    const traitValues = getEnvVariableValueByVariableName(
      env,
      typeConstraintName,
      "trait"
    );
    if (traitValues.length === 0) {
      throw formatErrorMessage({
        token: tokens[index],
        errorMessage: `Cannot find trait ${typeConstraintName}`,
        modulePath: env.modulePath,
        inputString: env.inputString,
      });
    } else if (traitValues.length > 1) {
      throw formatErrorMessage({
        token: tokens[index],
        errorMessage: `Ambiguous trait ${traitValues}`,
        modulePath: env.modulePath,
        inputString: env.inputString,
      });
    } else {
      const trait = traitValues[0].trait;
      if (!trait) {
        throw formatErrorMessage({
          token: tokens[index],
          errorMessage: `Cannot find trait ${typeConstraintName}`,
          modulePath: env.modulePath,
          inputString: env.inputString,
        });
      }
      const newTrait = applyTypeArgumentsToTrait({
        trait: trait,
        env,
        typeArguments,
        typeParameterToTypeArgumentMap: {},
      });
      typeConstraints.push(newTrait);

      /*
      // Add the interface implementation function
      for (let i = 0; i < newTrait.functions.length; i++) {
        const interfaceFunction = newTrait.functions[i];
        // interfaceFunction.func.hasNoImplementation = false; // Assume that the implementation exists
        trait.functions[i].func.traitFunctionImplementations.push(
          interfaceFunction
        );
      }
      */
    }

    if (tokens[index].type === TokenType.Comma) {
      index = index + 1;
      continue;
    }
  }

  // Extract functions from type constraints
  if (typeConstraints.length > 0) {
    typeConstraints.forEach((typeConstraint) => {
      typeConstraint.functions.forEach(({ name, func }) => {
        const newFunctionType: TFunction = {
          ...func,
          hasNoImplementation: false,
        };
        const { env: nextEnv } = addEnvVariableValue({
          env,
          variableValue: {
            variableName: name,
            type: newFunctionType,
            kind: "value",
            isMutable: false,
            token: emptyToken,
          },
        });
        env = nextEnv;
      });
    });
  }

  return {
    typeConstraints,
    index,
    env,
  };
}

/**
 * - Closure:
 *  - [own|read|write]<...>(...) => {...}
 * - Normal function:
 *  - <...>(...) => {...}
 * @returns
 */
export function synthesizeFunctionTypeFromTokens({
  tokens,
  index,
  env,
  parseExpression,
  withFunctionBody,
  expectedFunctionType,
  functionName,
}: {
  tokens: Token[];
  index: number;
  env: Environment;
  parseExpression: ParseExpression;
  withFunctionBody: boolean;
  expectedFunctionType?: TFunction;
  functionName?: string;
}): { typeValue: TFunction; index: number; env: Environment } {
  // Type parameters
  let frameLevel = getEnvCurrentFrameLevel(env);
  if (withFunctionBody) {
    frameLevel -= 1;
  }

  // Check Closure capture mode
  let closureCaptureMode: ClosureCaptureMode = "none";
  // TODO: Distinguish with => and =>>
  if (isClosureCaptureMode(tokens, index)) {
    if (tokens[index + 1].value === "&") {
      closureCaptureMode = "&";
    } else if (tokens[index + 1].value === "&mut") {
      closureCaptureMode = "&mut";
    } else if (tokens[index + 1].value === "=") {
      closureCaptureMode = "=";
    }
    index = index + 3;
  }

  let typeParameters: TTypeParameter[] = [];
  let typeConstraints: TTrait[] = [];
  if (tokens[index].value === "<") {
    const {
      typeParameters: nextTypeParameters,
      typeConstraints: nextTypeConstraints,
      index: nextIndex,
      env: nextEnv,
    } = synthesizeTypeParametersFromTokens({
      tokens,
      index,
      env,
      parseExpression,
    });
    typeParameters = nextTypeParameters;
    typeConstraints = nextTypeConstraints;
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
    expectedFunctionType,
  });
  index = nextIndex;
  env = nextEnv;

  // Function implementation
  if (withFunctionBody) {
    let returnType: Type = TypeValues.unknown;
    if (tokens[index].type === TokenType.Colon) {
      index += 1;
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

    if (returnType.type === "unknown" && expectedFunctionType) {
      returnType = expectedFunctionType.returnType;
    }

    if (
      tokens[index].type !== TokenType.FunctionArrow &&
      tokens[index].type !== TokenType.FatArrow &&
      tokens[index].type !== TokenType.MoveFatArrow
    ) {
      throw formatErrorMessage({
        token: tokens[index],
        errorMessage: "Expected '->', '=>', or '=>>' for function.",
        modulePath: env.modulePath,
        inputString: env.inputString,
      });
    }
    index += 1;

    const functionType: TFunction = {
      type: "Function",
      kind: closureCaptureMode === "=" ? "Type" : "Free",
      functionId:
        functionName === "main" || functionName?.startsWith("@") // compiletime functions
          ? functionName
          : generateVarialeValueId(env, functionName ?? "anonymousFunction"),
      parameterTypes,
      typeParameters,
      typeConstraints,
      returnType,
      closureCaptureMode,
      freeVariables: undefined,
      frameLevel,
      traitFunctionImplementations: [],
    };
    return {
      typeValue: functionType,
      index,
      env,
    };
  }

  if (tokens[index].type === TokenType.FunctionArrow) {
    index = index + 1;

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

    const functionType: TFunction = {
      type: "Function",
      kind: closureCaptureMode === "=" ? "Type" : "Free",
      functionId:
        functionName === "main" || functionName?.startsWith("@") // compiletime functions
          ? functionName
          : generateVarialeValueId(env, functionName ?? "anonymousFunction"),
      parameterTypes,
      typeParameters,
      typeConstraints,
      returnType,
      closureCaptureMode,
      freeVariables: undefined,
      frameLevel,
      traitFunctionImplementations: [],
    };
    return {
      typeValue: functionType,
      index,
      env,
    };
  } else {
    throw formatErrorMessage({
      token: tokens[index],
      errorMessage: "Expected function return type after '->', '=>', or '=>>'",
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

function getRecordTypeKind(properties: TRecordProperty[]): TypeKind {
  let kind: TypeKind = "Free";
  properties.forEach((property) => {
    if (kind === "Free") {
      const propertyKind = property.type.kind;
      kind = propertyKind;

      // QUESTION: What is the if here?
      if (property.type.type === "TypeParameter") {
        let appliedType = property.type.appliedType;
        if (appliedType) {
          while (
            appliedType.type === "TypeParameter" &&
            appliedType.appliedType
          ) {
            appliedType = appliedType.appliedType;
          }
          kind = appliedType.kind;
        }
      }
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
export function synthesizeTypeParametersFromTokens({
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
  typeParameters: TTypeParameter[];
  typeConstraints: TTrait[];
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
  let typeConstraints: TTrait[] = [];
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

    // Type constraints
    if (token.type === TokenType.Impl) {
      const {
        typeConstraints: nextTypeConstraints,
        index: nextIndex,
        env: nextEnv,
      } = synthesizeTypeConstraintsFromTokens({
        tokens,
        index,
        env,
        parseExpression,
      });
      typeConstraints = nextTypeConstraints;
      index = nextIndex;
      env = nextEnv;
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
    let kind: TypeKind | undefined = undefined;
    const parameterKindTokenIndex = index + 2;
    if (tokens[index + 1].type === TokenType.Colon) {
      index = index + 2;
      kind = parseTypeKind(tokens[index]);
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

    {
      const typeParameter: TTypeParameter = {
        type: "TypeParameter",
        kind: kind,
        typeParameterName: typeParameterName,
        typeParameterId: generateVarialeValueId(env, typeParameterName),
      };
      typeParameters.push(typeParameter);

      // Save to env
      const { env: nextEnv } = addEnvVariableValue({
        env,
        variableValue: {
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
    typeConstraints,
  };
}

/**
 * QUESTION: Should we support this?
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
    } else if (a.type === "Array" && b.type === "Array") {
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
    isFunctionImplementation,
  }: {
    extractTypeConstructor?: boolean | "all";
    hideTypeParameterKind?: boolean;
    isFunctionImplementation?: boolean;
  } = {}
): string {
  if ("tag" in type) {
    if (type.type === "symbol") {
      return `${JSON.stringify(type.value)}`;
    }
    return type.value; // + "::" + type.type;
  }

  switch (type.type) {
    case "()": {
      return "()";
    }
    case "boolean": {
      return `boolean`.trim();
    }
    case "char": {
      return `char`.trim();
    }
    case "u8": {
      return `u8`.trim();
    }
    case "u16": {
      return `u16`.trim();
    }
    case "u32": {
      return `u32`.trim();
    }
    case "u64": {
      return `u64`.trim();
    }
    /*
    case "u128": {
      return "u128";
    }
    */
    case "i8": {
      return `i8`.trim();
    }
    case "i16": {
      return `i16`.trim();
    }
    case "i32": {
      return `i32`.trim();
    }
    case "i64": {
      return `i64`.trim();
    }
    /*
    case "i128": {
      return "i128";
    }
    */
    case "f16": {
      return `f16`.trim();
    }
    case "f32": {
      return `f32`.trim();
    }
    case "f64": {
      return `f64`.trim();
    }
    case "usize": {
      return `usize`.trim();
    }
    case "symbol": {
      return `symbol`.trim();
    }
    case "Record": {
      return `{ ${type.properties
        .map(({ name, type }) => {
          return `${name}: ${typeToString(type, {
            extractTypeConstructor: false,
            hideTypeParameterKind: true,
          })}`;
        })
        .join("; ")} }`;
    }
    case "Function": {
      return `${closureCaptureModeToString(
        type.closureCaptureMode
      )}${typeParametersToString(type.typeParameters, type.typeConstraints, {
        hideTypeParameterKind: false,
      })}(${type.parameterTypes
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
        .join(", ")})${isFunctionImplementation ? ":" : "->"} ${typeToString(
        type.returnType,
        {
          hideTypeParameterKind: true,
        }
      )}`;
    }
    case "Union": {
      return `(${type.types
        .map((type) => typeToString(type))
        .join(" | ")})`.trim();
    }
    case "Intersection": {
      return `(${type.types
        .map((type) => typeToString(type))
        .join(" & ")})`.trim();
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
    case "Array": {
      return `${typeToString(type.elementType)}[${type.size ?? ""}]`.trim();
    }
    case "Tuple": {
      return `(${type.elements.map((type) => typeToString(type)).join(", ")}${
        type.elements.length === 1 ? "," : ""
      })`;
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
        return `${type.typeParameterName}`.trim();
      } else {
        return `${type.typeParameterName}: ${type.kind}`.trim();
      }
    }
    case "TypeConstructor": {
      if (extractTypeConstructor) {
        if (extractTypeConstructor === "all") {
          return `${type.typeConstructorName}${typeParametersToString(
            type.typeParameters,
            type.typeConstraints,
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
        let typeString = `${type.typeConstructorName}${typeParametersToString(
          type.typeParameters,
          type.typeConstraints,
          {
            hideTypeParameterKind,
          }
        )}`.trim();

        if (
          type.typeConstructorId ===
            TypeValues.ImmutableReference.typeConstructorId ||
          type.typeConstructorId ===
            TypeValues.MutableReference.typeConstructorId
        ) {
          typeString = typeString.replace(/<(.+?)>$/, "$1");
        }

        return typeString;
      }
    }
    case "Enum": {
      if (extractTypeConstructor) {
        return `enum ${type.enumName}${typeParametersToString(
          type.typeParameters,
          type.typeConstraints,
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
        return `${type.enumName}${typeParametersToString(
          type.typeParameters,
          type.typeConstraints,
          {
            hideTypeParameterKind: true,
          }
        )}${
          type.selectedVariantName && !hideTypeParameterKind
            ? `.${type.selectedVariantName}`
            : ""
        }`.trim();
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
  if (!expectedType || !givenType) {
    return false;
  }

  if (expectedType.type === "TypeParameter" && expectedType.appliedType) {
    return checkType(expectedType.appliedType, givenType, env);
  }
  if (givenType.type === "TypeParameter" && givenType.appliedType) {
    return checkType(expectedType, givenType.appliedType, env);
  }

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
      const valueTypes = getEnvVariableValueByVariableName(
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
        expectedType = applyTypeArgumentsToType({
          type: realType,
          env,
          typeArguments,
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
      /*
      if (expectedType.typeParameterId === givenType.typeParameterId) {
        return true;
      }
      */

      if (expectedType.appliedType.type === "TypeParameter") {
        return checkType(expectedType.appliedType, givenType, env);
      }

      if (givenType.appliedType) {
        return checkType(expectedType.appliedType, givenType.appliedType, env);
      }

      return false;
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
        ((expectedType.closureCaptureMode === "none" &&
          givenType.closureCaptureMode === "none") ||
          (expectedType.closureCaptureMode === "=" &&
            givenType.closureCaptureMode !== "none") ||
          (expectedType.closureCaptureMode === "&mut" &&
            givenType.closureCaptureMode === "&mut") ||
          (expectedType.closureCaptureMode === "&" &&
            givenType.closureCaptureMode === "&")) &&
        expectedType.parameterTypes.length ===
          givenType.parameterTypes.length &&
        expectedType.parameterTypes.every((parameterType, i) =>
          checkType(parameterType.type, givenType.parameterTypes[i].type, env)
        ) &&
        checkType(expectedType.returnType, givenType.returnType, env)
      );
    } else if (expectedTypeType === "Enum" && givenTypeType === "Enum") {
      return checkEnumExactMatchType(expectedType, givenType, env);
    } else if (expectedTypeType === "Tuple" && givenTypeType === "Tuple") {
      return checkTupleExactMatchType(expectedType, givenType, env);
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

export function typeParametersToString(
  typeParameters: TTypeParameter[],
  typeConstraints: TTrait[],
  { hideTypeParameterKind }: { hideTypeParameterKind?: boolean } = {}
) {
  if (typeParameters.length === 0) {
    return "";
  } else {
    return `<${typeParameters
      .map((type) => typeToString(type, { hideTypeParameterKind }))
      .join(", ")}${
      typeConstraints.length > 0
        ? ` given ${typeConstraints
            .map((trait) =>
              traitToString(trait, { extractTypeConstructor: false })
            )
            .join(", ")}`
        : ""
    }>`;
  }
}

export function closureCaptureModeToString(mode: ClosureCaptureMode): string {
  switch (mode) {
    case "none":
      return "";
    case "=":
      return "[=]";
    case "&":
      return "[&]";
    case "&mut":
      return "[&mut]";
  }
}

export function traitToString(
  type: TTrait,
  { extractTypeConstructor }: { extractTypeConstructor?: boolean } = {}
): string {
  if (extractTypeConstructor) {
    return `${
      type.isImplementation
        ? `impl${typeParametersToString(
            type.implementationTypeParameters ?? [],
            type.implementationTypeConstraints ?? []
          )}`
        : "trait"
    } ${type.traitName}${typeParametersToString(
      type.typeParameters,
      type.typeConstraints,
      {
        hideTypeParameterKind: type.isImplementation,
      }
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
  } else {
    return `${type.traitName}${typeParametersToString(
      type.typeParameters,
      type.typeConstraints,
      {
        hideTypeParameterKind: true,
      }
    )}`;
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

function checkTypeConstructorExactMatch(
  expectedType: TTypeConstructor,
  givenType: TTypeConstructor,
  env: Environment
) {
  if (expectedType.typeConstructorId !== givenType.typeConstructorId) {
    if (
      typeIsImmutableReference(expectedType) &&
      typeIsMutableReference(givenType)
    ) {
      // Do thing
    } else {
      return false;
    }
  }
  if (expectedType.typeParameters.length !== givenType.typeParameters.length) {
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
    expectedType.typeParameters.length !== givenType.typeParameters.length
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

function checkTupleExactMatchType(
  expectedType: TTuple,
  givenType: TTuple,
  env: Environment
): boolean {
  if (expectedType.elements.length !== givenType.elements.length) {
    return false;
  } else {
    return expectedType.elements.every((type, i) =>
      checkType(type, givenType.elements[i], env)
    );
  }
}

/**
 * This function will modify the `typeParameterToTypeArgumentMap`.
 * If the check failed, it will return false.
 * @param parameterType
 * @param argumentType
 * @param typeParameterToTypeArgumentMap
 */
function checkTypeForFunctionParametersAndArguments(
  env: Environment,
  parameterType: Type,
  argumentType: Type,
  typeParameterToTypeArgumentMap: { [key: string]: Type } = {}
): boolean {
  // .debug("- checkTypeForFunctionParametersAndArguments");
  // logger.debug("  - parameterType: ", typeToString(parameterType));
  // logger.debug("  - argumentType:  ", typeToString(argumentType));
  if (argumentType.type === "TypeParameter" && argumentType.appliedType) {
    return checkTypeForFunctionParametersAndArguments(
      env,
      parameterType,
      argumentType.appliedType,
      typeParameterToTypeArgumentMap
    );
  }
  if (parameterType.type === "TypeParameter") {
    if (parameterType.typeParameterId in typeParameterToTypeArgumentMap) {
      if (
        !checkType(
          typeParameterToTypeArgumentMap[parameterType.typeParameterId],
          argumentType,
          env
        )
      ) {
        return false;
      }
    }
    if (parameterType.appliedType) {
      checkTypeForFunctionParametersAndArguments(
        env,
        parameterType.appliedType,
        argumentType,
        typeParameterToTypeArgumentMap
      );
    } else {
      typeParameterToTypeArgumentMap[parameterType.typeParameterId] =
        argumentType;
    }
  } else if (
    "typeParameters" in parameterType &&
    "typeParameters" in argumentType &&
    parameterType.type === argumentType.type
  ) {
    const parameterTypeParameters = parameterType.typeParameters;
    const argumentTypeParameters = argumentType.typeParameters;
    if (parameterTypeParameters.length !== argumentTypeParameters.length) {
      return false;
    }
    for (let i = 0; i < parameterTypeParameters.length; i++) {
      const parameterTypeParameter = parameterTypeParameters[i];
      const argumentTypeParameter = argumentTypeParameters[i];
      if (
        !checkTypeForFunctionParametersAndArguments(
          env,
          parameterTypeParameter,
          argumentTypeParameter,
          typeParameterToTypeArgumentMap
        )
      ) {
        return false;
      } /* else {
        typeParameterToTypeArgumentMap[parameterTypeParameter.name] =
          argumentTypeParameter;
      } */
    }

    return true;
  }

  return checkType(parameterType, argumentType, env);
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
} {
  const functionTypeParamters: TTypeParameter[] = calleeType.typeParameters;
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

  const functionArgumentsInOrder: (Expr | null)[] = functionParameterTypes.map(
    (pt) => pt.defaultValue
  );
  const functionTypeArgumentsInOrder: Type[] = functionTypeParamters.map(
    () => TypeValues.unknown
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
        return {
          functionArguments: null,
          functionTypeArguments: null,
        };
      } else {
        functionArgumentsInOrder[argumentPositionIndex] = value;
      }
    } else {
      if (i >= functionArgumentsInOrder.length) {
        return {
          functionArguments: null,
          functionTypeArguments: null,
        };
      }
      // Positional argument
      functionArgumentsInOrder[i] = argument;
    }
  }

  // If functionArgumentsInOrder has any null, then it's not a match
  const typeParameterToTypeArgumentMap: { [key: string]: Type } = {};
  if (functionArgumentsInOrder.some((arg) => arg === null)) {
    return {
      functionArguments: null,
      functionTypeArguments: null,
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
        };
      }

      if (
        !checkTypeForFunctionParametersAndArguments(
          env,
          parameterType.type,
          argument.typeValue,
          typeParameterToTypeArgumentMap
        )
      ) {
        return {
          functionArguments: null,
          functionTypeArguments: null,
        };
      }
    }

    logger.debug(
      "  - typeParameterToTypeArgumentMap: ",
      typeParameterToTypeArgumentMap
    );

    for (let i = 0; i < functionTypeParamters.length; i++) {
      const typeParameter = functionTypeParamters[i];
      const typeArgument = functionTypeArguments[i];

      logger.debug(
        "    - typeParameter: ",
        typeToString(typeParameter),
        !!typeParameter.appliedType,
        typeParameter.typeParameterId in typeParameterToTypeArgumentMap
      );
      logger.debug(
        "    - typeArgument: ",
        typeArgument ? typeToString(typeArgument) : undefined
      );

      if (typeParameter.appliedType) {
        if (typeArgument) {
          if (checkType(typeParameter.appliedType, typeArgument, env)) {
            functionTypeArgumentsInOrder[i] = typeArgument;
          } else {
            // QUESTION: Should we throw error here?
            // ANSWER: Yes we should. The line below will override the type argument that we passed to the function, which might be different from the type parameter's appliedType.
            // functionTypeArgumentsInOrder[i] = typeParameter.appliedType;
            return {
              functionArguments: [],
              functionTypeArguments: null,
            };
          }
        } else {
          functionTypeArgumentsInOrder[i] = typeParameter.appliedType;
        }
      } else if (
        typeParameter.typeParameterId in typeParameterToTypeArgumentMap
      ) {
        // logger.debug(typeArgument) ;
        // Check type
        if (!typeArgument || typeArgument.type === "unknown") {
          functionTypeArgumentsInOrder[i] =
            typeParameterToTypeArgumentMap[typeParameter.typeParameterId];
        } else if (
          !checkType(
            typeArgument,
            typeParameterToTypeArgumentMap[typeParameter.typeParameterId],
            env
          )
        ) {
          return {
            functionArguments: [],
            functionTypeArguments: null,
          };
        } else {
          functionTypeArgumentsInOrder[i] =
            typeParameterToTypeArgumentMap[typeParameter.typeParameterId];
        }
      } else if (typeArgument) {
        functionTypeArgumentsInOrder[i] = typeArgument;
      } /* else {
        return {
          functionArguments: functionArgumentsInOrder as Expr[],
          functionTypeArguments: null,
        };
      } */

      functionTypeArgumentsInOrder[i] = applyTypeArgumentsToType({
        env,
        type: functionTypeArgumentsInOrder[i],
        typeArguments: [],
        typeParameterToTypeArgumentMap,
      });
    }

    logger.debug(
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
  receiverType: Type,
  functionName: string,
  env: Environment
) {
  const functionTypes = getEnvVariableValueByVariableName(env, functionName);
  // Find the functions that takes `expr` as the first argument
  const matchedFunctions = functionTypes.filter((functionType) => {
    if (functionType.type.type !== "Function") {
      return false;
    }
    const firstArgumentType = functionType.type.parameterTypes[0];
    if (!firstArgumentType) {
      return false;
    }
    return checkType(firstArgumentType.type, receiverType, env);
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

export function typeContainsTypeParameterThatDoesntHaveAppliedType(
  type: Type
): boolean {
  if (type.type === "TypeParameter") {
    if (type.appliedType) {
      return typeContainsTypeParameterThatDoesntHaveAppliedType(
        type.appliedType
      );
    } else {
      return true;
    }
  } else if ("typeParameters" in type) {
    const typeParameters = type.typeParameters;
    return typeParameters.some((t) =>
      typeContainsTypeParameterThatDoesntHaveAppliedType(t)
    );
  }

  return false;
}

function synthesizeTypeParameters({
  typeParameters,
  givenTypeParameters,
  typeParameterToTypeArgumentMap,
}: {
  typeParameters: TTypeParameter[];
  givenTypeParameters: TTypeParameter[];
  typeParameterToTypeArgumentMap: { [key: string]: Type };
}): void {
  for (let i = 0; i < typeParameters.length; i++) {
    const typeParameter = typeParameters[i];
    const givenTypeParameter = givenTypeParameters[i];
    if (!givenTypeParameter) {
      givenTypeParameters[i] = typeParameter; // QUESTION: Deepcopy?
      continue;
    }

    if (
      !typeParameter.appliedType ||
      typeParameter.appliedType.type === "unknown"
    ) {
      typeParameter.appliedType = givenTypeParameters[i].appliedType;
      if (typeParameter.appliedType) {
        typeParameterToTypeArgumentMap[typeParameter.typeParameterId] =
          typeParameter.appliedType;
      }
    }
  }
}

function synthesizeFunctions({
  expectedFunction,
  givenFunction,
  typeParameterToTypeArgumentMap,
}: {
  expectedFunction: TFunction;
  givenFunction: TFunction;
  typeParameterToTypeArgumentMap: { [key: string]: Type };
}): void {
  // Function type arguments
  synthesizeTypeParameters({
    typeParameters: expectedFunction.typeParameters,
    givenTypeParameters: givenFunction.typeParameters,
    typeParameterToTypeArgumentMap,
  });
  // Function parameters
  for (let i = 0; i < expectedFunction.parameterTypes.length; i++) {
    const expectedParameterType = expectedFunction.parameterTypes[i];
    const givenParameterType = givenFunction.parameterTypes[i];
    if (
      expectedParameterType.type.type === "unknown" &&
      givenParameterType.type
    ) {
      expectedParameterType.type = givenParameterType.type;
    } else if (
      givenParameterType.type.type === "unknown" &&
      expectedParameterType.type
    ) {
      givenParameterType.type = expectedParameterType.type;
    } else if (
      expectedParameterType.type &&
      givenParameterType.type &&
      expectedParameterType.type.type !== "unknown"
    ) {
      synthesizeTypes({
        expectedType: expectedParameterType.type,
        givenType: givenParameterType.type,
        typeParameterToTypeArgumentMap,
      });
    }
  }
  if (
    expectedFunction.returnType.type === "unknown" &&
    givenFunction.returnType.type !== "unknown"
  ) {
    expectedFunction.returnType = givenFunction.returnType;
  } else if (
    givenFunction.returnType.type === "unknown" &&
    expectedFunction.returnType.type !== "unknown"
  ) {
    givenFunction.returnType = expectedFunction.returnType;
  } else {
    // Function return type
    synthesizeTypes({
      expectedType: expectedFunction.returnType,
      givenType: givenFunction.returnType,
      typeParameterToTypeArgumentMap,
    });
  }
}

/**
 * Synthesize types
 * @param expectedType
 * @param givenType
 * @returns
 */
export function synthesizeTypes({
  expectedType,
  givenType,
  typeParameterToTypeArgumentMap,
}: {
  expectedType: Type;
  givenType: Type;
  typeParameterToTypeArgumentMap: { [key: string]: Type } | undefined;
}): Type | null {
  typeParameterToTypeArgumentMap = typeParameterToTypeArgumentMap ?? {};
  if (!expectedType || !givenType) {
    return null;
  }

  // Type inference for enum type
  if (
    expectedType.type === "Enum" &&
    givenType.type === "Enum" &&
    expectedType.enumId === givenType.enumId &&
    (expectedType.selectedVariantName === undefined ||
      expectedType.selectedVariantName === givenType.selectedVariantName)
  ) {
    synthesizeTypeParameters({
      typeParameters: expectedType.typeParameters,
      givenTypeParameters: givenType.typeParameters,
      typeParameterToTypeArgumentMap,
    });
    expectedType.selectedVariantName = givenType.selectedVariantName;
  }

  if (expectedType.type === "Array") {
    let userType = expectedType;
    let valueType = givenType as TArray;
    // Assign size to the array if it's undefined
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (userType.size === undefined) {
        userType.size = valueType.size;
      } else if (valueType.size && valueType.size < userType.size) {
        valueType.size = userType.size;
      }

      if (userType.elementType.type === "Array") {
        userType = userType.elementType;
        valueType = valueType.elementType as TArray;
      } else {
        break;
      }
    }
  }

  if (expectedType.type === "Tuple") {
    if (givenType.type === "Tuple") {
      if (expectedType.elements.length !== givenType.elements.length) {
        throw new Error(
          `Cannot synthesize types for tuple with different number of elements`
        );
      }
      for (let i = 0; i < expectedType.elements.length; i++) {
        synthesizeTypes({
          expectedType: expectedType.elements[i],
          givenType: givenType.elements[i],
          typeParameterToTypeArgumentMap,
        });
      }
    }
  }

  if (expectedType.type === "TypeConstructor") {
    if (givenType.type === "TypeConstructor") {
      synthesizeTypeParameters({
        typeParameters: expectedType.typeParameters,
        givenTypeParameters: givenType.typeParameters,
        typeParameterToTypeArgumentMap,
      });
    } else {
      synthesizeTypes({
        expectedType: expectedType.typeValue,
        givenType,
        typeParameterToTypeArgumentMap,
      });
      for (let i = 0; i < expectedType.typeParameters.length; i++) {
        const typeParameter = expectedType.typeParameters[i];
        if (
          (!typeParameter.appliedType ||
            typeParameter.appliedType.type === "unknown") &&
          typeParameter.typeParameterId in typeParameterToTypeArgumentMap
        ) {
          typeParameter.appliedType =
            typeParameterToTypeArgumentMap[typeParameter.typeParameterId];
        }
      }
    }
  }

  if (expectedType.type === "Function" && givenType.type === "Function") {
    synthesizeFunctions({
      expectedFunction: expectedType,
      givenFunction: givenType,
      typeParameterToTypeArgumentMap,
    });
    givenType.functionId = expectedType.functionId;
  }

  if (expectedType.type === "Record" && givenType.type === "Record") {
    if (expectedType.properties.length !== givenType.properties.length) {
      throw new Error(
        `Cannot synthesize types for record with different number of properties`
      );
    }
    for (let i = 0; i < expectedType.properties.length; i++) {
      const userDefinedTypeProperty = expectedType.properties[i];
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
          expectedType: userDefinedTypeProperty.type,
          givenType: givenTypeProperty.type,
          typeParameterToTypeArgumentMap,
        });
      }
    }
  }

  if (expectedType.type === "TypeParameter") {
    if (
      !expectedType.appliedType ||
      expectedType.appliedType.type === "unknown"
    ) {
      expectedType.appliedType = givenType;
    } else {
      synthesizeTypes({
        expectedType: expectedType.appliedType,
        givenType,
        typeParameterToTypeArgumentMap,
      });
    }
  }

  // Update expectedType kind
  // Check examples/tuple/tuple2.mo
  if (expectedType.kind === "Type") {
    expectedType.kind = givenType.kind;
  }

  return expectedType;
}

export function typeContainsReference(type: Type): boolean {
  if (typeIsReference(type)) {
    return true;
  } else if (type.type === "Record") {
    return type.properties.some((property) =>
      typeContainsReference(property.type)
    );
  } else if (type.type === "Array") {
    return typeContainsReference(type.elementType);
  } else if (type.type === "TypeConstructor") {
    return typeContainsReference(type.typeValue);
  } else if (type.type === "Enum") {
    return type.variants.some((variant) =>
      variant.parameterTypes.some((parameterType) =>
        typeContainsReference(parameterType.type)
      )
    );
  } else if (type.type === "Union" || type.type === "Intersection") {
    return type.types.some((type) => typeContainsReference(type));
  } else {
    return false;
  }
}

export function typeIsReference(type: Type): boolean {
  return (
    type.type === "TypeConstructor" &&
    (type.typeConstructorId ===
      TypeValues.ImmutableReference.typeConstructorId ||
      type.typeConstructorId === TypeValues.MutableReference.typeConstructorId)
  );
}

export function typeIsMutableReference(type: Type): boolean {
  return (
    type.type === "TypeConstructor" &&
    type.typeConstructorId === TypeValues.MutableReference.typeConstructorId
  );
}

export function typeIsImmutableReference(type: Type): boolean {
  return (
    type.type === "TypeConstructor" &&
    type.typeConstructorId === TypeValues.ImmutableReference.typeConstructorId
  );
}

export function isClosureCaptureMode(tokens: Token[], index: number): boolean {
  return (
    tokens[index]?.value === "[" &&
    ["&", "&mut", "="].includes(tokens[index + 1]?.value) &&
    tokens[index + 2]?.value === "]"
  );
}

export function unifyTypeKinds(kinds: TypeKind[]): TypeKind {
  if (kinds.find((kind) => kind === "Type")) {
    return "Type";
  } else if (kinds.find((kind) => kind === "Linear")) {
    return "Linear";
  } else {
    return "Free";
  }
}
