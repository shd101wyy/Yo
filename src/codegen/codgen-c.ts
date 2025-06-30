import { Emitter } from "../emitter";
import { getVariablesFromEnv } from "../env";
import { AtomExpr, Expr, FuncCallExpr } from "../expr";
import { FunctionValue } from "../function-value";
import { EnumType, FunctionType, StructType, Type, UnionType } from "../types";
import { isEnumType, isStructType, isUnionType } from "../types/guards";
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

  // Store generic function instantiations: "funcName" -> typeSignature -> {mangledName, typeArgs}
  private genericInstantiations: Map<
    string,
    Map<string, { mangledName: string; typeArgs: string[] }>
  > = new Map();

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

    // Second pass: Collect generic function instantiations
    this.collectGenericInstantiations(moduleValue);

    // Third pass: Generate type declarations
    this.generateTypeDeclarations();

    // Fourth pass: Generate function declarations (prototypes) including monomorphized functions
    this.generateFunctionDeclarations(moduleValue);
    this.generateMonomorphizedFunctionDeclarations();

    // Fifth pass: Generate all collected functions including monomorphized ones
    this.generateAllFunctions(moduleValue);
    this.generateMonomorphizedFunctions();
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
                } else if (
                  functionVariable.type &&
                  functionVariable.type.tag === "Function"
                ) {
                  // This might be an extern function (has type but no implementation)
                  const functionType = functionVariable.type as FunctionType;
                  this.functionNameMap.set(funcName, funcName); // extern functions keep their original names
                  this.externFunctions.set(funcName, functionType);
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

        // Skip generic functions - they will be handled via monomorphization
        if (this.isGenericFunction(element)) {
          continue;
        }

        const cFunctionName = this.functionNameMap.get(label) || label;
        this.generateFunctionDeclaration(element, label, cFunctionName);
      }
    }

    // Generate declarations for non-exported functions that were collected
    for (const [funcName, functionValue] of this.collectedFunctions.entries()) {
      // Skip monomorphized functions - they will be handled separately
      if (funcName.startsWith("yo_fn_mono_")) {
        continue;
      }

      // Skip generic functions - only monomorphized versions should be declared
      if (this.isGenericFunction(functionValue)) {
        continue;
      }

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

      // Generate parameter list (excluding compile-time parameters)
      const runtimeParams = functionType.parameters.filter(
        (param) => !param.isCompileTimeOnly
      );
      const params = runtimeParams
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

    // Generate parameter list (excluding compile-time parameters)
    const runtimeParams = functionType.parameters.filter(
      (param) => !param.isCompileTimeOnly
    );
    const params = runtimeParams
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

    // Generate non-exported functions that were collected (but skip generic functions)
    for (const [funcName, functionValue] of this.collectedFunctions.entries()) {
      // Skip if this is a generic function (it will be handled via monomorphization)
      if (this.isGenericFunction(functionValue)) {
        continue;
      }

      // Skip if this is a monomorphized function (it will be generated separately)
      if (funcName.includes("yo_fn_mono_")) {
        continue;
      }

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

    // Generate parameter list (excluding compile-time parameters)
    const runtimeParams = functionType.parameters.filter(
      (param) => !param.isCompileTimeOnly
    );
    const params = runtimeParams
      .map((param) => {
        const paramTypeStr = this.getTypeString(param.type);
        const paramName = param.label || "param";
        return `${paramTypeStr} ${paramName}`;
      })
      .join(", ");

    // For main function, use standard C main signature if it returns c_int with no runtime params
    if (
      isMain &&
      functionType.return.type.tag === "c_int" &&
      runtimeParams.length === 0
    ) {
      this.emitter.emitLine(`int ${functionName}() {`);
    } else {
      this.emitter.emitLine(`${returnTypeStr} ${functionName}(${params}) {`);
    }

    // Generate function body
    this.emitter.emitLine(`  // Function body compilation`);

    // Set current function name for recur support
    const previousFunctionName = this.currentFunctionName;
    this.currentFunctionName = functionName;

    // Generate function body with proper return handling
    this.generateFunctionBody(functionValue.body, functionType, isMain, "  ");

    // Restore previous function name
    this.currentFunctionName = previousFunctionName;

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

      // Check if this is a struct or union constructor call
      if (this.collectedTypes.has(funcName)) {
        const userType = this.collectedTypes.get(funcName);
        if (userType && isStructType(userType)) {
          // This is a struct constructor - handle it specially
          this.handleStructConstructor(expr, indent, userType);
          return;
        } else if (userType && isUnionType(userType)) {
          // This is a union constructor - handle it specially
          this.handleUnionConstructor(expr, indent, userType);
          return;
        }
      }

      if (funcName === "tuple") {
        // Handle tuple() calls - for unit values, generate nothing
        if (expr.args.length === 0) {
          // Empty tuple represents unit value - generate no C code
          return;
        } else {
          // Non-empty tuples - TODO: implement proper tuple handling
          this.emitter.emitLine(`${indent}// TODO: Handle non-empty tuple`);
          return;
        }
      } else if (funcName === "begin") {
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
              // Generate assignments for any complex arguments first
              for (const arg of valueExpr.args) {
                this.generateArgStatementsIfNeeded(arg, indent);
              }

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
      } else if (funcName === "::" && expr.isInfix) {
        // Handle compile-time type definition
        if (expr.args.length >= 2) {
          const typeNameExpr = expr.args[0];
          const typeDefExpr = expr.args[1];

          if (
            typeNameExpr &&
            typeNameExpr.tag === "Atom" &&
            typeNameExpr.token.type === "identifier"
          ) {
            const typeName = typeNameExpr.token.value;

            if (
              typeDefExpr &&
              typeDefExpr.tag === "FuncCall" &&
              typeDefExpr.func.tag === "Atom" &&
              typeDefExpr.func.token.value === "struct"
            ) {
              // Generate struct definition
              this.generateStructDefinition(typeName, typeDefExpr, indent);
            } else {
              this.emitter.emitLine(
                `${indent}// TODO: Handle type definition for ${typeName}`
              );
            }
          }
        }
      } else {
        // Handle regular function calls
        if (expr.$ && expr.$.variableName) {
          // This function call should be assigned to a temporary variable
          const varName = expr.$.variableName;
          const varType = this.getTypeString(expr.$.type);
          const funcCallCode = this.generateFuncCallAsExpression(expr);
          this.emitter.emitLine(
            `${indent}${varType} ${varName} = ${funcCallCode};`
          );
        } else {
          // Function call without assignment (rare case)
          const funcCallCode = this.generateFuncCallAsExpression(expr);
          this.emitter.emitLine(`${indent}${funcCallCode};`);
        }
      }
    }
  } /**
   * Generate a function call as an expression (returns the code as a string)
   */
  private generateFuncCallAsExpression(expr: FuncCallExpr): string {
    if (expr.func.tag === "Atom") {
      const funcName = expr.func.token.value;

      // Check if this is a struct or union constructor call
      if (this.collectedTypes.has(funcName)) {
        const userType = this.collectedTypes.get(funcName);
        if (userType && isStructType(userType)) {
          return this.generateStructConstructorExpression(expr, userType);
        } else if (userType && isUnionType(userType)) {
          return this.generateUnionConstructorExpression(expr, userType);
        } else if (userType && isEnumType(userType)) {
          return this.generateEnumConstructorExpression(expr, userType);
        }
      }

      // Handle special functions (fallback if no variable name available)
      if (funcName === "cond") {
        return this.generateCondExpressionAsValue(expr);
      }

      // Handle match expressions
      if (funcName === "match") {
        return this.generateMatchExpressionAsValue(expr);
      }

      // Handle recur - convert to recursive call to current function
      if (funcName === "recur") {
        return this.generateRecurAsExpression(expr);
      }

      // Handle field access operator
      if (funcName === ".") {
        return this.generateFieldAccess(expr);
      }

      // Use the correct C function name (could be mangled)
      let cFunctionName = this.functionNameMap.get(funcName) || funcName;

      // Check if this is a generic function call and get the monomorphized name
      const functionValue = this.collectedFunctions.get(funcName);
      if (functionValue && this.isGenericFunction(functionValue)) {
        const compileTimeParams = functionValue.type.parameters.filter(
          (p) => p.isCompileTimeOnly
        );
        const typeArgs = expr.args.slice(0, compileTimeParams.length);

        const typeSignature = typeArgs
          .map((arg) => {
            if (arg.tag === "Atom") {
              return arg.token.value;
            }
            return "unknown";
          })
          .join("_");

        const instantiations = this.genericInstantiations.get(funcName);
        const instantiationInfo = instantiations?.get(typeSignature);
        if (instantiationInfo) {
          cFunctionName = instantiationInfo.mangledName;
        }
      }

      // Get function type to filter out compile-time arguments
      const functionType = this.getFunctionTypeByName(funcName);
      let filteredArgs: string[];

      if (functionType) {
        // Filter arguments to only include those for runtime parameters
        const runtimeParamCount = functionType.parameters.filter(
          (p) => !p.isCompileTimeOnly
        ).length;
        const runtimeArgs = expr.args.slice(-runtimeParamCount); // Take the last N args (runtime args come after compile-time args)
        filteredArgs = runtimeArgs.map((arg) =>
          this.generateExpressionAsCode(arg)
        );
      } else {
        // Fallback: use all arguments if we don't have function type info
        filteredArgs = expr.args.map((arg) =>
          this.generateExpressionAsCode(arg)
        );
      }

      const args = filteredArgs.join(", ");
      return `${cFunctionName}(${args})`;
    } else if (
      expr.func.tag === "FuncCall" &&
      expr.func.func.tag === "Atom" &&
      expr.func.func.token.value === "."
    ) {
      // Handle enum variant constructor calls like Shape.Circle(3.2)
      return this.generateEnumVariantConstructor(expr);
    }

    return "/* TODO: complex function call */";
  }

  /**
   * Generate a function call as an expression without using pre-evaluated variable names
   */
  private generateFuncCallAsExpressionWithoutVariables(
    expr: FuncCallExpr
  ): string {
    if (expr.func.tag === "Atom") {
      const funcName = expr.func.token.value;

      // Check if this is a struct or union constructor call
      if (this.collectedTypes.has(funcName)) {
        const userType = this.collectedTypes.get(funcName);
        if (userType && isStructType(userType)) {
          return this.generateStructConstructorExpression(expr, userType);
        } else if (userType && isUnionType(userType)) {
          return this.generateUnionConstructorExpression(expr, userType);
        } else if (userType && isEnumType(userType)) {
          return this.generateEnumConstructorExpression(expr, userType);
        }
      }

      // Handle field access operator
      if (funcName === ".") {
        return this.generateFieldAccess(expr);
      }

      // Use the correct C function name (could be mangled)
      const cFunctionName = this.functionNameMap.get(funcName) || funcName;

      // Generate arguments - use pre-evaluated variables if they exist
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
    } else if (isUnionType(type) && type.typeName) {
      // Use the union's typeId to generate a mangled C type name
      const cTypeName = `yo_union_${type.typeId}`;
      this.typeNameMap.set(type.typeName, cTypeName);
      this.collectedTypes.set(type.typeName, type);
    } else if (isEnumType(type) && type.typeName) {
      // Use the enum's typeId to generate a mangled C type name
      const cTypeName = `yo_enum_${type.typeId}`;
      this.typeNameMap.set(type.typeName, cTypeName);
      this.collectedTypes.set(type.typeName, type);
    }
  }

  /**
   * Generate type declarations for all collected types
   */
  private generateTypeDeclarations(): void {
    for (const [, type] of this.collectedTypes.entries()) {
      if (isStructType(type)) {
        this.generateStructDeclaration(type);
      } else if (isUnionType(type)) {
        this.generateUnionDeclaration(type);
      } else if (isEnumType(type)) {
        this.generateEnumDeclaration(type);
      }
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

    this.emitter.emitDeclarationLine(
      `typedef struct { // ${structType.typeName} : ${typeToString(structType)}`
    );

    for (const element of structType.elements) {
      const fieldTypeStr = this.getTypeString(element.type);
      const fieldName = element.label || "field";
      this.emitter.emitDeclarationLine(`  ${fieldTypeStr} ${fieldName};`);
    }

    this.emitter.emitDeclarationLine(`} ${cTypeName};`);
    this.emitter.emitDeclarationLine(""); // Add blank line for readability
  }

  /**
   * Generate a union declaration
   */
  private generateUnionDeclaration(unionType: UnionType): void {
    if (!unionType.typeName) {
      console.warn("Cannot generate declaration for unnamed union");
      return;
    }

    const cTypeName = this.typeNameMap.get(unionType.typeName);
    if (!cTypeName) {
      console.warn(`No C type name found for union ${unionType.typeName}`);
      return;
    }

    // Generate C union (not tagged union)
    this.emitter.emitDeclarationLine(
      `typedef union { // ${unionType.typeName} : ${typeToString(unionType)}`
    );

    for (const element of unionType.elements) {
      const fieldTypeStr = this.getTypeString(element.type);
      const fieldName = element.label || "field";
      this.emitter.emitDeclarationLine(`  ${fieldTypeStr} ${fieldName};`);
    }

    this.emitter.emitDeclarationLine(`} ${cTypeName};`);
    this.emitter.emitDeclarationLine(""); // Add blank line for readability
  }

  /**
   * Generate an enum declaration (tagged union)
   */
  private generateEnumDeclaration(enumType: EnumType): void {
    if (!enumType.typeName) {
      console.warn("Cannot generate declaration for unnamed enum");
      return;
    }

    const cTypeName = this.typeNameMap.get(enumType.typeName);
    if (!cTypeName) {
      console.warn(`No C type name found for enum ${enumType.typeName}`);
      return;
    }

    // Generate tag enum for discriminant
    const tagEnumName = `${cTypeName}_tag`;
    this.emitter.emitDeclarationLine(`typedef enum {`);

    for (let i = 0; i < enumType.variants.length; i++) {
      const variant = enumType.variants[i];
      if (variant) {
        // Use fully mangled names for enum tags to avoid global scope conflicts
        const tagName = `${cTypeName.toUpperCase()}_${variant.name.toUpperCase()}`;
        const comma = i < enumType.variants.length - 1 ? "," : "";
        this.emitter.emitDeclarationLine(`  ${tagName} = ${i}${comma}`);
      }
    }

    this.emitter.emitDeclarationLine(`} ${tagEnumName};`);
    this.emitter.emitDeclarationLine("");

    // Generate union for variant data
    const variantUnionName = `${cTypeName}_data`;
    this.emitter.emitDeclarationLine(`typedef union {`);

    for (const variant of enumType.variants) {
      if (variant.elements && variant.elements.length > 0) {
        // Variant has data - create a struct for its fields using just the variant name
        const variantStructName = variant.name;
        this.emitter.emitDeclarationLine(`  struct {`);

        for (const element of variant.elements) {
          const fieldTypeStr = this.getTypeString(element.type);
          const fieldName = element.label || "field";
          this.emitter.emitDeclarationLine(`    ${fieldTypeStr} ${fieldName};`);
        }

        this.emitter.emitDeclarationLine(`  } ${variantStructName};`);
      }
    }

    this.emitter.emitDeclarationLine(`} ${variantUnionName};`);
    this.emitter.emitDeclarationLine("");

    // Generate the main tagged union struct
    this.emitter.emitDeclarationLine(
      `typedef struct { // ${enumType.typeName} : ${typeToString(enumType)}`
    );
    this.emitter.emitDeclarationLine(`  ${tagEnumName} tag;`);
    this.emitter.emitDeclarationLine(`  ${variantUnionName} data;`);
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
      case "unit":
        return "void";
      case "Struct":
        // For struct types, use the mangled type name
        if (isStructType(type) && type.typeName) {
          const cTypeName = this.typeNameMap.get(type.typeName);
          return cTypeName || type.typeName;
        }
        return "struct_unknown";
      case "Union":
        // For union types, use the mangled type name
        if (isUnionType(type) && type.typeName) {
          const cTypeName = this.typeNameMap.get(type.typeName);
          return cTypeName || type.typeName;
        }
        return "union_unknown";
      case "Enum":
        // For enum types, use the mangled type name
        if (isEnumType(type) && type.typeName) {
          const cTypeName = this.typeNameMap.get(type.typeName);
          return cTypeName || type.typeName;
        }
        return "enum_unknown";
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
   * Handle union constructor calls
   */
  private handleUnionConstructor(
    expr: FuncCallExpr,
    indent: string,
    unionType: UnionType
  ): void {
    // This method is called when we detect a union constructor call
    // For now, we'll treat it as a comment until we implement full union initialization
    const unionName = unionType.typeName || "UnknownUnion";
    this.emitter.emitLine(
      `${indent}// TODO: Union constructor for ${unionName} with ${expr.args.length} arguments`
    );
  }

  /**
   * Generate union constructor as an expression
   */
  private generateUnionConstructorExpression(
    expr: FuncCallExpr,
    unionType: UnionType
  ): string {
    const unionTypeName = unionType.typeName || "UnknownUnion";
    const cTypeName = this.typeNameMap.get(unionTypeName) || unionTypeName;

    // Parse the constructor arguments - expect "fieldName : value" pattern
    if (expr.args.length === 1) {
      const arg = expr.args[0];
      if (
        arg &&
        arg.tag === "FuncCall" &&
        arg.func.tag === "Atom" &&
        arg.func.token.value === ":"
      ) {
        // This is a named field constructor: "fieldName : value"
        const fieldNameExpr = arg.args[0];
        const valueExpr = arg.args[1];

        if (
          fieldNameExpr &&
          fieldNameExpr.tag === "Atom" &&
          fieldNameExpr.token.type === "identifier" &&
          valueExpr
        ) {
          const fieldName = fieldNameExpr.token.value;
          const valueCode = this.generateExpressionAsCode(valueExpr);

          // Generate C union compound literal (not tagged union)
          return `((${cTypeName}){.${fieldName} = ${valueCode}})`;
        }
      }
    }

    // Fallback for unrecognized patterns
    return `/* TODO: Union constructor for ${cTypeName} with complex args */`;
  }

  /**
   * Generate enum constructor as an expression (for direct enum type calls)
   */
  private generateEnumConstructorExpression(
    expr: FuncCallExpr,
    enumType: EnumType
  ): string {
    // This would handle direct enum type calls, but typically enums are called via variants
    const enumTypeName = enumType.typeName || "UnknownEnum";
    const cTypeName = this.typeNameMap.get(enumTypeName) || enumTypeName;
    return `/* TODO: Direct enum constructor for ${cTypeName} */`;
  }

  /**
   * Generate enum variant constructor (for calls like Shape.Circle(3.2))
   */
  private generateEnumVariantConstructor(expr: FuncCallExpr): string {
    // expr.func should be a field access like Shape.Circle
    if (
      expr.func.tag !== "FuncCall" ||
      expr.func.func.tag !== "Atom" ||
      expr.func.func.token.value !== "."
    ) {
      return "/* ERROR: Invalid enum variant constructor */";
    }

    const fieldAccessExpr = expr.func;
    if (fieldAccessExpr.args.length !== 2) {
      return "/* ERROR: Field access requires exactly 2 arguments */";
    }

    const enumTypeExpr = fieldAccessExpr.args[0];
    const variantExpr = fieldAccessExpr.args[1];

    if (!enumTypeExpr || !variantExpr) {
      return "/* ERROR: Invalid enum variant constructor arguments */";
    }

    // Get the enum type name
    if (
      enumTypeExpr.tag !== "Atom" ||
      enumTypeExpr.token.type !== "identifier"
    ) {
      return "/* ERROR: Enum type must be an identifier */";
    }

    // Get the variant name
    if (variantExpr.tag !== "Atom" || variantExpr.token.type !== "identifier") {
      return "/* ERROR: Variant name must be an identifier */";
    }

    const enumTypeName = enumTypeExpr.token.value;
    const variantName = variantExpr.token.value;

    // Check if this is a known enum type
    if (!this.collectedTypes.has(enumTypeName)) {
      return `/* ERROR: Unknown enum type ${enumTypeName} */`;
    }

    const enumType = this.collectedTypes.get(enumTypeName);
    if (!enumType || !isEnumType(enumType)) {
      return `/* ERROR: ${enumTypeName} is not an enum type */`;
    }

    const cTypeName = this.typeNameMap.get(enumTypeName) || enumTypeName;

    // Find the variant
    const variant = enumType.variants.find((v) => v.name === variantName);
    if (!variant) {
      return `/* ERROR: Variant ${variantName} not found in enum ${enumTypeName} */`;
    }

    // Generate the tag name using the fully mangled naming scheme
    const tagName = `${cTypeName.toUpperCase()}_${variantName.toUpperCase()}`;

    // Handle variant data
    if (variant.elements && variant.elements.length > 0) {
      // Variant has data fields
      if (expr.args.length === 0) {
        return `/* ERROR: Variant ${variantName} requires arguments */`;
      }

      // Check if we have positional or named arguments
      const hasNamedArgs = expr.args.some(
        (arg) =>
          arg.tag === "FuncCall" &&
          arg.func.tag === "Atom" &&
          arg.func.token.value === ":"
      );

      if (hasNamedArgs) {
        // Named field initialization
        const fieldAssignments: string[] = [];

        for (const arg of expr.args) {
          if (
            arg.tag === "FuncCall" &&
            arg.func.tag === "Atom" &&
            arg.func.token.value === ":"
          ) {
            const fieldNameExpr = arg.args[0];
            const valueExpr = arg.args[1];

            if (
              fieldNameExpr?.tag === "Atom" &&
              fieldNameExpr.token.type === "identifier" &&
              valueExpr
            ) {
              const fieldName = fieldNameExpr.token.value;
              const valueCode = this.generateExpressionAsCode(valueExpr);
              fieldAssignments.push(`.${fieldName} = ${valueCode}`);
            }
          }
        }

        const variantDataName = variantName;
        return `((${cTypeName}){.tag = ${tagName}, .data.${variantDataName} = {${fieldAssignments.join(", ")}}})`;
      } else {
        // Positional initialization
        const values = expr.args.map((arg) =>
          this.generateExpressionAsCode(arg)
        );

        if (variant.elements.length === 1) {
          // Single field variant - use same pattern as multi-field for consistency
          const fieldName = variant.elements[0]?.label || "field";
          const variantDataName = variantName;
          return `((${cTypeName}){.tag = ${tagName}, .data.${variantDataName} = {.${fieldName} = ${values[0]}}})`;
        } else {
          // Multiple field variant - use positional assignment
          const fieldAssignments = variant.elements.map((element, index) => {
            const fieldName = element.label || `field${index}`;
            const value = values[index] || "0";
            return `.${fieldName} = ${value}`;
          });

          const variantDataName = variantName;
          return `((${cTypeName}){.tag = ${tagName}, .data.${variantDataName} = {${fieldAssignments.join(", ")}}})`;
        }
      }
    } else {
      // Variant has no data - just the tag
      if (expr.args.length > 0) {
        return `/* ERROR: Variant ${variantName} does not accept arguments */`;
      }

      return `((${cTypeName}){.tag = ${tagName}})`;
    }
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
        // Generate assignments for any complex arguments first
        for (const arg of expr.args) {
          this.generateArgStatementsIfNeeded(arg, indent);
        }

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
    // Check if this expression has been pre-evaluated and has a variable name
    if (expr.$ && expr.$.variableName) {
      return expr.$.variableName;
    }

    switch (expr.tag) {
      case "Atom":
        if (expr.token.type === "identifier") {
          return expr.token.value;
        } else if (expr.token.type === "integer") {
          return expr.token.value;
        } else if (expr.token.type === "float") {
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

  /**
   * Generate field access for structs, unions, and enums
   */
  private generateFieldAccess(expr: FuncCallExpr): string {
    if (expr.args.length !== 2) {
      return "/* ERROR: field access requires exactly 2 arguments */";
    }

    const objectExpr = expr.args[0];
    const fieldExpr = expr.args[1];

    if (!objectExpr || !fieldExpr) {
      return "/* ERROR: invalid field access arguments */";
    }

    const objectCode = this.generateExpressionAsCode(objectExpr);

    if (fieldExpr.tag === "Atom" && fieldExpr.token.type === "identifier") {
      const fieldName = fieldExpr.token.value;

      // Check if the object is an enum type
      if (objectExpr.$ && objectExpr.$.type && isEnumType(objectExpr.$.type)) {
        const enumType = objectExpr.$.type;

        // For enum field access, we need to determine which variant contains this field
        // and generate the appropriate path: object.data.VariantName.fieldName
        for (const variant of enumType.variants) {
          if (variant.elements) {
            for (const element of variant.elements) {
              if (element.label === fieldName) {
                // Found the field in this variant
                const variantName = variant.name;
                return `${objectCode}.data.${variantName}.${fieldName}`;
              }
            }
          }
        }

        return `/* ERROR: field ${fieldName} not found in enum ${enumType.typeName} */`;
      } else {
        // For C structs and unions, access fields directly
        return `${objectCode}.${fieldName}`;
      }
    }

    return "/* ERROR: field name must be an identifier */";
  }

  /**
   * Generate a match expression as a value (C switch statement)
   */
  private generateMatchExpressionAsValue(expr: FuncCallExpr): string {
    if (expr.args.length < 2) {
      return "/* ERROR: match requires at least 2 arguments */";
    }

    // Check if the match expression has been evaluated and has a variable name
    if (expr.$ && expr.$.variableName) {
      const tempVar = expr.$.variableName;
      const varType = this.getTypeString(expr.$.type);

      // The first argument is the value to match
      const matchValue = expr.args[0];
      if (!matchValue) {
        return "/* ERROR: match value is missing */";
      }

      // Generate the variable declaration and the switch statement
      this.emitter.emitLine(`  ${varType} ${tempVar};`);

      // Generate the match value
      const matchValueCode = this.generateExpressionAsCode(matchValue);
      this.emitter.emitLine(`  switch (${matchValueCode}.tag) {`);

      // Process each case (starting from args[1])
      for (let i = 1; i < expr.args.length; i++) {
        const caseArg = expr.args[i];
        if (
          caseArg &&
          caseArg.tag === "FuncCall" &&
          caseArg.func.tag === "Atom" &&
          caseArg.func.token.value === "=>"
        ) {
          // This is a pattern => value pair
          const pattern = caseArg.args[0];
          const value = caseArg.args[1];

          if (pattern && value) {
            const caseLabel = this.generateMatchCaseLabel(pattern, matchValue);
            const valueCode = this.generateExpressionAsCode(value);

            this.emitter.emitLine(`    case ${caseLabel}:`);
            this.emitter.emitLine(`      ${tempVar} = ${valueCode};`);
            this.emitter.emitLine(`      break;`);
          }
        }
      }

      // Add a default case for safety
      this.emitter.emitLine(`    default:`);
      this.emitter.emitLine(
        `      ${tempVar} = 0; /* ERROR: unhandled match case */`
      );
      this.emitter.emitLine(`      break;`);
      this.emitter.emitLine(`  }`);

      return tempVar;
    }

    // Fallback for non-evaluated expressions
    return "/* TODO: match as expression */";
  }

  /**
   * Generate the case label for a match pattern
   */
  private generateMatchCaseLabel(pattern: Expr, matchValue: Expr): string {
    if (pattern.tag === "Atom" && pattern.token.type === "identifier") {
      const variantName = pattern.token.value;

      // Remove the leading dot if present (.Circle -> Circle)
      const cleanVariantName = variantName.startsWith(".")
        ? variantName.slice(1)
        : variantName;

      // Get the enum type from the match value
      if (matchValue.$ && matchValue.$.type && isEnumType(matchValue.$.type)) {
        const enumType = matchValue.$.type;
        const cTypeName =
          this.typeNameMap.get(enumType.typeName || "") || enumType.typeName;

        if (cTypeName) {
          return `${cTypeName.toUpperCase()}_${cleanVariantName.toUpperCase()}`;
        }
      }

      return `/* ERROR: Cannot generate case label for ${cleanVariantName} - no enum type found */`;
    } else if (
      pattern.tag === "FuncCall" &&
      pattern.func.tag === "Atom" &&
      pattern.func.token.value === "."
    ) {
      // Handle enum variant pattern like .Circle (single argument to ".")
      if (pattern.args.length === 1) {
        const variantExpr = pattern.args[0];

        if (
          variantExpr?.tag === "Atom" &&
          variantExpr.token.type === "identifier"
        ) {
          const variantName = variantExpr.token.value;

          // Get the enum type from the match value
          if (
            matchValue.$ &&
            matchValue.$.type &&
            isEnumType(matchValue.$.type)
          ) {
            const enumType = matchValue.$.type;
            const cTypeName =
              this.typeNameMap.get(enumType.typeName || "") ||
              enumType.typeName;

            if (cTypeName) {
              return `${cTypeName.toUpperCase()}_${variantName.toUpperCase()}`;
            }
          }
        }
      }

      // Legacy handling for field access pattern like (.enumType.Circle) - if we encounter it
      if (pattern.args.length === 2) {
        const variantExpr = pattern.args[1];

        if (
          variantExpr &&
          variantExpr.tag === "Atom" &&
          variantExpr.token.type === "identifier"
        ) {
          const variantName = variantExpr.token.value;

          // Get the enum type from the match value
          if (
            matchValue.$ &&
            matchValue.$.type &&
            isEnumType(matchValue.$.type)
          ) {
            const enumType = matchValue.$.type;
            const cTypeName =
              this.typeNameMap.get(enumType.typeName || "") ||
              enumType.typeName;

            console.log(
              `DEBUG: Found enum type: ${enumType.typeName}, cTypeName: ${cTypeName}`
            );

            if (cTypeName) {
              const result = `${cTypeName.toUpperCase()}_${variantName.toUpperCase()}`;
              console.log(`DEBUG: Generated case label: ${result}`);
              return result;
            }
          }
        }
      }

      return `/* ERROR: Invalid field access pattern */`;
    }

    // Add debug information to help understand the pattern structure
    const patternStr =
      pattern.tag === "Atom"
        ? `Atom(${pattern.token.type}: "${pattern.token.value}")`
        : `${pattern.tag}`;
    return `/* ERROR: Invalid match pattern: ${patternStr} */`;
  }

  /**
   * Generate assignment statements for expressions that have been evaluated to variables
   */
  private generateVariableAssignments(expr: Expr, indent: string): void {
    // If this expression has a variable name, generate its assignment statement
    if (expr.$ && expr.$.variableName) {
      // First, recursively generate assignments for any sub-expressions
      this.generateVariableAssignmentsRecursive(expr, indent);

      // Then generate the assignment for this expression
      const varName = expr.$.variableName;
      const varType = this.getTypeString(expr.$.type);

      if (
        expr.tag === "FuncCall" &&
        expr.func.tag === "Atom" &&
        expr.func.token.value === "begin"
      ) {
        // For begin expressions, generate the begin block logic
        this.generateBeginAssignment(expr, varName, varType, indent);
      } else {
        // For other expressions, generate a direct assignment
        const exprCode = this.generateExpressionAsCode(expr);
        this.emitter.emitLine(`${indent}${varType} ${varName} = ${exprCode};`);
      }
    }
  }

  /**
   * Recursively generate variable assignments for sub-expressions
   */
  private generateVariableAssignmentsRecursive(
    expr: Expr,
    indent: string
  ): void {
    if (expr.tag === "FuncCall") {
      // Check all arguments for variable assignments
      for (const arg of expr.args) {
        if (arg) {
          this.generateVariableAssignments(arg, indent);
        }
      }
    }
  }

  /**
   * Generate assignment for a begin expression
   */
  private generateBeginAssignment(
    expr: FuncCallExpr,
    varName: string,
    varType: string,
    indent: string
  ): void {
    const args = expr.args;

    // Declare the result variable first
    this.emitter.emitLine(`${indent}${varType} ${varName};`);

    // Create a scoped block for the begin expression
    this.emitter.emitLine(`${indent}{`);
    const innerIndent = indent + "  ";

    // Generate all expressions except the last as statements
    for (let i = 0; i < args.length - 1; i++) {
      const arg = args[i];
      if (arg) {
        this.generateExpr(arg, innerIndent);
      }
    }

    // Generate assignment for the last expression
    if (args.length > 0) {
      const lastExpr = args[args.length - 1];
      if (lastExpr) {
        if (lastExpr.tag === "FuncCall") {
          // Generate assignments for any complex arguments first
          for (const arg of lastExpr.args) {
            this.generateArgStatementsIfNeeded(arg, innerIndent);
          }

          const funcCallCode = this.generateFuncCallAsExpression(lastExpr);
          this.emitter.emitLine(`${innerIndent}${varName} = ${funcCallCode};`);
        } else {
          const lastCode = this.generateExpressionAsCode(lastExpr);
          this.emitter.emitLine(`${innerIndent}${varName} = ${lastCode};`);
        }
      }
    }

    this.emitter.emitLine(`${indent}}`);
  }

  /**
   * Generate assignment for a cond expression
   */
  private generateCondAssignment(
    expr: FuncCallExpr,
    varName: string,
    varType: string,
    indent: string
  ): void {
    const args = expr.args;

    // Declare the result variable first
    this.emitter.emitLine(`${indent}${varType} ${varName};`);

    // Generate if-else chain for each condition => value pair
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
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

          // For simple conditions like "true", just generate the code directly
          let conditionCode: string;
          if (condition.tag === "Atom" && condition.token.value === "true") {
            conditionCode = "true";
          } else if (
            condition.tag === "Atom" &&
            condition.token.value === "false"
          ) {
            conditionCode = "false";
          } else {
            conditionCode = this.generateExpressionAsCode(condition);
          }

          this.emitter.emitLine(`${indent}${ifKeyword} (${conditionCode}) {`);

          // Generate the value assignment
          if (
            value.tag === "FuncCall" &&
            value.func.tag === "Atom" &&
            value.func.token.value === "begin"
          ) {
            // Handle begin block as value
            const innerIndent = indent + "  ";

            // Generate all expressions except the last as statements
            for (let j = 0; j < value.args.length - 1; j++) {
              const valArg = value.args[j];
              if (valArg) {
                this.generateExpr(valArg, innerIndent);
              }
            }

            // Generate assignment for the last expression
            if (value.args.length > 0) {
              const lastExpr = value.args[value.args.length - 1];
              if (lastExpr) {
                if (lastExpr.tag === "FuncCall") {
                  const funcCallCode =
                    this.generateFuncCallAsExpression(lastExpr);
                  this.emitter.emitLine(
                    `${innerIndent}${varName} = ${funcCallCode};`
                  );
                } else {
                  const lastCode = this.generateExpressionAsCode(lastExpr);
                  this.emitter.emitLine(
                    `${innerIndent}${varName} = ${lastCode};`
                  );
                }
              }
            }
          } else {
            // Simple value assignment
            if (value.tag === "Atom" && value.token.type === "integer") {
              this.emitter.emitLine(
                `${indent}  ${varName} = ${value.token.value};`
              );
            } else {
              const valueCode = this.generateExpressionAsCode(value);
              this.emitter.emitLine(`${indent}  ${varName} = ${valueCode};`);
            }
          }

          this.emitter.emitLine(`${indent}}`);
        }
      }
    }
  }

  /**
   * Generate statements for complex expressions (begin, cond, match) that are used as function arguments
   */
  private generateArgStatementsIfNeeded(expr: Expr, indent: string): void {
    // Handle field access expressions (.operator)
    if (
      expr.tag === "FuncCall" &&
      expr.func.tag === "Atom" &&
      expr.func.token.value === "."
    ) {
      // For field access, recursively handle the object expression
      if (expr.args.length >= 1 && expr.args[0]) {
        this.generateArgStatementsIfNeeded(expr.args[0], indent);
      }
      return;
    }

    // Check if this expression has been pre-evaluated and has a variable name
    if (expr.$ && expr.$.variableName) {
      const varName = expr.$.variableName;
      const varType = this.getTypeString(expr.$.type);

      // Generate the assignment based on the expression type
      if (expr.tag === "FuncCall" && expr.func.tag === "Atom") {
        const funcName = expr.func.token.value;

        if (funcName === "begin") {
          // Generate begin block assignment
          this.generateBeginAssignment(expr, varName, varType, indent);
        } else if (funcName === "cond") {
          // Generate cond assignment
          this.generateCondAssignment(expr, varName, varType, indent);
        } else if (funcName === "match") {
          // Generate match assignment - for now just declare the variable
          this.emitter.emitLine(
            `${indent}${varType} ${varName}; // TODO: match logic`
          );
        } else {
          // Regular function call - generate assignment
          // First generate assignments for any complex arguments
          for (const arg of expr.args) {
            this.generateArgStatementsIfNeeded(arg, indent);
          }

          const funcCallCode = this.generateFuncCallAsExpression(expr);
          this.emitter.emitLine(
            `${indent}${varType} ${varName} = ${funcCallCode};`
          );
        }
      }
    }
  }

  /**
   * Generate struct definition from Yo source (Point :: struct(x: i32, y: i32))
   */
  private generateStructDefinition(
    typeName: string,
    structExpr: FuncCallExpr,
    indent: string
  ): void {
    // This is a compile-time definition, so it shouldn't generate runtime code
    // Instead, we need to register the struct type and generate the C typedef

    // For now, let's just add a comment indicating the struct definition
    this.emitter.emitLine(
      `${indent}// Struct definition: ${typeName} :: struct(...)`
    );

    // TODO: Parse the struct fields and create proper StructType
    // TODO: Register with collectedTypes
    // TODO: Generate C typedef declaration
  }

  /**
   * Get function type by name from collected functions
   */
  private getFunctionTypeByName(funcName: string): FunctionType | undefined {
    const functionValue = this.collectedFunctions.get(funcName);
    if (functionValue && functionValue.type.tag === "Function") {
      return functionValue.type;
    }
    return undefined;
  }

  /**
   * Collect all generic function instantiations by analyzing function calls
   */
  private collectGenericInstantiations(moduleValue: ModuleValue): void {
    // Start with exported functions
    for (let i = 0; i < moduleValue.elements.length; i++) {
      const element = moduleValue.elements[i];
      const moduleElement = moduleValue.type.elements[i];

      if (element && moduleElement && isFunctionValue(element)) {
        // Recursively collect generic instantiations from this function
        this.findGenericInstantiationsInExpr(element.body, moduleValue);
      }
    }
  }

  /**
   * Find generic function instantiations in an expression
   */
  private findGenericInstantiationsInExpr(
    expr: Expr,
    moduleValue: ModuleValue
  ): void {
    switch (expr.tag) {
      case "FuncCall":
        if (expr.func.tag === "Atom") {
          const funcName = expr.func.token.value;

          // Check if this is a call to a generic function
          const functionValue = this.collectedFunctions.get(funcName);
          if (functionValue && this.isGenericFunction(functionValue)) {
            this.recordGenericInstantiation(expr, funcName, functionValue);
          }
        }

        // Recursively check arguments
        for (const arg of expr.args) {
          this.findGenericInstantiationsInExpr(arg, moduleValue);
        }
        break;

      case "Atom":
        // Nothing to do for atoms
        break;

      default:
        // For other expression types, we might need to handle them in the future
        break;
    }
  }

  /**
   * Check if a function is generic (has compile-time type parameters)
   */
  private isGenericFunction(functionValue: FunctionValue): boolean {
    return functionValue.type.parameters.some(
      (param) => param.isCompileTimeOnly
    );
  }

  /**
   * Record a generic function instantiation
   */
  private recordGenericInstantiation(
    expr: FuncCallExpr,
    funcName: string,
    functionValue: FunctionValue
  ): void {
    // Extract compile-time type arguments (assuming they come first)
    const compileTimeParams = functionValue.type.parameters.filter(
      (p) => p.isCompileTimeOnly
    );
    const typeArgs = expr.args.slice(0, compileTimeParams.length);

    // Create type signature for this instantiation
    const typeSignature = typeArgs
      .map((arg) => {
        // For now, use a simple string representation of the type
        // In a full implementation, this would need to be more sophisticated
        if (arg.tag === "Atom") {
          return arg.token.value;
        }
        return "unknown";
      })
      .join("_");

    // Create mangled name for this instantiation
    const mangledName = this.createMangledName(funcName, typeSignature);

    // Store the instantiation
    if (!this.genericInstantiations.has(funcName)) {
      this.genericInstantiations.set(funcName, new Map());
    }

    // Avoid duplicates
    const existingInstantiations = this.genericInstantiations.get(funcName)!;
    if (existingInstantiations.has(typeSignature)) {
      return;
    }

    // Store type signature strings for comment generation
    const typeArgStrings = typeArgs.map((arg) => {
      if (arg.tag === "Atom") {
        return arg.token.value;
      }
      return "unknown";
    });

    existingInstantiations.set(typeSignature, {
      mangledName,
      typeArgs: typeArgStrings,
    });

    // Store the monomorphized function for later generation with type information
    this.storeMonomorphizedFunction(
      funcName,
      typeArgs,
      mangledName,
      functionValue
    );
  }

  /**
   * Create a mangled name for a generic function instantiation
   */
  private createMangledName(funcName: string, typeSignature: string): string {
    // Get the original C function name for this Yo function
    const originalCName =
      this.functionNameMap.get(funcName) || `yo_fn_${funcName}`;
    return `${originalCName}_${typeSignature}`;
  }

  /**
   * Store a monomorphized function for later generation
   */
  private storeMonomorphizedFunction(
    originalFuncName: string,
    typeArgs: Expr[],
    mangledName: string,
    originalFunction: FunctionValue
  ): void {
    // Avoid storing duplicates
    if (this.collectedFunctions.has(mangledName)) {
      return;
    }

    // Create a specialized version of the function with concrete types
    // For now, we'll store the original function and handle type substitution during generation
    const monomorphizedFunction: FunctionValue = {
      ...originalFunction,
      funcId: mangledName,
      funcName: mangledName,
    };

    // Store it in collected functions with the mangled name
    this.collectedFunctions.set(mangledName, monomorphizedFunction);
    this.functionNameMap.set(mangledName, mangledName);
  }

  /**
   * Generate monomorphized functions
   */
  private generateMonomorphizedFunctions(): void {
    for (const [
      funcName,
      instantiations,
    ] of this.genericInstantiations.entries()) {
      const originalFunction = this.collectedFunctions.get(funcName);
      if (!originalFunction) continue;

      for (const [, instantiationInfo] of instantiations.entries()) {
        const { mangledName } = instantiationInfo;
        const monomorphizedFunction = this.collectedFunctions.get(mangledName);
        if (monomorphizedFunction) {
          this.generateMonomorphizedFunction(
            originalFunction,
            monomorphizedFunction,
            mangledName
          );
        }
      }
    }
  }

  /**
   * Generate a single monomorphized function
   */
  private generateMonomorphizedFunction(
    originalFunction: FunctionValue,
    monomorphizedFunction: FunctionValue,
    mangledName: string
  ): void {
    const functionType = originalFunction.type;

    // Extract the concrete type from the mangled name
    const concreteType = this.extractConcreteTypeFromMangledName(mangledName);
    const concreteCType = this.getCTypeForConcreteType(concreteType);

    // Create specialized function type with concrete types
    const runtimeParams = functionType.parameters.filter(
      (param) => !param.isCompileTimeOnly
    );

    // Generate function signature with specialized types
    // For generic_id, the return type and parameter type should be the same (T)
    const params = runtimeParams
      .map((param) => {
        // Use concrete type for parameters that were generic (T)
        const paramTypeStr = concreteCType; // Assume the parameter type is T
        const paramName = param.label || "param";
        return `${paramTypeStr} ${paramName}`;
      })
      .join(", ");

    // Use concrete type for return type (assuming return type is T)
    const returnTypeStr = concreteCType;

    this.emitter.emitLine(`${returnTypeStr} ${mangledName}(${params}) {`);
    this.emitter.emitLine(`  // Monomorphized function body`);

    // Set current function name for recur support
    const previousFunctionName = this.currentFunctionName;
    this.currentFunctionName = mangledName;

    // Generate function body
    this.generateFunctionBody(originalFunction.body, functionType, false, "  ");

    // Restore previous function name
    this.currentFunctionName = previousFunctionName;

    this.emitter.emitLine(`}`);
  } /**
   * Generate declarations for monomorphized functions
   */
  private generateMonomorphizedFunctionDeclarations(): void {
    const generated = new Set<string>(); // Track already generated declarations

    for (const [
      funcName,
      instantiations,
    ] of this.genericInstantiations.entries()) {
      const originalFunction = this.collectedFunctions.get(funcName);
      if (!originalFunction) continue;

      for (const [, instantiationInfo] of instantiations.entries()) {
        const { mangledName, typeArgs } = instantiationInfo;

        // Skip if already generated
        if (generated.has(mangledName)) {
          continue;
        }
        generated.add(mangledName);

        const functionType = originalFunction.type;
        const runtimeParams = functionType.parameters.filter(
          (param) => !param.isCompileTimeOnly
        );

        // Extract concrete type and use it for specialized signature
        const concreteType =
          this.extractConcreteTypeFromMangledName(mangledName);
        const concreteCType = this.getCTypeForConcreteType(concreteType);

        const returnTypeStr = concreteCType; // Use concrete type for return
        const params = runtimeParams
          .map((param) => {
            const paramTypeStr = concreteCType; // Use concrete type for parameters
            const paramName = param.label || "param";
            return `${paramTypeStr} ${paramName}`;
          })
          .join(", ");

        // Build monomorphized signature comment: "generic_id : (i32, val: i32) -> i32"
        const allParamStrs = typeArgs.concat(
          runtimeParams.map((param) => {
            const typeStr = typeToString(param.type);
            const paramName = param.label || "param";
            return `${paramName}: ${typeStr}`;
          })
        );

        const returnTypeYoStr = typeToString(functionType.return.type);
        const monomorphizedSig = `${funcName} : (${allParamStrs.join(", ")}) -> ${returnTypeYoStr}`;

        this.emitter.emitDeclarationLine(
          `${returnTypeStr} ${mangledName}(${params}); // ${monomorphizedSig}`
        );
      }
    }
  }

  /**
   * Extract concrete type from mangled function name
   */
  private extractConcreteTypeFromMangledName(mangledName: string): string {
    // Extract type signature from mangled name: yo_fn_xxx_i32 -> i32
    const parts = mangledName.split("_");
    if (parts.length > 0) {
      return parts[parts.length - 1] || "unknown"; // Get the last part (type signature)
    }
    return "unknown";
  }

  /**
   * Get C type string for a concrete type name
   */
  private getCTypeForConcreteType(typeName: string): string {
    switch (typeName) {
      case "i32":
        return "int32_t";
      case "f64":
        return "double";
      case "f32":
        return "float";
      case "i64":
        return "int64_t";
      case "u32":
        return "uint32_t";
      case "boolean":
        return "bool";
      // For struct types, check if it's a collected type
      default: {
        if (this.collectedTypes.has(typeName)) {
          const userType = this.collectedTypes.get(typeName);
          if (userType && isStructType(userType)) {
            return this.getTypeString(userType);
          }
        }
        return typeName; // fallback
      }
    }
  }

  public print(): string {
    return this.emitter.print();
  }
}
