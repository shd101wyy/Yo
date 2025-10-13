import {
  ArrayType,
  ClosureType,
  DynType,
  EnumType,
  FunctionType,
  FutureType,
  ModuleType,
  MutPtrType,
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

export function isObjectType(
  type?: Type
): type is StructType & { isReferenceSemantics: true } {
  return (
    type?.tag === TypeTag.Struct && (type as StructType).isReferenceSemantics
  );
}

export function isModuleType(type?: Type): type is ModuleType {
  return type?.tag === TypeTag.Module;
}

export function isFunctionType(type?: Type): type is FunctionType {
  return type?.tag === TypeTag.Function;
}

export function isClosureFunctionType(type?: Type): type is FunctionType {
  return (
    type?.tag === TypeTag.Function && Boolean((type as FunctionType).isClosure)
  );
}

export function isClosureType(type?: Type): type is ClosureType {
  return type?.tag === TypeTag.Closure;
}

export function isRegularFunctionType(type?: Type): type is FunctionType {
  return type?.tag === TypeTag.Function && !(type as FunctionType).isClosure;
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
export function isMutPtrType(type?: Type): type is MutPtrType {
  return type?.tag === TypeTag.MutPtr;
}

export function isDynType(type?: Type): type is DynType {
  return type?.tag === TypeTag.Dyn;
}

/**
 * This checks if the type is using the reference semantics.
 * @param type
 * @returns
 */
export function isARCType(type?: Type): boolean {
  return (
    isObjectType(type) ||
    isDynType(type) || // All Dyn types are reference semantics
    isClosureType(type) || // All closures are reference semantics
    isFutureType(type) // All futures are reference semantics
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

export function isFutureType(type?: Type): type is FutureType {
  return type?.tag === TypeTag.Future;
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
    functionType.forallParameters.length > 0 ||
    functionType.implicitParameters.some((p) => p.isCompileTimeOnly);

  return hasCompileTimeParams;
}
