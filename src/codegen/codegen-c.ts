import { Emitter } from "../emitter";
import {
  AtomExpr,
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  FuncCallExpr,
} from "../expr";
import { FunctionValue, FuncValueId } from "../function-value";
import {
  EnumType,
  FunctionType,
  isEnumType,
  isFunctionSpecializable,
  isFunctionType,
  isStructType,
  isUnionType,
  isUnitType,
  StructType,
  Type,
  TypeId,
  TypeTag,
  typeToString,
  UnionType,
} from "../types";
import { generateModuleId } from "../utils";
import { isFunctionValue, isTypeValue, ModuleValue } from "../value";

export class CodeGeneratorC {
  private emitter: Emitter;

  /**
   * Collected types that need to be generated
   */
  private types: Record<TypeId, { type: Type; cName: string }> = {};

  /**
   * Collected functions that need to be generated
   */
  private functions: Record<
    FuncValueId,
    { type: FunctionType; value: FunctionValue; cName: string }
  > = {};

  /**
   * Extern functions
   */
  private externFunctions: Record<
    TypeId,
    { type: FunctionType; cName: string }
  > = {};

  /**
   * track the current function being generated for recur
   */
  private currentFunctionName: string = "";

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
    this.collectRequiredFunctions(moduleValue); // This has to be before types
    this.collectRequiredTypes(moduleValue);

    // Second pass: Generate type declarations
    this.generateTypeDeclarations();

    // Third pass: Generate function declarations (prototypes) for regular functions
    this.generateFunctionDeclarations();

    // Fourth pass: Generate all collected functions (this collects specialized functions)
    this.generateAllFunctions();

    // Fifth pass: Generate declarations for specialized functions (now that they're collected)
    this.generateSpecializedFunctionDeclarations();

