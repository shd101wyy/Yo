import { Environment, getVariablesFromEnv } from "./env";
import { Expr } from "./expr";
import { FunctionValue } from "./function-value";
import { TypeValue } from "./type-value";
import { randomId } from "./utils";
import { Value, valueToString } from "./value";
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
  Unit = "()",

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
  F16 = "f16",
  F32 = "f32",
  F64 = "f64",

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

  // Placeholder
  // This is only used as an intermediate type
  // which should be synthesized to a real type
  Placeholder = "Placeholder",

  // Interface
  Interface = "Interface",
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
  size?: number;

  /**
   * Whether the value of the type is compile-time known or not.
   */
  isCompileTimeOnly?: boolean;

  methods?: TypeMethod[];
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
    type.tag === TypeTag.F16 ||
    type.tag === TypeTag.F32 ||
    type.tag === TypeTag.F64 // ||
    // type.tag === TypeTag.Undefined // Add undefined as a primitive type
  );
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
  size: 0, // Types themselves don't have runtime size
  level: 0,
};

export const TLinear: TypeHierarchyType = {
  tag: TypeTag.Linear,
  size: 0, // Types themselves don't have runtime size
  level: 0,
};

export const TType: TypeHierarchyType = {
  tag: TypeTag.Type,
  size: 0, // Types themselves don't have runtime size
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

  // TODO: Implemented interfaces
}

export const TBoolean: Type = {
  tag: TypeTag.Boolean,
  size: 8,
};

/**
 * 4 bytes unicode
 */
export const TChar: Type = {
  tag: TypeTag.Char,
  size: 4 * 8,
};

export const TUsize: Type = {
  tag: TypeTag.Usize,
  size: getPtrSize() * 8,
};
export const TIsize: Type = {
  tag: TypeTag.Isize,
  size: getPtrSize() * 8,
};
export const TU8: Type = {
  tag: TypeTag.U8,
  size: 1 * 8,
};
export const TU16: Type = {
  tag: TypeTag.U16,
  size: 2 * 8,
};
export const TU32: Type = {
  tag: TypeTag.U32,
  size: 4 * 8,
};
export const TU64: Type = {
  tag: TypeTag.U64,
  size: 8 * 8,
};
export const TI8: Type = {
  tag: TypeTag.I8,
  size: 1 * 8,
};
export const TI16: Type = {
  tag: TypeTag.I16,
  size: 2 * 8,
};
export const TI32: Type = {
  tag: TypeTag.I32,
  size: 4 * 8,
};
export const TI64: Type = {
  tag: TypeTag.I64,
  size: 8 * 8,
};
export const TF16: Type = {
  tag: TypeTag.F16,
  size: 2 * 8,
};
export const TF32: Type = {
  tag: TypeTag.F32,
  size: 4 * 8,
};
export const TF64: Type = {
  tag: TypeTag.F64,
  size: 8 * 8,
};

// Update the primitive type constants to include kind
export const TUnit: Type = {
  tag: TypeTag.Unit,
  size: 0,
};

export interface PlaceholderType extends Type {
  tag: TypeTag.Placeholder;
}

export const TPlaceholder: PlaceholderType = {
  tag: TypeTag.Placeholder,
};

// Extended Type interface for compound types
export interface ArrayType extends Type {
  tag: TypeTag.Array;
  elementType: Type;
  length: number; // Fixed length is required
}

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
   */
  label?: string;

  /**
   * The default value of the element.
   * Which has to be compile-time known.
   */
  defaultValue?: Value;

  /**
   * The expression of the element.
   */
  expr: Expr;
}

export interface TupleType extends Type {
  tag: TypeTag.Tuple;
  /**
   * The elements of the tuple.
   */
  elements: TupleElement[];
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
   */
  label?: string;

  /**
   * The expression of the element.
   */
  expr: Expr;

  /**
   * This is only used for Functions
   */
  isMutable: boolean;

  /**
   * This is only used for Functions
   */
  isCompileTimeOnly: boolean;

  /**
   * This is only used for Functions
   */
  // defaultValue?: Expr;
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
   * The members of the struct.
   */
  members: TupleElement[];
}

export interface EnumVariant {
  /**
   * Without `.` prefix
   */
  name: string;
  params?: TupleElement[]; // Changed from TupleElement[] to TupleType for consistency
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
   * The variants of the enum.
   */
  variants: EnumVariant[];

