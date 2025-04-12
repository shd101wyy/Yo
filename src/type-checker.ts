// FIXME: We need to determine the ptr size based on the givenType architecture.
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
  Array = "Array",
  Tuple = "Tuple",
  Record = "Record",
  Struct = "Struct",
  Enum = "Enum",
  Union = "Union",
  Function = "Function",

  // Value
  Literal = "Literal",
}

export interface Type {
  /**
   * The tag to identify the type of type.
   */
  tag: TypeTag;

  /**
   * The size of the type in bytes.
   * For example, a 32-bit integer has a size of 4 bytes.
   * A 64-bit integer has a size of 8 bytes.
   * If not specified, the size is unknown.
   */
  size?: number;

  /**
   * Whether the value of the type is compile-time known or not.
   */
  isCompileTimeKnown?: boolean;
}

export interface Literal extends Type {
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

export interface FunctionParameter {
  name?: string;
  type: Type;
  /**
   * The default value for this parameter.
   * Can be either a concrete Value or a Type (for type parameters).
   */
  // defaultValue?: Type;
  isMutable?: boolean;
  // isCompileTimeKnown?: boolean;
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

// Add missing kind field to all Type constants
// export const TUndefined: Type = {
//   tag: TypeTag.Undefined,
//   size: 0, // Undefined has no runtime size
// };

export const TFree: TTypeHierarchy = {
  tag: TypeTag.Free,
  size: 0, // Types themselves don't have runtime size
  level: 0,
};

export const TLinear: TTypeHierarchy = {
  tag: TypeTag.Linear,
  size: 0, // Types themselves don't have runtime size
  level: 0,
};

export const TType: TTypeHierarchy = {
  tag: TypeTag.Type,
  size: 0, // Types themselves don't have runtime size
  level: 0,
};

export interface TTypeHierarchy extends Type {
  level: number;
}

export const TBoolean: Type = {
  tag: TypeTag.Boolean,
  size: 1,
};

/**
 * 4 bytes unicode
 */
export const TChar: Type = {
  tag: TypeTag.Char,
  size: 4,
};

export const TUsize: Type = {
  tag: TypeTag.Usize,
  size: getPtrSize(),
};
export const TIsize: Type = {
  tag: TypeTag.Isize,
  size: getPtrSize(),
};
export const TU8: Type = {
  tag: TypeTag.U8,
  size: 1,
};
export const TU16: Type = {
  tag: TypeTag.U16,
  size: 2,
};
export const TU32: Type = {
  tag: TypeTag.U32,
  size: 4,
};
export const TU64: Type = {
  tag: TypeTag.U64,
  size: 8,
};
export const TI8: Type = {
  tag: TypeTag.I8,
  size: 1,
};
export const TI16: Type = {
  tag: TypeTag.I16,
  size: 2,
};
export const TI32: Type = {
  tag: TypeTag.I32,
  size: 4,
};
export const TI64: Type = {
  tag: TypeTag.I64,
  size: 8,
};
export const TF16: Type = {
  tag: TypeTag.F16,
  size: 2,
};
export const TF32: Type = {
  tag: TypeTag.F32,
  size: 4,
};
export const TF64: Type = {
  tag: TypeTag.F64,
  size: 8,
};

// Update the primitive type constants to include kind
export const TUnit: Type = {
  tag: TypeTag.Unit,
  size: 0,
};

// Extended Type interface for compound types
export interface ArrayType extends Type {
  tag: TypeTag.Array;
  elementType: Type;
  length: number; // Fixed length is required
}

export interface TupleType extends Type {
  tag: TypeTag.Tuple;
  elementTypes: Type[];
}

export interface RecordType extends Type {
  tag: TypeTag.Record;
  fields: Map<string, Type>;
}

// Update StructType interface to remove structName
export interface StructType extends Type {
  tag: TypeTag.Struct;
  baseType: Type; // The underlying type being wrapped
}

export interface EnumVariant {
  name: string;
  type?: Type; // Optional associated type
  // TODO: return type? For GADT
}

export interface EnumType extends Type {
  tag: TypeTag.Enum;
  variants: EnumVariant[];
}

export interface UnionType extends Type {
  tag: TypeTag.Union;
  memberTypes: Map<string, Type>;
}

export interface FunctionType extends Type {
  tag: TypeTag.Function;
  params: FunctionParameter[];
  returnType: Type;

