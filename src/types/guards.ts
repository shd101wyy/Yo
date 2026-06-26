import { typeImplementsFuture } from "../evaluator/trait-checking";
import { FunctionValue } from "../function-value";
import type {
  ArrayType,
  ComptimeListType,
  ConcreteTraitType,
  DynType,
  EnumType,
  FnTraitType,
  FunctionType,
  FutureTraitType,
  IsoType,
  SourceNamespaceType,
  PtrType,
  StrType,
  SomeType,
  StructType,
  TraitType,
  TupleType,
  Type,
  TypeApplicationType,
  TypeHierarchyType,
  UnionType,
  VoidType,
} from "./definitions";
import { TypeTag } from "./tags";

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

export function isComptimeIntType(type?: Type): boolean {
  return type?.tag === TypeTag.ComptimeInt;
}

export function isComptimeFloatType(type?: Type): boolean {
  return type?.tag === TypeTag.ComptimeFloat;
}

export function isComptimeStringType(type?: Type): boolean {
  return type?.tag === TypeTag.ComptimeString;
}

export function isComptimeListType(type?: Type): type is ComptimeListType {
  return type?.tag === TypeTag.ComptimeList;
}

export function isExprListType(type?: Type): boolean {
  return isComptimeListType(type) && isExprType(type.childType);
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

export function isStrType(type?: Type): type is StrType {
  return type?.tag === TypeTag.Str;
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
  return (
    type?.tag === TypeTag.Struct && !(type as StructType).isSourceNamespace
  );
}

export function isObjectType(
  type?: Type
): type is StructType & { isReferenceSemantics: true } {
  return (
    type?.tag === TypeTag.Struct && (type as StructType).isReferenceSemantics
  );
}

export function isAtomicObjectType(
  type?: Type
): type is StructType & { isReferenceSemantics: true; isAtomicRc: true } {
  return (
    type?.tag === TypeTag.Struct &&
    (type as StructType).isReferenceSemantics &&
    (type as StructType).isAtomicRc === true
  );
}

/** Reference-semantics enum: `ref(enum(…))`. */
export function isReferenceEnumType(
  type?: Type
): type is EnumType & { isReferenceSemantics: true } {
  return (
    type?.tag === TypeTag.Enum &&
    (type as EnumType).isReferenceSemantics === true
  );
}

/** Atomic reference-semantics enum: `atomic(ref(enum(…)))`. */
export function isAtomicReferenceEnumType(
  type?: Type
): type is EnumType & { isReferenceSemantics: true; isAtomicRc: true } {
  return (
    type?.tag === TypeTag.Enum &&
    (type as EnumType).isReferenceSemantics === true &&
    (type as EnumType).isAtomicRc === true
  );
}

export function isNewtypeType(
  type?: Type
): type is StructType & { isNewtype: true } {
  return type?.tag === TypeTag.Struct && (type as StructType).isNewtype;
}

export function isSourceNamespaceType(
  type?: Type
): type is SourceNamespaceType {
  return (
    type?.tag === TypeTag.Struct &&
    (type as StructType).isSourceNamespace === true
  );
}

export function isTraitType(type?: Type): type is TraitType {
  return type?.tag === TypeTag.Trait;
}

/**
 * Check if a type is a FnTraitType (callable/closure type).
 * This replaces the old isClosureType - closures are now TraitTypes with isFn set.
 */
export function isFnTraitType(type?: Type): type is FnTraitType {
  return isTraitType(type) && type.isFn !== undefined;
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

export function isFunctionTypeAndReturnsComptimeValue(type?: Type) {
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

export function isTypeApplicationType(
  type?: Type
): type is TypeApplicationType {
  return type?.tag === TypeTag.TypeApplication;
}

/**
 * This checks if the type is using the reference semantics.
 * Note: FnTraitType (closures) and FutureTraitType (futures) are NOT inherently reference types.
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
    // Reference-semantics enums (`ref(enum(…))`) are RC-managed like objects.
    isReferenceEnumType(type) ||
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

export function isFutureTraitType(type?: Type): type is FutureTraitType {
  return isTraitType(type) && type.isFuture !== undefined;
}

export function isConcreteTraitType(type?: Type): type is ConcreteTraitType {
  return isTraitType(type) && type.isConcrete !== undefined;
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
 * Pure type-level check: does this function type have unresolved generic
 * parameters that require specialization?
 *
 * This includes:
 * - Compile-time only parameters
 * - Forall type parameters
 * - Any implicit parameters (all implicit params are compile-time)
 * - SomeType parameters needing monomorphization
 *
 * Use this for:
 * - Checking if a specialized type still has unresolved params
 * - Validating that runtime vars can't have generic function types (binding.ts)
 * - Evaluator deciding whether to specialize at call sites (helper.ts)
 */
export function isFunctionTypeGeneric(functionType: FunctionType): boolean {
  if (!functionType) {
    return false;
  }

  if (functionType.return?.isCompileTimeOnly) {
    return false;
  }

  const hasCompileTimeParams =
    functionType.parameters.some((p) => p.isCompileTimeOnly) ||
    !!functionType.variadicParameter?.isCompileTimeOnly ||
    !!functionType.variadicParameter?.isQuote ||
    functionType.forallParameters.length > 0;

  const hasSomeTypeParams = functionType.parameters.some(
    (p) =>
      !p.isCompileTimeOnly &&
      isSomeType(p.type) &&
      !typeImplementsFuture(p.type)
  );

  return hasCompileTimeParams || hasSomeTypeParams;
}

/**
 * Check if a function type has "hard" generic parameters that make the
 * unspecialized form invalid for C codegen. This means comptime params,
 * forall params, or SomeType params — but NOT implicit-params-only.
 *
 * Functions that are generic ONLY because of implicit parameters can still
 * be generated as regular C functions because implicit params are resolved
 * at compile time and don't appear in the C function signature.
 */
export function isFunctionTypeHardGeneric(functionType: FunctionType): boolean {
  if (!functionType) {
    return false;
  }

  if (functionType.return?.isCompileTimeOnly) {
    return false;
  }

  const hasCompileTimeParams =
    functionType.parameters.some((p) => p.isCompileTimeOnly) ||
    !!functionType.variadicParameter?.isCompileTimeOnly ||
    !!functionType.variadicParameter?.isQuote ||
    functionType.forallParameters.length > 0;

  const hasSomeTypeParams = functionType.parameters.some(
    (p) =>
      !p.isCompileTimeOnly &&
      isSomeType(p.type) &&
      !typeImplementsFuture(p.type) &&
      // SomeType parameters with a resolved concrete type are fully specialized
      // — codegen can use the concrete type via getTypeString. This matters for
      // closure-typed parameters (e.g., `f : F` where F = Impl(Fn(...))
      // resolves to the closure's capture struct).
      !p.type.resolvedConcreteType
  );

  return hasCompileTimeParams || hasSomeTypeParams;
}

/**
 * Value-level check: does this function need per-call-site specialization
 * for C codegen?
 *
 * A function is specializable when:
 * 1. Its type is generic (has compile-time params, forall params, implicit params,
 *    or SomeType params) — checked by isFunctionTypeGeneric
 * 2. The evaluator actually created specialized versions for it
 *    — checked by specializedFunctionCaches
 *
 * This correctly handles:
 * - using(io : Io): generic type but no caches (Io resolved at compile time) → false
 * - using(raise : Raise): generic type + evaluator created caches → true
 * - using(raise_mod : RaiseMod): generic type + evaluator created caches → true
 * - forall(T): generic type + evaluator created caches → true
 */
export function isFunctionSpecializable(functionValue: FunctionValue): boolean {
  const functionType = functionValue.type;
  if (!functionType) {
    return false;
  }

  return (
    isFunctionTypeGeneric(functionType) &&
    (functionValue.specializedFunctionCaches?.length ?? 0) > 0
  );
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
