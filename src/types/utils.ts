import type { Environment } from "../env";
import { formatErrorMessages } from "../error";
import {
  typeImplementsAcyclic,
  typeImplementsComptime,
  typeImplementsFn,
  typeImplementsFuture,
  typeImplementsRuntime,
} from "../evaluator/trait-checking";
import { type Expr, exprToString } from "../expr";
import { stringIsOperator, type Token } from "../token";
import { isNumberValue, isUnknownValue, valueToString } from "../value";
import { createF64Type, createI32Type, createStrType } from "./creators";
import type {
  ArrayType,
  ComptimeListType,
  DynType,
  EnumType,
  FunctionParameter,
  FunctionType,
  IsoType,
  TypeField,
  PtrType,
  SomeType,
  StructType,
  TraitType,
  TupleType,
  Type,
  TypeApplicationType,
  UnionType,
} from "./definitions";
import {
  isArrayType,
  isBooleanType,
  isCharType,
  isComptimeFloatType,
  isComptimeIntType,
  isComptimeListType,
  isComptimeStringType,
  isDynType,
  isEnumType,
  isExprType,
  isF32Type,
  isF64Type,
  isFloatType,
  isFnTraitType,
  isFunctionType,
  isFutureTraitType,
  isI16Type,
  isI32Type,
  isI64Type,
  isI8Type,
  isIntegerType,
  isIsizeType,
  isSourceNamespaceType,
  isReferenceStructType,
  isPtrType,
  isRcType,
  isSomeType,
  isStructType,
  isTraitType,
  isTupleType,
  isTypeHierarchyType,
  isU16Type,
  isU32Type,
  isU64Type,
  isU8Type,
  isUnionType,
  isUnitType,
  isUsizeType,
  isVoidType,
} from "./guards";
import { TypeTag } from "./tags";

/**
 * Check if the type of the value requires to use the comptime modifier.
 * For example:
 *   comptime(x): Type
 *   comptime(x): comptime_int
 *
 * This includes:
 * - Primitive comptime-only types (Type, comptime_int, comptime_float, etc.)
 * - Compound types that are comptime-only (structs with comptime_int fields, etc.)
 */
export function typeRequiresComptimeModifier(
  type: Type | undefined,
  env: Environment
): boolean {
  if (!type) {
    return false;
  }

  // Check if compound types are comptime-only based on their availability
  // A type with availability { comptime: true, runtime: false } is comptime-only
  return isComptimeOnlyType(type, env);
}

export function typeProhibitsComptimeModifier(
  type: Type | undefined,
  env: Environment
): boolean {
  if (!type) {
    return false;
  }

  const result = isRuntimeOnlyType(type, env);
  return result;
}

/**
 * Check if a type is comptime-only (cannot be used at runtime).
 */
export function isComptimeOnlyType(type: Type, env: Environment): boolean {
  return typeImplementsComptime(type, env) && !typeImplementsRuntime(type, env);
}

/**
 * Check if a type is runtime-only (cannot be used at compile time).
 */
export function isRuntimeOnlyType(type: Type, env: Environment): boolean {
  const implementsComptime = typeImplementsComptime(type, env);
  const implementsRuntime = typeImplementsRuntime(type, env);
  const result = !implementsComptime && implementsRuntime;
  return result;
}

/**
 * Check if the type contains `object` or `Dyn`
 * @param type
 */
export function typeContainsRcType(
  type?: Type,
  checkedTypes: Type[] = []
): boolean {
  if (!type) {
    return false;
  }

  if (checkedTypes.includes(type)) {
    return false;
  } else {
    checkedTypes.push(type);
  }

  if (type.isExtern) {
    // NOTE: Extern types, mostly the SomeType, don't need Rc
    return false;
  }

  if (isRcType(type)) {
    return true;
  }

  // Recursively check in complex types
  switch (type.tag) {
    case TypeTag.Array:
      return typeContainsRcType((type as ArrayType).childType, checkedTypes);
    case TypeTag.Tuple:
      return (type as TupleType).fields.some((field) =>
        typeContainsRcType(field.type, checkedTypes)
      );
    case TypeTag.Union:
      return (type as UnionType).fields.some((field) =>
        typeContainsRcType(field.type, checkedTypes)
      );
    case TypeTag.Struct:
      return (type as StructType).fields.some((field) =>
        typeContainsRcType(field.type, checkedTypes)
      );
    case TypeTag.Enum:
      return (type as EnumType).variants.some((variant) =>
        variant.fields?.some((param) =>
          typeContainsRcType(param.type, checkedTypes)
        )
      );
    case TypeTag.Iso:
      // Iso itself is GC type (atomic RC), check inner type
      return typeContainsRcType((type as IsoType).childType, checkedTypes);
    case TypeTag.Function: {
      return false; // Regular functions are not reference types
    }
    case TypeTag.SomeType: {
      const someType = type as SomeType;
      if (typeImplementsFuture(someType)) {
        return true; // All Future types are reference counted
      }
      if (someType.resolvedConcreteType) {
        return typeContainsRcType(someType.resolvedConcreteType, checkedTypes);
      } else {
        // Conservatively return true because we don't know at
        return true;
      }
    }
    // case TypeTag.SomeType: { // NOTE: SomeType is now handled in isRcType
    //   // SomeType conservatively returns true because we don't know at
    //   // generation time whether the concrete type will contain GC types.
    //   // This ensures Box(SomeType_V) generates proper ___dispose code.
    //   return true;
    // }
    // No need to consider ptr/ref types, as they are not owning types
    default:
      return false; // For other types, no references are present
  }
}

/**
 * Check if a type is "control-bound" — i.e., a value of this type carries
 * (transitively) a control-function value. Control-bound values are
 * frame-bound: they cannot escape via function return, module-level
 * binding, heap allocation, closure capture, or pointer indirection.
 *
 * See plans/EXPLICIT_EFFECTS.md §4 "Handler value unwind-escape
 * restrictions — `ctl()` type constructor".
 *
 * Rules:
 * - `ctl(...) -> ret` (FunctionType with `isControl === true`) → true.
 * - Regular `fn(...) -> ret` → false (a fn pointer doesn't carry a CF,
 *   even if its parameters/return reference ctl types).
 * - Aggregates (Struct, Tuple, Enum, Union, Array, Slice) → true iff
 *   any field/element type is control-bound.
 * - `&T` (Ptr) → true iff T is control-bound. Pointers to control-bound
 *   storage are themselves rejected (rule 11) to prevent escape via
 *   pointer-write to outer-frame storage.
 * - Other types (numbers, strings, types, etc.) → false.
 */
export function typeIsControlBound(
  type?: Type,
  checkedTypes: Type[] = []
): boolean {
  if (!type) {
    return false;
  }

  if (checkedTypes.includes(type)) {
    return false;
  }
  checkedTypes.push(type);

  switch (type.tag) {
    case TypeTag.Function: {
      // Only a `ctl(...) -> ret` function value is itself control-bound.
      // A regular `fn(...) -> ret` is a plain fn pointer; even if its
      // parameter or return types reference ctl, the function value does
      // not carry a CF — it merely calls one provided by the caller.
      return (type as FunctionType).isControl === true;
    }
    case TypeTag.Struct:
      return (type as StructType).fields.some((field) =>
        typeIsControlBound(field.type, checkedTypes)
      );
    case TypeTag.Tuple:
      return (type as TupleType).fields.some((field) =>
        typeIsControlBound(field.type, checkedTypes)
      );
    case TypeTag.Union:
      return (type as UnionType).fields.some((field) =>
        typeIsControlBound(field.type, checkedTypes)
      );
    case TypeTag.Enum:
      return (type as EnumType).variants.some((variant) =>
        variant.fields?.some((param) =>
          typeIsControlBound(param.type, checkedTypes)
        )
      );
    case TypeTag.Array:
      return typeIsControlBound((type as ArrayType).childType, checkedTypes);
    case TypeTag.Ptr:
      return typeIsControlBound((type as PtrType).childType, checkedTypes);
    case TypeTag.SomeType: {
      const someType = type as SomeType;
      if (someType.resolvedConcreteType) {
        return typeIsControlBound(someType.resolvedConcreteType, checkedTypes);
      }
      return false;
    }
    default:
      return false;
  }
}