  /**
   * The size of the tag in bits.
   */
  tagSize: number;

  /**
   * The name of the selected variant.
   */
  selectedVariantName?: string;
}

export interface UnionType extends Type {
  tag: TypeTag.Union;
  members: TupleElement[];
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
   * The parameters of the function.
   */
  params: FunctionParameter[];
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
}

export interface InterfaceMember {
  /**
   * The label of the member.
   */
  label: string;
  /**
   * The type of the member.
   */
  type: TypeHierarchyType | FunctionType;

  /**
   * The type expression of the member.
   * Such as:
   * - Type,
   * - (x: Self, y: Self)-> Self
   */
  typeExpr: Expr;

  /**
   * The implemented value of the member.  \
   * If it's not implemented, then it's undefined.  \
   * Only the TypeValue and FunctionValue (both are compt) are allowed.
   */
  value: TypeValue | FunctionValue | undefined;
}

// NOTE: Interface is not Type
// It is just a collection of types
export interface InterfaceType extends Type {
  tag: TypeTag.Interface;
  /**
   * The unique identifier for this interface.
   */
  typeId: string;

  /**
   * The name of the interface.
   * eg:
   *   Id := interface;
   * Id is the name of the struct.
   */
  typeName?: string;

  /**
   * The receiver type of the interface.
   * We take member whose name is "Self" as the receiverType.
   */
  receiverType?: Type;

  /**
   * The members of the interface.
   */
  members: InterfaceMember[];

  /**
   * And interface is unsized
   */
  size: undefined;

  /**
   * Whether the interface is implemented or not.
   */
  isImplemented: boolean;

  /**
   * The env when the function type is created.
   * The env shouldn't contain the frame that have the parameters.
   * The env is also useful to show the frame level at which the function is defined.
   */
  env: Environment;
}

export function createTypeHierarchy(level: number): TypeHierarchyType {
  return {
    tag: TypeTag.Type,
    size: 0,
    level,
  };
}

// Type constructor functions (need to be updated to include kind)
/*
export function createArrayType(elementType: Type, length: number): ArrayType {
  if (elementType.size === undefined) {
    throw new Error(`Cannot create array type: element type size is undefined`);
  }

  return {
    tag: TypeTag.Array,
    size: elementType.size * length,
    elementType,
    length,
  };
}
*/

export function createTupleType(elements: TupleElement[]): TupleType {
  let totalSize: undefined | number = 0;
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    if (element.type.size === undefined) {
      totalSize = undefined;
    } else if (typeof totalSize === "number") {
      totalSize += element.type.size;
    }
  }

  return {
    tag: TypeTag.Tuple,
    size: totalSize,
    elements,
  };
}

export function createStructType(
  members: TupleElement[],
  typeId?: string
): StructType {
  let totalSize: undefined | number = 0;
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    if (member.type.size === undefined) {
      totalSize = undefined;
    } else if (typeof totalSize === "number") {
      totalSize += member.type.size;
    }
  }

  return {
    tag: TypeTag.Struct,
    size: totalSize,
    members,
    typeId: typeId ?? `struct_${randomId()}`,
  };
}

