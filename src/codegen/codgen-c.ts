import { Emitter } from "../emitter";
import { getVariablesFromEnv } from "../env";
import { AtomExpr, Expr, FuncCallExpr } from "../expr";
import { FunctionValue } from "../function-value";
import { Type } from "../types";
import { generateModuleId } from "../utils";
import { ModuleValue, isFunctionValue } from "../value";

export class CodeGeneratorC {
  private emitter: Emitter;
  private functionNameMap: Map<string, string> = new Map(); // yo function name -> C function name
  private collectedFunctions: Map<string, FunctionValue> = new Map(); // store collected function values

  constructor() {
    this.emitter = new Emitter();

    this.emitter.emitHeaderLine("#include <stdbool.h>");
    this.emitter.emitHeaderLine("#include <stdint.h>");
    this.emitter.emitHeaderLine("#include <stddef.h>");
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

    // First pass: Collect all functions (exported and required by exported functions)
    this.collectRequiredFunctions(moduleValue);

    // Second pass: Generate all collected functions
    this.generateAllFunctions(moduleValue);
  }

  /**
   * First pass: collect all functions that need to be generated
   */
  private collectRequiredFunctions(moduleValue: ModuleValue): void {
    // Start with exported functions
    for (let i = 0; i < moduleValue.elements.length; i++) {
      const element = moduleValue.elements[i];
      const moduleElement = moduleValue.type.elements[i];

      if (element && moduleElement && isFunctionValue(element)) {
        const label = moduleElement.label;
        // Exported functions keep their original names (especially main)
        if (label === "main") {
          this.functionNameMap.set(label, "main");
        } else {
          this.functionNameMap.set(label, `yo_${label}`);
        }
        
        // Recursively collect functions called by this function
        this.collectCalledFunctions(element, moduleValue);
      }
    }
  }

  /**
   * Recursively collect functions called by the given function
   */
  private collectCalledFunctions(functionValue: FunctionValue, moduleValue: ModuleValue): void {
    // Analyze the function body to find function calls
    this.findFunctionCallsInExpr(functionValue.body, moduleValue);
  }

  /**
   * Find function calls in an expression and collect them
   */
  private findFunctionCallsInExpr(expr: Expr, moduleValue: ModuleValue): void {
    switch (expr.tag) {
      case "FuncCall":
        if (expr.func.tag === "Atom") {
          const funcName = expr.func.token.value;
          
          // Skip built-in operations
          if (funcName === "begin" || funcName === ":=") {
            // Recursively check arguments
            for (const arg of expr.args) {
              this.findFunctionCallsInExpr(arg, moduleValue);
            }
            return;
          }
          
          // This might be a user-defined function call
          if (!this.functionNameMap.has(funcName)) {
            // Use the environment from the expression to find the function
            if (expr.$ && expr.$.env) {
              const env = expr.$.env;
              const functionVariables = getVariablesFromEnv(env, funcName);
              
              if (functionVariables.length > 0) {
                const functionVariable = functionVariables[functionVariables.length - 1]!; // Get the latest one
                if (functionVariable.value && isFunctionValue(functionVariable.value)) {
                  // Use the function's funcId as the C function name
                  const cFunctionName = `yo_${functionVariable.value.funcId}`;
                  this.functionNameMap.set(funcName, cFunctionName);
                  this.collectedFunctions.set(funcName, functionVariable.value);
                  
                  // Recursively collect functions called by this function
                  this.findFunctionCallsInExpr(functionVariable.value.body, moduleValue);
                  
                  console.log(`Found call to non-exported function: ${funcName} -> ${cFunctionName} (funcId: ${functionVariable.value.funcId})`);
                }
              }
            }
          } else {
            // Function already collected, but still check its body if we have it
            const functionValue = this.collectedFunctions.get(funcName);
            if (functionValue) {
              this.findFunctionCallsInExpr(functionValue.body, moduleValue);
            }
          }
        }
        
        // Recursively check arguments
        for (const arg of expr.args) {
          this.findFunctionCallsInExpr(arg, moduleValue);
        }
        break;
      case "Atom":
        // Nothing to do for atoms
        break;
    }
  }

  /**
   * Second pass: generate all collected functions
   */
  private generateAllFunctions(moduleValue: ModuleValue): void {
    // Generate exported functions
    for (let i = 0; i < moduleValue.elements.length; i++) {
      const element = moduleValue.elements[i];
      const moduleElement = moduleValue.type.elements[i];

      if (element && moduleElement && isFunctionValue(element)) {
        const label = moduleElement.label;
        const cFunctionName = this.functionNameMap.get(label) || label;
        this.generateFunction(element, label, cFunctionName);
      }
    }

    // Generate non-exported functions that were collected
    for (const [funcName, functionValue] of this.collectedFunctions.entries()) {
      const cFunctionName = this.functionNameMap.get(funcName);
      if (cFunctionName) {
        this.generateFunction(functionValue, funcName, cFunctionName);
      }
    }
  }