/**
 * Check if a type's runtime representation transitively carries a raw
 * pointer (`*(T)`), where "transitively" walks through aggregate fields
 * but **stops at heap-owning `object` types** — those manage their own
 * pointer's lifetime via Rc and cannot dangle through a return slot.
 *
 * Used by the flowability rule from `plans/SLICE_FLOWABILITY.md`:
 * a function returning a type for which this predicate is true (and
 * whose return is NOT already `-> ref(T)`) must have a flowable
 * return expression, because the return slot would otherwise smuggle
 * a pointer into the caller that aliases dead storage.
 *
 * Rules:
 * - `Ptr` → true (a raw pointer is the base case).
 * - `Struct` with `isReferenceSemantics` (i.e. `object` / `atomic(object(...))`)
 *   → **false**. Heap-owning types manage their own pointer; passing
 *   them around at the value layer does not give the receiver an
 *   alias to dying storage.
 * - `Struct` without reference semantics (plain struct, newtype) →
 *   recurse into each field's type. This catches any user wrapper
 *   that stores a raw-pointer field.
 * - `Tuple` / `Union` → recurse into each field.
 * - `Enum` → recurse into each variant's fields. Catches
 *   `Option(*(T))`, `Result(*(T), E)`, etc.
 * - `Array(T, N)` → recurse into `T`. (Arrays inline their elements
 *   contiguously, so if `T` carries a raw pointer the array does too.)
 * - `Function` → false. A function pointer is itself a pointer at the
 *   C ABI, but it points at code (static), not at data — it cannot
 *   dangle through a stack-local source the way a raw data pointer
 *   can. The closure-capture story is handled by the separate
 *   `cannot-capture-ref` gate.
 * - `SomeType` → follow `resolvedConcreteType` if resolved; otherwise
 *   false. An unresolved generic type variable doesn't tell us anything
 *   yet — the check will re-run after specialization.
 * - Primitive types, comptime types, etc. → false.
 */
export function typeRepresentationContainsRawPtr(
  type?: Type,
  checkedTypes: Type[] = []
): boolean {
  if (!type) {
    return false;
  }

  if (checkedTypes.includes(type)) {
    return false;
  }
  checkedTypes.push(type);

  // Heap-owning `object` types (and atomic-rc variants) manage their
  // pointer lifetime via Rc. They are safe to return at the value layer.
  // Check this BEFORE the generic Struct fall-through so a struct's
  // `isReferenceSemantics` short-circuits the field walk.
  if (isReferenceStructType(type)) {
    return false;
  }
  // `Dyn(Trait)` is a fat pointer (data + vtable) into RC-managed
  // object storage. Same reasoning as `isReferenceStructType`: returning a
  // `Dyn` transfers (or shares) the Rc, so the data pointer stays
  // alive. Skip the field walk.
  if (isDynType(type)) {
    return false;
  }

  switch (type.tag) {
    case TypeTag.Ptr:
      return true;
    // str is the builtin view of STATIC string bytes (immortal backing) —
    // it carries a pointer, but never a dangling one: as_str/as_slice are
    // deleted and ranges copy (plans/SLICE_REWORK.md). No flow constraints.
    case TypeTag.Str:
      return false;
    case TypeTag.Struct:
      // Plain struct or newtype — walk fields.
      return (type as StructType).fields.some((field) =>
        typeRepresentationContainsRawPtr(field.type, checkedTypes)
      );
    case TypeTag.Tuple:
      return (type as TupleType).fields.some((field) =>
        typeRepresentationContainsRawPtr(field.type, checkedTypes)
      );
    case TypeTag.Union:
      return (type as UnionType).fields.some((field) =>
        typeRepresentationContainsRawPtr(field.type, checkedTypes)
      );
    case TypeTag.Enum:
      return (type as EnumType).variants.some((variant) =>
        variant.fields?.some((param) =>
          typeRepresentationContainsRawPtr(param.type, checkedTypes)
        )
      );
    case TypeTag.Array:
      return typeRepresentationContainsRawPtr(
        (type as ArrayType).childType,
        checkedTypes
      );
    case TypeTag.SomeType: {
      const someType = type as SomeType;
      if (someType.resolvedConcreteType) {
        return typeRepresentationContainsRawPtr(
          someType.resolvedConcreteType,
          checkedTypes
        );
      }
      return false;
    }
    default:
      // Function, primitives, trait, dyn, type, etc. — no pointer-escape
      // surface at the representation level for our purposes.
      return false;
  }
}

/**
 * Sibling to `typeRepresentationContainsRawPtr` that ALSO treats
 * `object`/`atomic(object(...))` types as a "yes" leaf. Used by the
 * slice-flowability R3 check to decide which call arguments could
 * have provided the source pointer for the callee's returned slice.
 *
 * The distinction matters because:
 *
 * - At the return-site question ("does this function's return type
 *   transitively carry a raw pointer that could dangle?") an `object`
 *   return is SAFE: ownership transfers to the caller and the Rc
 *   keeps the buffer alive. So `typeRepresentationContainsRawPtr`
 *   says NO for objects.
 *
 * - At the argument-source question ("could this arg be the storage
 *   the callee's returned slice points into?") an `object` arg
 *   absolutely qualifies — `arr.as_slice()` returns a `Slice` into
 *   `arr`'s heap buffer, which dies when `arr`'s Rc count drops to
 *   zero. If `arr` is a non-flowable local, the slice dangles.
 *
 * Returns true iff the type, walked through structs/tuples/unions/
 * enums/arrays, has a leaf that is `Ptr`, `Slice`, or an `object`
 * type. Function types are NOT recursed into (function pointers are
 * static), and `SomeType` follows `resolvedConcreteType` if resolved.
 */
export function typeMayProvideSliceSource(
  type?: Type,
  checkedTypes: Type[] = []
): boolean {
  if (!type) return false;
  if (checkedTypes.includes(type)) return false;
  checkedTypes.push(type);

  if (isReferenceStructType(type)) return true;
  // `Dyn(Trait)` carries an RC-managed object behind a fat pointer.
  // A callee can project a slice into that object's heap data, so a
  // `Dyn` arg is just as much a source candidate as an `object` arg.
  if (isDynType(type)) return true;

  switch (type.tag) {
    case TypeTag.Ptr:
      return true;
    case TypeTag.Struct:
      return (type as StructType).fields.some((field) =>
        typeMayProvideSliceSource(field.type, checkedTypes)
      );
    case TypeTag.Tuple:
      return (type as TupleType).fields.some((field) =>
        typeMayProvideSliceSource(field.type, checkedTypes)
      );
    case TypeTag.Union:
      return (type as UnionType).fields.some((field) =>
        typeMayProvideSliceSource(field.type, checkedTypes)
      );
    case TypeTag.Enum:
      return (type as EnumType).variants.some((variant) =>
        variant.fields?.some((param) =>
          typeMayProvideSliceSource(param.type, checkedTypes)
        )
      );
    case TypeTag.Array:
      return typeMayProvideSliceSource(
        (type as ArrayType).childType,
        checkedTypes
      );
    case TypeTag.SomeType: {
      const someType = type as SomeType;
      if (someType.resolvedConcreteType) {
        return typeMayProvideSliceSource(
          someType.resolvedConcreteType,
          checkedTypes
        );
      }
      return false;
    }
    default:
      return false;
  }
}

/**
 * Check if a type contains SomeType.
 */
export function typeContainsSomeType(
  type?: Type,
  checkedTypes: Type[] = []
): boolean {
  if (!type) {
    return false;
  }

  if (checkedTypes.includes(type)) {
    return false; // Prevent infinite recursion on circular types
  }

  checkedTypes.push(type);

  // Check if the type is a SomeType
  if (isSomeType(type)) {
    // If it's an extern type, it's concrete at codegen time, so don't count it
    // eg:
    //
    //    extern("yo", YO_THREAD_SYNC_TYPE: Type);
    //
    // YO_THREAD_SYNC_TYPE is SomeType but concrete
    if (type.isExtern) {
      return false;
    }

    if (type.resolvedConcreteType) {
      return typeContainsSomeType(type.resolvedConcreteType, checkedTypes);
    }

    {
      // FIXME: The check here is essentially wrong

      // Treat Impl(Fn(...)) as concrete at codegen time.
      // Codegen lowers such SomeType to the corresponding FnTraitType.
      if (typeImplementsFn(type)) {
        return false;
      }

      // Treat Impl(Future(...)) as concrete at codegen time.
      // Codegen generates state machine structs for Futures.
      if (typeImplementsFuture(type)) {
        return false;
      }
    }

    return true;
  }

  // Recursively check for SomeType in complex types
  switch (type.tag) {
    case TypeTag.Array:
      return typeContainsSomeType((type as ArrayType).childType, checkedTypes);
    case TypeTag.Tuple:
      return (type as TupleType).fields.some((field) =>
        typeContainsSomeType(field.type, checkedTypes)
      );
    case TypeTag.Struct:
      return (type as StructType).fields.some(
        (field) =>
          !field.isEffectParam && typeContainsSomeType(field.type, checkedTypes)
      );
    case TypeTag.Enum:
      return (type as EnumType).variants.some((variant) =>
        variant.fields?.some((param) =>
          typeContainsSomeType(param.type, checkedTypes)
        )
      );
    case TypeTag.Union:
      return (type as UnionType).fields.some((field) =>
        typeContainsSomeType(field.type, checkedTypes)
      );
    case TypeTag.Function: {
      const functionType = type as FunctionType;
      return (
        functionType.forallParameters.length > 0 ||
        functionType.parameters.some((parameter) =>
          typeContainsSomeType(parameter.type, checkedTypes)
        ) ||
        typeContainsSomeType(functionType.return.type, checkedTypes)
      );
    }
    case TypeTag.Ptr:
      return typeContainsSomeType((type as PtrType).childType, checkedTypes);
    case TypeTag.TypeApplication:
      // TypeApplication always contains a SomeType (the constructor)
      return true;

    default:
      return false; // For other types, no SomeType is present
  }
}

