import {
  addVariableToEnv,
  Environment,
  Frame,
  getVariablesFromEnv,
} from "./env";
import { Expr, exprToString } from "./expr";
import { FunctionValue } from "./function-value";
import { Token } from "./token";
import { TypeValue } from "./type-value";
import { randomId } from "./utils";
import {
  areValuesEqual,
  createUnknownValue,
  isTypeValue,
  Value,
  valueToString,
} from "./value";
import { ValueTag } from "./value-tag";

// FIXME: We need to determine the ptr size based on the givenType architecture.
/**
 * @returns The size of a pointer in bytes.
 */
export function getPtrSize(): number {
  return 8;
}

/**
 * Type tags to identify different kinds of types
 */
export enum TypeTag {
  // Primitive types
  Unit = "unit",
  Boolean = "boolean",
  Char = "char",
  Usize = "usize",
  Isize = "isize",
  U8 = "u8",
  I8 = "i8",
  U16 = "u16",
  I16 = "i16",
  U32 = "u32",
  I32 = "i32",
  U64 = "u64",
  I64 = "i64",
  F32 = "f32",
  F64 = "f64",

  // Compt types
  ComptInt = "compt_int",
  ComptFloat = "compt_float",
  ComptString = "compt_string",

  // Add Undefined type
  // Undefined = "Undefined",

  // Type universes
  Free = "Free",
  Linear = "Linear",
  Type = "Type",

  // Complex types
  // Variant = "Variant",
  Array = "Array",
  Tuple = "Tuple",
  Struct = "Struct",
  Enum = "Enum",
  Union = "Union",
  Function = "Function",

  // Some Type
  SomeType = "SomeType",

  // Value
  Literal = "Literal",

  // Module
  Module = "Module",

  // Pointer & Reference
  MutLinearPtr = "MutLinearPtr",
  LinearPtr = "LinearPtr",
  MutPtr = "MutPtr",
  Ptr = "Ptr",
  MutRef = "MutRef",
  Ref = "Ref",
}

export interface TypeMethod {
  label: string;
  type: FunctionType;
  value: FunctionValue;
}

export interface Type {
  /**
   * The tag to identify the type of type.
   */
  tag: TypeTag;

  /**
   * The size of the type in bits, not bytes.
   * For example, a 32-bit integer has a size of 4 bytes.
   * A 64-bit integer has a size of 8 bytes.
   * If not specified, the size is unknown.
   */
  // size?: number;
}

export interface LiteralType extends Type {
  tag: TypeTag.Literal;
  /**
   * The value of the singleton type.
   * This is also used to represent the value of a variable.
   */
  value: unknown;
  /**
   * The type of the value.
   */
  type: Type;
}

export function isPrimitiveType(type: Type): boolean {
  return (
    type.tag === TypeTag.Unit ||
    type.tag === TypeTag.Boolean ||
    type.tag === TypeTag.Char ||
    type.tag === TypeTag.Usize ||
    type.tag === TypeTag.Isize ||
    type.tag === TypeTag.U8 ||
    type.tag === TypeTag.I8 ||
    type.tag === TypeTag.U16 ||
    type.tag === TypeTag.I16 ||
    type.tag === TypeTag.U32 ||
    type.tag === TypeTag.I32 ||
    type.tag === TypeTag.U64 ||
    type.tag === TypeTag.I64 ||
    type.tag === TypeTag.F32 ||
    type.tag === TypeTag.F64 // ||
    // type.tag === TypeTag.Undefined // Add undefined as a primitive type
  );
}

export function isComptIntType(type?: Type): boolean {
  return type?.tag === TypeTag.ComptInt;
}

export function isComptFloatType(type?: Type): boolean {
  return type?.tag === TypeTag.ComptFloat;
}

export function isComptStringType(type?: Type): boolean {
  return type?.tag === TypeTag.ComptString;
}

export function isBooleanType(type: Type): boolean {
  return type.tag === TypeTag.Boolean;
}

// Add missing kind field to all Type constants
// export const TUndefined: Type = {
//   tag: TypeTag.Undefined,
//   size: 0, // Undefined has no runtime size
// };

export interface TypeHierarchyType extends Type {
  tag: TypeTag.Free | TypeTag.Linear | TypeTag.Type;
  level: number;

  // TODO: Implemented interfaces
}

export const TFree: TypeHierarchyType = {
  tag: TypeTag.Free,
  // size: 0, // Types themselves don't have runtime size
  level: 0,
};

export const TLinear: TypeHierarchyType = {
  tag: TypeTag.Linear,
  // size: 0, // Types themselves don't have runtime size
  level: 0,
};

export const TType: TypeHierarchyType = {
  tag: TypeTag.Type,
  // size: 0, // Types themselves don't have runtime size
  level: 0,
};

/**
 * SomeType is a type that is not known.
 *
 * MyType: (Type <: Display)
 * - type: (Type <: Display)
 * - value: SomeType(Type <: Display)
 *
 * The value here is the SomeType itself.
 */
export interface SomeType extends Type {
  tag: TypeTag.SomeType;

  /**
   * The name of the SomeType.
   * eg: T: Type
   * T is the name of the SomeType.
   */
  name: string;

  /**
   * The unique identifier for this SomeType.
   */
  typeId: string;

  /**
   * The parent type of the SomeType.
   */
  parentType: TypeHierarchyType;
  /**
   * size is unknown for SomeType
   */
  size: undefined;
}

export const TComptInt: Type = {
  tag: TypeTag.ComptInt,
  // size: 0, // Size of compt_int is not available at runtime
};

export const TComptFloat: Type = {
  tag: TypeTag.ComptFloat,
  // size: 0, // Size of compt_float is not available at runtime
};

export const TComptString: Type = {
  tag: TypeTag.ComptString,
  // size: 0, // Size of compt_string is not avaiable at runtime
};

export const TBoolean: Type = {
  tag: TypeTag.Boolean,
  // size: 8,
};

/**
 * 4 bytes unicode
 */
export const TChar: Type = {
  tag: TypeTag.Char,
  // size: 4 * 8,
};

