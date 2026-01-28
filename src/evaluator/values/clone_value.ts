import { FunctionValue } from "../../function-value";
import { TypeValue } from "../../type-value";
import { UnitValue } from "../../unit-value";
import {
  ArrayValue,
  BooleanValue,
  ComptListValue,
  ComptStringValue,
  EnumValue,
  ExprValue,
  ModuleValue,
  NumberValue,
  PtrValue,
  SliceValue,
  StructValue,
  TraitValue,
  TupleValue,
  UnknownValue,
  Value,
} from "../../value";
import { ValueTag } from "../../value-tag";

/**
 * Deep clone a Value, creating new array references for PtrValues and compound types.
 * This is used during CTFE checking phase to prevent pointer mutations from
 * affecting the original environment.
 *
 * @param preservePointerReferences - If true (default), pointers are NOT cloned to preserve
 *   reference semantics. This is important for compile-time assignments like `p :: &(val)`
 *   where p should still reference the original val. If false, pointers are cloned (used
 *   in CTFE checking phase to prevent mutations from affecting original environment).
 *
 * For PtrValue: behavior depends on preservePointerReferences flag
 * For compound types (struct, enum, tuple, array): recursively clones fields/elements
 * For primitive types: returns as-is (immutable)
 */
export function cloneValue(
  value: Value,
  preservePointerReferences: boolean = true
): Value {
  switch (value.tag) {
    // Primitive/immutable types - no cloning needed
    case ValueTag.ComptInt:
    case ValueTag.ComptFloat:
    case ValueTag.U8:
    case ValueTag.I8:
    case ValueTag.U16:
    case ValueTag.I16:
    case ValueTag.U32:
    case ValueTag.I32:
    case ValueTag.U64:
    case ValueTag.I64:
    case ValueTag.F32:
    case ValueTag.F64:
    case ValueTag.Usize:
    case ValueTag.Isize:
      return value as NumberValue;

    case ValueTag.Bool:
      return value as BooleanValue;

    case ValueTag.Unit:
      return value as UnitValue;

    case ValueTag.ComptString:
      return value as ComptStringValue;

    case ValueTag.Type:
      // TypeValue contains a Type which is immutable
      return value as TypeValue;

    case ValueTag.Function:
      // FunctionValue is complex but shouldn't contain mutable state we care about
      return value as FunctionValue;

    case ValueTag.Expr:
      // ExprValue contains an Expr which we don't need to deep clone for CTFE
      return value as ExprValue;

    case ValueTag.Unknown:
      // UnknownValue is a placeholder, no mutable state
      return value as UnknownValue;

    // Pointer type - behavior depends on preservePointerReferences flag
    // If preservePointerReferences=true (default): return as-is to preserve reference semantics
    // If preservePointerReferences=false: clone targetValue for CTFE checking isolation
    case ValueTag.Ptr: {
      if (preservePointerReferences) {
        // Don't clone pointers - preserve reference semantics
        return value as PtrValue;
      }
      // Clone for CTFE checking - this creates a new targetValue array
      // which breaks pointer-array relationships but isolates mutations
      const ptrValue = value as PtrValue;
      return {
        ...ptrValue,
        targetValue: [
          cloneValue(ptrValue.targetValue[0]!, preservePointerReferences),
        ],
        targetIndex: ptrValue.targetIndex,
      } as PtrValue;
    }

    // Compound types - need to recursively clone fields/elements
    case ValueTag.Tuple: {
      const tupleValue = value as TupleValue;
      return {
        ...tupleValue,
        fields: tupleValue.fields.map((f) =>
          cloneValue(f, preservePointerReferences)
        ),
      } as TupleValue;
    }

    case ValueTag.Struct: {
      const structValue = value as StructValue;
      return {
        ...structValue,
        fields: structValue.fields.map((f) =>
          cloneValue(f, preservePointerReferences)
        ),
      } as StructValue;
    }

    case ValueTag.Enum: {
      const enumValue = value as EnumValue;
      return {
        ...enumValue,
        fields: enumValue.fields.map((f) =>
          cloneValue(f, preservePointerReferences)
        ),
      } as EnumValue;
    }

    case ValueTag.Array: {
      const arrayValue = value as ArrayValue;
      return {
        ...arrayValue,
        elements: arrayValue.elements.map((e) =>
          cloneValue(e, preservePointerReferences)
        ),
      } as ArrayValue;
    }

    case ValueTag.Slice: {
      if (preservePointerReferences) {
        // Slices are fat pointers - don't clone the source array reference
        // This preserves reference semantics so mutations through the slice
        // affect the original array
        return value as SliceValue;
      }
      // For CTFE checking, clone the source array
      const sliceValue = value as SliceValue;
      const clonedArray = cloneValue(
        sliceValue.sourceArray[0],
        preservePointerReferences
      ) as ArrayValue;
      return {
        ...sliceValue,
        sourceArray: [clonedArray],
      } as SliceValue;
    }

    case ValueTag.ComptList: {
      const comptListValue = value as ComptListValue;
      return {
        ...comptListValue,
        elements: comptListValue.elements.map((e) =>
          cloneValue(e, preservePointerReferences)
        ),
      } as ComptListValue;
    }

    case ValueTag.Module: {
      const moduleValue = value as ModuleValue;
      return {
        ...moduleValue,
        fields: moduleValue.fields.map((f) =>
          f ? cloneValue(f, preservePointerReferences) : undefined
        ),
      } as ModuleValue;
    }

    case ValueTag.Trait: {
      const traitValue = value as TraitValue;
      return {
        ...traitValue,
        fields: traitValue.fields.map((f) =>
          f ? cloneValue(f, preservePointerReferences) : undefined
        ),
      } as TraitValue;
    }

    default: {
      // Exhaustive check - if we get here, we missed a case
      const _exhaustive: never = value;
      return _exhaustive;
    }
  }
}
