/**
 * Tests for `typeRepresentationContainsRawPtr` — the helper that drives
 * the flowability rule from `plans/archive/SLICE_FLOWABILITY.md`. Phase A.
 *
 * Verifies the predicate's leaves and recursion structure:
 * - `Ptr(T)` is the "yes" leaf (base case).
 * - Plain structs / tuples / unions / enums recurse into their fields.
 * - `Array(T, N)` recurses into the element type.
 * - `object` and `atomic(object(...))` types are "no" — they own their
 *   pointer's lifetime via Rc and can't dangle through a return slot.
 * - Function types are "no" — function pointers don't dangle the way
 *   a raw pointer into someone else's storage can.
 * - Primitives are "no".
 *
 * The unit tests build types via the type creators rather than
 * round-tripping through the evaluator — keeps them fast and focused
 * on the predicate's shape.
 */
import { describe, expect, test } from "bun:test";
import { createEmptyEnv } from "../env";
import {
  createArrayType,
  createBooleanType,
  createI32Type,
  createPtrType,
  createStructType,
  createU8Type,
  createUsizeType,
} from "../types/creators";
import { TypeTag } from "../types/tags";
import type {
  EnumType,
  TupleType,
  TypeField,
  UnionType,
} from "../types/definitions";
import type { Value } from "../value";
import { ValueTag } from "../value-tag";
import type { Type } from "../types/definitions";
import { typeRepresentationContainsRawPtr } from "../types/utils";

// Cheap stand-in for a comptime usize length. Array.length must be a
// Value, but the predicate doesn't inspect it; any Value will do.
const dummyLength: Value = {
  tag: ValueTag.Usize,
  type: createUsizeType(),
  value: 3n,
} as unknown as Value;

// Field constructor. `exprs` is required by the TypeField interface; the
// predicate under test never inspects it, so an empty object is fine.
function mkField(label: string, type: Type): TypeField {
  return {
    label,
    type,
    assignedValue: undefined,
    exprs: {} as never,
  };
}