export const TUsize: Type = {
  tag: TypeTag.Usize,
  // size: getPtrSize() * 8,
};
export const TIsize: Type = {
  tag: TypeTag.Isize,
  // size: getPtrSize() * 8,
};
export const TU8: Type = {
  tag: TypeTag.U8,
  // size: 1 * 8,
};
export const TU16: Type = {
  tag: TypeTag.U16,
  // size: 2 * 8,
};
export const TU32: Type = {
  tag: TypeTag.U32,
  // size: 4 * 8,
};
export const TU64: Type = {
  tag: TypeTag.U64,
  // size: 8 * 8,
};
export const TI8: Type = {
  tag: TypeTag.I8,
  // size: 1 * 8,
};
export const TI16: Type = {
  tag: TypeTag.I16,
  // size: 2 * 8,
};
export const TI32: Type = {
  tag: TypeTag.I32,
  // size: 4 * 8,
};
export const TI64: Type = {
  tag: TypeTag.I64,
  // size: 8 * 8,
};
export const TF32: Type = {
  tag: TypeTag.F32,
  // size: 4 * 8,
};
export const TF64: Type = {
  tag: TypeTag.F64,
  // size: 8 * 8,
};
export const TUnit: Type = {
  tag: TypeTag.Unit,
  // size: 0,
};

// Extended Type interface for compound types
export interface ArrayType extends Type {
  tag: TypeTag.Array;
  elementType: Type;
  length: Value; // Compile-time known usize compatible value.
}

export type TupleElementExprs = {
  /**
   * The expression of the tuple element.
   */
  expr: Expr;
  /**
   * For example:
   *   x in (x: i32)
   */
  labelExpr?: Expr;
  /**
   * For example:
   *   i32 in (x: i32)
   */
  typeExpr?: Expr;
  /**
   * For example:
   *   x ?= 10
   *
   * defaultValueExpr is:
   *   10
   */
  defaultValueExpr?: Expr;
  /**
   * For example:
   *   x = 20
   *
   * assignedValueExpr is:
   *  20
   */
  assignedValueExpr?: Expr;
};

export interface TupleElement {
  /**
   * The type of the element.
   * eg: i32
   * i32 is the type of the element.
   */
  type: Type;

  /**
   * label of the element,
   * eg: x: i32
   * x is the label of the element.
   *
   * For the element that is not labelled, we generate temporary label for it.
   * For example:
   *  i32
   * This is a element without label.
   * We generate a temporary label for it, like $element_12345
   */
  label: string;

  /**
   * If the element is compile time only or not
   */
  isCompileTimeOnly: boolean;

  /**
   * If the element is implicit or not.
   */
  isImplicit: boolean;

  /**
   * The default value of the element, define using the ?= operator.
   * Which has to be compile-time known.
   * For example:
   *  (T: Type) ?= i32
   */
  defaultValue?: Value;

  /**
   * The assigned value of the element.
   * Which has to be compile-time known.
   * For example:
   *  (T: Type) = i32;
   *
   * Once this is set, we cannot assign/change the value.
   *
   * For example:
   *
   *    ```
   *    Id :: ((@(T): Type)-> @(Type))
   *      struct:
   *        (@(Self) : Type) = T,
   *        // or
   *        // Self :: T,
   *
   *        id:
   *          (x: Self)-> Self
   *    ;
   *    MyId :: Id(i32)
   *      // Self: i32, // <- This line is not allowed
   *      id:
   *        fn(x)-> x
   *    ;
   *    ```
   */
  assignedValue?: Value;

  /**
   * The expression of the element.
   */
  exprs: TupleElementExprs;
}

export interface TupleType extends Type {
  tag: TypeTag.Tuple;
  /**
   * The elements of the tuple.
   */
  elements: TupleElement[];
}

export type FunctionParameterExprs =
  | {
      // (i32)
      labelExpr: undefined;
      typeExpr: Expr;
      defaultValueExpr: undefined;
    }
  | {
      // (x: i32)
      labelExpr: Expr;
      typeExpr: Expr;
      defaultValueExpr: undefined;
    }
  | {
      // ((x : i32) = 14)
      labelExpr: Expr;
      typeExpr: Expr;
      defaultValueExpr: Expr;
    }
  | {
      // (x = 15)
      labelExpr: Expr;
      typeExpr: undefined;
      defaultValueExpr: Expr;
    };

export function getFunctionParameterExprs({
  labelExpr,
  typeExpr,
  defaultValueExpr,
}: {
  labelExpr: Expr | undefined;
  typeExpr: Expr | undefined;
  defaultValueExpr: Expr | undefined;
}): FunctionParameterExprs {
  if (!labelExpr && !typeExpr && !defaultValueExpr) {
    throw new Error(
      `At least one of labelExpr, typeExpr or defaultValueExpr must be defined`
    );
  }
  if (!typeExpr && !defaultValueExpr) {
    throw new Error(
      `Expected either typeExpr or defaultValueExpr to be defined`
    );
  }
  return { labelExpr, typeExpr, defaultValueExpr } as FunctionParameterExprs;
}

export interface FunctionParameter {
  /**
   * The type of the element.
   * eg: i32
   * i32 is the type of the element.
   */
  type: Type;

  /**
   * label of the element,
   * eg: x: i32
   * x is the label of the element.
   *
   * For the parameter that is not labelled, we generate temporary label for it.
   * For example:
   * i32
   * This is a parameter without label.
   * We generate a temporary label for it, like $param_12345
   */
  label: string;

  // Some expressions used in the parameter definition
  exprs: FunctionParameterExprs;

  /**
   * If the parameter is mutable or not.
   */
  isMutable: boolean;

  /**
   * If the parameter is compile-time only or not.
   */
  isCompileTimeOnly: boolean;
}

export function getFunctionParameterToken(parameter: FunctionParameter): Token {
  if (parameter.exprs.labelExpr?.token) {
    return parameter.exprs.labelExpr.token;
  } else if (parameter.exprs.typeExpr?.token) {
    return parameter.exprs.typeExpr.token;
  } else if (parameter.exprs.defaultValueExpr?.token) {
    return parameter.exprs.defaultValueExpr.token;
  } else {
    throw new Error(`Cannot get token for function parameter`);
  }
}

export interface StructType extends Type {
  tag: TypeTag.Struct;

  /**
   * The unique identifier for this struct.
   */
  typeId: string;

  /**
   * The name of the struct.
   * eg:
   *   Point := struct(i32, i32);
   * Point is the name of the struct.
   */
  typeName?: string;

  /**
   * The function that returns the struct.
   * eg:
   *   def Container:
   *     (compt(T): Type)-> compt(Type),
   *     struct(T, T)
   * ;
   * "Container" is the function that returns the struct.
   */
  functionValue?: FunctionValue;

  /**
   * The elements of the struct.
   */
  elements: TupleElement[];

  /**
   * The methods implemented for this type
   */
  methods: TypeMethod[];
}