  typeFunctionImplementation?: (args: Type[]) => Type;
}

// NOTE: Interface is not Type
// It is just a collection of types
export interface Interface {
  tag: "Interface"; // Using Type as the tag for interfaces
  memberTypes: Map<string, Type>; // Renamed from members to memberTypes for consistency
}

export function createTypeHierarchy(level: number): TTypeHierarchy {
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

export function createTupleType(elementTypes: Type[]): TupleType {
  let totalSize = 0;
  for (let i = 0; i < elementTypes.length; i++) {
    const type = elementTypes[i];
    if (type.size === undefined) {
      throw new Error(
        `Cannot create tuple type: element at index ${i} has undefined size`
      );
    }
    totalSize += type.size;
  }

  return {
    tag: TypeTag.Tuple,
    size: totalSize,
    elementTypes,
  };
}

export function createRecordType(fields: Map<string, Type>): RecordType {
  let totalSize = 0;
  for (const [fieldName, type] of fields.entries()) {
    if (type.size === undefined) {
      throw new Error(
        `Cannot create record type: field '${fieldName}' has undefined size`
      );
    }
    totalSize += type.size;
  }

  return {
    tag: TypeTag.Record,
    size: totalSize,
    fields,
  };
}

// Update createStructType function to remove structName parameter
export function createStructType(baseType: Type): StructType {
  if (baseType.size === undefined) {
    throw new Error(`Cannot create struct type: base type size is undefined`);
  }

  return {
    tag: TypeTag.Struct,
    size: baseType.size,
    baseType,
  };
}

export function createEnumType(variants: EnumVariant[]): EnumType {
  let maxSize = 0;
  let hasVariantWithSize = false;

  for (const variant of variants) {
    if (variant.type) {
      if (variant.type.size === undefined) {
        throw new Error(
          `Cannot create enum type: variant '${variant.name}' has undefined size`
        );
      }
      maxSize = Math.max(maxSize, variant.type.size);
      hasVariantWithSize = true;
    }
  }

  // If no variants have associated types, we need at least space for the tag
  if (!hasVariantWithSize) {
    maxSize = 1; // At minimum, need 1 byte for the discriminant
  }

  return {
    tag: TypeTag.Enum,
    size: maxSize,
    variants,
  };
}

export function createUnionType(memberTypes: Map<string, Type>): UnionType {
  if (memberTypes.size === 0) {
    throw new Error("Cannot create union type: no member types provided");
  }

  let maxSize = 0;

  for (const [typeName, type] of memberTypes.entries()) {
    if (type.size === undefined) {
      throw new Error(
        `Cannot create union type: member '${typeName}' has undefined size`
      );
    }
    maxSize = Math.max(maxSize, type.size);
  }

  return {
    tag: TypeTag.Union,
    size: maxSize,
    memberTypes,
  };
}

export function createFunctionType(
  params: FunctionParameter[],
  returnType: Type,
  typeFunctionImplementation?: (args: Type[]) => Type
): FunctionType {
  return {
    tag: TypeTag.Function,
    size: getPtrSize(),
    params,
    returnType,
    typeFunctionImplementation,
  };
}

export function createInterfaceType(memberTypes: Map<string, Type>): Interface {
  return {
    tag: "Interface",
    memberTypes, // Updated to use the renamed field
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
export const OptionFunction: FunctionType = createFunctionType(
  [{ name: "T", type: TType }],
  TType, // Return type is Type
  (args: Type[]): EnumType => {
    const innerType = args[0];
    const variants: EnumVariant[] = [
      { name: "Some", type: innerType },
      { name: "None" },
    ];
    return {
      tag: TypeTag.Enum,
      size: undefined,
      variants,
    };
  }
);

// Helper function to check if a function returns a type
export function isTypeReturningFunction(func: FunctionType): boolean {
  // Check if the return type is Type or any higher type universe level
  return (
    func.returnType === TType ||
    (func.returnType.tag === TypeTag.Type &&
      "level" in func.returnType &&
      (func.returnType as TTypeHierarchy).level >= 0)
  );
}

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

// Helper function to determine the type universe of a list of types
function determineTypeUniverse(types: Type[]): Type {
  let hasLinear = false;

  for (const type of types) {
    // Check if it's any type universe directly
    if (type === TType || (type.tag === TypeTag.Type && "level" in type)) {
      return TType; // If any field is Type, the whole thing is Type
    } else if (type === TLinear) {
      hasLinear = true;
    } else if (type === TFree) {
      // Free doesn't affect anything unless all types are free
      continue;
    } else {
      // For non-universe types, recursively check their type
      const typeOfSubType = typeOfType(type);
      if (
        typeOfSubType === TType ||
        (typeOfSubType.tag === TypeTag.Type && "level" in typeOfSubType)
      ) {
        return TType;
      } else if (typeOfSubType === TLinear) {
        hasLinear = true;
      }
    }
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
  } else if (t === TFree || t === TLinear || t === TType) {
    return createTypeHierarchy((t as TTypeHierarchy).level + 1);
  } else if (t.tag === TypeTag.Function) {
    return TFree;
  } else if (isArrayType(t)) {
    // For arrays, check the element type
    return typeOfType(t.elementType);
  } else if (isTupleType(t)) {
    // For tuples, check all element types
    return determineTypeUniverse(t.elementTypes);
  } else if (isRecordType(t)) {
    // For records, check all field types
    return determineTypeUniverse(Array.from(t.fields.values()));
  } else if (isStructType(t)) {
    // For structs, check the base type
    return typeOfType(t.baseType);
  } else if (isEnumType(t)) {
    // For enums, check all variant types
    const typesToCheck: Type[] = [];
    for (const variant of t.variants) {
      if (variant.type) {
        typesToCheck.push(variant.type);
      }
    }
    return determineTypeUniverse(typesToCheck);
  } else if (isUnionType(t)) {
    // For unions, check all member types
    return determineTypeUniverse(Array.from(t.memberTypes.values()));
  } else {
    throw new Error(`Unknown type tag: ${t.tag}`);
  }
}

// Update the areTypesCompatible function for StructType
export function areTypesCompatible(
  expectedType: Type,
  givenType: Type
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
      areTypesCompatible(expectedType.elementType, givenType.elementType)
    );
  }

  if (isTupleType(expectedType) && isTupleType(givenType)) {
    if (expectedType.elementTypes.length !== givenType.elementTypes.length) {
      return false;
    }

    for (let i = 0; i < expectedType.elementTypes.length; i++) {
      if (
        !areTypesCompatible(
          expectedType.elementTypes[i],
          givenType.elementTypes[i]
        )
      ) {
        return false;
      }
    }
    return true;
  }

  if (isRecordType(expectedType) && isRecordType(givenType)) {
    for (const [fieldName, fieldType] of givenType.fields) {
      const sourceField = expectedType.fields.get(fieldName);
      if (!sourceField || !areTypesCompatible(sourceField, fieldType)) {
        return false;
      }
    }
    return true;
  }

  if (isStructType(expectedType) && isStructType(givenType)) {
    // For structs, base types must be compatible
    return areTypesCompatible(expectedType.baseType, givenType.baseType);
  }

  if (isEnumType(expectedType) && isEnumType(givenType)) {
    // For enums, variants must match
    if (expectedType.variants.length !== givenType.variants.length)
      return false;

    for (let i = 0; i < expectedType.variants.length; i++) {
      const sourceVariant = expectedType.variants[i];
      const targetVariant = givenType.variants[i];

      if (sourceVariant.name !== targetVariant.name) return false;

      // Compare associated types if present
      if (sourceVariant.type && targetVariant.type) {
        if (!areTypesCompatible(sourceVariant.type, targetVariant.type)) {
          return false;
        }
      } else if (sourceVariant.type !== targetVariant.type) {
        // One has a type and the other doesn't
        return false;
      }
    }

    return true;
  }

  if (isFunctionType(expectedType) && isFunctionType(givenType)) {
    if (expectedType.params.length !== givenType.params.length) return false;

    for (let i = 0; i < expectedType.params.length; i++) {
      if (
        !areTypesCompatible(
          givenType.params[i].type,
          expectedType.params[i].type
        )
      ) {
        return false;
      }
    }

    return areTypesCompatible(expectedType.returnType, givenType.returnType);
  }

  return false;
}

// Add or fix type guard functions
export function isArrayType(type: Type): type is ArrayType {
  return type.tag === TypeTag.Array;
}

export function isTupleType(type: Type): type is TupleType {
  return type.tag === TypeTag.Tuple;
}

export function isRecordType(type: Type): type is RecordType {
  return type.tag === TypeTag.Record;
}

export function isStructType(type: Type): type is StructType {
  return type.tag === TypeTag.Struct;
}

export function isEnumType(type: Type): type is EnumType {
  return type.tag === TypeTag.Enum;
}

export function isUnionType(type: Type): type is UnionType {
  return type.tag === TypeTag.Union;
}

export function isFunctionType(type: Type): type is FunctionType {
  return type.tag === TypeTag.Function;
}

export function isLiteral(type: Type): type is Literal {
  return type.tag === TypeTag.Literal;
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
      if ((type as TupleType).elementTypes.length === 0) {
        return "()";
      }
      return `(${(type as TupleType).elementTypes
        .map(typeToString)
        .join(", ")})`;
    }

    case TypeTag.Record: {
      const fields = Array.from((type as RecordType).fields.entries());
      return `{ ${fields
        .map(([name, fieldType]) => `${name}: ${typeToString(fieldType)}`)
        .join(", ")} }`;
    }

    case TypeTag.Struct: {
      return typeToString((type as StructType).baseType);
    }

    case TypeTag.Enum: {
      const variants = (type as EnumType).variants;
      return `enum { ${variants
        .map((variant) =>
          variant.type
            ? `${variant.name}(${typeToString(variant.type)})`
            : variant.name
        )
        .join(", ")} }`;
    }

    case TypeTag.Union: {
      const memberTypes = Array.from((type as UnionType).memberTypes.entries());
      return `union { ${memberTypes
        .map(([name, memberType]) => `${name}: ${typeToString(memberType)}`)
        .join(", ")} }`;
    }

    case TypeTag.Function: {
      const func = type as FunctionType;
      const params = func.params
        .map((param) =>
          param.name
            ? `${
                param.isMutable ? `mut(${param.name})` : `${param.name}`
              }: ${typeToString(param.type)}`
            : (param.isMutable ? `mut(_):` : "") + typeToString(param.type)
        )
        .join(", ");
      return `(${params}) -> ${typeToString(func.returnType)}`;
    }

    case TypeTag.Literal: {
      const literal = type as Literal;
      return `${literal.value}:${typeToString(literal.type)}`;
    }

    default: {
      return `${type.tag}`;
    }
  }
}
