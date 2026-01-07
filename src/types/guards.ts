import {
  ArrayType,
  ComptListType,
  ConcreteModuleType,
  DynType,
  EnumType,
  FnModuleType,
  FunctionType,
  FutureModuleType,
  IsoType,
  ModuleType,
  PtrType,
  SliceType,
  SomeType,
  StructType,
  TupleType,
  Type,
  TypeHierarchyType,
  UnionType,
  VoidType,
} from "./definitions";
import { TypeTag } from "./tags";
import { typeImplementsFuture } from "./utils";

// Basic type guards
export function isPrimitiveType(type: Type): boolean {
  return (
    type.tag === TypeTag.Unit ||
    type.tag === TypeTag.Bool ||
    // type.tag === TypeTag.Char ||
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
    type.tag === TypeTag.F64 ||
    // C compatible types
    type.tag === TypeTag.Char ||
    type.tag === TypeTag.Short ||
    type.tag === TypeTag.UShort ||
    type.tag === TypeTag.Int ||
    type.tag === TypeTag.UInt ||
    type.tag === TypeTag.Long ||
    type.tag === TypeTag.ULong ||
    type.tag === TypeTag.LongLong ||
    type.tag === TypeTag.ULongLong ||
    type.tag === TypeTag.LongDouble
  );
}