export interface EnumVariant {
  /**
   * Without `.` prefix
   */
  name: string;
  elements?: TupleElement[]; // Changed from TupleElement[] to TupleType for consistency
  // TODO: return type? For GADT
}

export interface EnumType extends Type {
  tag: TypeTag.Enum;

  /**
   * The unique identifier for this struct.
   */
  typeId: string;

  /**
   * The name of the struct.
   * eg:
   *   Point := struct(i32, i32);
   * Point is the name of the struct.
   */
  typeName?: string;

  /**
   * The function that returns the enum.
   */
  functionValue?: FunctionValue;

  /**
   * The variants of the enum.
   */
  variants: EnumVariant[];

  /**
   * The size of the tag in bits.
   */
  // tagSize: number;

  /**
   * The name of the selected variant.
   */
  selectedVariantName?: string;

  /**
   * The methods implemented for this type
   */
  methods: TypeMethod[];
}

export interface UnionType extends Type {
  tag: TypeTag.Union;

  /**
   * The unique identifier for this struct.
   */
  typeId: string;

  /**
   * The name of the struct.
   * eg:
   *   Point := struct(i32, i32);
   * Point is the name of the struct.
   */
  typeName?: string;

  /**
   * The elements of the union.
   */
  elements: TupleElement[];

  /**
   * The methods implemented for this type
   */
  methods: TypeMethod[];
}

export interface FunctionReturn {
  /**
   * The expression of the function return.
   */
  expr: Expr;

  /**
   * The type of the function return.
   */
  type: Type;

  /**
   * Whether the value of the function return can be used for compile-time only or not.
   */
  isCompileTimeOnly?: boolean;
}

export interface FunctionType extends Type {
  tag: TypeTag.Function;
  /**
   * The normal parameters of the function.
   */
  parameters: FunctionParameter[];

  /**
   * The type parameters, usually defined in forall(...):
   * eg:
   *   (forall(@(T): Type), x: T)-> T;
   */
  typeParameters: FunctionParameter[];

  /**
   * The implicit parameters (aka contextual parameters), usually define in implicit(...):
   * eg:
   *   (@(T): Type, p: Point(T), implicit(Show(T)))-> String
   */
  implicitParameters: FunctionParameter[];

  /**
   * The return information of the function.
   */
  return: FunctionReturn;
  /**
   * The env when the function type is created.
   * The env shouldn't contain the frame that have the parameters.
   * The env is also useful to show the frame level at which the function is defined.
   */
  env: Environment;

  /**
   * The frame that contains the parameters
   */
  parametersFrame: Frame;

  /**
   * Under which interface/struct/enum/union this function is defined.
   */
  SelfType?: Type;
}

export interface MutLinearPtrType extends Type {
  tag: TypeTag.MutLinearPtr;
  /**
   * The type of the pointer.
   */
  type: Type;
}

export interface LinearPtrType extends Type {
  tag: TypeTag.LinearPtr;
  /**
   * The type of the pointer.
   */
  type: Type;
}

export interface MutPtrType extends Type {
  tag: TypeTag.MutPtr;
  /**
   * The type of the pointer.
   */
  type: Type;
}

export interface PtrType extends Type {
  tag: TypeTag.Ptr;
  /**
   * The type of the pointer.
   */
  type: Type;
}

export interface MutRefType extends Type {
  tag: TypeTag.MutRef;
  /**
   * The type of the reference.
   */
  type: Type;
}

export interface RefType extends Type {
  tag: TypeTag.Ref;
  /**
   * The type of the reference.
   */
  type: Type;
}

export function createTypeHierarchy(level: number): TypeHierarchyType {
  return {
    tag: TypeTag.Type,
    // size: 0,
    level,
  };
}

// Type constructor functions (need to be updated to include kind)
export function createArrayType(elementType: Type, length: Value): ArrayType {
  /*
  if (elementType.size === undefined) {
    throw new Error(
      `Cannot create array type of ${typeToString(elementType)}.
Element type size is undefined.`
    );
  }
    */

  return {
    tag: TypeTag.Array,
    // size: elementType.size * length,
    elementType,
    length,
  };
}

export function createTupleType(elements: TupleElement[]): TupleType {
  /* let totalSize: undefined | number = 0;
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i]!;
    if (element.type.size === undefined) {
      totalSize = undefined;
    } else if (typeof totalSize === "number") {
      totalSize += element.type.size;
    }
  }
  */

  return {
    tag: TypeTag.Tuple,
    // size: totalSize,
    elements,
  };
}

export function createStructType(
  elements: TupleElement[],
  methods: TypeMethod[] = [],
  typeId?: string
): StructType {
  /*
  let totalSize: undefined | number = 0;
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i]!;
    if (element.type.size === undefined) {
      totalSize = undefined;
    } else if (typeof totalSize === "number") {
      totalSize += element.type.size;
    }
  }
  */

  return {
    tag: TypeTag.Struct,
    // size: totalSize,
    elements,
    methods,
    typeId: typeId ?? `struct_${randomId()}`,
  };
}

export function createEnumType(
  variants: EnumVariant[],
  methods: TypeMethod[] = [],
  typeId?: string
): EnumType {
  /*
  let totalSize: undefined | number = 0;
  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i]!;
    let variantSize = 0;
    if (variant.elements) {
      for (let j = 0; j < variant.elements.length; j++) {
        const element = variant.elements[j]!;
        if (element.type.size === undefined) {
          totalSize = undefined;
        } else if (typeof totalSize === "number") {
          variantSize += element.type.size;
        }
      }
    }
    if (typeof totalSize === "number") {
      totalSize = Math.max(totalSize, variantSize);
    }
  }

  // Get the tagSize in bits
  const tagSize =
    typeof totalSize === "number" && totalSize > 0
      ? Math.ceil(Math.log2(variants.length)) * 8
      : 0;
  */

  return {
    tag: TypeTag.Enum,
    // size: typeof totalSize === "number" ? totalSize + tagSize : undefined,
    variants,
    methods,
    // tagSize,
    typeId: typeId ?? `enum_${randomId()}`,
  };
}

export function createUnionType(
  elements: TupleElement[],
  methods: TypeMethod[] = [],
  typeId?: string
): UnionType {
  /*
  let maxSize = 0;
  for (let i = 0; i < elements.length; i++) {
    const type = elements[i]!.type;
    if (type.size === undefined) {
      throw new Error(
        `Cannot create union type: type at index ${i} has undefined size`
      );
    }
    maxSize = Math.max(maxSize, type.size);
  }
  */

  return {
    tag: TypeTag.Union,
    // size: maxSize, // Changed from totalSize to maxSize as unions use the size of largest variant
    elements,
    methods,
    typeId: typeId ?? `union_${randomId()}`,
  };
}