    // Sixth pass: Generate the specialized function bodies
    this.generateMonomorphizedFunctions();
  }

  /**
   * First pass: collect all functions that need to be generated
   */
  private collectRequiredFunctions(moduleValue: ModuleValue): void {
    // Start with exported functions
    for (let i = 0; i < moduleValue.elements.length; i++) {
      const value = moduleValue.elements[i]!;
      const element = moduleValue.type.elements[i]!;

      if (isFunctionValue(value)) {
        const label = element.label;

        // Exported functions keep their original names (especially main)
        if (label === "main") {
          this.functions[value.funcId] = {
            type: value.type,
            value,
            cName: "main",
          };
        } else {
          this.functions[value.funcId] = {
            type: value.type,
            value,
            cName: value.funcId,
          };
        }

        // Recursively collect functions called by this function
        this.findFunctionCallsInExpr(value.body, moduleValue);
      }
    }
  }

  /**
   * Find function calls in an expression and collect them
   */
  private findFunctionCallsInExpr(expr: Expr, moduleValue: ModuleValue): void {
    if (exprIsFunctionCall(expr)) {
      const functionType = expr.func.$?.type;
      const functionValue = expr.func.$?.value;

      if (isFunctionType(functionType)) {
        if (isFunctionValue(functionValue)) {
          if (this.functions[functionValue.funcId]) {
            // Already collected this function
            return;
          } else {
            // Collect the function if it's not already collected
            this.functions[functionValue.funcId] = {
              type: functionType,
              value: functionValue,
              cName: functionValue.funcId, // Use the function id as the C name
            };
          }
        } else {
          // Might be the extern functions
          this.externFunctions[functionType.id] = {
            type: functionType,
            cName: exprIsAtom(expr.func)
              ? expr.func.token.value
              : functionType.id, // Use the type id as the C name if the func is not atom
          };
        }
      } else {
        // Recursively check the function call arguments
        for (const arg of expr.args) {
          this.findFunctionCallsInExpr(arg, moduleValue);
        }
      }
    }
  }

  /**
   * Collect all user-defined types that need to be generated
   */
  private collectRequiredTypes(moduleValue: ModuleValue): void {
    // Start with exports functions and collect types used in their signatures and bodies
    for (let i = 0; i < moduleValue.elements.length; i++) {
      const value = moduleValue.elements[i]!;

      if (isFunctionValue(value)) {
        // Collect types from function signatures
        this.collectTypesFromFunctionType(value.type);

        // Collect types from function body expressions
        this.collectTypesFromExpr(value.body);
      }
    }

    // Also collect types from non-exported functions we've already collected
    // Traverse this.functions
    for (const funcId in this.functions) {
      const func = this.functions[funcId]!;
      this.collectTypesFromFunctionType(func.type);
      this.collectTypesFromExpr(func.value.body);
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
    for (const param of functionType.typeParameters) {
      this.collectType(param.type);
    }
    for (const param of functionType.implicitParameters) {
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
      case ExprTag.FuncCall:
        // Collect types from function arguments
        for (const arg of expr.args) {
          this.collectTypesFromExpr(arg);
        }
        break;
      case ExprTag.Atom:
        // Nothing special for atoms
        break;
    }
  }

  /**
   * Collect a single type if it's a user-defined type
   */
  private collectType(type: Type): void {
    if (this.types[type.id]) {
      return; // Already collected this type
    }

    if (isStructType(type) || isUnionType(type) || isEnumType(type)) {
      // Use the struct's id to generate a mangled C type name
      const cTypeName = `yo_${type.id}`;
      this.types[type.id] = {
        type,
        cName: cTypeName,
      };
    }
  }

  /**
   * Generate type declarations for all collected types
   */
  private generateTypeDeclarations(): void {
    for (const typeId in this.types) {
      const { type, cName } = this.types[typeId]!;
      if (isStructType(type)) {
        this.generateStructDeclaration(type, cName);
      } else if (isUnionType(type)) {
        this.generateUnionDeclaration(type, cName);
      } else if (isEnumType(type)) {
        this.generateEnumDeclaration(type, cName);
      }
    }
  }

  /**
   * Generate a struct declaration
   */
  private generateStructDeclaration(
    structType: StructType,
    cName: string
  ): void {
    this.emitter.emitDeclarationLine(
      `typedef struct { // ${structType.typeName} : ${typeToString(structType)}`
    );

    for (const element of structType.elements) {
      const fieldTypeStr = this.getTypeString(element.type);
      const fieldName = element.label || "field";
      this.emitter.emitDeclarationLine(`  ${fieldTypeStr} ${fieldName};`);
    }

    this.emitter.emitDeclarationLine(`} ${cName};`);
    this.emitter.emitDeclarationLine(""); // Add blank line for readability
  }

  /**
   * Generate a union declaration
   */
  private generateUnionDeclaration(unionType: UnionType, cName: string): void {
    // Generate C union (not tagged union)
    this.emitter.emitDeclarationLine(
      `typedef union { // ${unionType.typeName} : ${typeToString(unionType)}`
    );

    for (const element of unionType.elements) {
      const fieldTypeStr = this.getTypeString(element.type);
      const fieldName = element.label || "field";
      this.emitter.emitDeclarationLine(`  ${fieldTypeStr} ${fieldName};`);
    }

    this.emitter.emitDeclarationLine(`} ${cName};`);
    this.emitter.emitDeclarationLine(""); // Add blank line for readability
  }

  /**
   * Generate an enum declaration (tagged union)
   */
  private generateEnumDeclaration(enumType: EnumType, cName: string): void {
    // Generate tag enum for discriminant
    const tagEnumName = `${cName}_tag`;
    this.emitter.emitDeclarationLine(`typedef enum {`);

    for (let i = 0; i < enumType.variants.length; i++) {
      const variant = enumType.variants[i];
      if (variant) {
        // Use fully mangled names for enum tags to avoid global scope conflicts
        const tagName = `${cName.toUpperCase()}_${variant.name.toUpperCase()}`;
        const comma = i < enumType.variants.length - 1 ? "," : "";
        this.emitter.emitDeclarationLine(`  ${tagName} = ${i}${comma}`);
      }
    }

    this.emitter.emitDeclarationLine(`} ${tagEnumName};`);
    this.emitter.emitDeclarationLine("");

    // Generate union for variant data
    const variantUnionName = `${cName}_data`;
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
    this.emitter.emitDeclarationLine(`} ${cName};`);
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
      case TypeTag.CInt:
        return "int"; // C int type
      case TypeTag.CChar:
        return "char"; // C char type
      case "Struct":
        // For struct types, use the mangled type name
        if (isStructType(type)) {
          const cTypeName = this.types[type.id]?.cName;
          if (!cTypeName) {
            throw new Error(
              `No C type name found for struct ${typeToString(type)}`
            );
          }
          return cTypeName;
        }
        return "struct_unknown";
      case "Union":
        // For union types, use the mangled type name
        if (isUnionType(type)) {
          const cTypeName = this.types[type.id]?.cName;
          if (!cTypeName) {
            throw new Error(
              `No C type name found for union ${typeToString(type)}`
            );
          }
          return cTypeName;
        }
        return "union_unknown";
      case "Enum":
        // For enum types, use the mangled type name
        if (isEnumType(type)) {
          const cTypeName = this.types[type.id]?.cName;
          if (!cTypeName) {
            throw new Error(
              `No C type name found for enum ${typeToString(type)}`
            );
          }
          return cTypeName;
        }
        return "enum_unknown";
      default:
        return `// Unknown type: ${typeToString(type)}`; // fallback
    }
  }

  /**
   * Check if a function is generic (has compile-time type parameters)
   */
  private isGenericFunction(functionValue: FunctionValue): boolean {
    return isFunctionSpecializable(functionValue.type);
  }

  /**
   * Generate function declarations (prototypes)
   */
  private generateFunctionDeclarations(): void {
    this.emitter.emitDeclarationLine(`// Function declarations`);

    // Generate declarations for extern functions first
    for (const key in this.externFunctions) {
      const { cName, type } = this.externFunctions[key]!;
      this.generateFunctionDeclaration(type, cName);
    }

    // Generate declarations for other functions
    for (const funcId in this.functions) {
      const { cName, type, value } = this.functions[funcId]!;
      if (this.isGenericFunction(value)) {
        continue;
      }
      this.generateFunctionDeclaration(type, cName);
    }
  }

  /**
   * Generate a function declaration (prototype)
   */
  private generateFunctionDeclaration(
    functionType: FunctionType,
    cFunctionName: string
  ): void {
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
      `${returnTypeStr} ${cFunctionName}(${params}); // ${yoTypeStr}`
    );
  }

  /**
   * Generate all collected functions
   */
  private generateAllFunctions(): void {
    this.emitter.emitLine(`// Function implementations`);

    for (const funcId in this.functions) {
      const { value, cName } = this.functions[funcId]!;

      // If the function is generic, we will handle it later
      if (this.isGenericFunction(value)) {
        continue;
      }

      // Generate the function body
      this.generateFunction(value, cName);
    }
  }

  /**
   * Generate C code for a function
   */
  private generateFunction(
    functionValue: FunctionValue,
    cFunctionName: string
  ): void {
    // Use provided C function name or default to label
    const functionName = cFunctionName;
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

    this.emitter.emitLine(`${returnTypeStr} ${functionName}(${params}) {`);

    // Set current function name for recur support
    const previousFunctionName = this.currentFunctionName;
    this.currentFunctionName = functionName;

    // Generate function body with proper return handling
    this.generateFunctionBody(functionValue.body, functionType, "  ");

    // Restore previous function name
    this.currentFunctionName = previousFunctionName;

    this.emitter.emitLine(`}`);
  }

  /**
   * Generate function body with proper return handling
   */
  private generateFunctionBody(
    expr: Expr,
    functionType: FunctionType,
    indent: string
  ): void {
    if (
      exprIsFunctionCall(expr) &&
      exprIsFunctionCallOf(expr, BuiltinKeywords.begin)
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
      } else {
        // For other functions, return the expression
        this.generateReturnStatement(expr, indent);
      }
    }
  }

  /**
   * Generate C code for an expression
   */
  private generateExpr(expr: Expr, indent: string): string {
    switch (expr.tag) {
      case ExprTag.FuncCall:
        return this.generateFuncCall(expr, indent);
      case ExprTag.Atom:
        return this.generateAtom(expr);
    }
  }

  /**
   * Generate C code for a function call expression
   */
  private generateFuncCall(expr: FuncCallExpr, indent: string): string {
    if (exprIsFunctionCallOf(expr, ":=", 2)) {
      const lhs = expr.args[0]!;
      const rhs = expr.args[1]!;

      if (exprIsAtom(lhs)) {
        const varName = lhs.token.value;
        if (!lhs.$?.type) {
          return `// Error: No type information for variable ${varName}\n`;
        }

        const varType = this.getTypeString(lhs.$.type);
        // Transpile the rhs
        const rhsCode = this.generateExpr(rhs, indent);
        // Assign to lhs
        if (!isUnitType(lhs.$.type)) {
          this.emitter.emitLine(`${indent}${varType} ${varName} = ${rhsCode};`);
        }
        return "";
      }
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.begin)) {
      const tempVariableName = expr.$?.variableName;
      const valueType = expr.$?.type;
      if (tempVariableName && valueType) {
        if (!isUnitType(valueType)) {
          this.emitter.emitLine(
            `${indent}${this.getTypeString(valueType)} ${tempVariableName};`
          );
        }

        // Evaluate each argument
        this.emitter.emitLine(`${indent}{ // begin block`);
        const argsCode = expr.args.map((arg) =>
          this.generateExpr(arg, indent + "  ")
        );
        if (!isUnitType(valueType)) {
          this.emitter.emitLine(
            `${indent}  ${tempVariableName} = ${argsCode[argsCode.length - 1]};`
          );
        }
        this.emitter.emitLine(`${indent}} // end begin block`);

        return tempVariableName;
      }
    } else {
      const functionType = expr.func.$?.type;
      const functionValue = expr.func.$?.value;
      if (isFunctionType(functionType)) {
        // Evaluate each argument
        const argsCode = expr.args.map((arg) => this.generateExpr(arg, indent));

        if (isFunctionValue(functionValue)) {
          // Normal function call
        } else {
          // Might be extern function or a built-in
          const externFunction = this.externFunctions[functionType.id];
          if (externFunction) {
            // Generate extern function call
            const cFuncName = externFunction.cName;
            const argsList = argsCode.join(", ");
            return `${cFuncName}(${argsList})`;
          }
        }
      } else if (isTypeValue(functionValue)) {
        if (isStructType(functionValue.value)) {
          console.log("Found struct type function call:");
        }
      }
    }

    return `// Failed to transpile ${exprToString(expr)}`;
  }

  /**
   * Generate C code for an atom expression
   */
  private generateAtom(expr: AtomExpr): string {
    return expr.token.value;
  }

  /**
   * Generate a return statement for a function body expression
   */
  private generateReturnStatement(expr: Expr, indent: string): void {
    switch (expr.tag) {
      case ExprTag.Atom: {
        // Use generateExpressionAsCode to handle compile-time values
        const atomCode = this.generateAtom(expr);
        this.emitter.emitLine(`${indent}return ${atomCode};`);
        break;
      }
      case ExprTag.FuncCall: {
        // Return the result of a function call
        const funcCallCode = this.generateFuncCall(expr, indent);
        this.emitter.emitLine(`${indent}return ${funcCallCode};`);
        break;
      }
    }
  }

  /**
   * Generate declarations for specialized (monomorphized) functions
   */
  private generateSpecializedFunctionDeclarations(): void {}

  /**
   * Generate the bodies of specialized (monomorphized) functions
   */
  private generateMonomorphizedFunctions(): void {}

  public print(): string {
    return this.emitter.print();
  }
}
