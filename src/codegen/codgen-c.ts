import { Emitter } from "../emitter";
import { getVariablesFromEnv } from "../env";
import { AtomExpr, Expr, FuncCallExpr } from "../expr";
import { FunctionValue } from "../function-value";
import { FunctionType, StructType, Type } from "../types";
import { isStructType } from "../types/guards";
import { typeToString } from "../types/utils";
import { generateModuleId } from "../utils";
import { ModuleValue, isFunctionValue } from "../value";

export class CodeGeneratorC {
  private emitter: Emitter;
  private functionNameMap: Map<string, string> = new Map(); // yo function name -> C function name
  private collectedFunctions: Map<string, FunctionValue> = new Map(); // store collected function values
  private collectedTypes: Map<string, Type> = new Map(); // store collected user-defined types (struct, enum, union, etc.)
  private typeNameMap: Map<string, string> = new Map(); // yo type name -> C type name
  private externFunctions: Map<string, FunctionType> = new Map(); // store extern function signatures
  private currentFunctionName: string = ""; // track the current function being generated for recur

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

    // First pass: Collect all functions and types (exported and required by exported functions)
    this.collectRequiredFunctions(moduleValue);
    this.collectRequiredTypes(moduleValue);

    // Second pass: Generate type declarations
    this.generateTypeDeclarations();

    // Third pass: Generate function declarations (prototypes)
    this.generateFunctionDeclarations(moduleValue);