export function createFunctionType({
  parameters,
  typeParameters,
  implicitParameters,
  return_,
  env,
  parametersFrame,
  SelfType,
}: {
  parameters: FunctionParameter[];
  typeParameters: FunctionParameter[];
  implicitParameters: FunctionParameter[];
  return_: FunctionReturn;
  env: Environment;
  parametersFrame: Frame;
  SelfType?: Type;
}): FunctionType {
  return {
    tag: TypeTag.Function,
    // size: getPtrSize() * 8,
    parameters: parameters, // Wrap params in a TupleType
    typeParameters,
    implicitParameters,
    return: return_,
    env,
    parametersFrame,
    SelfType,
  };
}

export function getStructReceiverType(structType: StructType): Type | null {
  const receiverType = structType.elements.find(
    (element) => element.label === "Self" && element.isCompileTimeOnly
  );
  if (!receiverType || !receiverType.assignedValue) {
    return null;
  }
  const typeValue = receiverType.assignedValue;
  if (!isTypeValue(typeValue)) {
    return null;
  }
  return typeValue.value;
}

export function createMutLinearPtrType(type: Type): MutLinearPtrType {
  return {
    tag: TypeTag.MutLinearPtr,
    // size: getPtrSize() * 8,
    type,
  };
}

export function createLinearPtrType(type: Type): LinearPtrType {
  return {
    tag: TypeTag.LinearPtr,
    // size: getPtrSize() * 8,
    type,
  };
}

export function createMutPtrType(type: Type): MutPtrType {
  return {
    tag: TypeTag.MutPtr,
    // size: getPtrSize() * 8,
    type,
  };
}

export function createPtrType(type: Type): PtrType {
  return {
    tag: TypeTag.Ptr,
    // size: getPtrSize() * 8,
    type,
  };
}

export function createMutRefType(type: Type): MutRefType {
  return {
    tag: TypeTag.MutRef,
    // size: getPtrSize() * 8,
    type,
  };
}

export function createRefType(type: Type): RefType {
  return {
    tag: TypeTag.Ref,
    // size: getPtrSize() * 8,
    type,
  };
}

// Helper function to determine the type universe of a list of types
function determineTypeUniverse(types: Type[]): Type {
  let hasLinear = false;
  let meetTypeTag = false;
  let maxTypeLevel = 0;

  for (const type of types) {
    // For non-universe types, recursively check their type
    const typeOfSubType = typeOfType(type);
    if (isTypeHierarchyType(typeOfSubType)) {
      maxTypeLevel = Math.max(maxTypeLevel, typeOfSubType.level);
      if (typeOfSubType.tag === TypeTag.Linear) {
        hasLinear = true;
      } else if (typeOfSubType.tag === TypeTag.Type) {
        meetTypeTag = true;
      }
    }
  }

  if (maxTypeLevel > 0) {
    return createTypeHierarchy(maxTypeLevel);
  }
  if (meetTypeTag) {
    return TType;
  }

  // If we found any linear but no type, return linear
  if (hasLinear) {
    return TLinear;
  }

  // Otherwise all are free
  return TFree;
}

// Update typeOfType function
export function typeOfType(t: Type): Type {
  /*if (t.tag === TypeTag.Undefined) {
    return TFree; // Undefined is in the free type universe
  } else */ if (isPrimitiveType(t)) {
    return TFree;
  } else if (isTypeHierarchyType(t)) {
    return createTypeHierarchy((t as TypeHierarchyType).level + 1);
  } else if (isComptIntType(t) || isComptFloatType(t) || isComptStringType(t)) {
    return TFree;
  } else if (t.tag === TypeTag.Function) {
    return TFree;
  } else if (isArrayType(t)) {
    // For arrays, check the element type
    return typeOfType(t.elementType);
  } else if (isTupleType(t)) {
    // For tuples, check all element types
    return determineTypeUniverse(
      t.elements
        .filter((element) => !element.isCompileTimeOnly)
        .map((element) => element.type)
    );
  } else if (isStructType(t)) {
    // For structs, check all member types
    return determineTypeUniverse(
      t.elements
        .filter((element) => !element.isCompileTimeOnly)
        .map((element) => element.type)
    );
  } else if (isEnumType(t)) {
    // For enums, check all variant
    const types: Type[] = [];
    for (const variant of t.variants) {
      if (variant.elements) {
        types.push(...variant.elements.map((param) => param.type));
      }
    }
    return determineTypeUniverse(types);
  } else if (isUnionType(t)) {
    // For unions, check all member types
    return determineTypeUniverse(t.elements.map((element) => element.type));
  } else if (isSomeType(t)) {
    return t.parentType;
  } else if (isMutLinearPtrType(t) || isLinearPtrType(t)) {
    return TLinear;
  } else if (
    isMutPtrType(t) ||
    isPtrType(t) ||
    isMutRefType(t) ||
    isRefType(t)
  ) {
    return TFree;
  } else {
    throw new Error(`Unknown type tag: ${t}`);
  }
}

export function getValueOfSomeTypeFromEnv(
  env: Environment,
  someType: SomeType
): Type {
  let someTypeValue: TypeValue | undefined = undefined;
  do {
    const variables = getVariablesFromEnv(env, someType.name, (variable) => {
      return variable.value?.tag === ValueTag.Type;
      // cannot use "isTypeValue" function here due to circular dependency
    });
    if (!variables.length) {
      // NOTE: This might be SomeType defined from "forall"
      // So it doesn't exist in the env.
      return someType; // Return itself
      // return undefined;
    }

    someTypeValue = variables[variables.length - 1]!.value as TypeValue;

    // This if condition is used to prevent the infinite loop
    if (someTypeValue.value === someType) {
      return someType; // Returned itself actually
    }
    if (isSomeType(someTypeValue.value)) {
      someType = someTypeValue.value;
    } else {
      break;
    }
  } while (isSomeType(someType));
  return someTypeValue.value;
}

/**
 * Check if two function types are compatible.
 * @param expectedType The expected function type.
 * @param givenType The given function type.
 * @param env
 * @returns
 */