/**
 * Like `typeContainsSomeType` but distinguishes "free" SomeTypes from those
 * locally bound by a nested function's `forall(...)`. A function type's
 * `forallParameters` introduce SomeType bindings whose scope is just that
 * function's signature; references to those names inside the parameters or
 * return type are NOT free in the outer position.
 *
 * Without this distinction, `typeContainsSomeType(Io)` returns true via the
 * recursion into Io's fn-typed fields (`async : fn(forall(T, E), ...) -> ...`),
 * which causes `shouldDeferBodyEvaluation` in anonymous-function.ts to defer
 * any function body that takes `io : Io` as a parameter. The test runner's
 * batched-main function hit exactly this trap and silently dropped every test
 * body until commit `7b3b788b` worked around it by removing the parameter.
 *
 * This function tracks the set of forall-bound SomeType names per scope
 * (innermost wins, supporting shadowing). When recursing into a FunctionType,
 * the function's own forall labels are added to the bound set for the inner
 * walk. SomeTypes whose `name` matches a bound entry are skipped.
 *
 * NOTE: name-based tracking is sufficient because forall parameter names are
 * unique within a single function signature and Yo's evaluator generates a
 * fresh SomeType per forall declaration. A SomeType encountered inside the
 * function whose name matches a forall label IS that forall's variable.
 */
export function typeContainsUnboundSomeType(
  type?: Type,
  boundNames: Set<string> = new Set(),
  checkedTypes: Type[] = []
): boolean {
  if (!type) return false;
  if (checkedTypes.includes(type)) return false;
  checkedTypes.push(type);

  if (isSomeType(type)) {
    if (type.isExtern) return false;
    if (type.resolvedConcreteType) {
      return typeContainsUnboundSomeType(
        type.resolvedConcreteType,
        boundNames,
        checkedTypes
      );
    }
    if (typeImplementsFn(type)) return false;
    if (typeImplementsFuture(type)) return false;
    if (boundNames.has(type.name)) return false;
    return true;
  }

  switch (type.tag) {
    case TypeTag.Array:
      return typeContainsUnboundSomeType(
        (type as ArrayType).childType,
        boundNames,
        checkedTypes
      );
    case TypeTag.Tuple:
      return (type as TupleType).fields.some((field) =>
        typeContainsUnboundSomeType(field.type, boundNames, checkedTypes)
      );
    case TypeTag.Struct:
      return (type as StructType).fields.some(
        (field) =>
          !field.isEffectParam &&
          typeContainsUnboundSomeType(field.type, boundNames, checkedTypes)
      );
    case TypeTag.Enum:
      return (type as EnumType).variants.some((variant) =>
        variant.fields?.some((param) =>
          typeContainsUnboundSomeType(param.type, boundNames, checkedTypes)
        )
      );
    case TypeTag.Union:
      return (type as UnionType).fields.some((field) =>
        typeContainsUnboundSomeType(field.type, boundNames, checkedTypes)
      );
    case TypeTag.Function: {
      const fnType = type as FunctionType;
      // Extend bound set with this function's forall labels for the inner walk.
      // Use a per-recursion copy so siblings don't see each other's bindings.
      const innerBound = new Set(boundNames);
      for (const fp of fnType.forallParameters) {
        innerBound.add(fp.label);
      }
      return (
        fnType.parameters.some((p) =>
          typeContainsUnboundSomeType(p.type, innerBound, checkedTypes)
        ) ||
        typeContainsUnboundSomeType(
          fnType.return.type,
          innerBound,
          checkedTypes
        )
      );
    }
    case TypeTag.Ptr:
      return typeContainsUnboundSomeType(
        (type as PtrType).childType,
        boundNames,
        checkedTypes
      );
    case TypeTag.TypeApplication:
      return true;
    default:
      return false;
  }
}

/**
 * Variant of `typeContainsSomeType` used by codegen's "is this function
 * parameter truly generic?" filter. Behaves identically to
 * `typeContainsSomeType` except that when recursing into struct fields, it
 * does NOT recurse into FunctionType-valued fields.
 *
 * Rationale: effect-record types like `Exception` are concrete C structs
 * whose only "generic" content lives inside function-typed fields (e.g.
 * `throw : ctl(forall(R), error : AnyError) -> R`). At C codegen time those
 * fields are type-erased function pointers — concrete bytes — so a regular
 * function taking `exn : Exception` is NOT itself generic and must still be
 * emitted with a forward declaration and body. The plain
 * `typeContainsSomeType` returns true for `Exception` (because the field
 * walk hits the forall inside `throw`), which causes declarations.ts and
 * generation.ts to incorrectly skip the function — leaving call sites with
 * an undeclared `fn_*_parse` and similar.
 */
export function typeContainsSomeTypeForCodegenParam(
  type?: Type,
  checkedTypes: Type[] = []
): boolean {
  if (!type) return false;
  if (checkedTypes.includes(type)) return false;
  checkedTypes.push(type);

  if (isSomeType(type)) {
    if (type.isExtern) return false;
    if (type.resolvedConcreteType) {
      return typeContainsSomeTypeForCodegenParam(
        type.resolvedConcreteType,
        checkedTypes
      );
    }
    if (typeImplementsFn(type)) return false;
    if (typeImplementsFuture(type)) return false;
    return true;
  }

  switch (type.tag) {
    case TypeTag.Array:
      return typeContainsSomeTypeForCodegenParam(
        (type as ArrayType).childType,
        checkedTypes
      );
    case TypeTag.Tuple:
      return (type as TupleType).fields.some((field) =>
        typeContainsSomeTypeForCodegenParam(field.type, checkedTypes)
      );
    case TypeTag.Struct:
      return (type as StructType).fields.some(
        (field) =>
          !field.isEffectParam &&
          field.type.tag !== TypeTag.Function &&
          typeContainsSomeTypeForCodegenParam(field.type, checkedTypes)
      );
    case TypeTag.Enum:
      return (type as EnumType).variants.some((variant) =>
        variant.fields?.some((param) =>
          typeContainsSomeTypeForCodegenParam(param.type, checkedTypes)
        )
      );
    case TypeTag.Union:
      return (type as UnionType).fields.some((field) =>
        typeContainsSomeTypeForCodegenParam(field.type, checkedTypes)
      );
    case TypeTag.Function: {
      const functionType = type as FunctionType;
      return (
        functionType.forallParameters.length > 0 ||
        functionType.parameters.some((parameter) =>
          typeContainsSomeTypeForCodegenParam(parameter.type, checkedTypes)
        ) ||
        typeContainsSomeTypeForCodegenParam(
          functionType.return.type,
          checkedTypes
        )
      );
    }
    case TypeTag.Ptr:
      return typeContainsSomeTypeForCodegenParam(
        (type as PtrType).childType,
        checkedTypes
      );
    case TypeTag.TypeApplication:
      return true;
    default:
      return false;
  }
}

/**
 * Check if a type contains any Unknown values (e.g., array length is Unknown).
 * Used to determine if we should fully specialize a generic impl method or not.
 */
export function typeContainsUnknownValue(
  type: Type,
  visited: Set<string> = new Set()
): boolean {
  // Prevent infinite recursion on cyclic types
  if (visited.has(type.id)) {
    return false;
  }
  visited.add(type.id);

  if (isArrayType(type)) {
    if (isUnknownValue(type.length)) {
      return true;
    }
    return typeContainsUnknownValue(type.childType, visited);
  }
  if (isPtrType(type)) {
    return typeContainsUnknownValue(type.childType, visited);
  }
  if (isTupleType(type)) {
    return type.fields.some((f) => typeContainsUnknownValue(f.type, visited));
  }
  if (isStructType(type)) {
    return type.fields.some((f) => typeContainsUnknownValue(f.type, visited));
  }
  if (isEnumType(type)) {
    return type.variants.some((v) =>
      v.fields?.some((param) => typeContainsUnknownValue(param.type, visited))
    );
  }
  if (isUnionType(type)) {
    return type.fields.some((f) => typeContainsUnknownValue(f.type, visited));
  }

  // Add other cases as needed
  return false;
}