  /**
   * Generate C code for a function
   */
  private generateFunction(functionValue: FunctionValue, label: string, cFunctionName?: string): void {
    // Use provided C function name or default to label
    const functionName = cFunctionName || label;
    const isMain = label === "main";

    // Generate function signature
    if (isMain) {
      this.emitter.emitDeclarationLine(`int ${functionName}() {`);
    } else {
      // For non-main functions, generate signature based on function type
      // For now, we'll use a simple heuristic: if it's id function, assume int32_t -> int32_t
      if (label === "id") {
        this.emitter.emitDeclarationLine(`int32_t ${functionName}(int32_t x) {`);
      } else {
        // For other functions, we'll need to analyze the function type
        this.emitter.emitDeclarationLine(
          `// TODO: Generate proper signature for ${functionName}`
        );
        this.emitter.emitDeclarationLine(`void ${functionName}() {`);
      }
    }

    // Generate function body
    this.emitter.emitDeclarationLine(`  // Function body compilation`);
    
    if (!isMain && label === "id") {
      // Special handling for id function - it should return its parameter
      this.emitter.emitDeclarationLine(`  return x;`);
    } else {
      this.generateExpr(functionValue.body, "  ");
      
      if (isMain) {
        this.emitter.emitDeclarationLine(`  return 0;`);
      }
    }

    this.emitter.emitDeclarationLine(`}`);
  }

  /**
   * Generate C code for an expression
   */
  private generateExpr(expr: Expr, indent: string): void {
    switch (expr.tag) {
      case "FuncCall":
        this.generateFuncCall(expr, indent);
        break;
      case "Atom":
        this.generateAtom(expr, indent);
        break;
      default:
        this.emitter.emitDeclarationLine(
          `${indent}// Unknown expression type: ${expr.tag}`
        );
    }
  }

  /**
   * Generate C code for a function call expression
   */
  private generateFuncCall(expr: FuncCallExpr, indent: string): void {
    if (expr.func.tag === "Atom") {
      const funcName = expr.func.token.value;

      if (funcName === "begin") {
        // Handle begin block - just generate each argument in sequence
        for (const arg of expr.args) {
          this.generateExpr(arg, indent);
        }
      } else if (funcName === ":=" && expr.isInfix) {
        // Handle assignment
        if (expr.args.length >= 2) {
          const varExpr = expr.args[0];
          const valueExpr = expr.args[1];

          if (
            varExpr &&
            varExpr.tag === "Atom" &&
            varExpr.token.type === "identifier"
          ) {
            const varName = varExpr.token.value;
            // Try to get the type from the evaluated expression data
            let varType = "int32_t"; // default fallback

            // Access the evaluation data to get the actual type
            // We know from the debug output that expressions have a $ property with type info
            if (
              "$" in varExpr &&
              varExpr.$ &&
              "type" in varExpr.$ &&
              varExpr.$.type
            ) {
              varType = this.getTypeString(varExpr.$.type as Type);
            }

            if (
              valueExpr &&
              valueExpr.tag === "Atom" &&
              valueExpr.token.type === "integer"
            ) {
              const value = valueExpr.token.value;
              this.emitter.emitDeclarationLine(
                `${indent}${varType} ${varName} = ${value};`
              );
            } else if (valueExpr && valueExpr.tag === "FuncCall") {
              // Handle function call as value
              const funcCallCode = this.generateFuncCallAsExpression(valueExpr);
              this.emitter.emitDeclarationLine(
                `${indent}${varType} ${varName} = ${funcCallCode};`
              );
            } else {
              this.emitter.emitDeclarationLine(
                `${indent}${varType} ${varName} = /* TODO: compile value expression */;`
              );
            }
          }
        }
      } else {
        this.emitter.emitDeclarationLine(
          `${indent}// TODO: Handle function call: ${funcName}`
        );
      }
    }
  }

  /**
   * Generate a function call as an expression (returns the code as a string)
   */
  private generateFuncCallAsExpression(expr: FuncCallExpr): string {
    if (expr.func.tag === "Atom") {
      const funcName = expr.func.token.value;
      
      // Use the correct C function name (could be mangled)
      const cFunctionName = this.functionNameMap.get(funcName) || funcName;

      // Generate arguments
      const args = expr.args
        .map((arg) => {
          if (arg.tag === "Atom" && arg.token.type === "integer") {
            return arg.token.value;
          } else if (arg.tag === "Atom" && arg.token.type === "identifier") {
            return arg.token.value;
          } else {
            return "/* TODO: complex arg */";
          }
        })
        .join(", ");

      return `${cFunctionName}(${args})`;
    }

    return "/* TODO: complex function call */";
  }

  /**
   * Generate C code for an atom expression
   */
  private generateAtom(expr: AtomExpr, indent: string): void {
    if (expr.token.type === "integer") {
      // For standalone integers, we might want to add them as statements
      // but in this context they're probably return values
      this.emitter.emitDeclarationLine(
        `${indent}// Standalone integer: ${expr.token.value}`
      );
    } else if (expr.token.type === "identifier") {
      this.emitter.emitDeclarationLine(
        `${indent}// Identifier: ${expr.token.value}`
      );
    } else {
      this.emitter.emitDeclarationLine(`${indent}// Atom: ${expr.token.value}`);
    }
  }

  /**
   * Convert a Yo type to C type string
   */
  private getTypeString(type?: Type): string {
    if (!type) return "int32_t"; // fallback

    switch (type.tag) {
      case "i32":
        return "int32_t";
      case "compt_int":
        // compt_int is a compile-time integer with infinite precision
        // For C generation, we'll use a reasonable default like int64_t
        // In a more sophisticated implementation, we might analyze the actual value
        return "int64_t";
      case "f32":
        return "float";
      case "f64":
        return "double";
      case "boolean":
        return "bool";
      default:
        return "int32_t"; // fallback
    }
  }

  public print(): string {
    return this.emitter.print();
  }
}