export function areFunctionTypesCompatible(
  expected: {
    type: FunctionType;
    env: Environment;
  },
  given: {
    type: FunctionType;
    env: Environment;
  }
): boolean {
  // Check if the type parameters have the same count
  if (expected.type.parameters.length !== given.type.parameters.length) {
    return false;
  }

  // Check if the parameters have the same count
  if (
    expected.type.typeParameters.length !== given.type.typeParameters.length
  ) {
    return false;
  }

  // Check if the implicit parameters have the same count
  if (
    expected.type.implicitParameters.length !==
    given.type.implicitParameters.length
  ) {
    return false;
  }

  // Check type parameters for compatibility
  for (let i = 0; i < expected.type.typeParameters.length; i++) {
    const expectedTypeParam = expected.type.typeParameters[i]!;
    const givenTypeParam = given.type.typeParameters[i]!;

    /**
     * Check if
     * Type == Type
     * Linear == Linear
     * Free == Free
     */
    if (
      !areTypesCompatible(
        { type: expectedTypeParam.type, env: expected.env },
        { type: givenTypeParam.type, env: given.env }
      )
    ) {
      return false;
    }
    // Create some type value for expectedType and givenType
    // then add it to the env.
    const typeValue = createUnknownValue(
      givenTypeParam.type,
      `some_type_${randomId()}`
    );
    if (expectedTypeParam.label) {
      const { env: nextEnv } = addVariableToEnv({
        env: expected.env,
        variable: {
          name: expectedTypeParam.label,
          value: typeValue,
          type: typeValue.type,
          isCompileTimeOnly: true,
          isImplicit: false,
          isUndefined: false,
          isMutable: false,
          token: getFunctionParameterToken(expectedTypeParam),
        },
      });
      expected.env = nextEnv;
    }
    if (givenTypeParam.label) {
      const { env: nextEnv2 } = addVariableToEnv({
        env: given.env,
        variable: {
          name: givenTypeParam.label,
          value: typeValue,
          type: typeValue.type,
          isCompileTimeOnly: true,
          isImplicit: false,
          isUndefined: false,
          isMutable: false,
          token: getFunctionParameterToken(givenTypeParam),
        },
      });
      given.env = nextEnv2;
    }
  }

  // Check regular parameters for compatibility
  for (let i = 0; i < expected.type.parameters.length; i++) {
    if (
      !areTypesCompatible(
        {
          type: expected.type.parameters[i]!.type,
          env: expected.env,
        },
        {
          type: given.type.parameters[i]!.type,
          env: given.env,
        }
      )
    ) {
      return false;
    }
  }

  // Check implicit parameters for compatibility
  for (let i = 0; i < expected.type.implicitParameters.length; i++) {
    const expectedImplicitParam = expected.type.implicitParameters[i]!;
    const givenImplicitParam = given.type.implicitParameters[i]!;

    if (
      expectedImplicitParam.isCompileTimeOnly !==
        givenImplicitParam.isCompileTimeOnly ||
      !areTypesCompatible(
        { type: expectedImplicitParam.type, env: expected.env },
        { type: givenImplicitParam.type, env: given.env }
      )
    ) {
      return false;
    }
  }

  return areTypesCompatible(
    { type: expected.type.return.type, env: expected.env },
    { type: given.type.return.type, env: given.env }
  );
}

