import { BuiltinFunctions, exprIsAtom, FnCallExpr } from "../../expr";
import {
  isDynType,
  isEnumType,
  isNewtypeType,
  isObjectType,
  isPtrType,
  isSliceType,
  isStructType,
  isTupleType,
  TraitType,
  Type,
} from "../../types";
import { isFunctionValue, isTypeValue } from "../../value";
import {
  canOptimizeAsNullablePointer,
  CodeGenContext,
  getEnumVariantCName,
  sanitizeForCIdentifier,
} from "../utils";
import { generateExpr } from "./expr";

/**
 * Generate field access for structs, unions, and enums - extracted from original codegen-c.ts
 */
export function generateFieldAccess(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (expr.args.length !== 2) {
    return "/* ERROR: field access requires exactly 2 arguments */";
  }

  const objectExpr = expr.args[0];
  const fieldExpr = expr.args[1];

  if (!objectExpr || !fieldExpr) {
    return "/* ERROR: invalid field access arguments */";
  }

  const objectCode = generateExpr(objectExpr, indent, context);
  const objectType = objectExpr.$?.type;
  const objectValue = objectExpr.$?.value;

  if (exprIsAtom(fieldExpr)) {
    const fieldName = fieldExpr.token.value;

    // Check if this field access is actually a method access (function from type's trait or nested traits)
    // This includes both direct type methods and methods from nested traits
    if (expr.$?.value && isFunctionValue(expr.$.value)) {
      const functionValue = expr.$.value;
      const cFunctionName =
        context.functions[functionValue.funcId]?.cName || functionValue.funcId;
      return cFunctionName;
    }

    // Fallback: Check if this is an Rc method call (___drop, ___dup, ___dispose)
    // Sometimes, we only called addRcFunctionSignaturesToStructType / addRcFunctionSignaturesToEnumType
    // So they are using the `undefined` function value, before we actually update its trait fields.
    if (
      !expr.$?.value &&
      (BuiltinFunctions.___dispose.includes(fieldName) ||
        BuiltinFunctions.___drop.includes(fieldName) ||
        BuiltinFunctions.___dup.includes(fieldName)) &&
      objectType
    ) {
      // For Rc methods, we need to look up the function from the type's trait
      // and return the function name directly instead of treating it as field access
      let typeTrait: TraitType | null = null;

      if (isStructType(objectType)) {
        typeTrait = objectType.trait;
      } else if (isEnumType(objectType)) {
        typeTrait = objectType.trait;
      }

      if (typeTrait) {
        // Find the function in the type's trait
        const functionElement = typeTrait.fields.find(
          (field) =>
            field.label === fieldName &&
            field.assignedValue &&
            isFunctionValue(field.assignedValue)
        );

        if (functionElement && isFunctionValue(functionElement.assignedValue)) {
          const functionValue = functionElement.assignedValue;
          const cFunctionName =
            context.functions[functionValue.funcId]?.cName ||
            functionValue.funcId;
          return cFunctionName;
        } else {
          return `/* ERROR: Rc method ${fieldName} not found in type module */`;
        }
      } else {
        return `/* ERROR: No module found for Rc method ${fieldName} */`;
      }
    }

    // Handle newtype field access - just return the object itself (zero-cost abstraction)
    if (isNewtypeType(objectType) && objectType.fields.length === 1) {
      // For newtype, accessing the single field just returns the value itself
      // since newtype is typedef'd to the underlying type
      const singleField = objectType.fields[0];
      if (singleField && singleField.label === fieldName) {
        return objectCode;
      }
    }

    // Check if the object is an enum type
    if (isEnumType(objectType)) {
      const enumType = objectType;

      // Check if this enum is optimized as a nullable pointer
      const nullablePointerType = canOptimizeAsNullablePointer(enumType);
      if (nullablePointerType) {
        // For optimized nullable pointer enums, direct field access should be simplified
        // ptr.value becomes ptr (since ptr is already the pointer)
        // NOTE: No need to check fieldName, as the nullablePointerType always only has one field
        // if (fieldName === "value") {
        return objectCode; // Return the pointer directly
        // }
      }

      // For enum field access, we need to determine which variant contains this field
      // and generate the appropriate path: object.data.VariantName.fieldName
      for (const variant of enumType.variants) {
        if (variant.fields) {
          for (const field of variant.fields) {
            if (field.label === fieldName) {
              // Found the field in this variant
              const variantName = variant.name;
              return `${objectCode}.data.${variantName}.${sanitizeForCIdentifier(fieldName)}`;
            }
          }
        }
      }

      return `/* ERROR: field ${fieldName} not found in enum ${enumType.typeName} */`;
    } else if (isTypeValue(objectValue) && isEnumType(objectValue.value)) {
      const enumType = objectValue.value;
      const variant = enumType.variants.find((v) => v.name === fieldName);
      const cName = context.types[enumType.id]?.cName;

      // Accessing variant that has no fields.
      // Like: Color.Red
      if (!!variant && !variant.fields && cName) {
        const tagName = getEnumVariantCName(enumType, variant.name, context);
        return `(${cName}){ .tag = ${tagName}, .data = {  } }`;
      }
    }
    // Check if the object is pointer or reference
    else if (isPtrType(objectType)) {
      if (fieldName === "*") {
        // Regular dereference for pointers/references
        // Ensure proper parenthesization: (*ptr) not *(ptr)
        return `(*${objectCode})`; // Dereference the pointer/reference
      }
      // Special handling for slice types: pointer-to-slice field access
      // (but not dereference which was already handled above)
      else if (isSliceType(objectType.childType)) {
        // For pointer-to-slice, use arrow notation for field access
        return `${objectCode}->${sanitizeForCIdentifier(fieldName)}`;
      } else {
        // Dereference until not a pointer/reference
        let dereferenceLevel = 0;
        let currentType: Type = objectType;
        while (isPtrType(currentType)) {
          dereferenceLevel++;
          currentType = currentType.childType;
        }

        // IMPORTANT: For reference-semantics types (objects), the type is already a pointer in C.
        // So *(MyBox) in Yo becomes MyBox** in C, which requires 2 dereferences, not 1.
        // We need to add an extra dereference level for reference-semantics types.
        if (
          dereferenceLevel > 0 &&
          isStructType(currentType) &&
          currentType.isReferenceSemantics
        ) {
          dereferenceLevel++;
        }

        // Check if the dereferenced type is a newtype accessing its single field
        if (isNewtypeType(currentType) && currentType.fields.length === 1) {
          const singleField = currentType.fields[0];
          if (singleField && singleField.label === fieldName) {
            // For newtype, accessing the single field through a pointer just dereferences the pointer
            // since newtype is typedef'd to the underlying type
            if (dereferenceLevel === 1) {
              return `(*${objectCode})`;
            } else {
              return `${"*".repeat(dereferenceLevel)}(${objectCode})`;
            }
          }
        }

        if (dereferenceLevel > 0) {
          // For pointer types, use arrow notation for field access
          if (dereferenceLevel === 1) {
            return `${objectCode}->${sanitizeForCIdentifier(fieldName)}`;
          } else {
            // Multiple levels of dereference: (*ptr)->field for ptr**
            // Need to parenthesize the dereferenced expression to get correct precedence
            const dereferencedObjectCode = `(${"*".repeat(dereferenceLevel - 1)}${objectCode})`;
            return `${dereferencedObjectCode}->${sanitizeForCIdentifier(fieldName)}`;
          }
        } else {
          // If no dereferencing is needed, just access the field
          return `${objectCode}.${sanitizeForCIdentifier(fieldName)}`;
        }
      }
    }
    // For tuple type, we need to convert the field to index
    else if (isTupleType(objectType)) {
      if (fieldName.match(/^\d+$/)) {
        return `${objectCode}._${fieldName}`;
      } else {
        const index = objectType.fields.findIndex(
          (field) => field.label === fieldName
        );
        return `${objectCode}._${index}`;
      }
    }
    // Handle dynamic dispatch method access
    else if (isDynType(objectType)) {
      // For dyn types, access methods through vtable
      // e.g. s.speak becomes s.vtable->speak (Dyn is value type, vtable is pointer)
      return `${objectCode}.vtable->${sanitizeForCIdentifier(fieldName)}`;
    } else {
      // For C structs and unions, access fields directly
      // Check if this is a reference-counted type (object)
      if (isObjectType(objectType)) {
        // For ref types (pointers), access field directly: ptr->field
        return `${objectCode}->${sanitizeForCIdentifier(fieldName)}`;
      } else {
        // For regular structs/enums, access fields directly
        return `${objectCode}.${sanitizeForCIdentifier(fieldName)}`;
      }
    }
  }

  return "/* ERROR: field name must be an identifier */";
}