/**
 * Get all SomeTypes contained within a type.
 * @param type
 */
export function getAllSomeTypes(type: Type): Set<SomeType> {
  const result = new Set<SomeType>();
  const visited = new Set<Type>();

  function helper(t: Type) {
    // Prevent infinite recursion on circular/self-referential types
    if (t && visited.has(t)) {
      return;
    }

    if (t) {
      visited.add(t);
    }

    if (isSomeType(t)) {
      if (result.has(t)) {
        return; // Already checked
      }
      if (!t.resolvedConcreteType) {
        result.add(t);
      }
    }

    switch (t.tag) {
      case TypeTag.Array:
        helper((t as ArrayType).childType);
        break;
      case TypeTag.Tuple:
        (t as TupleType).fields.forEach((field) => helper(field.type));
        break;
      case TypeTag.Struct:
        (t as StructType).fields.forEach((field) => helper(field.type));
        break;
      case TypeTag.Enum:
        (t as EnumType).variants.forEach((variant) => {
          variant.fields?.forEach((param) => helper(param.type));
        });
        break;
      case TypeTag.Union:
        (t as UnionType).fields.forEach((field) => helper(field.type));
        break;
      case TypeTag.Ptr:
        helper((t as PtrType).childType);
        break;
      default:
        break; // For other types, do nothing
    }
  }

  helper(type);
  return result;
}

/**
 * Check if a type contains unknown values.
 */
export function typeRequiresInference(type?: Type): boolean {
  if (!type) {
    return false;
  }

  // Recursively check for unknown values in complex types
  switch (type.tag) {
    case TypeTag.Array: {
      const arrayType = type as ArrayType;
      return (
        isUnknownValue(arrayType.length) ||
        typeRequiresInference(arrayType.childType)
      );
    }
    // NOTE: Let's only support ArrayType for now.
    /*
    case TypeTag.Tuple:
      return (type as TupleType).elements.some((element) =>
        typeRequiresInference(element.type)
      );
    case TypeTag.Struct:
      return (type as StructType).elements.some((element) =>
        typeRequiresInference(element.type)
      );
    case TypeTag.Enum:
      return (type as EnumType).variants.some((variant) =>
        variant.elements?.some((param) => typeRequiresInference(param.type))
      );
    case TypeTag.Union:
      return (type as UnionType).elements.some((element) =>
        typeRequiresInference(element.type)
      );
    case TypeTag.Function: {
      const functionType = type as FunctionType;
      return (
        functionType.parameters.some((param) =>
          typeRequiresInference(param.type)
        ) ||
        typeRequiresInference(functionType.return.type) ||
        functionType.forallParameters.some((param) =>
          typeRequiresInference(param.type)
        ) ||
        (functionType.variadicParameter
          ? typeRequiresInference(functionType.variadicParameter.type)
          : false)
      );
    }
    case TypeTag.Ptr:
      return typeRequiresInference((type as PtrType).type);
    case TypeTag.Ptr:
      return typeRequiresInference((type as PtrType).type);
    case TypeTag.Gc:
      return typeRequiresInference((type as RefType).type);
    case TypeTag.MutRef:
      return typeRequiresInference((type as MutRefType).type);
    */
    case TypeTag.SomeType:
      // SomeType represents unknown/inferable types
      return true;
    case TypeTag.Trait: {
      // For FnTraitType, check if the function signature requires inference
      const traitType = type as TraitType;
      if (traitType.isFn) {
        return typeRequiresInference(traitType.isFn.callType);
      }
      return false;
    }
    default:
      return false; // For other types, no unknown values are present
  }
}

/**
 * Convert comptime types to their runtime equivalents.
 * If expr is provided and a conversion happens, sets expr.$.convertedRuntimeType
 * NOTE: We only convert scalar comptime types here (comptime_int, comptime_float, comptime_str), like Zig.
 */
export function convertComptimeTypeToRuntimeType({
  type,
  expectedType,
  expr,
  env,
}: {
  type: Type;
  expectedType?: Type;
  expr?: Expr;
  env: Environment;
}): Type {
  let convertedType: Type | undefined;

  if (isComptimeIntType(type)) {
    convertedType = createI32Type();
  } else if (isComptimeFloatType(type)) {
    convertedType = createF64Type();
  } else if (isComptimeStringType(type)) {
    if (expectedType) {
      // Check if it's
      // - *(u8)
      // - *(char)
      if (
        isPtrType(expectedType) && // *(u8) or *(char)
        (isU8Type(expectedType.childType) || isCharType(expectedType.childType))
      ) {
        convertedType = expectedType;
      }
    }

    if (!convertedType) {
      // Default: Convert the comptime_str to str from prelude
      convertedType = createStrType(env);
    }
  } else {
    // No change
    return type;
  }

  // If we have a converted type and an expr, store the conversion info
  if (convertedType && expr?.$) {
    expr.$.convertedRuntimeType = convertedType;
  }

  return convertedType ?? type;
}

/**
 * Get the bit size of an integer type.
 */
export function getIntegerTypeBits(type: Type): number {
  switch (type.tag) {
    case TypeTag.U8:
    case TypeTag.I8:
      return 8;
    case TypeTag.U16:
    case TypeTag.I16:
      return 16;
    case TypeTag.U32:
    case TypeTag.I32:
      return 32;
    case TypeTag.U64:
    case TypeTag.I64:
      return 64;
    case TypeTag.Usize:
    case TypeTag.Isize:
      return getTargetPointerSizeBits(); // Platform dependent, use configured pointer size
    default:
      throw new Error(`Not an integer type: ${type.tag}`);
  }
}

/**
 * Get the value range of an integer type.
 */
export function getIntegerTypeRange(type: Type): { min: bigint; max: bigint } {
  const bits = getIntegerTypeBits(type);

  if (
    type.tag === TypeTag.U8 ||
    type.tag === TypeTag.U16 ||
    type.tag === TypeTag.U32 ||
    type.tag === TypeTag.U64 ||
    type.tag === TypeTag.Usize
  ) {
    // Unsigned types
    return {
      min: BigInt(0),
      max: (BigInt(1) << BigInt(bits)) - BigInt(1),
    };
  } else {
    // Signed types
    const maxPositive = (BigInt(1) << BigInt(bits - 1)) - BigInt(1);
    return {
      min: -(BigInt(1) << BigInt(bits - 1)),
      max: maxPositive,
    };
  }
}

/**
 * Check if comptime_int can be cast to a target type.
 */
export function canComptimeIntCastTo(targetType: Type): boolean {
  return isIntegerType(targetType) || isComptimeIntType(targetType);
}

/**
 * Check if comptime_float can be cast to a target type.
 */
export function canComptimeFloatCastTo(targetType: Type): boolean {
  return isFloatType(targetType) || isComptimeFloatType(targetType);
}

/**
 * Convert a function parameter to string representation.
 */
export function functionParameterToString(
  parameter: FunctionParameter,
  visited: Set<string> = new Set()
): string {
  let label = parameter.label;

  if (parameter.isQuote) {
    label = `quote(${label})`;
  } else if (parameter.isCompileTimeOnly) {
    label = `comptime(${label})`;
  }

  const typeStr = typeToString(parameter.type, visited);

  const defaultValueStr = parameter.exprs.defaultValueExpr
    ? exprToString(parameter.exprs.defaultValueExpr)
    : "";

  if (label === "") {
    return typeStr;
  }

  if (defaultValueStr) {
    return `(${label} : ${typeStr}) ?= ${defaultValueStr}`;
  } else {
    // typeStr is always defined here
    return `${label} : ${typeStr}`;
  }
}
/**
 * Convert a tuple element to string representation.
 * NOTE: Don't use element.exprs
 */
export function tupleFieldToString(
  element: TypeField,
  visited: Set<string> = new Set()
): string {
  let label = element.label;
  if (stringIsOperator(label)) {
    label = `(${label})`;
  }

  const defaultValueStr = element.defaultValue
    ? valueToString(element.defaultValue)
    : "";

  const assignedValueStr = element.assignedValue
    ? valueToString(element.assignedValue)
    : "";

  if (defaultValueStr) {
    return `(${label}: ${typeToString(element.type, visited)}) ?= ${defaultValueStr}`;
  }

  if (assignedValueStr) {
    return `(${label}: ${typeToString(element.type, visited)}) = ${assignedValueStr}`;
  }

  return `${label}: ${typeToString(element.type, visited)}`;
}

