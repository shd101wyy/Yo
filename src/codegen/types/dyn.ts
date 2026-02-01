import { BuiltinFunctions } from "../../expr";
import { DynType, FunctionType } from "../../types/definitions";
import { isFnTraitType, isFunctionType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import {
  CodeGenContext,
  getTypeString,
  sanitizeForCIdentifier,
} from "../utils";

/**
 * Generate a dynamic dispatch declaration
 */
export function generateDynDeclaration(
  dynType: DynType,
  cName: string,
  context: CodeGenContext
): void {
  const emitter = context.emitter;

  // Generate vtable structure for the dynamic dispatch
  // The vtable contains function pointers for each method in the module
  const vtableName = `${cName}_vtable`;

  emitter.emitDeclarationLine(
    `typedef struct { // Vtable for ${typeToString(dynType)}`
  );

  // Generate function pointers in the correct order: base module methods first, then user module methods
  const processedMethods = new Set<string>();

  // Reserved ARC/GC hooks are generated outside the dyn vtable.
  const reservedDynMethodLabels = new Set<string>([
    BuiltinFunctions.___dup[0]!,
    BuiltinFunctions.___drop[0]!,
    BuiltinFunctions.___dispose[0]!,
    BuiltinFunctions.dispose[0]!,
  ]);

  // Process modules in the order they appear in dynType.requiredTraits
  for (const traitType of dynType.requiredTraits) {
    // Handle FnTraitType specially - it has isFn which represents the "call" method
    if (isFnTraitType(traitType)) {
      const functionType = traitType.isFn.callType;
      const returnTypeStr = getTypeString(functionType.return.type, context);

      // Generate the complete parameter list for the call function pointer
      const paramList = functionType.parameters
        .map((param) => {
          const paramTypeStr = getTypeString(param.type, context);
          const paramName = sanitizeForCIdentifier(param.label);
          return `${paramTypeStr} ${paramName}`;
        })
        .join(", ");

      // Call function takes void* self as first parameter, then user parameters
      emitter.emitDeclarationLine(
        `  ${returnTypeStr} (*call)(void* self${paramList ? ", " + paramList : ""}); // Call function pointer`
      );
      processedMethods.add("call");
      continue;
    }

    for (const field of traitType.fields) {
      // Skip 'Self' type declarations as they're not methods
      if (field.label === "Self") {
        continue;
      }

      // Skip reserved ARC/GC hooks; Dyn dup/drop are generated separately.
      if (reservedDynMethodLabels.has(field.label)) {
        continue;
      }

      // Avoid duplicate methods from different modules
      if (processedMethods.has(field.label)) {
        continue;
      }
      processedMethods.add(field.label);

      // Generate function pointer for this method
      const methodName = sanitizeForCIdentifier(field.label);

      // Check if this field is a function type
      if (isFunctionType(field.type)) {
        const functionType = field.type as FunctionType;

        // Only include methods whose first parameter is of type Self
        if (functionType.parameters.length > 0) {
          const firstParam = functionType.parameters[0];
          if (firstParam && firstParam.label === "self") {
            // FIXME: ^ This way is not sufficient judging if this function is a method.
            // This is a method that should be included in the vtable
            const returnTypeStr = getTypeString(
              functionType.return.type,
              context
            );

            // Generate the complete parameter list for the function pointer
            const paramList = functionType.parameters
              .map((param, index) => {
                if (index === 0) {
                  // First parameter (self) is always void* in vtable
                  return "void* self";
                } else {
                  // Other parameters use their actual types
                  const paramTypeStr = getTypeString(param.type, context);
                  const paramName = sanitizeForCIdentifier(param.label);
                  return `${paramTypeStr} ${paramName}`;
                }
              })
              .join(", ");

            emitter.emitDeclarationLine(
              `  ${returnTypeStr} (*${methodName})(${paramList}); // Method pointer for ${field.label}`
            );
          }
          // Skip functions that don't have 'self' as first parameter
        }
      } else {
        // For non-function fields, treat as data members (shouldn't happen for trait methods)
        const elementTypeStr = getTypeString(field.type, context);
        emitter.emitDeclarationLine(
          `  ${elementTypeStr} ${methodName}; // Non-function member ${field.label}`
        );
      }
    }
  }

  emitter.emitDeclarationLine(`} ${vtableName};`);
  emitter.emitDeclarationLine("");

  // Generate the dynamic dispatch object structure
  // Dyn is a value type (fat pointer) - just data pointer + vtable pointer
  // The data pointer points to a boxed value that has yo_ref_header_t
  // The vtable pointer points to a static vtable instance (one per impl)
  emitter.emitDeclarationLine(
    `typedef struct { // ${dynType.typeName || "Dyn"} : ${typeToString(dynType)} (value type - fat pointer)`
  );
  emitter.emitDeclarationLine(
    `  void* data; // Pointer to boxed data (with yo_ref_header_t)`
  );
  emitter.emitDeclarationLine(
    `  const ${vtableName}* vtable; // Pointer to static vtable (no allocation needed)`
  );
  emitter.emitDeclarationLine(`} ${cName};`);
  emitter.emitDeclarationLine("");
}

/**
 * Generate box types for all dyn() implementations
 * Box types wrap values for dynamic dispatch with reference counting header
 */
export function generateDynBoxTypes(context: CodeGenContext): void {
  const emitter = context.emitter;

  if (context.dynImpls.size === 0) {
    return;
  }

  emitter.emitDeclarationLine("");
  emitter.emitDeclarationLine("// === Dyn Box Types ===");
  emitter.emitDeclarationLine(
    "// These structs wrap concrete types for dynamic dispatch"
  );
  emitter.emitDeclarationLine("");

  // Track generated box types to avoid duplicates
  const generatedBoxTypes = new Set<string>();

  for (const [, impl] of context.dynImpls) {
    const concreteTypeCName =
      context.types[impl.concreteType.id]?.cName ||
      `unknown_${impl.concreteType.id}`;
    const boxTypeName = `yo_dyn_box_${concreteTypeCName}`;

    // Skip if already generated (multiple dyn() calls with same type)
    if (generatedBoxTypes.has(boxTypeName)) {
      continue;
    }
    generatedBoxTypes.add(boxTypeName);

    const valueTypeStr = getTypeString(impl.concreteType, context);

    // Generate box struct
    emitter.emitDeclarationLine(`typedef struct {`);
    emitter.emitDeclarationLine(`  yo_ref_header_t header;`);
    emitter.emitDeclarationLine(`  ${valueTypeStr} value;`);
    emitter.emitDeclarationLine(`} ${boxTypeName};`);
    emitter.emitDeclarationLine("");

    // Generate box constructor declaration
    emitter.emitDeclarationLine(
      `${boxTypeName}* __yo_new_${boxTypeName}(${valueTypeStr} value);`
    );

    // Generate box dispose declaration
    emitter.emitDeclarationLine(`void __yo_dispose_${boxTypeName}(void* ptr);`);
    emitter.emitDeclarationLine("");
  }
}