describe("typeRepresentationContainsRawPtr", () => {
  test("primitive types are false", () => {
    expect(typeRepresentationContainsRawPtr(createI32Type())).toBe(false);
    expect(typeRepresentationContainsRawPtr(createU8Type())).toBe(false);
    expect(typeRepresentationContainsRawPtr(createUsizeType())).toBe(false);
    expect(typeRepresentationContainsRawPtr(createBooleanType())).toBe(false);
  });

  test("undefined is false (defensive)", () => {
    expect(typeRepresentationContainsRawPtr(undefined)).toBe(false);
  });

  test("Ptr(i32) is true (base case — raw pointer)", () => {
    expect(
      typeRepresentationContainsRawPtr(createPtrType(createI32Type()))
    ).toBe(true);
  });

  test("Array(i32, 3) is false — arrays inline value-typed elements", () => {
    const arr = createArrayType(createI32Type(), dummyLength);
    expect(typeRepresentationContainsRawPtr(arr)).toBe(false);
  });

  test("Array(Ptr(i32), 3) is true — array of pointers propagates", () => {
    const arr = createArrayType(createPtrType(createI32Type()), dummyLength);
    expect(typeRepresentationContainsRawPtr(arr)).toBe(true);
  });

  test("plain struct with no pointer fields is false", () => {
    const env = createEmptyEnv();
    const s = createStructType(env);
    s.fields = [mkField("x", createI32Type()), mkField("y", createI32Type())];
    expect(typeRepresentationContainsRawPtr(s)).toBe(false);
  });

  test("newtype struct wrapping a Ptr field is true", () => {
    const env = createEmptyEnv();
    const s = createStructType(env, false, true); // isNewtype = true
    s.fields = [mkField("bytes", createPtrType(createU8Type()))];
    expect(typeRepresentationContainsRawPtr(s)).toBe(true);
  });

  test("plain struct wrapping a Ptr field is true", () => {
    const env = createEmptyEnv();
    const s = createStructType(env);
    s.fields = [mkField("raw", createPtrType(createI32Type()))];
    expect(typeRepresentationContainsRawPtr(s)).toBe(true);
  });

  test("object (isReferenceSemantics) struct with Ptr field is FALSE — heap-owning", () => {
    // This is the critical case: ArrayList(T) is internally `object(_ptr : Option(*(T)), ...)`,
    // and HashMap is similar. They carry pointers but those pointers point at
    // heap storage that the object itself owns and drops; returning the object
    // value hands the ownership to the caller, no dangling.
    const env = createEmptyEnv();
    const s = createStructType(env, true /* isReferenceSemantics */);
    s.fields = [
      mkField("_ptr", createPtrType(createI32Type())),
      mkField("_len", createUsizeType()),
    ];
    expect(typeRepresentationContainsRawPtr(s)).toBe(false);
  });

  test("atomic object struct is FALSE — Arc-style heap-owning", () => {
    const env = createEmptyEnv();
    const s = createStructType(
      env,
      true /* isReferenceSemantics */,
      false,
      true /* isAtomicRc */
    );
    s.fields = [mkField("_ptr", createPtrType(createI32Type()))];
    expect(typeRepresentationContainsRawPtr(s)).toBe(false);
  });

  test("tuple with a Ptr field is true", () => {
    const tuple: TupleType = {
      id: "test_tuple_with_ptr",
      tag: TypeTag.Tuple,
      fields: [
        mkField("0", createI32Type()),
        mkField("1", createPtrType(createU8Type())),
      ],
      trait: undefined as never,
    } as unknown as TupleType;
    expect(typeRepresentationContainsRawPtr(tuple)).toBe(true);
  });

  test("tuple of primitives is false", () => {
    const tuple: TupleType = {
      id: "test_tuple_primitives",
      tag: TypeTag.Tuple,
      fields: [
        mkField("0", createI32Type()),
        mkField("1", createBooleanType()),
      ],
      trait: undefined as never,
    } as unknown as TupleType;
    expect(typeRepresentationContainsRawPtr(tuple)).toBe(false);
  });

  test("enum with a variant carrying a Ptr field is true (Option(*(u8)) shape)", () => {
    // Mimics Option(*(u8)) — Some(value : *(u8)) / None
    const enumType: EnumType = {
      id: "test_enum_option_ptr",
      tag: TypeTag.Enum,
      variants: [
        { name: "None", fields: undefined },
        {
          name: "Some",
          fields: [mkField("value", createPtrType(createU8Type()))],
        },
      ],
      trait: undefined as never,
      env: createEmptyEnv(),
    } as unknown as EnumType;
    expect(typeRepresentationContainsRawPtr(enumType)).toBe(true);
  });

  test("enum with only primitive variants is false", () => {
    const enumType: EnumType = {
      id: "test_enum_primitive_only",
      tag: TypeTag.Enum,
      variants: [
        { name: "A", fields: undefined },
        { name: "B", fields: [mkField("x", createI32Type())] },
      ],
      trait: undefined as never,
      env: createEmptyEnv(),
    } as unknown as EnumType;
    expect(typeRepresentationContainsRawPtr(enumType)).toBe(false);
  });

  test("union with a Ptr field is true", () => {
    const env = createEmptyEnv();
    const union: UnionType = {
      id: "test_union_with_ptr",
      tag: TypeTag.Union,
      fields: [
        mkField("a", createI32Type()),
        mkField("b", createPtrType(createU8Type())),
      ],
      trait: undefined as never,
      env,
    } as unknown as UnionType;
    expect(typeRepresentationContainsRawPtr(union)).toBe(true);
  });

  test("nested: struct wrapping a newtype with an inner Ptr is true", () => {
    // A user type wrapping a newtype over a raw pointer transitively
    // carries that raw pointer.
    const env = createEmptyEnv();
    const ptrNewtype = createStructType(env, false, true /* isNewtype */);
    ptrNewtype.fields = [mkField("bytes", createPtrType(createU8Type()))];
    const wrapper = createStructType(env);
    wrapper.fields = [mkField("s", ptrNewtype)];
    expect(typeRepresentationContainsRawPtr(wrapper)).toBe(true);
  });

  test("cyclic struct reference does not infinite-loop", () => {
    // Defensive: the helper tracks visited types via the checkedTypes
    // accumulator. A struct referencing itself (directly via a field)
    // must terminate instead of stack-overflowing.
    const env = createEmptyEnv();
    const s = createStructType(env);
    s.fields = [
      // Self-reference (structurally implausible by-value, but the
      // cycle guard must hold anyway).
      mkField("self_ref", s),
    ];
    // No raw pointer anywhere in the cycle — the guard terminates the
    // walk and the predicate reports false.
    expect(typeRepresentationContainsRawPtr(s)).toBe(false);
  });

  test("Dyn(Trait) is FALSE — RC-managed reference-semantics", () => {
    // Dyn(Trait) is a fat pointer (data + vtable) into Rc-managed
    // object storage. Returning a Dyn transfers / shares the Rc, so
    // the data stays alive — same reasoning as `isReferenceStructType`.
    const dynType = {
      id: "test_dyn",
      tag: TypeTag.Dyn,
      requiredTraits: [],
      negativeTraits: [],
    } as unknown as Type;
    expect(typeRepresentationContainsRawPtr(dynType)).toBe(false);
  });
});
