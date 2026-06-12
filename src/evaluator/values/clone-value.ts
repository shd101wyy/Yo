import type { FunctionValue } from "../../function-value";
import type { TypeValue } from "../../type-value";
import type { UnitValue } from "../../unit-value";
import type {
  ArrayValue,
  BooleanValue,
  ComptimeListValue,
  ComptimeStringValue,
  EnumValue,
  ExprValue,
  StructValue,
  NumberValue,
  PtrValue,
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
 * @param targetValueMapping - When cloning an environment with pointers, we need to ensure
 *   that pointers within the cloned environment point to the correct cloned variables.
 *   This map tracks original [Value] arrays to their cloned counterparts.
 *
 * For PtrValue: behavior depends on preservePointerReferences flag
 * For compound types (struct, enum, tuple, array): recursively clones fields/elements
 * For primitive types: returns as-is (immutable)
 */
export function cloneValue(
  value: Value,
  preservePointerReferences: boolean = true,
  targetValueMapping?: Map<[Value], [Value]>
): Value {
  switch (value.tag) {
    // Primitive/immutable types - no cloning needed
    case ValueTag.ComptimeInt:
    case ValueTag.ComptimeFloat:
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

    case ValueTag.ComptimeString:
      return value as ComptimeStringValue;

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
      // Clone for CTFE checking - use mapping to maintain pointer relationships
      const ptrValue = value as PtrValue;

      // Check if we already have a cloned version of this targetValue
      if (targetValueMapping) {
        const existingClone = targetValueMapping.get(ptrValue.targetValue);
        if (existingClone) {
          return {
            ...ptrValue,
            targetValue: existingClone,
            targetIndex: ptrValue.targetIndex,
          } as PtrValue;
        }
      }

      // Create new targetValue and register in mapping
      const clonedTarget = cloneValue(
        ptrValue.targetValue[0]!,
        preservePointerReferences,
        targetValueMapping
      );
      const newTargetValue: [Value] = [clonedTarget];
      if (targetValueMapping) {
        targetValueMapping.set(ptrValue.targetValue, newTargetValue);
      }
      return {
        ...ptrValue,
        targetValue: newTargetValue,
        targetIndex: ptrValue.targetIndex,
      } as PtrValue;
    }

    // Compound types - need to recursively clone fields/elements
    case ValueTag.Tuple: {
      const tupleValue = value as TupleValue;
      return {
        ...tupleValue,
        fields: tupleValue.fields.map((f) =>
          cloneValue(f, preservePointerReferences, targetValueMapping)
        ),
      } as TupleValue;
    }

    case ValueTag.Struct: {
      const structValue = value as StructValue;
      return {
        ...structValue,
        fields: structValue.fields.map((f) =>
          f ? cloneValue(f, preservePointerReferences, targetValueMapping) : f
        ),
      } as StructValue;
    }

    case ValueTag.Enum: {
      const enumValue = value as EnumValue;
      return {
        ...enumValue,
        fields: enumValue.fields.map((f) =>
          cloneValue(f, preservePointerReferences, targetValueMapping)
        ),
      } as EnumValue;
    }

    case ValueTag.Array: {
      const arrayValue = value as ArrayValue;
      return {
        ...arrayValue,
        elements: arrayValue.elements.map((e) =>
          cloneValue(e, preservePointerReferences, targetValueMapping)
        ),
      } as ArrayValue;
    }

    case ValueTag.ComptimeList: {
      const comptimetListValue = value as ComptimeListValue;
      return {
        ...comptimetListValue,
        elements: comptimetListValue.elements.map((e) =>
          cloneValue(e, preservePointerReferences, targetValueMapping)
        ),
      } as ComptimeListValue;
    }

    case ValueTag.Trait: {
      const traitValue = value as TraitValue;
      return {
        ...traitValue,
        fields: traitValue.fields.map((f) =>
          f
            ? cloneValue(f, preservePointerReferences, targetValueMapping)
            : undefined
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
