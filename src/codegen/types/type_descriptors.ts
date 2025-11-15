/**
 * Type descriptor generation for precise GC pointer scanning
 *
 * This module generates YoTypeDescriptor structs for all GC-managed types.
 * Type descriptors tell the GC which fields contain GC pointers so it can
 * traverse object graphs correctly during mark phase.
 */

import {
  isClosureType,
  isDynType,
  isFutureType,
  isGcType,
  isStructType,
  Type,
  typeContainsGcType,
} from "../../types";
import { CodeGenContext, sanitizeForCIdentifier } from "../utils";

/**
 * Information about a GC pointer field in a type
 */
interface GcPointerField {
  fieldName: string;
  offsetExpression: string; // C expression like "offsetof(TypeName, fieldName)"
}

/**
 * Generate type descriptor declarations for all GC-managed types
 * This should be called after all type declarations have been emitted
 */
export function generateTypeDescriptorDeclarations(
  context: CodeGenContext
): void {
  const emitter = context.emitter;

  emitter.emitDeclarationLine(`// Type descriptors for GC pointer scanning`);
  emitter.emitDeclarationLine(
    `// These tell the GC which fields contain GC pointers`
  );
  emitter.emitDeclarationLine(``);

  // Generate the YoTypeDescriptor struct definition
  emitter.emitDeclarationLine(`typedef struct {`);
  emitter.emitDeclarationLine(
    `  const char* name;           // Type name (for debugging)`
  );
  emitter.emitDeclarationLine(
    `  size_t size;                // Object size in bytes`
  );
  emitter.emitDeclarationLine(
    `  size_t pointer_count;       // Number of GC pointers`
  );
  emitter.emitDeclarationLine(
    `  size_t* pointer_offsets;    // Offsets of GC pointer fields`
  );
  emitter.emitDeclarationLine(
    `  void (*finalizer)(void*);   // Dispose function`
  );
  emitter.emitDeclarationLine(`} YoTypeDescriptor;`);
  emitter.emitDeclarationLine(``);

  // Generate type descriptors for each GC-managed type
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;

    if (isGcType(type)) {
      generateTypeDescriptor(type, cName, context);
    }
  }
}

/**
 * Generate a type descriptor for a single GC-managed type
 */
function generateTypeDescriptor(
  type: Type,
  cName: string,
  context: CodeGenContext
): void {
  const emitter = context.emitter;
  const descriptorName = `${cName}_type_descriptor`;

  // Collect GC pointer fields
  const gcPointerFields = collectGcPointerFields(type, cName, context);

  if (gcPointerFields.length === 0) {
    // Type has no GC pointers - generate descriptor with NULL pointer_offsets
    emitter.emitDeclarationLine(
      `// Type descriptor for ${cName} (no GC pointers)`
    );
    emitter.emitDeclarationLine(
      `static YoTypeDescriptor ${descriptorName} = {`
    );
    emitter.emitDeclarationLine(`  .name = "${type.typeName || cName}",`);
    emitter.emitDeclarationLine(
      `  .size = sizeof(${getStructName(type, cName)}),`
    );
    emitter.emitDeclarationLine(`  .pointer_count = 0,`);
    emitter.emitDeclarationLine(`  .pointer_offsets = NULL,`);
    emitter.emitDeclarationLine(
      `  .finalizer = NULL  // Set during object construction`
    );
    emitter.emitDeclarationLine(`};`);
    emitter.emitDeclarationLine(``);
    return;
  }

  // Generate pointer offsets array
  const offsetsArrayName = `${cName}_pointer_offsets`;
  emitter.emitDeclarationLine(`// Pointer offsets for ${cName}`);
  emitter.emitDeclarationLine(`static size_t ${offsetsArrayName}[] = {`);

  for (let i = 0; i < gcPointerFields.length; i++) {
    const field = gcPointerFields[i]!;
    const comma = i < gcPointerFields.length - 1 ? "," : "";
    emitter.emitDeclarationLine(
      `  ${field.offsetExpression}${comma}  // ${field.fieldName}`
    );
  }

  emitter.emitDeclarationLine(`};`);
  emitter.emitDeclarationLine(``);

  // Generate type descriptor
  emitter.emitDeclarationLine(`// Type descriptor for ${cName}`);
  emitter.emitDeclarationLine(`static YoTypeDescriptor ${descriptorName} = {`);
  emitter.emitDeclarationLine(`  .name = "${type.typeName || cName}",`);
  emitter.emitDeclarationLine(
    `  .size = sizeof(${getStructName(type, cName)}),`
  );
  emitter.emitDeclarationLine(`  .pointer_count = ${gcPointerFields.length},`);
  emitter.emitDeclarationLine(`  .pointer_offsets = ${offsetsArrayName},`);
  emitter.emitDeclarationLine(
    `  .finalizer = NULL  // Set during object construction`
  );
  emitter.emitDeclarationLine(`};`);
  emitter.emitDeclarationLine(``);
}