// Update the areTypesCompatible function for StructType
export function areTypesCompatible(
  expected: {
    type: Type;
    env: Environment;
  },
  given: {
    type: Type;
    env: Environment;
  }
): boolean {
  if (isPrimitiveType(expected.type) && isPrimitiveType(given.type)) {
    return expected.type.tag === given.type.tag;
  }

  // compt_int can be converted to
  // - compt_int
  // - u8
  // - i8
  // - u16
  // - i16
  // - u32
  // - i32
  // - u64
  // - i64
  // - usize
  // - isize
  if (
    (isComptIntType(expected.type) ||
      expected.type.tag === TypeTag.U8 ||
      expected.type.tag === TypeTag.I8 ||
      expected.type.tag === TypeTag.U16 ||
      expected.type.tag === TypeTag.I16 ||
      expected.type.tag === TypeTag.U32 ||
      expected.type.tag === TypeTag.I32 ||
      expected.type.tag === TypeTag.U64 ||
      expected.type.tag === TypeTag.I64 ||
      expected.type.tag === TypeTag.Usize ||
      expected.type.tag === TypeTag.Isize) &&
    isComptIntType(given.type)
  ) {
    return true;
  }

  // compt_float can be converted to
  // - compt_float
  // - f32
  // - f64
  if (
    (isComptFloatType(expected.type) ||
      expected.type.tag === TypeTag.F32 ||
      expected.type.tag === TypeTag.F64) &&
    isComptFloatType(given.type)
  ) {
    return true;
  }

  // compt_string can be converted to
  // - compt_float
  // TODO:
  // - *(u8);  // C-style string pointer.
  // - Array(u8, N); // Fixed-length array of u8.
  // - &(str); // Rust-style string slice, fat pointer.
  if (isComptStringType(expected.type) && isComptStringType(given.type)) {
    return true;
  }

  if (isArrayType(expected.type) && isArrayType(given.type)) {
    // Arrays must have same length and compatible element types
    return (
      areValuesEqual(
        { value: expected.type.length, env: expected.env },
        { value: given.type.length, env: expected.env }
      ) &&
      areTypesCompatible(
        {
          type: expected.type.elementType,
          env: expected.env,
        },
        { type: given.type.elementType, env: given.env }
      )
    );
  }

  if (isTupleType(expected.type) && isTupleType(given.type)) {
    if (expected.type.elements.length !== given.type.elements.length) {
      return false;
    }
    for (let i = 0; i < expected.type.elements.length; i++) {
      const expectedTypeElement = expected.type.elements[i]!;
      const givenTypeElement = given.type.elements[i]!;

      if (
        !areTypesCompatible(
          { type: expectedTypeElement.type, env: expected.env },
          { type: givenTypeElement.type, env: given.env }
        )
      ) {
        return false;
      }

      // QUESTION: Should we check the label here?
      // NOTE: We don't check labels, as the Tuple is a structural type,
      //       not a nominal type.
    }
    return true;
  }

  if (isStructType(expected.type) && isStructType(given.type)) {
    // Structs must have same elements and compatible types
    if (
      expected.type.elements.length !== given.type.elements.length ||
      // NOTE: Below is not necessarily true
      // We might compare Box(T) and Box(U), where T and U are SomeType.
      (expected.type.typeId !== given.type.typeId &&
        !typeContainsSomeType(expected.type) &&
        !typeContainsSomeType(given.type))
    ) {
      return false;
    }

    if (expected.type.typeId === given.type.typeId) {
      return true;
    }

    for (let i = 0; i < expected.type.elements.length; i++) {
      const expectedElement = expected.type.elements[i]!;
      const givenElement = given.type.elements[i]!;

      if (
        expectedElement.label !== givenElement.label ||
        !areTypesCompatible(
          {
            type: expectedElement.type,
            env: expected.env,
          },
          { type: givenElement.type, env: given.env }
        )
      ) {
        return false;
      }
    }
    return true;
  }

  if (isEnumType(expected.type) && isEnumType(given.type)) {
    if (expected.type.typeId === given.type.typeId) {
      return true;
    }

    // Check each variants
    if (expected.type.variants.length !== given.type.variants.length) {
      return false;
    }

    for (let i = 0; i < expected.type.variants.length; i++) {
      const expectedVariant = expected.type.variants[i]!;
      const givenVariant = given.type.variants[i]!;

      if (expectedVariant.name !== givenVariant.name) {
        return false;
      }

      if (expectedVariant.elements?.length !== givenVariant.elements?.length) {
        return false;
      }

      if (expectedVariant.elements) {
        for (let j = 0; j < expectedVariant.elements.length; j++) {
          const expectedElement = expectedVariant.elements![j]!;
          const givenElement = givenVariant.elements![j]!;

          if (
            expectedElement.label !== givenElement.label ||
            !areTypesCompatible(
              { type: expectedElement.type, env: expected.env },
              { type: givenElement.type, env: given.env }
            )
          ) {
            return false;
          }
        }
      }
    }

    if (
      expected.type.selectedVariantName &&
      given.type.selectedVariantName &&
      expected.type.selectedVariantName !== given.type.selectedVariantName
    ) {
      return false;
    } else if (!expected.type.selectedVariantName) {
      return true;
    } else {
      return false;
    }
  }

  if (isUnionType(expected.type) && isUnionType(given.type)) {
    // Unions must have same elements and compatible types
    if (
      expected.type.elements.length !== given.type.elements.length ||
      (expected.type.typeId !== given.type.typeId &&
        !typeContainsSomeType(expected.type) &&
        !typeContainsSomeType(given.type))
    ) {
      return false;
    }

    if (expected.type.typeId === given.type.typeId) {
      return true;
    }

    for (let i = 0; i < expected.type.elements.length; i++) {
      const expectedElement = expected.type.elements[i]!;
      const givenElement = given.type.elements[i]!;

      if (
        expectedElement.label !== givenElement.label ||
        !areTypesCompatible(
          { type: expectedElement.type, env: expected.env },
          { type: givenElement.type, env: given.env }
        )
      ) {
        return false;
      }
    }
    return true;
  }

  if (isFunctionType(expected.type) && isFunctionType(given.type)) {
    return areFunctionTypesCompatible(
      { type: expected.type, env: expected.env },
      { type: given.type, env: given.env }
    );
  }

  if (isTypeHierarchyType(expected.type) && isTypeHierarchyType(given.type)) {
    // Check if the given type is a subtype of the expected type
    return (
      given.type.level === expected.type.level &&
      (given.type.tag === expected.type.tag ||
        expected.type.tag === TypeTag.Type)
    );
  }

  // ^
  if (
    isLinearPtrType(expected.type) &&
    (isLinearPtrType(given.type) || isMutLinearPtrType(given.type))
  ) {
    // Linear pointers must have the same type
    return areTypesCompatible(
      { type: expected.type.type, env: expected.env },
      { type: given.type.type, env: given.env }
    );
  }

  // ^!
  if (isMutLinearPtrType(expected.type) && isMutLinearPtrType(given.type)) {
    // MutLinear pointers must have the same type
    return areTypesCompatible(
      { type: expected.type.type, env: expected.env },
      { type: given.type.type, env: given.env }
    );
  }

  // *
  if (
    isPtrType(expected.type) &&
    (isPtrType(given.type) ||
      isMutPtrType(given.type) ||
      isLinearPtrType(given.type) ||
      isMutLinearPtrType(given.type))
  ) {
    // Pointers must have the same type
    return areTypesCompatible(
      { type: expected.type.type, env: expected.env },
      { type: given.type.type, env: given.env }
    );
  }

  // *!
  if (
    isMutPtrType(expected.type) &&
    (isMutPtrType(given.type) || isMutLinearPtrType(given.type))
  ) {
    // Mut pointers must have the same type
    return areTypesCompatible(
      { type: expected.type.type, env: expected.env },
      { type: given.type.type, env: given.env }
    );
  }

  // &
  if (
    isRefType(expected.type) &&
    (isRefType(given.type) || isMutRefType(given.type))
  ) {
    // References must have the same type
    return areTypesCompatible(
      { type: expected.type.type, env: expected.env },
      { type: given.type.type, env: given.env }
    );
  }

  // &!
  if (isMutRefType(expected.type) && isMutRefType(given.type)) {
    // Mut references must have the same type
    return areTypesCompatible(
      { type: expected.type.type, env: expected.env },
      { type: given.type.type, env: given.env }
    );
  }

  // Meet SomeType,
  // eg: x: T
  // here T should already be added to env by the if condition above ^^^
  if (isSomeType(expected.type)) {
    if (isSomeType(given.type)) {
      const expectedType_ = getValueOfSomeTypeFromEnv(
        expected.env,
        expected.type
      );
      const givenType_ = getValueOfSomeTypeFromEnv(given.env, given.type);
      if (isSomeType(expectedType_) && isSomeType(givenType_)) {
        // QUESTION: Should compare name instead?
        return expectedType_.typeId === givenType_.typeId;
      } else {
        // QUESTION: Is this correct?
        return false;
      }
    } else {
      const expectedType_ = getValueOfSomeTypeFromEnv(
        expected.env,
        expected.type
      );
      if (expected.type === expectedType_) {
        return false;
      }
      return areTypesCompatible(
        { type: expectedType_, env: expected.env },
        given
      );
    }
  }

  return false;
}

// Add or fix type guard functions
export function isArrayType(type?: Type): type is ArrayType {
  return type?.tag === TypeTag.Array;
}

export function isTupleType(type?: Type): type is TupleType {
  return type?.tag === TypeTag.Tuple;
}

export function isUnionType(type?: Type): type is UnionType {
  return type?.tag === TypeTag.Union;
}

// Add isEnumType guard function
export function isEnumType(type?: Type): type is EnumType {
  return type?.tag === TypeTag.Enum;
}

// Add isStructType guard function
export function isStructType(type?: Type): type is StructType {
  return type?.tag === TypeTag.Struct;
}