export function isUnitType(type?: Type): boolean {
  return type?.tag === TypeTag.Unit;
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

export function isComptListType(type?: Type): type is ComptListType {
  return type?.tag === TypeTag.ComptList;
}

export function isExprListType(type?: Type): boolean {
  return isComptListType(type) && isExprType(type.childType);
}

export function isBooleanType(type?: Type): boolean {
  return type?.tag === TypeTag.Bool;
}

export function isUsizeType(type?: Type): boolean {
  return type?.tag === TypeTag.Usize;
}

export function isIsizeType(type?: Type): boolean {
  return type?.tag === TypeTag.Isize;
}

export function isU8Type(type?: Type): boolean {
  return type?.tag === TypeTag.U8;
}

export function isI8Type(type?: Type): boolean {
  return type?.tag === TypeTag.I8;
}

export function isU16Type(type?: Type): boolean {
  return type?.tag === TypeTag.U16;
}

export function isI16Type(type?: Type): boolean {
  return type?.tag === TypeTag.I16;
}

export function isU32Type(type?: Type): boolean {
  return type?.tag === TypeTag.U32;
}

export function isI32Type(type?: Type): boolean {
  return type?.tag === TypeTag.I32;
}

export function isU64Type(type?: Type): boolean {
  return type?.tag === TypeTag.U64;
}

export function isI64Type(type?: Type): boolean {
  return type?.tag === TypeTag.I64;
}

export function isF32Type(type?: Type): boolean {
  return type?.tag === TypeTag.F32;
}

export function isF64Type(type?: Type): boolean {
  return type?.tag === TypeTag.F64;
}

export function isExprType(type?: Type): boolean {
  return type?.tag === TypeTag.Expr;
}

// Complex type guards
export function isArrayType(type?: Type): type is ArrayType {
  return type?.tag === TypeTag.Array;
}

export function isSliceType(type?: Type): type is SliceType {
  return type?.tag === TypeTag.Slice;
}

export function isTupleType(type?: Type): type is TupleType {
  return type?.tag === TypeTag.Tuple;
}

export function isUnionType(type?: Type): type is UnionType {
  return type?.tag === TypeTag.Union;
}

export function isEnumType(type?: Type): type is EnumType {
  return type?.tag === TypeTag.Enum;
}

export function isStructType(type?: Type): type is StructType {
  return type?.tag === TypeTag.Struct;
}

export function isObjectType(
  type?: Type
): type is StructType & { isReferenceSemantics: true } {
  return (
    type?.tag === TypeTag.Struct && (type as StructType).isReferenceSemantics
  );
}

export function isNewtypeType(
  type?: Type
): type is StructType & { isNewtype: true } {
  return type?.tag === TypeTag.Struct && (type as StructType).isNewtype;
}

export function isModuleType(type?: Type): type is ModuleType {
  return type?.tag === TypeTag.Module;
}

/**
 * Check if a type is a FnModuleType (callable/closure type).
 * This replaces the old isClosureType - closures are now ModuleTypes with isFn set.
 */
export function isFnModuleType(type?: Type): type is FnModuleType {
  return type?.tag === TypeTag.Module && !!(type as ModuleType).isFn;
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

export function isFunctionTypeAndIsMacroFunction(type?: Type) {
  return (
    type?.tag === TypeTag.Function && (type as FunctionType).return.isUnquote
  );
}

export function isFunctionTypeAndReturnsComptValue(type?: Type) {
  return (
    type?.tag === TypeTag.Function &&
    (type as FunctionType).return.isCompileTimeOnly
  );
}

/*
export function isLiteralType(type?: Type): type is LiteralType {
  return type?.tag === TypeTag.Literal;
}
  */

// Type hierarchy guards
export function isTypeHierarchyType(type?: Type): type is TypeHierarchyType {
  return type?.tag === TypeTag.Type;
}

export function isType0(type?: Type): boolean {
  return (
    isTypeHierarchyType(type) && type.tag === TypeTag.Type && type.level === 0
  );
}

export function isSomeType(type?: Type): type is SomeType {
  return type?.tag === TypeTag.SomeType;
}

// Pointer and reference guards
export function isPtrType(type?: Type): type is PtrType {
  return type?.tag === TypeTag.Ptr;
}

export function isIsoType(type?: Type): type is IsoType {
  return type?.tag === TypeTag.Iso;
}

export function isDynType(type?: Type): type is DynType {
  return type?.tag === TypeTag.Dyn;
}

/**
 * This checks if the type is using the reference semantics.
 * Note: FnModuleType (closures) and FutureModuleType (futures) are NOT inherently reference types.
 * - Impl(Fn(...)) / Impl(Future(...)) is value semantics (anonymous struct)
 * - Dyn(Fn(...)) / Dyn(Future(...)) is reference semantics (handled by isDynType)
 * @param type
 * @returns
 */
export function isRcType(type?: Type): boolean {
  if (isSomeType(type)) {
    const someType = type as SomeType;

    if (typeImplementsFuture(someType)) {
      return true;
    }
    if (someType.resolvedConcreteType) {
      return isRcType(someType.resolvedConcreteType);
    }
  }

  return (
    isObjectType(type) ||
    // We assume all the SomeType is reference-counted
    // isSomeType(type) ||
    // The DynType is a struct that contains a pointer to data where the data must be an ObjectType
    isDynType(type) ||
    // IsoType uses atomic reference counting
    isIsoType(type)
  );
}

// Numeric type guards
export function isIntegerType(type?: Type): boolean {
  return (
    type?.tag === TypeTag.U8 ||
    type?.tag === TypeTag.I8 ||
    type?.tag === TypeTag.U16 ||
    type?.tag === TypeTag.I16 ||
    type?.tag === TypeTag.U32 ||
    type?.tag === TypeTag.I32 ||
    type?.tag === TypeTag.U64 ||
    type?.tag === TypeTag.I64 ||
    type?.tag === TypeTag.Usize ||
    type?.tag === TypeTag.Isize
  );
}

export function isFloatType(type?: Type): boolean {
  return type?.tag === TypeTag.F32 || type?.tag === TypeTag.F64;
}

export function isSignedIntegerType(type?: Type): boolean {
  return (
    type?.tag === TypeTag.I8 ||
    type?.tag === TypeTag.I16 ||
    type?.tag === TypeTag.I32 ||
    type?.tag === TypeTag.I64 ||
    type?.tag === TypeTag.Isize
  );
}

export function isUnsignedIntegerType(type?: Type): boolean {
  return (
    type?.tag === TypeTag.U8 ||
    type?.tag === TypeTag.U16 ||
    type?.tag === TypeTag.U32 ||
    type?.tag === TypeTag.U64 ||
    type?.tag === TypeTag.Usize
  );
}

// C Compatible types
export function isCharType(type?: Type): boolean {
  return type?.tag === TypeTag.Char;
}

export function isShortType(type?: Type): boolean {
  return type?.tag === TypeTag.Short;
}

export function isUShortType(type?: Type): boolean {
  return type?.tag === TypeTag.UShort;
}

export function isIntType(type?: Type): boolean {
  return type?.tag === TypeTag.Int;
}

export function isUIntType(type?: Type): boolean {
  return type?.tag === TypeTag.UInt;
}

export function isLongType(type?: Type): boolean {
  return type?.tag === TypeTag.Long;
}

export function isULongType(type?: Type): boolean {
  return type?.tag === TypeTag.ULong;
}

export function isLongLongType(type?: Type): boolean {
  return type?.tag === TypeTag.LongLong;
}

export function isULongLongType(type?: Type): boolean {
  return type?.tag === TypeTag.ULongLong;
}

export function isLongDoubleType(type?: Type): boolean {
  return type?.tag === TypeTag.LongDouble;
}

export function isVoidType(type?: Type): type is VoidType {
  return type?.tag === TypeTag.Void;
}

export function isFutureModuleType(type?: Type): type is FutureModuleType {
  return isModuleType(type) && type.isFuture !== undefined;
}

export function isConcreteModuleType(type?: Type): type is ConcreteModuleType {
  return isModuleType(type) && type.isConcrete !== undefined;
}

// Helper function to check if a type is a C compatible type
export function isCCompatibleType(type?: Type): boolean {
  return (
    !!type &&
    (type.tag === TypeTag.Char ||
      type.tag === TypeTag.Short ||
      type.tag === TypeTag.UShort ||
      type.tag === TypeTag.Int ||
      type.tag === TypeTag.UInt ||
      type.tag === TypeTag.Long ||
      type.tag === TypeTag.ULong ||
      type.tag === TypeTag.LongLong ||
      type.tag === TypeTag.ULongLong ||
      type.tag === TypeTag.LongDouble)
  );
}

/**
 * Checks if a function is specializable (generic) based on its type.
 * A function is specializable if it has:
 * - Compile-time only parameters
 * - Type parameters
 * - Compile-time only implicit parameters
 * - Parameters with SomeType (Impl(...)) that need monomorphization
 * And its return type is not compile-time only.
 */
export function isFunctionSpecializable(functionType: FunctionType): boolean {
  if (!functionType) {
    return false;
  }

  // If the return type is compile-time only, this function is not specializable
  // for runtime code generation
  if (functionType.return?.isCompileTimeOnly) {
    return false;
  }

  // Check if this function has compile-time parameters and needs specialization
  const hasCompileTimeParams =
    functionType.parameters.some((p) => p.isCompileTimeOnly) ||
    functionType.forallParameters.length > 0;

  // Check if this function has SomeType parameters (like Impl(Fn(...)))
  // that need monomorphization for different concrete types
  const hasSomeTypeParams = functionType.parameters.some(
    (p) =>
      !p.isCompileTimeOnly &&
      isSomeType(p.type) &&
      !typeImplementsFuture(p.type)
  );

  return hasCompileTimeParams || hasSomeTypeParams;
}

/**
 * Check if the given type is a Boxed type (Box(T)).
 * @param type
 * @returns
 */
export function isBoxedType(
  type: Type
): type is StructType & { isReferenceSemantics: true; __isBoxed: true } {
  if (!isObjectType(type)) {
    return false;
  } else {
    // Check if it's the Box(T) where Box is from the prelude.yo
    return (
      type.fields.length === 1 &&
      type.fields[0]!.label === "*" &&
      !!type.typeName?.startsWith("Box(")
    );
  }
}
