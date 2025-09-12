import {
  ClosureType,
  EnumType,
  isClosureType,
  isEnumType,
  isStructType,
  isStructTypeWithReferenceSemantics,
  isTupleType,
  isUnionType,
  StructType,
  TupleType,
  typeContainsSomeType,
  typeToString,
  UnionType,
} from "../../types";
import {
  canOptimizeAsNullablePointer,
  canOptimizeAsSimpleEnum,
  CodeGenContext,
  getEnumVariantCName,
  getTypeString,
  sanitizeForCIdentifier,
} from "../utils";

/**
 * Generate type declarations for all collected types
 */
export function generateTypeDeclarations(context: CodeGenContext): void {
  // Generate common reference counter header for ref structs and ref enums
  const hasARCTypes = Object.values(context.types).some(({ type }) =>
    isStructTypeWithReferenceSemantics(type)
  );

  if (hasARCTypes) {
    context.emitter
      .emitDeclarationLine(`// Reference counter header for ref structs and ref enums
typedef struct {
  size_t ref_count;
} yo_ref_header_t;
`);
  }

  // Generate array struct types first
  generateArrayStructDeclarations(context);

  // Generate slice struct types
  generateSliceStructDeclarations(context);

  // Forward declarations - generate struct and enum forward declarations first
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (typeContainsSomeType(type)) {
      continue; // Skip types that contain `SomeType` as they are not concrete types
    }

    if (isStructType(type)) {
      context.emitter.emitDeclarationLine(
        `typedef struct ${cName}_struct ${cName}; // Forward declaration`
      );
    } else if (isEnumType(type)) {
      context.emitter.emitDeclarationLine(
        `typedef struct ${cName}_struct ${cName}; // Forward declaration`
      );
    }
  }

  // Add blank line after forward declarations
  context.emitter.emitDeclarationLine("");

  // First pass: Generate struct declarations
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (typeContainsSomeType(type)) {
      continue; // Skip types that contain `SomeType` as they are not concrete types
    }

    if (isStructType(type)) {
      generateStructDeclaration(type, cName, context);
    } else if (isClosureType(type)) {
      generateClosureDeclaration(type, cName, context);
    } else if (isUnionType(type)) {
      generateUnionDeclaration(type, cName, context);
    } else if (isEnumType(type)) {
      generateEnumDeclaration(type, cName, context);
    } else if (isTupleType(type)) {
      // For tuples, we can generate a struct-like declaration
      generateTupleDeclaration(type, cName, context);
    }
  }
}

/**
 * Generate array struct type declarations
 */
export function generateArrayStructDeclarations(context: CodeGenContext): void {
  const emitter = context.emitter;
  for (const [
    arrayTypeName,
    { elementType, length },
  ] of context.arrayStructTypes) {
    emitter.emitDeclarationLine(`typedef struct { // Array wrapper struct`);
    emitter.emitDeclarationLine(`  ${elementType} data[${length}];`);
    emitter.emitDeclarationLine(`} ${arrayTypeName};`);
    emitter.emitDeclarationLine("");
  }
}

/**
 * Generate slice struct type declarations
 */
export function generateSliceStructDeclarations(context: CodeGenContext): void {
  const emitter = context.emitter;
  for (const [sliceTypeName, { elementType }] of context.sliceStructTypes) {
    emitter.emitDeclarationLine(`typedef struct { // Slice wrapper struct`);
    emitter.emitDeclarationLine(`  ${elementType}* data;`);
    emitter.emitDeclarationLine(`  size_t length;`);
    emitter.emitDeclarationLine(`} ${sliceTypeName};`);
    emitter.emitDeclarationLine("");
  }
}

/**
 * Generate a closure declaration
 */