export function isFunctionType(type?: Type): type is FunctionType {
  return type?.tag === TypeTag.Function;
}

export function isFunctionTypeAndIsTypeFunction(type?: Type) {
  return (
    type?.tag === TypeTag.Function &&
    isTypeHierarchyType((type as FunctionType).return.type)
  );
}

export function isLiteralType(type?: Type): type is LiteralType {
  return type?.tag === TypeTag.Literal;
}

export function isTypeHierarchyType(type?: Type): type is TypeHierarchyType {
  return (
    type?.tag === TypeTag.Free ||
    type?.tag === TypeTag.Linear ||
    type?.tag === TypeTag.Type
  );
}

export function isFreeType(type?: Type): boolean {
  return type?.tag === TypeTag.Free;
}

export function isLinearType(type?: Type): boolean {
  return type?.tag === TypeTag.Linear;
}

export function isType0(type?: Type): boolean {
  return (
    isTypeHierarchyType(type) && type.tag === TypeTag.Type && type.level === 0
  );
}

export function isLinearOrType0Type(type?: Type): boolean {
  return isLinearType(type) || isType0(type);
}

export function isSomeType(type?: Type): type is SomeType {
  return type?.tag === TypeTag.SomeType;
}

export function isMutLinearPtrType(type?: Type): type is MutLinearPtrType {
  return type?.tag === TypeTag.MutLinearPtr;
}

export function isLinearPtrType(type?: Type): type is LinearPtrType {
  return type?.tag === TypeTag.LinearPtr;
}

export function isMutPtrType(type?: Type): type is MutPtrType {
  return type?.tag === TypeTag.MutPtr;
}

export function isPtrType(type?: Type): type is PtrType {
  return type?.tag === TypeTag.Ptr;
}

export function isMutRefType(type?: Type): type is MutRefType {
  return type?.tag === TypeTag.MutRef;
}

export function isRefType(type?: Type): type is RefType {
  return type?.tag === TypeTag.Ref;
}

/**
 * Check if the type of the value requires to use the compt modifier.
 * For example:
 *   compt(x): Type
 *   compt(x): compt_int
 */
export function typeRequiresComptModifier(type?: Type): boolean {
  return (
    isTypeHierarchyType(type) ||
    // If it's struct type, and it has compile-time only elements,
    // then it cannot be assigned to a runtime variable.
    (isStructType(type) &&
      type.elements.some((element) => element.isCompileTimeOnly)) ||
    isComptIntType(type) ||
    isComptFloatType(type) ||
    isComptStringType(type)
  );
}

export function typeContainsReference(type?: Type): boolean {
  if (!type) {
    return false;
  }

  // Check if the type is a reference type
  if (isRefType(type) || isMutRefType(type)) {
    return true;
  }

  // Recursively check for references in complex types
  switch (type.tag) {
    case TypeTag.Array:
      return typeContainsReference((type as ArrayType).elementType);
    case TypeTag.Tuple:
      return (type as TupleType).elements.some((element) =>
        typeContainsReference(element.type)
      );
    case TypeTag.Struct:
      return (type as StructType).elements.some((element) =>
        typeContainsReference(element.type)
      );
    case TypeTag.Enum:
      return (type as EnumType).variants.some((variant) =>
        variant.elements?.some((param) => typeContainsReference(param.type))
      );
    case TypeTag.Union:
      return (type as UnionType).elements.some((element) =>
        typeContainsReference(element.type)
      );
    default:
      return false; // For other types, no references are present
  }
}

export function typeContainsSomeType(type?: Type): boolean {
  if (!type) {
    return false;
  }

  // Check if the type is a SomeType
  if (isSomeType(type)) {
    return true;
  }

  // Recursively check for SomeType in complex types
  switch (type.tag) {
    case TypeTag.Array:
      return typeContainsSomeType((type as ArrayType).elementType);
    case TypeTag.Tuple:
      return (type as TupleType).elements.some((element) =>
        typeContainsSomeType(element.type)
      );
    case TypeTag.Struct:
      return (type as StructType).elements.some((element) =>
        typeContainsSomeType(element.type)
      );
    case TypeTag.Enum:
      return (type as EnumType).variants.some((variant) =>
        variant.elements?.some((param) => typeContainsSomeType(param.type))
      );
    case TypeTag.Union:
      return (type as UnionType).elements.some((element) =>
        typeContainsSomeType(element.type)
      );
    default:
      return false; // For other types, no SomeType is present
  }
}

/*
// Helper function for checking if a type is undefined
export function isUndefinedType(type: Type): boolean {
  return type.tag === TypeTag.Undefined;
}
*/

export function functionParameterToString(
  parameter: FunctionParameter
): string {
  let label = parameter.label;
  if (parameter.isMutable) {
    label = `mut(${label})`;
  }
  if (parameter.isCompileTimeOnly) {
    label = `@(${label})`;
  }

  const typeStr = typeToString(parameter.type);

  const defaultValueStr = parameter.exprs.defaultValueExpr
    ? exprToString(parameter.exprs.defaultValueExpr)
    : "";

  if (defaultValueStr) {
    return `(${label}: ${typeStr}) ?= ${defaultValueStr}`;
  } else {
    // typeStr is always defined here
    return `${label}: ${typeStr}`;
  }
}

// NOTE: Don't use element.exprs
export function tupleElementToString(element: TupleElement): string {
  let label = element.label;
  if (element.isImplicit) {
    label = `?${label}`;
  }
  if (element.isCompileTimeOnly) {
    label = `@(${label})`;
  }

  const defaultValueStr = element.defaultValue
    ? valueToString(element.defaultValue)
    : "";

  const assignedValueStr = element.assignedValue
    ? valueToString(element.assignedValue)
    : "";

  if (defaultValueStr) {
    return `(${label}: ${typeToString(element.type)}) ?= ${defaultValueStr}`;
  }

  if (assignedValueStr) {
    return `(${label}: ${typeToString(element.type)}) = ${assignedValueStr}`;
  }

  return `${label}: ${typeToString(element.type)}`;
}

/**
 * Convert a Type object to a human-readable string representation
 */