/**
 * Convert a named type field to string representation.
 */
function namedTypeFieldToString(
  element: TypeField,
  visited: Set<string> = new Set()
): string {
  let label = element.label;
  if (stringIsOperator(label)) {
    label = `(${label})`;
  }

  const defaultValueStr = element.defaultValue
    ? valueToString(element.defaultValue)
    : "";

  const assignedValueStr = element.assignedValue
    ? valueToString(element.assignedValue)
    : "";

  if (defaultValueStr) {
    return `(${label} : ${typeToString(element.type, visited)}) ?= ${defaultValueStr}`;
  }

  if (assignedValueStr) {
    return `(${label} : ${typeToString(element.type, visited)}) = ${assignedValueStr}`;
  }

  return `${label} : ${typeToString(element.type, visited)}`;
}

function functionTypeToString(
  func: FunctionType,
  visited: Set<string> = new Set()
): string {
  const params = func.parameters
    .map((param) => functionParameterToString(param, visited))
    .join(", ");

  const typeParams =
    func.forallParameters.length > 0
      ? `forall(${func.forallParameters
          .map((param) => functionParameterToString(param, visited))
          .join(", ")})`
      : "";

  let variadicParam = "";
  if (func.variadicParameter) {
    if (func.variadicParameter.label === "...") {
      variadicParam = "...";
    } else if (func.variadicParameter.isQuote) {
      variadicParam = `...(quote(${func.variadicParameter.label}))`;
    } else if (func.variadicParameter.isCompileTimeOnly) {
      variadicParam = `...(comptime(${func.variadicParameter.label}))`;
    } else {
      variadicParam = `...(${func.variadicParameter.label})`;
    }
  }

  const returnTypeString = typeToString(func.return.type, visited);
  let returnString = returnTypeString;
  if (func.return.isUnquote) {
    if (func.return.label) {
      returnString = `(unquote(${func.return.label}) : ${returnTypeString})`;
    } else {
      returnString = `unquote(${returnTypeString})`;
    }
  } else if (func.return.isCompileTimeOnly) {
    if (func.return.label) {
      returnString = `(comptime(${func.return.label}) : ${returnTypeString})`;
    } else {
      returnString = `comptime(${returnTypeString})`;
    }
  }

  const paramsString = [typeParams, params, variadicParam]
    .filter((x) => !!x)
    .join(", ");
  const from = func.SelfType?.typeName;
  const fnKind = func.isControl ? "ctl" : "fn";
  return `${from ? `(${from}) ` : ""}${fnKind}(${paramsString}) -> ${returnString}`;
}

/**
 * Convert a Type object to a human-readable string representation.
 */
export function typeToString(
  type: Type,
  visited: Set<string> = new Set()
): string {
  // Check for circular references using type ID
  if (type.id && visited.has(type.id)) {
    // Return a placeholder for circular references
    return type.typeName || `<circular:${type.tag}>`;
  }

  // Add current type to visited set if it has an ID
  if (type.id) {
    visited.add(type.id);
  }

  try {
    return typeToStringInternal(type, visited);
  } finally {
    // Remove from visited set when done (for proper cleanup)
    if (type.id) {
      visited.delete(type.id);
    }
  }
}

/**
 * Internal implementation of typeToString with cycle detection
 */
function typeToStringInternal(type: Type, visited: Set<string>): string {
  if (!type) {
    return "unknown";
  }

  /*
  if (type.typeName) {
    if (
      isEnumType(type) &&
      (type.requiredVariantNames ?? type.selectedVariantName)
    ) {
      return `${type.typeName} (${
        type.requiredVariantNames
          ? `${type.requiredVariantNames.map((name) => `.${name}`).join(" | ")} required`
          : `.${type.selectedVariantName} selected`
      })`;
    }

    return type.typeName;
  }
  */

  switch (type.tag) {
    // Primitive types
    case TypeTag.Unit: {
      return "unit";
    }
    case TypeTag.Bool: {
      return "bool";
    }
    /*
    case TypeTag.Char: {
      return "char";
    }
    */
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
    case TypeTag.Type: {
      if ("level" in type && typeof type.level === "number" && type.level > 0) {
        return `Type(${type.level})`;
      }
      return "Type";
    }

    // Complex types
    case TypeTag.Array: {
      return `[${typeToString((type as ArrayType).childType, visited)}; ${valueToString(
        (type as ArrayType).length
      )}]`;
    }

    case TypeTag.Tuple: {
      if ((type as TupleType).fields.length === 0) {
        return "()";
      }
      return `(${(type as TupleType).fields
        .map((element) => tupleFieldToString(element, visited))
        .join(", ")}${(type as TupleType).fields.length === 1 ? "," : ""})`;
    }

    case TypeTag.Struct: {
      const structType = type as StructType;
      if (structType.typeName) {
        return structType.typeName;
      }

      if (structType.isSourceNamespace) {
        return `struct(${structType.fields.map((field) => namedTypeFieldToString(field, visited)).join(", ")})`;
      }

      return `${structType.isAtomicRc ? "atomic " : ""}${structType.isReferenceSemantics ? "object" : structType.isNewtype ? "newtype" : "struct"}(${structType.fields.map((field) => tupleFieldToString(field, visited)).join(", ")})`;
    }

    case TypeTag.Enum: {
      const enumType = type as EnumType;

      if (enumType.typeName) {
        const enumName = enumType.typeName;

        if (enumType.requiredVariantNames ?? enumType.selectedVariantName) {
          return `${enumName} (${
            enumType.requiredVariantNames
              ? `${enumType.requiredVariantNames.map((name) => `.${name}`).join(" | ")} required`
              : `.${enumType.selectedVariantName} selected`
          })`;
        }

        return enumName;
      }

      return `${enumType.typeName ? `(${enumType.typeName}) ` : ""}enum(${enumType.variants
        .map((variant) => {
          return `${variant.name}${
            variant.fields
              ? `(${variant.fields.map((field) => tupleFieldToString(field, visited)).join(", ")})`
              : ""
          }`;
        })
        .join(", ")})`;
    }

    case TypeTag.Union: {
      const unionType = type as UnionType;
      if (unionType.typeName) {
        return unionType.typeName;
      }

      const fields = unionType.fields;
      return `${unionType.typeName ? `(${unionType.typeName}) ` : ""}${
        unionType.typeName ? "union" : unionType.id
      }(${fields.map((field) => tupleFieldToString(field, visited)).join(", ")})`;
    }

    case TypeTag.Trait: {
      const traitType = type as TraitType;

      // Check if it's a FnTraitType (closure/function trait)
      if (isFnTraitType(traitType)) {
        // Display as Fn(...) -> ReturnType
        return `Fn${functionTypeToString(traitType.isFn.callType, visited).slice(2)}`; // Remove "fn" prefix and add "Fn"
      }

      // Check if it's a FutureTraitType
      if (isFutureTraitType(traitType)) {
        const parts = [typeToString(traitType.isFuture.outputType, visited)];
        if (traitType.isFuture.effect) {
          parts.push(typeToString(traitType.isFuture.effect.type, visited));
        }
        return `Future(${parts.join(", ")})`;
      }

      let traitTypeString: string;
      if (traitType.typeName) {
        traitTypeString = traitType.typeName;
      } else {
        traitTypeString = `${
          traitType.typeName ? `(${traitType.typeName}) ` : ""
        }trait(${traitType.fields.map((field) => namedTypeFieldToString(field, visited)).join(", ")})`;
      }

      if (traitType.receiverType) {
        traitTypeString = `(${typeToString(traitType.receiverType, visited)} <: ${traitTypeString})`;
      }

      return traitTypeString;
    }

    case TypeTag.Function: {
      const func = type as FunctionType;
      if (func.typeName) {
        return func.typeName;
      }
      return functionTypeToString(func, visited);
    }

    case TypeTag.SomeType: {
      const someType = type as SomeType;
      // If typeName is available, use it
      if (someType.typeName) {
        return someType.typeName;
      }
      if (someType.functionApplication) {
        return exprToString(someType.functionApplication);
      }
      // Display as Impl(Trait1, Trait2, ..., !NegTrait1, !NegTrait2, ...) with the required and negative modules
      const allTraitStrings: string[] = [];
      if (someType.requiredTraits && someType.requiredTraits.length > 0) {
        for (const mt of someType.requiredTraits) {
          allTraitStrings.push(typeToString(mt.traitType, visited));
        }
      }
      if (someType.negativeTraits && someType.negativeTraits.length > 0) {
        for (const mt of someType.negativeTraits) {
          allTraitStrings.push(`!(${typeToString(mt.traitType, visited)})`);
        }
      }
      if (allTraitStrings.length > 0) {
        return `${someType.name || "Impl"}(${allTraitStrings.join(", ")})`;
      }
      return someType.name || "Impl()";
    }

    case TypeTag.Ptr: {
      const ptrType = type as PtrType;
      return `*(${typeToString(ptrType.childType, visited)})`;
    }

    case TypeTag.Iso: {
      const isoType = type as IsoType;
      return `Iso(${typeToString(isoType.childType, visited)})`;
    }

    case TypeTag.Expr: {
      return "Expr";
    }

    case TypeTag.ComptimeList: {
      return `ComptimeList(${typeToString((type as ComptimeListType).childType)})`;
    }

    case TypeTag.Dyn: {
      const dynType = type as DynType;
      // If typeName is available, use it
      if (dynType.typeName) {
        return dynType.typeName;
      }
      // Display as Dyn(Trait1, Trait2, ..., !NegTrait1, !NegTrait2, ...) with the required and negative modules
      const allTraitStrings: string[] = [];
      for (const { traitType } of dynType.requiredTraits) {
        allTraitStrings.push(typeToString(traitType, visited));
      }
      if (dynType.negativeTraits && dynType.negativeTraits.length > 0) {
        for (const { traitType } of dynType.negativeTraits) {
          allTraitStrings.push(`!(${typeToString(traitType, visited)})`);
        }
      }
      return `Dyn(${allTraitStrings /*.slice(1)*/
        .join(", ")})`;
    }

    case TypeTag.TypeApplication: {
      const appType = type as TypeApplicationType;
      const constructorStr = typeToString(appType.constructor, visited);
      const argsStr = appType.args
        .map((arg) => typeToString(arg, visited))
        .join(", ");
      return `${constructorStr}(${argsStr})`;
    }

    default: {
      return `${type.tag}`;
    }
  }
}

