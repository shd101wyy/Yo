import type { Type } from "../../types/definitions";
import type { Expr } from "../../expr";
import type { FunctionType } from "../../types/definitions";
import {
  isComptimeStringType,
  isStrType,
  isFunctionType,
  isPtrType,
  isStructType,
  isTupleType,
  isUnitType,
} from "../../types/guards";
import { typeToString } from "../../types/utils";
import {
  isArrayValue,
  isBooleanValue,
  isComptimeStringValue,
  isEnumValue,
  isFunctionValue,
  isNumberValue,
  isPtrValue,
  isStructValue,
  isTupleValue,
  isTypeValue,
  type Value,
  valueToString,
} from "../../value";
import { ValueTag } from "../../value-tag";
import {
  canOptimizeAsNullablePointer,
  canOptimizeAsSimpleEnum,
  type CodeGenContext,
  getEnumVariantCName,
  getRuntimeStructFields,
  getTypeString,
  sanitizeForCIdentifier,
} from "../utils";

/**
 * Generate C code for a compile-time value - extracted from original codegen-c.ts
 */
export function generateComptimeValue(
  value: Value,
  context: CodeGenContext,
  _sourceExpr?: Expr,
  expectedType?: Type
): string {
  if (isNumberValue(value)) {
    const str =
      typeof value.value === "bigint"
        ? value.value.toString()
        : value.value.toString();
    if (value.tag === ValueTag.F32) {
      // Ensure float literal has decimal point and 'f' suffix for C
      const floatStr = str.includes(".") ? str : str + ".0";
      return floatStr + "f";
    }
    if (value.tag === ValueTag.F64 || value.tag === ValueTag.ComptimeFloat) {
      // Ensure double literal has decimal point
      return str.includes(".") ? str : str + ".0";
    }
    if (value.tag === ValueTag.U64 || value.tag === ValueTag.Usize) {
      return str + "ULL";
    }
    if (value.tag === ValueTag.I64 || value.tag === ValueTag.Isize) {
      return str + "LL";
    }
    if (value.tag === ValueTag.U32) {
      return str + "U";
    }
    return str;
  } else if (isBooleanValue(value)) {
    // For booleans, return true/false
    return value.value ? "true" : "false";
  } else if (isComptimeStringValue(value)) {
    // Check if there's a converted runtime type (e.g., comptime_str -> str or [u8])
    const targetType =
      _sourceExpr?.$?.convertedRuntimeType || _sourceExpr?.$?.type || expectedType;

    // Builtin str target: emit the fat pointer over the static literal.
    if (targetType && isStrType(targetType)) {
      const stringLiteral = JSON.stringify(value.value);
      const stringLength = Buffer.byteLength(value.value, "utf8");
      return `(__yo_str){ .ptr = (const uint8_t*)${stringLiteral}, .len = ${stringLength} }`;
    }

    // Fallback: comptime_str materializing in a runtime context with no
    // recorded conversion becomes the builtin str (branch-value temps,
    // field assignments). Pointer targets were handled above.
    if (!targetType || isComptimeStringType(targetType)) {
      const stringLiteral = JSON.stringify(value.value);
      const stringLength = Buffer.byteLength(value.value, "utf8");
      return `(__yo_str){ .ptr = (const uint8_t*)${stringLiteral}, .len = ${stringLength} }`;
    }

    // For regular strings, return the C string literal with proper escaping
    return JSON.stringify(value.value);
  } else if (isEnumValue(value)) {
    // For enums, check if it's optimized as nullable pointer
    const enumType = value.type;
    const nullablePointerType = canOptimizeAsNullablePointer(enumType);

    if (nullablePointerType) {
      // Generate optimized nullable pointer construction
      const variant = enumType.variants.find(
        (v) => v.name === value.variantName
      );
      if (!variant) {
        return `// Error: Variant ${value.variantName} not found in enum`;
      }

      if (!variant.fields || variant.fields.length === 0) {
        // This is the null case (None variant)
        return "NULL";
      } else if (variant.fields.length === 1 && value.fields.length === 1) {
        // This is the pointer case (Some variant).
        // Pass the pointer type as context so comptime_str values
        // are generated as C string literals, not as str/Slice structs.
        return generateComptimeValue(value.fields[0]!, context, {
          $: {
            type: nullablePointerType,
            convertedRuntimeType: nullablePointerType,
          },
        } as Expr);
      }
    }

    // Check if this enum can be optimized as a simple C enum
    const simpleEnumOptimizable = canOptimizeAsSimpleEnum(enumType);
    if (simpleEnumOptimizable) {
      // For simple enums, just return the enum constant
      return getEnumVariantCName(enumType, value.variantName, context);
    }

    // Generate regular tagged union construction
    const cName = context.types[enumType.id]?.cName;
    if (!cName) {
      return `// Error: No C type name found for enum ${typeToString(enumType)}`;
    }

    const variantTag = getEnumVariantCName(
      enumType,
      value.variantName,
      context
    );

    if (!value.fields || value.fields.length === 0) {
      // Variant with no data
      return `(${cName}){ .tag = ${variantTag} }`;
    } else {
      // Variant with data
      const variant = enumType.variants.find(
        (v) => v.name === value.variantName
      );
      if (!variant || !variant.fields) {
        return `// Error: Variant ${value.variantName} not found or has no fields`;
      }

      // Filter out unit type fields
      const nonUnitFields = value.fields
        .map((field, index) => {
          const variantElement = variant.fields![index];
          if (variantElement && !isUnitType(variantElement.type)) {
            const fieldName = sanitizeForCIdentifier(variantElement.label);
            const fieldCode = generateComptimeValue(field, context);
            return `.${fieldName} = ${fieldCode}`;
          }
          return null;
        })
        .filter((f) => f !== null);

      // If all fields are unit types, just return the tag
      if (nonUnitFields.length === 0) {
        return `(${cName}){ .tag = ${variantTag} }`;
      }

      return `(${cName}){ .tag = ${variantTag}, .data = { .${value.variantName} = { ${nonUnitFields.join(", ")} } } }`;
    }
  } else if (isTupleValue(value)) {
    // For tuple values, generate tuple struct initialization with numeric field names
    const type = value.type;
    const cName = context.types[type.id]?.cName;
    if (!cName) {
      return `// Error: No C type name found for tuple ${typeToString(type)}\n`;
    }

    const fields = value.fields.map((field, index) => {
      const fieldCode = generateComptimeValue(field, context);
      // Tuples always use numeric field names _0, _1, _2...
      return `._${index} = ${fieldCode}`;
    });

    return `(${cName}){ ${fields.join(", ")} }`;
  } else if (isStructValue(value)) {
    // For structs, we need to generate a struct initialization
    const type = value.type;
    if (type && isStructType(type)) {
      const cName = context.types[type.id]?.cName;
      if (!cName) {
        return `// Error: No C type name found for struct ${typeToString(type)}\n`;
      }

      // Handle newtype as zero-cost abstraction
      if (
        type.isNewtype &&
        type.fields.length === 1 &&
        value.fields.length === 1
      ) {
        // For newtype, just use the underlying value with a cast
        const underlyingValue = generateComptimeValue(
          value.fields[0]!,
          context
        );
        return `((${cName})(${underlyingValue}))`;
      }

      if (type.isReferenceSemantics) {
        // For object compile-time values, use constructor function
        const runtimeFieldValues = type.fields
          .map((field, index) => ({ field, value: value.fields[index] }))
          .filter(({ field }) =>
            getRuntimeStructFields(type).some(
              (runtimeField) => runtimeField === field
            )
          )
          .map(({ value: fieldValue }) =>
            generateComptimeValue(fieldValue!, context)
          );

        const constructorName = `__yo_new_${cName}`;
        return `${constructorName}(${runtimeFieldValues.join(", ")})`;
      } else {
        // For regular struct compile-time values, generate as before
        const runtimeFields = getRuntimeStructFields(type);
        const fields = type.fields
          .map((field, index) => ({ field, value: value.fields[index] }))
          .filter(({ field }) =>
            runtimeFields.some((runtimeField) => runtimeField === field)
          )
          .map(({ field, value: fieldValue }, index) => {
            // For tuples, use numeric field names _0, _1, _2...
            // For regular structs, use the actual field labels
            const fieldName = isTupleType(type)
              ? `_${index}`
              : sanitizeForCIdentifier(field.label);
            const fieldCode = generateComptimeValue(
              fieldValue!,
              context,
              undefined,
              field.type
            );
            return `.${fieldName} = ${fieldCode}`;
          });

        return `(${cName}){ ${fields.join(", ")} }`;
      }
    }
  } else if (isArrayValue(value)) {
    // For array values, generate struct wrapper initialization
    const arrayType = value.type;
    const arrayTypeName = getTypeString(arrayType, context);
    const elementCodes = value.elements.map((element) =>
      generateComptimeValue(element, context)
    );
    return `(${arrayTypeName}){ .data = { ${elementCodes.join(", ")} } }`;
  } else if (isFunctionValue(value)) {
    // For function values, we need to register them and return their C function name
    const cName = context.functions[value.funcId]?.cName;
    if (cName) {
      return cName; // Return the function name as a function pointer
    }
    // io.async / io.await / io.state / io.spawn (and join_handle.await) are
    // ioBuiltin MARKERS — they have no C function body. Every call site is
    // inlined into direct runtime calls by codegen, so the field value
    // stored in an `Io` / `JoinHandle` struct literal is never invoked
    // through a function pointer. Emit a NULL pointer so the struct
    // initializer is valid C; if a caller ever did dispatch through the
    // field it would crash, which is the same failure mode the explicit
    // injection of `(Io){0}` from main wrapper gives.
    if (value.type.ioBuiltin) {
      return "NULL";
    }
    return `// Error: No C function name found for function value with ID ${value.funcId}\n`;
  } else if (
    value.tag === ValueTag.Unknown &&
    isFunctionType(value.type) &&
    (value.type as FunctionType).ioBuiltin
  ) {
    // Same as the FunctionValue case above — when an Io/JoinHandle struct
    // is constructed at a runtime call site, its fields can show up as
    // UnknownValue placeholders (variableName set to e.g. "__yo_io_async")
    // rather than fully-resolved FunctionValue. The ioBuiltin markers
    // are never dispatched through, so NULL is a safe field initializer.
    return "NULL";
  } else if (isTypeValue(value)) {
    // For type values, we can return the C type name if available
    const type = value.value;
    if (type) {
      if (isStrType(type)) {
        return "__yo_str";
      }
      if (context.types[type.id]) {
        return context.types[type.id]!.cName;
      } else {
        return `/* Error: No C type name found for type ${typeToString(type)} */`;
      }
    }
  } else if (isPtrValue(value)) {
    // For pointer values, we need to:
    // 1. Generate the underlying value with proper type conversion
    // 2. Take the address of that generated value using a compound literal
    const targetValue = value.targetValue[0];
    if (targetValue) {
      // Check if we have a converted runtime type for the pointer's child type
      // e.g., for *(str), the sourceExpr.$.convertedRuntimeType is *(str),
      // and we need to generate the str value from comptime_str
      const ptrType =
        _sourceExpr?.$?.convertedRuntimeType || _sourceExpr?.$?.type;
      if (ptrType && isPtrType(ptrType)) {
        const childType = ptrType.childType;

        // Create a temporary expression-like object for the child value generation
        // This allows generateComptimeValue to use the correct target type
        const childCode = generateComptimeValue(targetValue, context, {
          $: {
            type: childType,
            convertedRuntimeType: childType,
          },
        } as Expr);

        if (
          childCode &&
          !childCode.startsWith("/*") &&
          !childCode.startsWith("//")
        ) {
          // The childCode already contains a compound literal with the type cast
          // (e.g., "(str){ .data = ..., .length = ... }"), so we just take its address
          return `(&${childCode})`;
        }
      }
    }
    return `/* Error: Cannot generate pointer value ${valueToString(value)} */`;
  }

  return `/* skip generating: ${valueToString(value)} */`; // No need to generate. It might be an effect record value, etc
}