export function typeToString(type: Type): string {
  if (!type) {
    return "unknown";
  }

  switch (type.tag) {
    // Primitive types
    case TypeTag.Unit: {
      return "unit";
    }
    case TypeTag.Boolean: {
      return "boolean";
    }
    case TypeTag.Char: {
      return "char";
    }
    case TypeTag.Usize: {
      return "usize";
    }
    case TypeTag.Isize: {
      return "isize";
    }
    case TypeTag.U8: {
      return "u8";
    }
    case TypeTag.I8: {
      return "i8";
    }
    case TypeTag.U16: {
      return "u16";
    }
    case TypeTag.I16: {
      return "i16";
    }
    case TypeTag.U32: {
      return "u32";
    }
    case TypeTag.I32: {
      return "i32";
    }
    case TypeTag.U64: {
      return "u64";
    }
    case TypeTag.I64: {
      return "i64";
    }
    case TypeTag.F32: {
      return "f32";
    }
    case TypeTag.F64: {
      return "f64";
    }

    // Type universes
    case TypeTag.Free: {
      return "Free";
    }
    case TypeTag.Linear: {
      return "Linear";
    }
    case TypeTag.Type: {
      if ("level" in type && typeof type.level === "number" && type.level > 0) {
        return `Type(${type.level})`;
      }
      return "Type";
    }

    // Complex types
    case TypeTag.Array: {
      return `Array(${typeToString((type as ArrayType).elementType)}, ${valueToString(
        (type as ArrayType).length
      )})`;
    }

    case TypeTag.Tuple: {
      if ((type as TupleType).elements.length === 0) {
        return "()";
      }
      return `(${(type as TupleType).elements
        .map(tupleElementToString)
        .join(", ")}${(type as TupleType).elements.length === 1 ? "," : ""})`;
    }

    case TypeTag.Struct: {
      const struct = type as StructType;
      if (struct.typeName) {
        return struct.typeName;
      }

      return `${struct.typeName ? `(${struct.typeName}) ` : ""}${
        struct.typeName ? "struct" : struct.typeId
      }(${struct.elements.map(tupleElementToString).join(", ")})`;
    }

    case TypeTag.Enum: {
      const enumType = type as EnumType;
      if (enumType.typeName) {
        return enumType.typeName;
      }

      return `${
        enumType.typeName ? `(${enumType.typeName}) ` : ""
      }enum(${enumType.variants
        .map((variant) => {
          return `${variant.name}${
            variant.elements
              ? `(${variant.elements.map(tupleElementToString).join(", ")})`
              : ""
          }`;
        })
        .join(", ")})`;
    }

    case TypeTag.Union: {
      const unionType = type as UnionType;
      const elements = unionType.elements;
      return `${unionType.typeName ? `(${unionType.typeName}) ` : ""}${
        unionType.typeName ? "union" : unionType.typeId
      }(${elements
        .map(
          (element) =>
            `${element.label ? `${element.label}:` : ""}${typeToString(
              element.type
            )}`
        )
        .join(", ")})`;
    }

    case TypeTag.Function: {
      const func = type as FunctionType;
      const params = func.parameters.map(functionParameterToString).join(", ");

      const typeParams =
        func.typeParameters.length > 0
          ? `forall(${func.typeParameters
              .map(functionParameterToString)
              .join(", ")})`
          : "";
      const implicitParams =
        func.implicitParameters.length > 0
          ? `implicit(${func.implicitParameters
              .map(functionParameterToString)
              .join(", ")})`
          : "";

      let returnTypeString = typeToString(func.return.type);
      if (func.return.isCompileTimeOnly) {
        returnTypeString = `compt(${returnTypeString})`;
      }
      const paramsString = [typeParams, params, implicitParams]
        .filter((x) => !!x)
        .join(", ");
      return `(${paramsString}) -> ${returnTypeString}`;
    }

    case TypeTag.Literal: {
      const literal = type as LiteralType;
      return `${literal.value}:${typeToString(literal.type)}`;
    }

    case TypeTag.SomeType: {
      const someType = type as SomeType;
      // const parentType = someType.parentType;
      // TODO: Display the interfaces implemented
      return someType.name;
      // return `${someType.name}(${someType.typeId})`;
      // return `some(${parentType.tag})`;
    }

    case TypeTag.LinearPtr: {
      return `^(${typeToString((type as LinearPtrType).type)})`;
    }

    case TypeTag.MutLinearPtr: {
      return `^!(${typeToString((type as MutLinearPtrType).type)})`;
    }

    case TypeTag.Ptr: {
      return `*(${typeToString((type as PtrType).type)})`;
    }

    case TypeTag.MutPtr: {
      return `*!(${typeToString((type as MutPtrType).type)})`;
    }

    case TypeTag.Ref: {
      return `&(${typeToString((type as RefType).type)})`;
    }

    case TypeTag.MutRef: {
      return `&!(${typeToString((type as MutRefType).type)})`;
    }

    default: {
      return `${type.tag}`;
    }
  }
}

/*
function addPluralSuffix(unit: string, value: number): string {
  if (value === 1) {
    return unit;
  } else {
    return `${unit}s`;
  }
}
*/
/**
 * @param size - The size in bits
 */
/*
export function getSizeString(type: Type): string {
  const size = type.size;
  if (size === undefined) {
    return "unknown";
  } else if (size % 8 === 0) {
    const byteSize = size / 8;

    if (isEnumType(type)) {
      return `${byteSize} ${addPluralSuffix("byte", byteSize)} (tag ${
        type.tagSize % 8 == 0
          ? `${type.tagSize / 8} ${addPluralSuffix("byte", type.tagSize / 8)}`
          : `${type.tagSize} ${addPluralSuffix("bit", type.tagSize)}`
      })`;
    }

    return `${byteSize} ${addPluralSuffix("byte", byteSize)}`;
  } else {
    return `${size} ${addPluralSuffix("bit", size)}`;
  }
}
*/

export function convertComptTypeToRuntimeType(type: Type): Type {
  if (isComptIntType(type)) {
    return TI32;
  } else if (isComptFloatType(type)) {
    return TF32;
  } else if (isArrayType(type)) {
    type.elementType = convertComptTypeToRuntimeType(type.elementType);
    return type;
  } else if (isTupleType(type)) {
    type.elements = type.elements.map((element) => {
      return {
        ...element,
        type: convertComptTypeToRuntimeType(element.type),
      };
    });
    return type;
  } else if (isStructType(type)) {
    type.elements = type.elements.map((element) => {
      return {
        ...element,
        type: convertComptTypeToRuntimeType(element.type),
      };
    });
    return type;
  } else if (isEnumType(type)) {
    type.variants = type.variants.map((variant) => {
      if (variant.elements) {
        variant.elements = variant.elements.map((param) => {
          return {
            ...param,
            type: convertComptTypeToRuntimeType(param.type),
          };
        });
      }
      return variant;
    });
    return type;
  } else {
    // No change
    return type;
  }
}