/**
 * Get the target pointer size in bits. Can be customized for different architectures.
 * Default is 64 bits (8 bytes) for modern 64-bit systems.
 */
let targetPointerSizeBits = 64;

/**
 * Set the target pointer size in bits.
 */
export function setTargetPointerSize(bits: number): void {
  if (bits <= 0 || bits % 8 !== 0) {
    throw new Error(
      `Invalid pointer size: ${bits} bits. Must be positive and divisible by 8.`
    );
  }
  targetPointerSizeBits = bits;
}

/**
 * Get the target pointer size in bits.
 */
export function getTargetPointerSizeBits(): number {
  return targetPointerSizeBits;
}

/**
 * Get the target pointer size in bytes.
 */
export function getTargetPointerSizeBytes(): number {
  return targetPointerSizeBits / 8;
}

function getArrayTypeSize(type: ArrayType): number | null {
  const elementSize = getSizeOfType(type.childType);
  if (elementSize === null) {
    return null; // If the element size is unknown, return null
  }
  if (elementSize === -1) {
    return -1; // If the element size is dynamic, return -1
  }

  const lengthValue = type.length;
  if (isNumberValue(lengthValue)) {
    const length = BigInt(lengthValue.value);
    if (length < 0) {
      throw new Error("Array length cannot be negative");
    }
    return Number(length) * elementSize; // Return total size in bits
  }
  // If the length is not a number, return null to represent an unknown size
  return null;
}

function getTupleTypeSize(type: TupleType): number | null {
  let offsetBytes = 0;
  let maxAlignBytes = 1;

  for (const field of type.fields) {
    const fieldSizeBits = getSizeOfType(field.type);
    if (fieldSizeBits === null) {
      return null;
    }
    if (fieldSizeBits === -1) {
      return -1;
    }
    const fieldAlignBytes = getAlignmentOfType(field.type);
    if (fieldAlignBytes === null) {
      return null;
    }

    const fieldSizeBytes = Math.ceil(fieldSizeBits / 8);
    // Align current offset to field's alignment requirement
    offsetBytes = Math.ceil(offsetBytes / fieldAlignBytes) * fieldAlignBytes;
    offsetBytes += fieldSizeBytes;
    maxAlignBytes = Math.max(maxAlignBytes, fieldAlignBytes);
  }

  // Pad total size to struct alignment
  offsetBytes = Math.ceil(offsetBytes / maxAlignBytes) * maxAlignBytes;
  return offsetBytes * 8; // Return total size in bits
}

function getStructTypeSize(type: StructType): number | null {
  let offsetBytes = 0;
  let maxAlignBytes = 1;

  for (const field of type.fields) {
    const fieldSizeBits = getSizeOfType(field.type);
    if (fieldSizeBits === null) {
      return null;
    }
    if (fieldSizeBits === -1) {
      return -1;
    }
    const fieldAlignBytes = getAlignmentOfType(field.type);
    if (fieldAlignBytes === null) {
      return null;
    }

    const fieldSizeBytes = Math.ceil(fieldSizeBits / 8);
    // Align current offset to field's alignment requirement
    offsetBytes = Math.ceil(offsetBytes / fieldAlignBytes) * fieldAlignBytes;
    offsetBytes += fieldSizeBytes;
    maxAlignBytes = Math.max(maxAlignBytes, fieldAlignBytes);
  }

  // Pad total size to struct alignment
  offsetBytes = Math.ceil(offsetBytes / maxAlignBytes) * maxAlignBytes;
  return offsetBytes * 8; // Return total size in bits
}

function getEnumTypeSize(type: EnumType): number | null {
  let maxSize = 0;
  let maxAlignment = 0;

  for (const variant of type.variants) {
    let variantOffsetBytes = 0;
    let variantMaxAlignBytes = 1;
    if (variant.fields) {
      for (const field of variant.fields) {
        const fieldSizeBits = getSizeOfType(field.type);
        if (fieldSizeBits === null) {
          return null;
        }
        if (fieldSizeBits === -1) {
          return -1;
        }
        const fieldAlignBytes = getAlignmentOfType(field.type);
        if (fieldAlignBytes === null) {
          return null;
        }

        const fieldSizeBytes = Math.ceil(fieldSizeBits / 8);
        // Align current offset to field's alignment requirement
        variantOffsetBytes =
          Math.ceil(variantOffsetBytes / fieldAlignBytes) * fieldAlignBytes;
        variantOffsetBytes += fieldSizeBytes;
        variantMaxAlignBytes = Math.max(variantMaxAlignBytes, fieldAlignBytes);

        // Track maximum alignment requirement across all variants
        maxAlignment = Math.max(maxAlignment, fieldAlignBytes * 8); // Convert bytes to bits
      }
    }
    // Pad variant size to its own alignment
    variantOffsetBytes =
      Math.ceil(variantOffsetBytes / variantMaxAlignBytes) *
      variantMaxAlignBytes;
    const variantSizeBits = variantOffsetBytes * 8;
    maxSize = Math.max(maxSize, variantSizeBits); // Track the maximum size of variants
  }

  const tagSize = Math.ceil(Math.ceil(Math.log2(type.variants.length)) / 8) * 8; // Size of the tag in bits
  const tagAlignment = 32; // Tag is typically int (4 bytes = 32 bits)

  // The union must be aligned to its largest member's alignment
  const dataAlignment = Math.max(maxAlignment, 8); // At least 1 byte alignment

  // Calculate total size with proper alignment:
  // 1. Tag takes tagSize bits
  // 2. Padding after tag to align data to dataAlignment
  // 3. Data takes maxSize bits
  // 4. Final struct alignment to the largest alignment requirement

  const structAlignment = Math.max(tagAlignment, dataAlignment);

  // Align tag end to data alignment
  const tagSizeBytes = tagSize / 8;
  const dataAlignmentBytes = dataAlignment / 8;
  const paddingAfterTag =
    ((dataAlignmentBytes - (tagSizeBytes % dataAlignmentBytes)) %
      dataAlignmentBytes) *
    8;

  const totalBeforeAlignment = tagSize + paddingAfterTag + maxSize;

  // Align total size to struct alignment
  const totalBytes = totalBeforeAlignment / 8;
  const structAlignmentBytes = structAlignment / 8;
  const finalPadding =
    ((structAlignmentBytes - (totalBytes % structAlignmentBytes)) %
      structAlignmentBytes) *
    8;

  return totalBeforeAlignment + finalPadding; // Return total size in bits
}

