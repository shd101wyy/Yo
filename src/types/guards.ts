import {
  ArrayType,
  EnumType,
  FunctionType,
  ModuleType,
  MutPtrType,
  MutRefType,
  PtrType,
  RefType,
  SliceType,
  SomeType,
  StructType,
  TupleType,
  Type,
  TypeHierarchyType,
  UnionType,
} from "./definitions";
import { TypeTag } from "./tags";

// Basic type guards
export function isPrimitiveType(type: Type): boolean {
  return (
    type.tag === TypeTag.Unit ||
    type.tag === TypeTag.Boolean ||
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
    type.tag === TypeTag.CChar ||
    type.tag === TypeTag.CShort ||
    type.tag === TypeTag.CUShort ||
    type.tag === TypeTag.CInt ||
    type.tag === TypeTag.CUInt ||
    type.tag === TypeTag.CLong ||
    type.tag === TypeTag.CULong ||
    type.tag === TypeTag.CLongLong ||
    type.tag === TypeTag.CULongLong ||
    type.tag === TypeTag.CLongDouble
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

export function isExprListType(type?: Type): boolean {
  return type?.tag === TypeTag.ExprList;
}

export function isBooleanType(type?: Type): boolean {
  return type?.tag === TypeTag.Boolean;
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

export function isModuleType(type?: Type): type is ModuleType {
  return type?.tag === TypeTag.Module;
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
  return isLinearType(type) || isType0(type) || Boolean(type?.forceLinear);
}

export function isSomeType(type?: Type): type is SomeType {
  return type?.tag === TypeTag.SomeType;
}

// Pointer and reference guards
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
export function isCCharType(type?: Type): boolean {
  return type?.tag === TypeTag.CChar;
}

export function isCShortType(type?: Type): boolean {
  return type?.tag === TypeTag.CShort;
}

export function isCUShortType(type?: Type): boolean {
  return type?.tag === TypeTag.CUShort;
}

export function isCIntType(type?: Type): boolean {
  return type?.tag === TypeTag.CInt;
}

export function isCUIntType(type?: Type): boolean {
  return type?.tag === TypeTag.CUInt;
}

export function isCLongType(type?: Type): boolean {
  return type?.tag === TypeTag.CLong;
}

export function isCULongType(type?: Type): boolean {
  return type?.tag === TypeTag.CULong;
}

export function isCLongLongType(type?: Type): boolean {
  return type?.tag === TypeTag.CLongLong;
}

export function isCULongLongType(type?: Type): boolean {
  return type?.tag === TypeTag.CULongLong;
}

export function isCLongDoubleType(type?: Type): boolean {
  return type?.tag === TypeTag.CLongDouble;
}

// Helper function to check if a type is a C compatible type
export function isCCompatibleType(type?: Type): boolean {
  return (
    !!type &&
    (type.tag === TypeTag.CChar ||
      type.tag === TypeTag.CShort ||
      type.tag === TypeTag.CUShort ||
      type.tag === TypeTag.CInt ||
      type.tag === TypeTag.CUInt ||
      type.tag === TypeTag.CLong ||
      type.tag === TypeTag.CULong ||
      type.tag === TypeTag.CLongLong ||
      type.tag === TypeTag.CULongLong ||
      type.tag === TypeTag.CLongDouble)
  );
}

/**
 * Checks if a function is specializable (generic) based on its type.
 * A function is specializable if it has:
 * - Compile-time only parameters
 * - Type parameters
 * - Compile-time only implicit parameters
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
    functionType.typeParameters.length > 0 ||
    functionType.implicitParameters.some((p) => p.isCompileTimeOnly);

  return hasCompileTimeParams;
}