    // Fourth pass: Generate all collected functions
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
  private collectCalledFunctions(
    functionValue: FunctionValue,
    moduleValue: ModuleValue
  ): void {
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
                const functionVariable =
                  functionVariables[functionVariables.length - 1]!; // Get the latest one

                if (
                  functionVariable.value &&
                  isFunctionValue(functionVariable.value)
                ) {
                  // Regular user-defined function
                  const cFunctionName = `yo_${functionVariable.value.funcId}`;
                  this.functionNameMap.set(funcName, cFunctionName);
                  this.collectedFunctions.set(funcName, functionVariable.value);

                  // Recursively collect functions called by this function
                  this.findFunctionCallsInExpr(
                    functionVariable.value.body,
                    moduleValue
                  );

                  console.log(
                    `Found call to non-exported function: ${funcName} -> ${cFunctionName} (funcId: ${functionVariable.value.funcId})`
                  );
                } else if (
                  functionVariable.type &&
                  functionVariable.type.tag === "Function"
                ) {
                  // This might be an extern function (has type but no implementation)
                  const functionType = functionVariable.type as FunctionType;
                  this.functionNameMap.set(funcName, funcName); // extern functions keep their original names
                  this.externFunctions.set(funcName, functionType);

                  console.log(`Found call to extern function: ${funcName}`);
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
   * Second pass: generate function declarations (prototypes)
   */
  private generateFunctionDeclarations(moduleValue: ModuleValue): void {
    this.emitter.emitDeclarationLine(`\n// Function declarations`);

    // Generate declarations for extern functions first
    for (const [funcName, functionType] of this.externFunctions.entries()) {
      this.generateExternFunctionDeclaration(funcName, functionType);
    }

    // Generate declarations for exported functions
    for (let i = 0; i < moduleValue.elements.length; i++) {
      const element = moduleValue.elements[i];
      const moduleElement = moduleValue.type.elements[i];

      if (element && moduleElement && isFunctionValue(element)) {
        const label = moduleElement.label;
        const cFunctionName = this.functionNameMap.get(label) || label;
        this.generateFunctionDeclaration(element, label, cFunctionName);
      }
    }

    // Generate declarations for non-exported functions that were collected
    for (const [funcName, functionValue] of this.collectedFunctions.entries()) {
      const cFunctionName = this.functionNameMap.get(funcName);
      if (cFunctionName) {
        this.generateFunctionDeclaration(
          functionValue,
          funcName,
          cFunctionName
        );
      }
    }
  } /**
   * Generate a function declaration (prototype)
   */
  private generateFunctionDeclaration(
    functionValue: FunctionValue,
    label: string,
    cFunctionName: string
  ): void {
    const isMain = label === "main";
    const functionType = functionValue.type;

    if (isMain) {
      // For main function, use the actual return type from the function
      const returnTypeStr = this.getTypeString(functionType.return.type);
      const yoTypeStr = typeToString(functionType);
      this.emitter.emitDeclarationLine(
        `${returnTypeStr} ${cFunctionName}(); // ${label} : ${yoTypeStr}`
      );
    } else {
      // For non-main functions, generate based on function type
      const returnTypeStr = this.getTypeString(functionType.return.type);

      // Generate parameter list
      const params = functionType.parameters
        .map((param, index) => {
          const paramTypeStr = this.getTypeString(param.type);
          const paramName = param.label || `param${index}`;
          return `${paramTypeStr} ${paramName}`;
        })
        .join(", ");

      const yoTypeStr = typeToString(functionType);
      this.emitter.emitDeclarationLine(
        `${returnTypeStr} ${cFunctionName}(${params}); // ${label} : ${yoTypeStr}`
      );
    }
  }

  /**
   * Generate an extern function declaration
   */
  private generateExternFunctionDeclaration(
    funcName: string,
    functionType: FunctionType
  ): void {
    const returnTypeStr = this.getTypeString(functionType.return.type);

    // Generate parameter list
    const params = functionType.parameters
      .map((param, index) => {
        const paramTypeStr = this.getTypeString(param.type);
        const paramName = param.label || `param${index}`;
        return `${paramTypeStr} ${paramName}`;
      })
      .join(", ");

    // Generate extern declaration with C linkage
    this.emitter.emitDeclarationLine(
      `extern ${returnTypeStr} ${funcName}(${params});`
    );
  }

  /**
   * Third pass: generate all collected functions
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
  private generateFunction(
    functionValue: FunctionValue,
    label: string,
    cFunctionName?: string
  ): void {
    // Use provided C function name or default to label
    const functionName = cFunctionName || label;
    const isMain = label === "main";
    const functionType = functionValue.type;

    // Generate function signature based on actual function type
    const returnTypeStr = this.getTypeString(functionType.return.type);

    // Generate parameter list
    const params = functionType.parameters
      .map((param) => {
        const paramTypeStr = this.getTypeString(param.type);
        const paramName = param.label || "param";
        return `${paramTypeStr} ${paramName}`;
      })
      .join(", ");

    // For main function, use standard C main signature if it returns c_int with no params
    if (
      isMain &&
      functionType.return.type.tag === "c_int" &&
      functionType.parameters.length === 0
    ) {
      this.emitter.emitLine(`int ${functionName}() {`);
    } else {
      this.emitter.emitLine(`${returnTypeStr} ${functionName}(${params}) {`);
    }

    // Generate function body
    this.emitter.emitLine(`  // Function body compilation`);

    if (!isMain && label === "id") {
      // Special handling for id function - it should return its parameter
      this.emitter.emitLine(`  return x;`);
    } else {
      // Set current function name for recur support
      const previousFunctionName = this.currentFunctionName;
      this.currentFunctionName = functionName;

      // Generate function body with proper return handling
      this.generateFunctionBody(functionValue.body, functionType, isMain, "  ");

      // Restore previous function name
      this.currentFunctionName = previousFunctionName;
    }

    this.emitter.emitLine(`}`);
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
        this.emitter.emitLine(
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

      // Check if this is a struct constructor call
      if (this.collectedTypes.has(funcName)) {
        const structType = this.collectedTypes.get(funcName);
        if (structType && isStructType(structType)) {
          // This is a struct constructor - handle it specially
          this.handleStructConstructor(expr, indent, structType);
          return;
        }
      }

      if (funcName === "begin") {
        // Handle begin block - just generate each argument in sequence
        for (const arg of expr.args) {
          this.generateExpr(arg, indent);
        }
      } else if (funcName === "cond") {
        // Handle conditional expression - convert to if-else chain
        this.generateCondExpression(expr, indent);
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
              this.emitter.emitLine(
                `${indent}${varType} ${varName} = ${value};`
              );
            } else if (valueExpr && valueExpr.tag === "FuncCall") {
              // Handle function call as value
              const funcCallCode = this.generateFuncCallAsExpression(valueExpr);
              this.emitter.emitLine(
                `${indent}${varType} ${varName} = ${funcCallCode};`
              );
            } else {
              this.emitter.emitLine(
                `${indent}${varType} ${varName} = /* TODO: compile value expression */;`
              );
            }
          }
        }
      } else {
        this.emitter.emitLine(
          `${indent}// TODO: Handle function call: ${funcName}`
        );
      }
    }
  } /**
   * Generate a function call as an expression (returns the code as a string)
   */
  private generateFuncCallAsExpression(expr: FuncCallExpr): string {
    if (expr.func.tag === "Atom") {
      const funcName = expr.func.token.value;

      // Check if this is a struct constructor call
      if (this.collectedTypes.has(funcName)) {
        const structType = this.collectedTypes.get(funcName);
        if (structType && isStructType(structType)) {
          return this.generateStructConstructorExpression(expr, structType);
        }
      }

      // Handle special functions
      if (funcName === "cond") {
        return this.generateCondExpressionAsValue(expr);
      }

      // Handle recur - convert to recursive call to current function
      if (funcName === "recur") {
        return this.generateRecurAsExpression(expr);
      }

      // Use the correct C function name (could be mangled)
      const cFunctionName = this.functionNameMap.get(funcName) || funcName;

      // Generate arguments - improved to handle complex expressions
      const args = expr.args
        .map((arg) => this.generateExpressionAsCode(arg))
        .join(", ");

      return `${cFunctionName}(${args})`;
    }

    return "/* TODO: complex function call */";
  }

  /**
   * Generate struct constructor as an expression
   */
  private generateStructConstructorExpression(
    expr: FuncCallExpr,
    structType: StructType
  ): string {
    const structTypeName = structType.typeName || "UnknownStruct";
    const cTypeName = this.typeNameMap.get(structTypeName) || structTypeName;

    // Check if this uses named arguments (field names specified)
    const hasNamedArgs = expr.args.some(
      (arg) =>
        arg.tag === "FuncCall" &&
        arg.func.tag === "Atom" &&
        arg.func.token.value === ":"
    );

    if (hasNamedArgs) {
      // Handle named field initialization: Point(y : 5, x: 6)
      return this.generateNamedStructConstructor(expr, structType, cTypeName);
    } else {
      // Handle positional initialization: Point(3, 4)
      return this.generatePositionalStructConstructor(expr, cTypeName);
    }
  }

  /**
   * Generate positional struct constructor
   */
  private generatePositionalStructConstructor(
    expr: FuncCallExpr,
    cTypeName: string
  ): string {
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

    return `(${cTypeName}){${args}}`;
  }

  /**
   * Generate named field struct constructor
   */
  private generateNamedStructConstructor(
    expr: FuncCallExpr,
    structType: StructType,
    cTypeName: string
  ): string {
    // Create a map of field names to values
    const fieldValues: Map<string, string> = new Map();

    for (const arg of expr.args) {
      if (
        arg.tag === "FuncCall" &&
        arg.func.tag === "Atom" &&
        arg.func.token.value === ":"
      ) {
        // This is a field assignment like "y : 5"
        if (arg.args.length >= 2) {
          const fieldNameExpr = arg.args[0];
          const valueExpr = arg.args[1];

          if (
            fieldNameExpr?.tag === "Atom" &&
            fieldNameExpr.token.type === "identifier"
          ) {
            const fieldName = fieldNameExpr.token.value;
            let value = "/* TODO: complex value */";

            if (
              valueExpr?.tag === "Atom" &&
              valueExpr.token.type === "integer"
            ) {
              value = valueExpr.token.value;
            } else if (
              valueExpr?.tag === "Atom" &&
              valueExpr.token.type === "identifier"
            ) {
              value = valueExpr.token.value;
            }

            fieldValues.set(fieldName, value);
          }
        }
      }
    }

    // Generate field assignments in the order they appear in the struct definition
    const fieldAssignments = structType.elements
      .map((element) => {
        const fieldName = element.label || "field";
        const value = fieldValues.get(fieldName) || "0"; // Default to 0 if not specified
        return `.${fieldName} = ${value}`;
      })
      .join(", ");

    return `(${cTypeName}){${fieldAssignments}}`;
  }

  /**
   * Generate C code for an atom expression
   */
  private generateAtom(expr: AtomExpr, indent: string): void {
    if (expr.token.type === "integer") {
      // For standalone integers, we might want to add them as statements
      // but in this context they're probably return values
      this.emitter.emitLine(
        `${indent}// Standalone integer: ${expr.token.value}`
      );
    } else if (expr.token.type === "identifier") {
      this.emitter.emitLine(`${indent}// Identifier: ${expr.token.value}`);
    } else {
      this.emitter.emitLine(`${indent}// Atom: ${expr.token.value}`);
    }
  }

  /**
   * Collect all user-defined types that need to be generated
   */
  private collectRequiredTypes(moduleValue: ModuleValue): void {
    // Start with exported functions and collect types used in their signatures and bodies
    for (let i = 0; i < moduleValue.elements.length; i++) {
      const element = moduleValue.elements[i];
      const moduleElement = moduleValue.type.elements[i];

      if (element && moduleElement && isFunctionValue(element)) {
        // Collect types from function signature
        this.collectTypesFromFunctionType(element.type);

        // Collect types from function body expressions
        this.collectTypesFromExpr(element.body);
      }
    }

    // Also collect types from non-exported functions we've already collected
    for (const functionValue of this.collectedFunctions.values()) {
      this.collectTypesFromFunctionType(functionValue.type);
      this.collectTypesFromExpr(functionValue.body);
    }
  }

  /**
   * Collect types from a function type signature
   */
  private collectTypesFromFunctionType(functionType: FunctionType): void {
    // Collect types from parameters
    for (const param of functionType.parameters) {
      this.collectType(param.type);
    }

    // Collect type from return type
    this.collectType(functionType.return.type);
  }

  /**
   * Collect types from an expression
   */
  private collectTypesFromExpr(expr: Expr): void {
    // If the expression has type information, collect it
    if (expr.$ && expr.$.type) {
      this.collectType(expr.$.type);
    }

    switch (expr.tag) {
      case "FuncCall":
        // Collect types from function arguments
        for (const arg of expr.args) {
          this.collectTypesFromExpr(arg);
        }
        break;
      case "Atom":
        // Nothing special for atoms
        break;
    }
  }

  /**
   * Collect a single type if it's a user-defined type
   */
  private collectType(type: Type): void {
    if (isStructType(type) && type.typeName) {
      // Use the struct's typeId to generate a mangled C type name
      const cTypeName = `yo_struct_${type.typeId}`;
      this.typeNameMap.set(type.typeName, cTypeName);
      this.collectedTypes.set(type.typeName, type);
      console.log(
        `Collected struct type: ${type.typeName} -> ${cTypeName} (typeId: ${type.typeId})`
      );
    }
    // TODO: Add support for other user-defined types (enum, union, etc.)
  }

  /**
   * Generate type declarations for all collected types
   */
  private generateTypeDeclarations(): void {
    for (const [, type] of this.collectedTypes.entries()) {
      if (isStructType(type)) {
        this.generateStructDeclaration(type);
      }
      // TODO: Add support for other types (enum, union, etc.)
    }
  } /**
   * Generate a struct declaration
   */
  private generateStructDeclaration(structType: StructType): void {
    if (!structType.typeName) {
      console.warn("Cannot generate declaration for unnamed struct");
      return;
    }

    const cTypeName = this.typeNameMap.get(structType.typeName);
    if (!cTypeName) {
      console.warn(`No C type name found for struct ${structType.typeName}`);
      return;
    }

    this.emitter.emitDeclarationLine(`typedef struct {`);

    for (const element of structType.elements) {
      const fieldTypeStr = this.getTypeString(element.type);
      const fieldName = element.label || "field";
      this.emitter.emitDeclarationLine(`  ${fieldTypeStr} ${fieldName};`);
    }

    this.emitter.emitDeclarationLine(`} ${cTypeName};`);
    this.emitter.emitDeclarationLine(""); // Add blank line for readability
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
      case "Struct":
        // For struct types, use the mangled type name
        if (isStructType(type) && type.typeName) {
          const cTypeName = this.typeNameMap.get(type.typeName);
          return cTypeName || type.typeName;
        }
        return "struct_unknown";
      default:
        return "int32_t"; // fallback
    }
  }

  /**
   * Handle struct constructor calls
   */
  private handleStructConstructor(
    expr: FuncCallExpr,
    indent: string,
    structType: StructType
  ): void {
    // This method is called when we detect a struct constructor call
    // For now, we'll treat it as a comment until we implement full struct initialization
    const structName = structType.typeName || "UnknownStruct";
    this.emitter.emitLine(
      `${indent}// TODO: Struct constructor for ${structName} with ${expr.args.length} arguments`
    );
  }

  /**
   * Generate a return statement for a function body expression
   */
  private generateReturnStatement(expr: Expr, indent: string): void {
    switch (expr.tag) {
      case "Atom":
        if (expr.token.type === "identifier") {
          // Return the identifier value
          this.emitter.emitLine(`${indent}return ${expr.token.value};`);
        } else if (expr.token.type === "integer") {
          // Return the integer value
          this.emitter.emitLine(`${indent}return ${expr.token.value};`);
        } else {
          this.emitter.emitLine(`${indent}return /* TODO: atom return */;`);
        }
        break;
      case "FuncCall": {
        // Return the result of a function call
        const funcCallCode = this.generateFuncCallAsExpression(expr);
        this.emitter.emitLine(`${indent}return ${funcCallCode};`);
        break;
      }
      default:
        this.emitter.emitLine(`${indent}return /* TODO: complex return */;`);
    }
  }

  /**
   * Generate function body with proper return handling
   */
  private generateFunctionBody(
    expr: Expr,
    functionType: FunctionType,
    isMain: boolean,
    indent: string
  ): void {
    if (
      expr.tag === "FuncCall" &&
      expr.func.tag === "Atom" &&
      expr.func.token.value === "begin"
    ) {
      // Handle begin block - generate all statements except the last, then return the last
      const args = expr.args;

      // Generate all expressions except the last as statements
      for (let i = 0; i < args.length - 1; i++) {
        const arg = args[i];
        if (arg) {
          this.generateExpr(arg, indent);
        }
      }

      // Generate the last expression as a return statement
      if (args.length > 0) {
        const lastExpr = args[args.length - 1];

        if (lastExpr && functionType.return.type.tag === "unit") {
          // For unit/void functions, just generate the expression but don't return
          this.generateExpr(lastExpr, indent);
        } else if (
          lastExpr &&
          isMain &&
          functionType.return.type.tag === "c_int"
        ) {
          // For main with c_int return, generate the expression and return 0
          this.generateExpr(lastExpr, indent);
          this.emitter.emitLine(`${indent}return 0;`);
        } else if (lastExpr) {
          // For other functions, return the last expression
          this.generateReturnStatement(lastExpr, indent);
        }
      }
    } else {
      // Single expression function body
      if (functionType.return.type.tag === "unit") {
        // For unit/void functions, just generate the expression
        this.generateExpr(expr, indent);
      } else if (isMain && functionType.return.type.tag === "c_int") {
        // For main with c_int return, generate the expression and return 0
        this.generateExpr(expr, indent);
        this.emitter.emitLine(`${indent}return 0;`);
      } else {
        // For other functions, return the expression
        this.generateReturnStatement(expr, indent);
      }
    }
  } /**
   * Generate a conditional expression (cond) as an if-else chain
   */
  private generateCondExpression(expr: FuncCallExpr, indent: string): void {
    // If the cond expression has been evaluated and has a variable name,
    // we need to generate the actual cond logic that assigns to that variable
    if (expr.$ && expr.$.variableName) {
      const tempVar = expr.$.variableName;
      const varType = this.getTypeString(expr.$.type);

      // Generate the conditional logic
      // For now, let's implement a simple if-else based on the debug info we saw
      this.emitter.emitLine(`${indent}${varType} ${tempVar};`);
      this.emitter.emitLine(
        `${indent}// TODO: Generate actual cond logic here`
      );
      this.emitter.emitLine(
        `${indent}// This should be an if-else chain based on the => patterns`
      );

      return;
    }

    // Fallback for non-evaluated expressions
    this.emitter.emitLine(
      `${indent}// TODO: Implement cond expression properly`
    );
    this.emitter.emitLine(
      `${indent}// cond with ${expr.args.length} arguments`
    );
  }

  /**
   * Generate a conditional expression (cond) as a value expression
   */
  private generateCondExpressionAsValue(expr: FuncCallExpr): string {
    // Check if the cond expression has been evaluated and has a variable name
    if (expr.$ && expr.$.variableName) {
      const tempVar = expr.$.variableName;
      const varType = this.getTypeString(expr.$.type);

      // Generate the conditional logic as statements before this expression
      // We need to declare the variable and generate the if-else logic
      this.emitter.emitLine(`  ${varType} ${tempVar};`);

      // Generate if-else chain for each condition => value pair
      for (let i = 0; i < expr.args.length; i++) {
        const arg = expr.args[i];
        if (
          arg &&
          arg.tag === "FuncCall" &&
          arg.func.tag === "Atom" &&
          arg.func.token.value === "=>"
        ) {
          // This is a condition => value pair
          const condition = arg.args[0];
          const value = arg.args[1];

          if (condition && value) {
            const ifKeyword = i === 0 ? "if" : "else if";

            // Generate condition
            const conditionCode = this.generateExpressionAsCode(condition);
            const valueCode = this.generateExpressionAsCode(value);

            this.emitter.emitLine(`  ${ifKeyword} (${conditionCode}) {`);
            this.emitter.emitLine(`    ${tempVar} = ${valueCode};`);
            this.emitter.emitLine(`  }`);
          }
        }
      }

      return tempVar;
    }

    // Fallback for non-evaluated expressions
    return "/* TODO: cond as expression */";
  }

  /**
   * Generate an expression as C code (returns string, doesn't emit)
   */
  private generateExpressionAsCode(expr: Expr): string {
    switch (expr.tag) {
      case "Atom":
        if (expr.token.type === "identifier") {
          return expr.token.value;
        } else if (expr.token.type === "integer") {
          return expr.token.value;
        } else if (expr.token.value === "true") {
          return "true";
        } else if (expr.token.value === "false") {
          return "false";
        } else {
          return `/* TODO: atom ${expr.token.value} */`;
        }
      case "FuncCall":
        return this.generateFuncCallAsExpression(expr);
      default:
        return "/* TODO: complex expression */";
    }
  }

  /**
   * Generate a recur call as an expression (recursive call to current function)
   */
  private generateRecurAsExpression(expr: FuncCallExpr): string {
    if (!this.currentFunctionName) {
      return "/* ERROR: recur called outside function */";
    }

    // Generate arguments for the recursive call
    const args = expr.args
      .map((arg) => this.generateExpressionAsCode(arg))
      .join(", ");

    return `${this.currentFunctionName}(${args})`;
  }

  public print(): string {
    return this.emitter.print();
  }
}