function getUnionType(type: UnionType): number | null {
  let maxSize = 0;
  for (const field of type.fields) {
    const fieldSize = getSizeOfType(field.type);
    if (fieldSize === null) {
      return null; // If any field size is unknown, return null
    }
    if (fieldSize === -1) {
      return -1; // If any field size is dynamic, return -1
    }
    maxSize = Math.max(maxSize, fieldSize); // Find the maximum size among elements
  }
  return maxSize; // Return the maximum size in bits
}

/**
 * Get the alignment of a type in bytes.
 * null = unknown/indeterminate alignment.
 * @param type
 */
export function getAlignmentOfType(type: Type): number | null {
  if (isSomeType(type)) {
    // SomeType is a placeholder, so it has unknown alignment
    return null;
  }

  if (
    isUnitType(type) || // Unit type has no alignment requirement
    isTypeHierarchyType(type) ||
    isComptimeIntType(type) ||
    isComptimeFloatType(type) ||
    isComptimeStringType(type) ||
    isComptimeListType(type) ||
    isSourceNamespaceType(type) ||
    isTraitType(type) ||
    isExprType(type) // ^ disallowed in the runtime
  ) {
    return 1; // Minimal alignment for compile-time only types
  } else if (isBooleanType(type)) {
    return 1; // Bool is 1 byte aligned
  } else if (isUsizeType(type) || isIsizeType(type)) {
    return getTargetPointerSizeBytes(); // Pointer-sized integers are pointer-aligned
  } else if (isU8Type(type) || isI8Type(type)) {
    return 1; // 1 byte aligned
  } else if (isU16Type(type) || isI16Type(type)) {
    return 2; // 2 byte aligned
  } else if (isU32Type(type) || isI32Type(type)) {
    return 4; // 4 byte aligned
  } else if (isU64Type(type) || isI64Type(type)) {
    return 8; // 8 byte aligned
  } else if (isF32Type(type)) {
    return 4; // 4 byte aligned
  } else if (isF64Type(type)) {
    return 8; // 8 byte aligned
  } else if (isArrayType(type)) {
    return getAlignmentOfType(type.childType); // Array alignment is element alignment
  } else if (isTupleType(type)) {
    // Tuple alignment is the maximum alignment of its fields
    let maxAlign = 1;
    for (const field of type.fields) {
      const fieldAlign = getAlignmentOfType(field.type);
      if (fieldAlign === null) {
        return null;
      }
      maxAlign = Math.max(maxAlign, fieldAlign);
    }
    return maxAlign;
  } else if (isStructType(type)) {
    // Check if it's reference semantics - if so, return pointer alignment
    if (type.isReferenceSemantics) {
      return getTargetPointerSizeBytes();
    }
    if (type.isNewtype) {
      return getAlignmentOfType(type.fields[0]!.type);
    }
    // Struct alignment is the maximum alignment of its fields
    let maxAlign = 1;
    for (const field of type.fields) {
      const fieldAlign = getAlignmentOfType(field.type);
      if (fieldAlign === null) {
        return null;
      }
      maxAlign = Math.max(maxAlign, fieldAlign);
    }
    return maxAlign;
  } else if (isEnumType(type)) {
    // A reference-semantics enum (`ref(enum(…))`) is a heap RC handle — a
    // pointer — so it is pointer-aligned, exactly like the ref-struct branch
    // above. Without this short-circuit the variant-field walk recurses forever
    // on a recursive ref-enum whose variant field is typed `Self` (no `Box`).
    if (type.isReferenceSemantics) {
      return getTargetPointerSizeBytes();
    }
    // Enum alignment is the maximum alignment of its variants
    let maxAlign = 1;
    for (const variant of type.variants) {
      if (variant.fields) {
        for (const field of variant.fields) {
          const fieldAlign = getAlignmentOfType(field.type);
          if (fieldAlign === null) {
            return null;
          }
          maxAlign = Math.max(maxAlign, fieldAlign);
        }
      }
    }
    return maxAlign;
  } else if (isUnionType(type)) {
    // Union alignment is the maximum alignment of its fields
    let maxAlign = 1;
    for (const field of type.fields) {
      const fieldAlign = getAlignmentOfType(field.type);
      if (fieldAlign === null) {
        return null;
      }
      maxAlign = Math.max(maxAlign, fieldAlign);
    }
    return maxAlign;
  } else if (isFunctionType(type)) {
    return getTargetPointerSizeBytes(); // Functions are treated as pointers, so pointer-aligned
  } else if (isPtrType(type)) {
    return getTargetPointerSizeBytes(); // Pointer and reference types are pointer-aligned
  }

  return null;
}

/**
 *
 *  Get the size of a type in bits.
 *  null = unknown/indeterminate size.
 *  -1   = dynamic/runtime-determined size.
 *  0    = zero size or no runtime size.
 * @param type
 */
export function getSizeOfType(type: Type): number | null {
  if (isSomeType(type)) {
    // SomeType is a placeholder, so it has unknown size
    return null;
  }

  if (
    isUnitType(type) || // Unit type has no size
    isTypeHierarchyType(type) ||
    isComptimeIntType(type) ||
    isComptimeFloatType(type) ||
    isComptimeStringType(type) ||
    isComptimeListType(type) ||
    isSourceNamespaceType(type) ||
    isTraitType(type) ||
    isExprType(type) // ^ disallowed in the runtime
  ) {
    return 0;
  } else if (isBooleanType(type)) {
    return 8; // Assuming boolean is represented as 1 byte (8 bits)
  } else if (isUsizeType(type) || isIsizeType(type)) {
    return getTargetPointerSizeBits(); // Pointer size (usually 64 bits)
  } else if (isU8Type(type) || isI8Type(type)) {
    return 8; // 1 byte (8 bits)
  } else if (isU16Type(type) || isI16Type(type)) {
    return 16; // 2 bytes (16 bits)
  } else if (isU32Type(type) || isI32Type(type)) {
    return 32; // 4 bytes (32 bits)
  } else if (isU64Type(type) || isI64Type(type)) {
    return 64; // 8 bytes (64 bits)
  } else if (isF32Type(type)) {
    return 32; // 4 bytes (32 bits)
  } else if (isF64Type(type)) {
    return 64; // 8 bytes (64 bits)
  } else if (isArrayType(type)) {
    return getArrayTypeSize(type);
  } else if (isTupleType(type)) {
    return getTupleTypeSize(type);
  } else if (isStructType(type)) {
    // Check if it's reference semantics - if so, return pointer size
    if (type.isReferenceSemantics) {
      return getTargetPointerSizeBits();
    }
    if (type.isNewtype) {
      return getSizeOfType(type.fields[0]!.type);
    }
    return getStructTypeSize(type);
  } else if (isEnumType(type)) {
    // A reference-semantics enum (`ref(enum(…))` / `atomic(ref(enum(…)))`) is a
    // heap RC handle — a pointer — so its size is the pointer size, exactly like
    // a reference-semantics struct above. Without this short-circuit,
    // `getEnumTypeSize` walks the variant field types inline, and a recursive
    // ref-enum (a variant field typed `Self`, with no `Box`) recurses into
    // itself forever. (Value enums break the same recursion via `Box(Self)`,
    // whose deref is a pointer.)
    if (type.isReferenceSemantics) {
      return getTargetPointerSizeBits();
    }
    return getEnumTypeSize(type);
  } else if (isUnionType(type)) {
    return getUnionType(type);
  } else if (isFunctionType(type)) {
    return getTargetPointerSizeBits(); // Functions are treated as pointers, so return pointer size
  } else if (isPtrType(type)) {
    return getTargetPointerSizeBits(); // Pointer and reference types have pointer size
  }

  return null;
}

export function prohibitVoidType(type: Type, token: Token): void {
  if (isVoidType(type)) {
    throw formatErrorMessages([
      {
        token,
        errorMessage: `Cannot use 'void' type here.
Please consider use 'unit' type instead.
`,
      },
    ]);
  }
}

/**
 * Check if a object type could potentially form cycles.
 * This is used to determine which object types need GC tracking.
 *
 * A object can form cycles if:
 * 1. It contains a direct or indirect reference to itself
 * 2. It references other object types that could reference back to it
 *
 * This uses a depth-first search with cycle detection to avoid infinite recursion.
 *
 * @param type The type to check
 * @param visitedTypes Internal tracking of visited types
 * @param env Environment for trait checking (used to check if SomeType implements Acyclic)
 */