export function generateClosureDeclaration(
  closureType: ClosureType,
  cName: string,
  context: CodeGenContext
): void {
  const emitter = context.emitter;

  // A closure is represented as just the captured data
  // Following the Rust model: no function pointer stored, call function is statically determined

  // TODO: If the capture type is a struct, generate it inline as part of the closure - commented out for closure system simplification
  /*
  if (isStructType(closureType.captureType)) {
    const captureStructType = closureType.captureType as StructType;
    const closureKind = closureType.callType.closureKind;

    // Generate the closure as the capture struct directly
    emitter.emitDeclarationLine(
      `typedef struct { // ${closureType.typeName || "Closure"} : ${typeToString(closureType)}`
    );
    for (const element of captureStructType.elements) {
      let fieldTypeStr: string;

      if (closureKind === "FnMove") {
        // For FnMove, capture by value
        fieldTypeStr = getTypeString(element.type, context);
      } else if (closureKind === "FnMut") {
        // For FnMut, capture by mutable reference
        const elementTypeStr = getTypeString(element.type, context);
        fieldTypeStr = `${elementTypeStr}*`;
      } else if (closureKind === "Fn") {
        // For Fn, capture by immutable reference (const pointer)
        const elementTypeStr = getTypeString(element.type, context);
        fieldTypeStr = `const ${elementTypeStr}*`;
      } else {
        // Default to value capture for unknown closure kinds
        fieldTypeStr = getTypeString(element.type, context);
      }

      emitter.emitDeclarationLine(`  ${fieldTypeStr} ${element.label};`);
    }
    emitter.emitDeclarationLine(`} ${cName};`);
  }
  // If no captures, generate an empty struct
  else {
    emitter.emitDeclarationLine(
      `typedef struct { // ${closureType.typeName || "Closure"} : ${typeToString(closureType)}`
    );
    */

  // TODO: For now, generate a simple placeholder for all closures
  emitter.emitDeclarationLine(
    `typedef struct { int _placeholder; } ${cName}; // TODO: Closure struct generation with new closure system`
  );

  /*
    emitter.emitDeclarationLine(
      `  char _unused; // Empty closure with no captures`
    );
    emitter.emitDeclarationLine(`} ${cName};`);
  }

  emitter.emitDeclarationLine(""); // Add blank line for readability
  */
}

/**
 * Generate a struct declaration
 */
export function generateStructDeclaration(
  structType: StructType,
  cName: string,
  context: CodeGenContext
): void {
  const emitter = context.emitter;

  if (structType.isReferenceSemantics) {
    // For ref struct, generate a struct with the common reference header
    emitter.emitDeclarationLine(
      `struct ${cName}_struct { // ${structType.typeName} : ${typeToString(structType)} (reference counted)`
    );
    emitter.emitDeclarationLine(
      `  yo_ref_header_t header; // Reference count header`
    );

    for (const element of structType.elements) {
      const fieldTypeStr = getTypeString(element.type, context);
      const fieldName = sanitizeForCIdentifier(element.label);
      emitter.emitDeclarationLine(`  ${fieldTypeStr} ${fieldName};`);
    }

    emitter.emitDeclarationLine(`};`);
  } else {
    // For regular struct, generate as before
    emitter.emitDeclarationLine(
      `struct ${cName}_struct { // ${structType.typeName} : ${typeToString(structType)}`
    );

    for (const element of structType.elements) {
      const fieldTypeStr = getTypeString(element.type, context);
      const fieldName = sanitizeForCIdentifier(element.label);
      emitter.emitDeclarationLine(`  ${fieldTypeStr} ${fieldName};`);
    }

    emitter.emitDeclarationLine(`};`);
  }

  emitter.emitDeclarationLine(""); // Add blank line for readability
}

/**
 * Generate a tuple declaration
 */
export function generateTupleDeclaration(
  tupleType: TupleType,
  cName: string,
  context: CodeGenContext
): void {
  const emitter = context.emitter;
  emitter.emitDeclarationLine(
    `typedef struct { // ${tupleType.typeName} : ${typeToString(tupleType)}`
  );

  for (const element of tupleType.elements) {
    const fieldTypeStr = getTypeString(element.type, context);
    const fieldName = element.label.match(/^\d+$/)
      ? `_${element.label}`
      : sanitizeForCIdentifier(element.label);
    emitter.emitDeclarationLine(`  ${fieldTypeStr} ${fieldName};`);
  }

  emitter.emitDeclarationLine(`} ${cName};`);
  emitter.emitDeclarationLine(""); // Add blank line for readability
}

/**
 * Generate a union declaration
 */
