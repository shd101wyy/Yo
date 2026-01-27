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
 * For PtrValue: creates a new targetValue array with cloned content
 * For compound types (struct, enum, tuple, array): recursively clones fields/elements
 * For primitive types: returns as-is (immutable)
 */
export function cloneValue(value: Value): Value {
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

    // Pointer type - clone the targetValue array
    // Note: For pointers to array elements, this creates a new array
    // which may break pointer-array relationships in cloned environments.
    // This is acceptable for CTFE checking since we only need to prevent
    // mutations from affecting the original environment.
    case ValueTag.Ptr: {
      const ptrValue = value as PtrValue;
      return {
        ...ptrValue,
        targetValue: [cloneValue(ptrValue.targetValue[0]!)],
        targetIndex: ptrValue.targetIndex,
      } as PtrValue;
    }

    // Compound types - need to recursively clone fields/elements
    case ValueTag.Tuple: {
      const tupleValue = value as TupleValue;
      return {
        ...tupleValue,
        fields: tupleValue.fields.map(cloneValue),
      } as TupleValue;
    }

    case ValueTag.Struct: {
      const structValue = value as StructValue;
      return {
        ...structValue,
        fields: structValue.fields.map(cloneValue),
      } as StructValue;
    }

    case ValueTag.Enum: {
      const enumValue = value as EnumValue;
      return {
        ...enumValue,
        fields: enumValue.fields.map(cloneValue),
      } as EnumValue;
    }

    case ValueTag.Array: {
      const arrayValue = value as ArrayValue;
      return {
        ...arrayValue,
        elements: arrayValue.elements.map(cloneValue),
      } as ArrayValue;
    }

    case ValueTag.ComptList: {
      const comptListValue = value as ComptListValue;
      return {
        ...comptListValue,
        elements: comptListValue.elements.map(cloneValue),
      } as ComptListValue;
    }

    case ValueTag.Module: {
      const moduleValue = value as ModuleValue;
      return {
        ...moduleValue,
        fields: moduleValue.fields.map((f) => (f ? cloneValue(f) : undefined)),
      } as ModuleValue;
    }

    case ValueTag.Trait: {
      const traitValue = value as TraitValue;
      return {
        ...traitValue,
        fields: traitValue.fields.map((f) => (f ? cloneValue(f) : undefined)),
      } as TraitValue;
    }

    default: {
      // Exhaustive check - if we get here, we missed a case
      const _exhaustive: never = value;
      return _exhaustive;
    }
  }
}