/**
 * Extract the element type a container holds behind its heap buffer field — the
 * pointee `E` of an `Option(*(E))` (`?*(E)`) field, the idiom every RC-capable std
 * container uses (`ArrayList._ptr : ?*(T)`, `HashMap.data : ?*(Bucket(K,V))`). A
 * bare `*(E)` field is intentionally NOT matched: it is treated as a non-owning raw
 * pointer that does not participate in ARC cycles, matching the field walk's existing
 * `isPtrType → false` behaviour. Used to see through a container to its elements both
 * for cycle detection and for the Acyclic auto-derive.
 */
export function bufferElementType(fieldType: Type): Type | undefined {
  if (isEnumType(fieldType)) {
    for (const variant of fieldType.variants) {
      for (const f of variant.fields ?? []) {
        if (isPtrType(f.type)) {
          return f.type.childType;
        }
      }
    }
  }
  return undefined;
}

export function canTypeFormRcCycle(
  type: Type,
  visitedTypes: Set<string>,
  env: Environment
): boolean {
  const isRefEnumRoot = isEnumType(type) && type.isReferenceSemantics;
  if (!isReferenceStructType(type) && !isRefEnumRoot) {
    return false; // Only reference-semantics structs/enums can form RC cycles
  }

  if (typeImplementsAcyclic(type, env)) {
    return false; // Type is marked as Acyclic, so it cannot form cycles
  }

  // Avoid infinite recursion by tracking visited types
  if (visitedTypes.has(type.id)) {
    return true; // We found a cycle back to a type we're already analyzing
  }

  visitedTypes.add(type.id);

  try {
    // Check every field — the struct's fields, or (for a ref-enum root) the
    // fields of all variants — for a reference path back to this type (a cycle).
    const fields = isStructType(type)
      ? type.fields
      : (type as EnumType).variants.flatMap((v) => v.fields ?? []);
    for (const field of fields) {
      if (typeCanFormCyclicRcReference(field.type, type, visitedTypes, env)) {
        return true;
      }
    }

    // Containers hold their elements behind a raw buffer pointer that the field
    // walk above treats as non-participating (raw pointers don't form ARC cycles).
    // Walk the buffer ELEMENT type so element cycles — `ArrayList(Self)`,
    // `HashMap(_, Self)`, the self-host `TypeValue.field_types : ArrayList(Self)`
    // shape — are detected.
    if (isStructType(type)) {
      for (const field of type.fields) {
        const elem = bufferElementType(field.type);
        if (elem && typeCanFormCyclicRcReference(elem, type, visitedTypes, env)) {
          return true;
        }
      }
    }

    return false;
  } finally {
    visitedTypes.delete(type.id); // Clean up for other paths
  }
}

/**
 * Helper function to check if a type can reference back to a cyclic object.
 * This traverses through containers (enums, arrays, etc.) to find object references.
 */
function typeCanFormCyclicRcReference(
  type: Type,
  originalRefStruct: StructType | EnumType,
  visitedTypes: Set<string>,
  env: Environment
): boolean {
  // If this type is the same as the original root (a ref-struct OR a ref-enum),
  // we have a direct self-reference. Compare by id so it covers ref-enum roots
  // too (must precede the enum visited-guard below, which would otherwise hide
  // the root's own id).
  if (
    (isStructType(type) || isEnumType(type)) &&
    type.id !== undefined &&
    type.id === originalRefStruct.id
  ) {
    return true;
  }

  // If this is a different RC object, check if it could form cycles with the original
  if (isStructType(type) && type.isReferenceSemantics) {
    return canTypeFormRcCycle(type, new Set(visitedTypes), env);
  }

  // Value-type structs (struct, newtype) are stored inline but can contain RC references
  // that form cycles. For example: Node :: atomic object(child: Option(Wrap(Self)))
  // where Wrap :: (fn(T) -> Type)(struct(inner: T)) — the struct Wrap(Node) contains
  // an RC pointer to Node, creating a cycle through the inline struct.
  if (isStructType(type) && !type.isReferenceSemantics) {
    for (const field of type.fields) {
      if (
        typeCanFormCyclicRcReference(
          field.type,
          originalRefStruct,
          visitedTypes,
          env
        )
      ) {
        return true;
      }
    }
  }

  // Check through enum variants. A reference-semantics enum (`ref(enum(…))`)
  // can be recursive via a `Self` variant field (no `Box` — a ref-enum value is
  // already a pointer); guard with `visitedTypes` (keyed by enum id) so we don't
  // descend into the same enum forever. Mirrors the struct guard in
  // `canTypeFormRcCycle`. Re-visiting an enum already on the path finds no NEW
  // route back to `originalRefStruct`, so returning false is sound.
  if (isEnumType(type)) {
    if (type.id && visitedTypes.has(type.id)) {
      return false;
    }
    if (type.id) {
      visitedTypes.add(type.id);
    }
    try {
      for (const variant of type.variants) {
        if (variant.fields) {
          for (const field of variant.fields) {
            if (
              typeCanFormCyclicRcReference(
                field.type,
                originalRefStruct,
                visitedTypes,
                env
              )
            ) {
              return true;
            }
          }
        }
      }
    } finally {
      if (type.id) {
        visitedTypes.delete(type.id);
      }
    }
  }

  if (isSomeType(type)) {
    // Check if SomeType implements Acyclic
    if (typeImplementsAcyclic(type, env)) {
      return false; // SomeType implements Acyclic, so it cannot form cycles
    }
    if (type.resolvedConcreteType) {
      return typeCanFormCyclicRcReference(
        type.resolvedConcreteType,
        originalRefStruct,
        visitedTypes,
        env
      );
    } else {
      return true; // Be conservative when no resolvedConcreteType
    }
  }

  // Check through arrays
  if (isArrayType(type)) {
    return typeCanFormCyclicRcReference(
      type.childType,
      originalRefStruct,
      visitedTypes,
      env
    );
  }

  // Check through tuples
  if (isTupleType(type)) {
    for (const field of type.fields) {
      if (
        typeCanFormCyclicRcReference(
          field.type,
          originalRefStruct,
          visitedTypes,
          env
        )
      ) {
        return true;
      }
    }
  }

  // Check through unions
  if (isUnionType(type)) {
    for (const field of type.fields) {
      if (
        typeCanFormCyclicRcReference(
          field.type,
          originalRefStruct,
          visitedTypes,
          env
        )
      ) {
        return true;
      }
    }
  }

  // Check through dynamic types - they can contain object types
  if (isDynType(type)) {
    return true;
  }

  // Ptr and MutRef are raw pointers/references - they don't participate in ARC
  // so they don't form reference counting cycles.
  if (isPtrType(type)) {
    return false;
  }

  // Other types (primitives, functions, etc.) cannot form cycles
  return false;
}

/**
 * Check if a type contains Self (directly or nested in compound types)
 * This is used for object-safety checks - methods returning types containing Self
 * cannot be called on Dyn values because different implementations return different types.
 *
 * @param type The type to check
 * @param selfType The SelfType to check against (from the function's type)
 * @returns true if the type contains Self anywhere in its structure
 */
export function typeContainsSelfTypeForDynamicDispatchCheck(
  type: Type,
  selfType: Type | undefined
): boolean {
  if (!selfType) {
    return false; // No Self type defined, so can't contain it
  }

  // Direct match: type IS Self
  if (type.id === selfType.id) {
    return true;
  }

  // Check compound types recursively
  if (isArrayType(type)) {
    return typeContainsSelfTypeForDynamicDispatchCheck(
      type.childType,
      selfType
    );
  }

  if (isPtrType(type)) {
    return typeContainsSelfTypeForDynamicDispatchCheck(
      type.childType,
      selfType
    );
  }

  if (isTupleType(type)) {
    return type.fields.some((elem) =>
      typeContainsSelfTypeForDynamicDispatchCheck(elem.type, selfType)
    );
  }

  if (isStructType(type)) {
    return type.fields.some((field) =>
      typeContainsSelfTypeForDynamicDispatchCheck(field.type, selfType)
    );
  }

  if (isUnionType(type)) {
    return type.fields.some((t) =>
      typeContainsSelfTypeForDynamicDispatchCheck(t.type, selfType)
    );
  }

  if (isEnumType(type)) {
    return type.variants.some((variant) =>
      variant.fields?.some((field) =>
        typeContainsSelfTypeForDynamicDispatchCheck(field.type, selfType)
      )
    );
  }

  if (isFunctionType(type)) {
    // Only check return type, not parameters
    // Parameters with Self are fine - they're passed as void* boxes
    // The problem is only with return types (caller doesn't know concrete type)
    return typeContainsSelfTypeForDynamicDispatchCheck(
      type.return.type,
      selfType
    );
  }

  // Other types (primitives, modules, etc.) don't contain Self
  return false;
}