export function generateUnionDeclaration(
  unionType: UnionType,
  cName: string,
  context: CodeGenContext
): void {
  const emitter = context.emitter;
  // Generate C union (not tagged union)
  emitter.emitDeclarationLine(
    `typedef union { // ${unionType.typeName} : ${typeToString(unionType)}`
  );

  for (const element of unionType.elements) {
    const fieldTypeStr = getTypeString(element.type, context);
    const fieldName = sanitizeForCIdentifier(element.label);
    emitter.emitDeclarationLine(`  ${fieldTypeStr} ${fieldName};`);
  }

  emitter.emitDeclarationLine(`} ${cName};`);
  emitter.emitDeclarationLine(""); // Add blank line for readability
}

/**
 * Generate an enum declaration (tagged union)
 */
export function generateEnumDeclaration(
  enumType: EnumType,
  cName: string,
  context: CodeGenContext
): void {
  const emitter = context.emitter;

  // Check if this enum can be optimized as a nullable pointer
  const nullablePointerType = canOptimizeAsNullablePointer(enumType);
  if (nullablePointerType) {
    // Generate a simple typedef for the pointer type
    const pointerTypeStr = getTypeString(nullablePointerType, context);
    emitter.emitDeclarationLine(
      `typedef ${pointerTypeStr} ${cName}; // ${enumType.typeName} : ${typeToString(enumType)} (optimized as nullable pointer)`
    );
    emitter.emitDeclarationLine(""); // Add blank line for readability
    return;
  }

  // Check if this enum can be optimized as a simple C enum
  const simpleEnumOptimizable = canOptimizeAsSimpleEnum(enumType);
  if (simpleEnumOptimizable) {
    // Generate a simple enum declaration
    emitter.emitDeclarationLine(
      `typedef enum { // ${enumType.typeName} : ${typeToString(enumType)} (optimized as simple enum)`
    );

    for (let i = 0; i < enumType.variants.length; i++) {
      const variant = enumType.variants[i];
      if (variant) {
        // Use fully mangled names for enum tags to avoid global scope conflicts
        const tagName = getEnumVariantCName(enumType, variant.name, context);
        const comma = i < enumType.variants.length - 1 ? "," : "";
        emitter.emitDeclarationLine(`  ${tagName} = ${i}${comma}`);
      }
    }

    emitter.emitDeclarationLine(`} ${cName};`);
    emitter.emitDeclarationLine(""); // Add blank line for readability
    return;
  }

  // Generate tag enum for discriminant
  const tagEnumName = `${cName}_tag`;
  emitter.emitDeclarationLine(`typedef enum {`);

  for (let i = 0; i < enumType.variants.length; i++) {
    const variant = enumType.variants[i];
    if (variant) {
      // Use fully mangled names for enum tags to avoid global scope conflicts
      const tagName = getEnumVariantCName(enumType, variant.name, context);
      const comma = i < enumType.variants.length - 1 ? "," : "";
      emitter.emitDeclarationLine(`  ${tagName} = ${i}${comma}`);
    }
  }

  emitter.emitDeclarationLine(`} ${tagEnumName};`);
  emitter.emitDeclarationLine("");

  // Generate union for variant data
  const variantUnionName = `${cName}_data`;
  emitter.emitDeclarationLine(`typedef union {`);

  for (const variant of enumType.variants) {
    if (variant.elements && variant.elements.length > 0) {
      // Variant has data - create a struct for its fields using just the variant name
      const variantStructName = variant.name;
      emitter.emitDeclarationLine(`  struct {`);

      for (const element of variant.elements) {
        const fieldTypeStr = getTypeString(element.type, context);
        const fieldName = sanitizeForCIdentifier(element.label);
        emitter.emitDeclarationLine(`    ${fieldTypeStr} ${fieldName};`);
      }

      emitter.emitDeclarationLine(`  } ${variantStructName};`);
    }
  }

  emitter.emitDeclarationLine(`} ${variantUnionName};`);
  emitter.emitDeclarationLine("");

  // Generate the main tagged union struct
  emitter.emitDeclarationLine(
    `struct ${cName}_struct { // ${enumType.typeName} : ${typeToString(enumType)}`
  );

  emitter.emitDeclarationLine(`  ${tagEnumName} tag;`);
  emitter.emitDeclarationLine(`  ${variantUnionName} data;`);

  emitter.emitDeclarationLine(`};`);
  emitter.emitDeclarationLine(""); // Add blank line for readability
}