export function createEnumType(
  variants: EnumVariant[],
  typeId?: string
): EnumType {
  let totalSize: undefined | number = 0;
  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    let variantSize = 0;
    if (variant.params) {
      for (let j = 0; j < variant.params.length; j++) {
        const param = variant.params[j];
        if (param.type.size === undefined) {
          totalSize = undefined;
        } else if (typeof totalSize === "number") {
          variantSize += param.type.size;
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

  return {
    tag: TypeTag.Enum,
    size: typeof totalSize === "number" ? totalSize + tagSize : undefined,
    variants,
    tagSize,
    typeId: typeId ?? `enum_${randomId()}`,
  };
}

export function createUnionType(members: TupleElement[]): UnionType {
  let maxSize = 0;
  for (let i = 0; i < members.length; i++) {
    const type = members[i].type;
    if (type.size === undefined) {
      throw new Error(
        `Cannot create union type: type at index ${i} has undefined size`
      );
    }
    maxSize = Math.max(maxSize, type.size);
  }

  return {
    tag: TypeTag.Union,
    size: maxSize, // Changed from totalSize to maxSize as unions use the size of largest variant
    members,
  };
}

export function createFunctionType({
  params,
  return_,
  env,
}: {
  params: FunctionParameter[];
  return_: FunctionReturn;
  env: Environment;
}): FunctionType {
  return {
    tag: TypeTag.Function,
    size: getPtrSize() * 8,
    params: params, // Wrap params in a TupleType
    return: return_,
    env,
  };
}

export function createInterfaceType(
  members: InterfaceMember[],
  env: Environment,
  typeId?: string
): InterfaceType {
  return {
    tag: TypeTag.Interface,
    members, // Updated to use the renamed field
    size: undefined,
    typeId: typeId ?? `interface_${randomId()}`,
    isImplemented: false,
    env,
  };
}

// Example: Array type function - now using regular FunctionType
/*
export const ArrayFunction: FunctionType = createFunctionType(
  [
    { name: "T", type: TType },
    { name: "length", type: TUsize },
  ],
  TType, // Return type is Type
  (args: Type[]): Type => {
    const elementType = args[0];
    const lengthArg = args[1];
    let length = 0;
    if (isLiteral(lengthArg) && lengthArg.type === TUsize) {
      length = lengthArg.value as number;
    } else {
      throw new Error(`Expected length to be a usize value.`);
    }
    return createArrayType(elementType, length);
  }
);
*/

// Example: Option type function
/*
export const OptionFunction: FunctionType = createFunctionType(
  { tag: TypeTag.Tuple, elements: [{ label: "T", type: TType }] },
  TType, // Return type is Type
  (args: Type[]): UnionType => {
    const innerType = args[0];
    const variants: EnumVariant[] = [
      { tag: TypeTag.Variant, name: "Some", type: innerType },
      { tag: TypeTag.Variant, name: "None" },
    ];
    return {
      tag: TypeTag.Union,
      size: undefined,
      types: variants,
    };
  }
);


// Replace applyTypeFunction with a more general function
export function applyTypeFunction(func: FunctionType, args: Type[]): Type {
  // Validate arguments
  if (args.length !== func.params.length) {
    throw new Error(
      `Expected ${func.params.length} arguments, got ${args.length}`
    );
  }

  // Ensure arg types match expected param types
  for (let i = 0; i < args.length; i++) {
    const argType = args[i];
    if (!areTypesCompatible(argType, func.params[i].type)) {
      throw new Error(
        `Argument ${i} is incompatible. Expected ${func.params[i].type.tag}, got ${argType.tag}`
      );
    }
  }

  // If implementation is provided, call it
  if (func.typeFunctionImplementation) {
    return func.typeFunctionImplementation(args);
  }

  throw new Error("Function has no implementation that returns a Type");
}
  */

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
  } else if (t.tag === TypeTag.Function) {
    return TFree;
  } else if (isArrayType(t)) {
    // For arrays, check the element type
    return typeOfType(t.elementType);
  } else if (isTupleType(t)) {
    // For tuples, check all element types
    return determineTypeUniverse(t.elements.map((element) => element.type));
  } else if (isStructType(t)) {
    // For structs, check all member types
    return determineTypeUniverse(t.members.map((element) => element.type));
  } else if (isEnumType(t)) {
    // For enums, check all variant
    const types: Type[] = [];
    for (const variant of t.variants) {
      if (variant.params) {
        types.push(...variant.params.map((param) => param.type));
      }
    }
    return determineTypeUniverse(types);
  } else if (isUnionType(t)) {
    // For unions, check all member types
    return determineTypeUniverse(t.members.map((element) => element.type));
  } else if (isSomeType(t)) {
    return t.parentType;
  } else if (isInterfaceType(t)) {
    return determineTypeUniverse(t.members.map((member) => member.type));
  } else {
    throw new Error(`Unknown type tag: ${t.tag}`);
  }
}

export function getValueOfSomeTypeFromEnv(
  env: Environment,
  someType: SomeType
): Type | undefined {
  let someTypeValue: TypeValue | undefined = undefined;
  do {
    const variables = getVariablesFromEnv(env, someType.name, (variable) => {
      return variable.value?.tag === ValueTag.Type; // isTypeValue
    });
    if (!variables.length) {
      return undefined;
    }
    someTypeValue = variables[variables.length - 1].value as TypeValue;

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

// Update the areTypesCompatible function for StructType
export function areTypesCompatible(
  expectedType: Type,
  givenType: Type,
  env: Environment
): boolean {
  // Undefined is only compatible with itself
  /*
  if (expectedType.tag === TypeTag.Undefined) {
    return givenType.tag === TypeTag.Undefined;
  }

  if (givenType.tag === TypeTag.Undefined) {
    return false; // Nothing is compatible with undefined except undefined itself
  }
    */

  if (isPrimitiveType(expectedType) && isPrimitiveType(givenType)) {
    return expectedType.tag === givenType.tag;
  }

  if (isArrayType(expectedType) && isArrayType(givenType)) {
    // Arrays must have same length and compatible element types
    return (
      expectedType.length === givenType.length &&
      areTypesCompatible(expectedType.elementType, givenType.elementType, env)
    );
  }

  if (isTupleType(expectedType) && isTupleType(givenType)) {
    if (expectedType.elements.length !== givenType.elements.length) {
      return false;
    }
    for (let i = 0; i < expectedType.elements.length; i++) {
      const expectedTypeElement = expectedType.elements[i];
      const givenTypeElement = givenType.elements[i];

      if (
        !areTypesCompatible(
          expectedTypeElement.type,
          givenTypeElement.type,
          env
        )
      ) {
        return false;
      }

      // QUESTION: Should we check the label here?
      // NOTE: Tuple is ordered. To be unordered, use Struct
      if (expectedTypeElement.label && givenTypeElement.label) {
        if (expectedTypeElement.label !== givenTypeElement.label) {
          return false;
        }
      }
    }
    return true;
  }

  if (isStructType(expectedType) && isStructType(givenType)) {
    // Structs must have same members and compatible types
    if (
      expectedType.members.length !== givenType.members.length ||
      expectedType.typeId !== givenType.typeId
    ) {
      return false;
    }

    if (
      expectedType.typeId &&
      givenType.typeId &&
      expectedType.typeId === givenType.typeId
    ) {
      return true;
    }

    // QUESTION: In theory comparing the typeId is enough
    for (let i = 0; i < expectedType.members.length; i++) {
      const expectedMember = expectedType.members[i];
      const givenMember = givenType.members[i];

      if (
        !areTypesCompatible(expectedMember.type, givenMember.type, env) ||
        expectedMember.label !== givenMember.label
      ) {
        return false;
      }
    }
    return true;
  }

  if (isEnumType(expectedType) && isEnumType(givenType)) {
    if (expectedType.typeId !== givenType.typeId) {
      return false;
    }
    if (
      expectedType.selectedVariantName &&
      givenType.selectedVariantName &&
      expectedType.selectedVariantName !== givenType.selectedVariantName
    ) {
      return false;
    } else if (!expectedType.selectedVariantName) {
      return true;
    } else {
      return false;
    }
  }

  // TODO: enum

  // TODO: union

  if (isFunctionType(expectedType) && isFunctionType(givenType)) {
    if (expectedType.params.length !== givenType.params.length) return false;

    for (let i = 0; i < expectedType.params.length; i++) {
      if (
        !areTypesCompatible(
          givenType.params[i].type,
          expectedType.params[i].type,
          env
        )
      ) {
        return false;
      }
    }

    return areTypesCompatible(
      expectedType.return.type,
      givenType.return.type,
      env
    );
  }

  if (isTypeHierarchyType(expectedType) && isTypeHierarchyType(givenType)) {
    // Check if the given type is a subtype of the expected type
    return (
      givenType.level === expectedType.level &&
      (givenType.tag === expectedType.tag || expectedType.tag === TypeTag.Type)
    );
  }

  // Meet SomeType,
  // eg: x: T
  // here T should already be added to env by the if condition above ^^^
  if (isSomeType(expectedType)) {
    if (isSomeType(givenType)) {
      const expectedType_ = getValueOfSomeTypeFromEnv(env, expectedType);
      const givenType_ = getValueOfSomeTypeFromEnv(env, givenType);
      if (!expectedType_ || !givenType_) {
        return false;
      }
      if (isSomeType(expectedType_) && isSomeType(givenType_)) {
        return expectedType_.typeId === givenType_.typeId;
      } else {
        // QUESTION: Is this correct?
        return false;
      }
    } else {
      const expectedType_ = getValueOfSomeTypeFromEnv(env, expectedType);
      if (!expectedType_) {
        return false;
      }
      return areTypesCompatible(expectedType_, givenType, env);
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

export function isInterfaceType(type?: Type): type is InterfaceType {
  return type?.tag === TypeTag.Interface;
}

// Add isEnumType guard function
export function isEnumType(type?: Type): type is EnumType {
  return type?.tag === TypeTag.Enum;
}

// Add isStructType guard function
export function isStructType(type?: Type): type is StructType {
  return type?.tag === TypeTag.Struct;
}

export function isPlaceholderType(type?: Type): type is PlaceholderType {
  return type?.tag === TypeTag.Placeholder;
}

export function isFunctionType(type?: Type): type is FunctionType {
  return type?.tag === TypeTag.Function;
}

export function isFunctionTypeAndIsTypeFunction(
  type?: Type
): type is FunctionType {
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

export function isSomeType(type?: Type): type is SomeType {
  return type?.tag === TypeTag.SomeType;
}

/*
// Helper function for checking if a type is undefined
export function isUndefinedType(type: Type): boolean {
  return type.tag === TypeTag.Undefined;
}
*/

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
      return "()";
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
    case TypeTag.F16: {
      return "f16";
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
      return `[${typeToString((type as ArrayType).elementType)}; ${
        (type as ArrayType).length
      }]`;
    }

    case TypeTag.Tuple: {
      if ((type as TupleType).elements.length === 0) {
        return "()";
      }
      return `(${(type as TupleType).elements
        .map((element) => {
          let t = `${element.label ? `${element.label}: ` : ""}${typeToString(
            element.type
          )}`;
          if (element.defaultValue) {
            t = `(${t}) = ${valueToString(element.defaultValue)}`;
          }
          return t;
        })
        .join(", ")}${(type as TupleType).elements.length === 1 ? "," : ""})`;
    }

    case TypeTag.Struct: {
      const struct = type as StructType;

      return `${struct.typeName ? `(${struct.typeName}) ` : ""}${
        struct.typeName ? "struct" : struct.typeId
      }(${struct.members
        .map((member) => {
          let t = `${member.label ? `${member.label}: ` : ""}${typeToString(
            member.type
          )}`;
          if (member.defaultValue) {
            t = `(${t}) = ${valueToString(member.defaultValue)}`;
          }
          return t;
        })
        .join(", ")})`;
    }

    case TypeTag.Enum: {
      const enumType = type as EnumType;
      return `${
        enumType.typeName ? `(${enumType.typeName}) ` : ""
      }enum(${enumType.variants
        .map((variant) => {
          return `${variant.name}${
            variant.params
              ? `(${variant.params
                  .map((param) => {
                    let t = `${
                      param.label ? `${param.label}: ` : ""
                    }${typeToString(param.type)}`;
                    if (param.defaultValue) {
                      t = `(${t}) = ${valueToString(param.defaultValue)}`;
                    }
                    return t;
                  })
                  .join(", ")})`
              : ""
          }`;
        })
        .join(", ")})`;
    }

    case TypeTag.Union: {
      const members = (type as UnionType).members;
      return `union(${members
        .map(
          (member) =>
            `${member.label ? `${member.label}:` : ""}${typeToString(
              member.type
            )}`
        )
        .join(", ")})`;
    }

    case TypeTag.Function: {
      const func = type as FunctionType;
      const params = func.params
        .map((param) =>
          param.label
            ? `${
                param.isMutable ? `mut(${param.label})` : `${param.label}`
              }: ${typeToString(param.type)}`
            : (param.isMutable ? `mut(_):` : "") + typeToString(param.type)
        )
        .join(", ");
      return `(${params}) -> ${typeToString(func.return.type)}`;
    }

    case TypeTag.Interface: {
      const interfaceType = type as InterfaceType;
      return `${interfaceType.typeName ? `(${interfaceType.typeName}) ` : ""}${
        interfaceType.typeName ? "interface" : interfaceType.typeId
      }(${interfaceType.members
        .map((member) => {
          return `${member.label ? `${member.label}:` : ""}${typeToString(
            member.type
          )}`;
        })
        .join(", ")})`;
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
      // return `some(${parentType.tag})`;
    }

    default: {
      return `${type.tag}`;
    }
  }
}

function addPluralSuffix(unit: string, value: number): string {
  if (value === 1) {
    return unit;
  } else {
    return `${unit}s`;
  }
}
/**
 * @param size - The size in bits
 */
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
