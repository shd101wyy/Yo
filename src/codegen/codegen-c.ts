import { Emitter } from "../emitter";
import { generateModuleId } from "../utils";
import { ModuleValue } from "../value";
import { collectCIncludes, emitCIncludes } from "./c/collection";

// Import the modular components
import { collectRequiredFunctions } from "./functions/collection";
import {
  generateAllFunctions,
  generateFunctionDeclarations,
  generateSpecializedFunctionDeclarations,
  generateSpecializedFunctions,
} from "./functions/generation";
import { collectRequiredTypes } from "./types/collection";
import { generateTypeDeclarations } from "./types/generation";
import { CodeGenContext } from "./utils";

export class CodeGeneratorC {
  private emitter: Emitter;

  constructor() {
    this.emitter = new Emitter();
  }

  /**
   * Compile a module to C code
   * @param modulePath
   * @param moduleValue
   */
  public compileModule(modulePath: string, moduleValue: ModuleValue): void {
    this.emitter.emitDeclarationLine(`\n// Module ${modulePath}`);
    this.emitter.emitDeclarationLine(
      `// Module ID: ${generateModuleId(modulePath)}`
    );

    // Create contexts for the modular functions
    const context: CodeGenContext = {
      functions: {},
      externFunctions: {},
      types: {},
      arrayStructTypes: new Map(),
      sliceStructTypes: new Map(),
      currentFunctionName: "",
      emitter: this.emitter,
      cIncludes: new Set([
        "<stdbool.h>",
        "<stdint.h>",
        "<stddef.h>",
        "<stdarg.h>",
      ]),
    };

    // First pass: Collect all functions and types (exported and required by exported functions)
    collectRequiredFunctions(moduleValue, context);
    collectRequiredTypes(moduleValue, context);

    // Collect C includes from variables used in the module
    collectCIncludes(context);

    // Emit C include headers
    emitCIncludes(context);

    // Second pass: Generate type declarations
    generateTypeDeclarations(context);

    // Third pass: Generate function declarations (prototypes) for regular functions
    generateFunctionDeclarations(context);

    // Fourth pass: Generate all collected functions
    generateAllFunctions(context);

    // Fifth pass: Generate declarations for specialized functions (now that they're collected)
    generateSpecializedFunctionDeclarations(context);

    // Sixth pass: Generate the specialized function bodies
    generateSpecializedFunctions(context);
  }

  public print(): string {
    return this.emitter.print();
  }
}