/**
 * Get the C struct name for a type (handles objects vs regular structs)
 */
function getStructName(type: Type, cName: string): string {
  if (isStructType(type) && type.isReferenceSemantics) {
    // Objects use: struct typename_struct
    return `struct ${cName}_struct`;
  } else if (isClosureType(type) || isDynType(type) || isFutureType(type)) {
    // Closures, dyn, futures are typedefs
    return cName;
  } else {
    // Regular structs
    return `struct ${cName}_struct`;
  }
}

/**
 * Collect all GC pointer fields from a type
 * Returns array of field information including offset expressions
 */
function collectGcPointerFields(
  type: Type,
  cName: string,
  context: CodeGenContext
): GcPointerField[] {
  const pointerFields: GcPointerField[] = [];
  const structName = getStructName(type, cName);

  if (isStructType(type)) {
    if (type.isReferenceSemantics) {
      // For objects, check each field
      for (const field of type.fields) {
        if (typeContainsGcType(field.type)) {
          const fieldName = sanitizeForCIdentifier(field.label);
          pointerFields.push({
            fieldName,
            offsetExpression: `offsetof(${structName}, ${fieldName})`,
          });
        }
      }
    }
  } else if (isClosureType(type)) {
    // Closures have:
    // - header (yo_gc_header_t) - not a GC pointer
    // - vtable (function pointers) - not GC pointers
    // - data (void*) - this IS a GC pointer if capture struct contains GC types

    // Check if the closure has a capture type with GC pointers
    // The capture type is stored in context.types with naming convention: closureCName_capture
    const captureTypeName = `${cName}_capture`;
    const captureTypeEntry = Object.values(context.types).find(
      (entry) => entry.cName === captureTypeName
    );

    if (captureTypeEntry && typeContainsGcType(captureTypeEntry.type)) {
      // The data field points to a capture struct with GC types
      pointerFields.push({
        fieldName: "data",
        offsetExpression: `offsetof(${structName}, data)`,
      });
    }
  } else if (isDynType(type)) {
    // Dyn types have:
    // - header (yo_gc_header_t) - not a GC pointer
    // - vtable (function pointers) - not GC pointers
    // - data (void*) - this IS a GC pointer (points to underlying object)

    // The data field always points to a GC-managed object
    pointerFields.push({
      fieldName: "data",
      offsetExpression: `offsetof(${structName}, data)`,
    });
  } else if (isFutureType(type)) {
    // Future types have:
    // - header (yo_gc_header_t) - not a GC pointer
    // - result field - check if it contains GC types
    // - state machine fields - may contain GC types

    // Check the child type (result type)
    if (typeContainsGcType(type.childType)) {
      pointerFields.push({
        fieldName: "result",
        offsetExpression: `offsetof(${structName}, result)`,
      });
    }

    // Note: State machine fields are more complex and may need special handling
    // For now, we focus on the result field which is the main GC pointer
  }

  return pointerFields;
}

/**
 * Get the type descriptor name for a type
 * Used when passing descriptors to __yo_gc_alloc
 */
export function getTypeDescriptorName(cName: string): string {
  return `&${cName}_type_descriptor`;
}
