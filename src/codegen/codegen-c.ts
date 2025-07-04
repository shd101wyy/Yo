import { Emitter } from "../emitter";
import {
  AtomExpr,
  BuiltinFunctions,
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
  ArrayType,
  EnumType,
  FunctionType,
  isArrayType,
  isEnumType,
  isFunctionSpecializable,
  isFunctionType,
  isMutPtrType,
  isMutRefType,
  isPtrType,
  isRefType,
  isStructType,
  isTupleType,
  isUnionType,
  isUnitType,
  StructType,
  TupleType,
  Type,
  typeContainsSomeType,
  TypeId,
  TypeTag,
  typeToString,
  UnionType,
} from "../types";
import { generateModuleId } from "../utils";
import {
  isBooleanValue,
  isFunctionValue,
  isNumberValue,
  isStructValue,
  isTypeValue,
  isUnknownValue,
  ModuleValue,
  Value,
  valueToString,
} from "../value";

const BuiltinCOperatorFunctions = [
  // Arithemtic
  ...BuiltinFunctions.__yo_op_add, // +
  ...BuiltinFunctions.__yo_op_sub, // -
  ...BuiltinFunctions.__yo_op_mul, // *
  ...BuiltinFunctions.__yo_op_div, // /
  ...BuiltinFunctions.__yo_op_mod, // %
  ...BuiltinFunctions.__yo_op_neg, // -

  // Relational
  ...BuiltinFunctions.__yo_op_eq, // ==
  ...BuiltinFunctions.__yo_op_neq, // !=
  ...BuiltinFunctions.__yo_op_lt, // <
  ...BuiltinFunctions.__yo_op_lte, // <=
  ...BuiltinFunctions.__yo_op_gt, // >
  ...BuiltinFunctions.__yo_op_gte, // >=

  // Logical
  ...BuiltinFunctions.__yo_op_and, // &&
  ...BuiltinFunctions.__yo_op_or, // ||
  ...BuiltinFunctions.__yo_op_not, // !

  // Bitwise
  ...BuiltinFunctions.__yo_op_bit_and,
  ...BuiltinFunctions.__yo_op_bit_or,
  ...BuiltinFunctions.__yo_op_xor,
  ...BuiltinFunctions.__yo_op_bit_complement,
  ...BuiltinFunctions.__yo_op_bit_left_shift,
  ...BuiltinFunctions.__yo_op_bit_right_shift,
];

const PrimitiveTypeTags = new Set([
  TypeTag.Boolean,
  TypeTag.Usize,
  TypeTag.Isize,
  TypeTag.U8,
  TypeTag.I8,
  TypeTag.U16,
  TypeTag.I16,
  TypeTag.U32,
  TypeTag.I32,
  TypeTag.U64,
  TypeTag.I64,
  TypeTag.F32,
  TypeTag.F64,
  TypeTag.CChar,
  TypeTag.CShort,
  TypeTag.CUShort,
  TypeTag.CInt,
  TypeTag.CUInt,
  TypeTag.CLong,
  TypeTag.CULong,
  TypeTag.CLongLong,
  TypeTag.CULongLong,
  TypeTag.CLongDouble,
]);

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
    { value: FunctionValue; cName: string }
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
    this.emitter.emitHeaderLine("#include <stdarg.h>");
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

    // Fourth pass: Generate all collected functions
    this.generateAllFunctions();

    // Fifth pass: Generate declarations for specialized functions (now that they're collected)
    this.generateSpecializedFunctionDeclarations();

    // Sixth pass: Generate the specialized function bodies
    this.generateSpecializedFunctions();
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
            value,
            cName: "main",
          };
        } else {
          this.functions[value.funcId] = {
            value,
            cName: value.funcId,
          };
        }

        // Recursively collect functions called by this function
        this.findFunctionCallsInExpr(value.body);
      }
    }
  }

  /**
   * Find function calls in an expression and collect them
   */
  private findFunctionCallsInExpr(expr: Expr): void {
    if (exprIsFunctionCall(expr)) {
      const functionType = expr.func.$?.type;
      const functionValue = expr.func.$?.value;

      if (expr.func.token.value === "?=") {
        // Skip the default value assignment in a module/function parameter?
        return;
      }

      if (isFunctionType(functionType)) {
        if (isFunctionValue(functionValue)) {
          if (this.functions[functionValue.funcId]) {
            // Already collected this function
            // return;
            // NOTE: We shouldn't return here, because it's arguments might be different
          } else {
            // Collect the function if it's not already collected
            this.functions[functionValue.funcId] = {
              value: functionValue,
              cName: functionValue.funcId, // Use the function id as the C name
            };

            // Recursively collect functions called by this function
            this.findFunctionCallsInExpr(functionValue.body);
          }
        } else if (functionType.isExtern === "c") {
          // Might be the extern functions
          this.externFunctions[functionType.id] = {
            type: functionType,
            cName: exprIsAtom(expr.func)
              ? expr.func.token.value
              : functionType.id, // Use the type id as the C name if the func is not atom
          };
        }
      }

      // Recursively check the function call arguments
      for (const arg of expr.args) {
        this.findFunctionCallsInExpr(arg);
      }
    }

    // expr might be anonymous function value
    const functionType = expr.$?.type;
    const functionValue = expr.$?.value;
    if (isFunctionType(functionType)) {
      if (isFunctionValue(functionValue)) {
        if (this.functions[functionValue.funcId]) {
          // Already collected this function
          return;
        } else {
          // Collect the function if it's not already collected
          this.functions[functionValue.funcId] = {
            value: functionValue,
            cName: functionValue.funcId, // Use the function id as the C name
          };

          // Recursively collect functions called by this function
          this.findFunctionCallsInExpr(functionValue.body);
        }
      }
    }
    // expr might be a compt function call that returns a type
    else if (isTypeValue(expr.$?.value)) {
      this.collectType(expr.$.value.value);
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
      this.collectTypesFromFunctionType(func.value.type);
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

        if (expr.$?.value && isTypeValue(expr.$.value)) {
          this.collectType(expr.$.value.value);
        }

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

    if (
      isStructType(type) ||
      isUnionType(type) ||
      isEnumType(type) ||
      isTupleType(type)
    ) {
      // Use the struct's id to generate a mangled C type name
      const cTypeName = `yo_${type.id}`;
      this.types[type.id] = {
        type,
        cName: cTypeName,
      };
    }
    // Check if it's primitive types
    else if (PrimitiveTypeTags.has(type.tag)) {
      this.types[type.id] = {
        type,
        cName: this.getTypeString(type),
      };
    }
    /*
    // NOTE: No need to collect pointer/reference types here,
    // Check if it's pointer/reference types
    else if (
      isPtrType(type) ||
      isMutPtrType(type) ||
      isRefType(type) ||
      isMutRefType(type)
    ) {
      // Use the base type's C name
      const baseType = type.type;
      const baseCName = this.getTypeString(baseType);
      const cName = `${baseCName}*`; // Pointer type in C
      this.types[type.id] = {
        type,
        cName,
      };
    }
    */
  }

  /**
   * Generate type declarations for all collected types
   */
  private generateTypeDeclarations(): void {
    for (const typeId in this.types) {
      const { type, cName } = this.types[typeId]!;
      if (typeContainsSomeType(type)) {
        continue; // Skip types that contain `SomeType` as they are not concrete types
      }

      if (isStructType(type)) {
        this.generateStructDeclaration(type, cName);
      } else if (isUnionType(type)) {
        this.generateUnionDeclaration(type, cName);
      } else if (isEnumType(type)) {
        this.generateEnumDeclaration(type, cName);
      } else if (isTupleType(type)) {
        // For tuples, we can generate a struct-like declaration
        this.generateTupleDeclaration(type, cName);
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
   * Generate a tuple declaration
   */
  private generateTupleDeclaration(tupleType: TupleType, cName: string): void {
    this.emitter.emitDeclarationLine(
      `typedef struct { // ${tupleType.typeName} : ${typeToString(tupleType)}`
    );

    for (const element of tupleType.elements) {
      const fieldTypeStr = this.getTypeString(element.type);
      const fieldName = element.label.match(/^\d+$/)
        ? `_${element.label}`
        : element.label;
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
        const tagName = this.getEnumVariantCName(enumType, variant.name);
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
   * Get C type string for variable declarations (handles arrays correctly)
   */
  private getVariableTypeString(type: Type, varName: string): string {
    if (isArrayType(type)) {
      const elementType = type.elementType;
      const length = type.length;
      if (isNumberValue(length)) {
        const elementTypeString = this.getTypeString(elementType);
        return `${elementTypeString} ${varName}[${length.value}]`;
      }
    }
    // For non-array types, use regular type string + variable name
    return `${this.getTypeString(type)} ${varName}`;
  }

  /**
   * Convert a Yo type to C type string
   */
  private getTypeString(type?: Type): string {
    if (!type) return "int32_t"; // fallback

    switch (type.tag) {
      case TypeTag.Unit:
        return "void";
      case TypeTag.Boolean:
        return "bool";
      case TypeTag.Usize:
        return "size_t"; // C size type
      case TypeTag.Isize:
        return "intptr_t"; // C pointer difference type
      case TypeTag.U8:
        return "uint8_t";
      case TypeTag.I8:
        return "int8_t";
      case TypeTag.U16:
        return "uint16_t";
      case TypeTag.I16:
        return "int16_t";
      case TypeTag.U32:
        return "uint32_t";
      case TypeTag.I32:
        return "int32_t";
      case TypeTag.U64:
        return "uint64_t";
      case TypeTag.I64:
        return "int64_t";
      case TypeTag.F32:
        return "float";
      case TypeTag.F64:
        return "double";
      case TypeTag.ComptInt:
        // compt_int is a compile-time integer with infinite precision
        // For C generation, we'll use a reasonable default like int64_t
        // In a more sophisticated implementation, we might analyze the actual value
        return "int64_t";
      case TypeTag.ComptFloat:
        return "double"; // For compt_float, we can use double
      // TODO: compt_string

      case TypeTag.CChar:
        return "char"; // C char type
      case TypeTag.CShort:
        return "short"; // C short type
      case TypeTag.CUShort:
        return "unsigned short"; // C unsigned short type
      case TypeTag.CInt:
        return "int"; // C int type
      case TypeTag.CUInt:
        return "unsigned int"; // C unsigned int type
      case TypeTag.CLong:
        return "long"; // C long type
      case TypeTag.CULong:
        return "unsigned long"; // C unsigned long type
      case TypeTag.CLongLong:
        return "long long"; // C long long type
      case TypeTag.CULongLong:
        return "unsigned long long"; // C unsigned long long type
      case TypeTag.CLongDouble:
        return "long double"; // C long double type
      case TypeTag.Tuple:
      case TypeTag.Struct:
      case TypeTag.Union:
      case TypeTag.Enum: {
        const cTypeName = this.types[type.id]?.cName;
        if (!cTypeName) {
          throw new Error(
            `No C type name found for struct ${typeToString(type)}`
          );
        }
        return cTypeName;
      }
      // Function type (function pointer)
      case TypeTag.Function: {
        const functionType = type as FunctionType;

        // C function pointer syntax: returnType (*)(paramTypes)
        return this.generateFunctionPrototype(functionType, "(*)");
      }
      // Fixed size array
      case TypeTag.Array: {
        const arrayType = type as ArrayType;
        const elementType = arrayType.elementType;
        const length = arrayType.length;
        if (isNumberValue(length)) {
          const elementTypeString = this.getTypeString(elementType);
          return `${elementTypeString}[${length.value}]`; // Fixed-size array
        }
      }
    }

    if (
      isPtrType(type) ||
      isMutPtrType(type) ||
      isRefType(type) ||
      isMutRefType(type)
    ) {
      const baseType = type.type;
      const isMutable = isMutPtrType(type) || isMutRefType(type);
      const baseTypeStr = this.getTypeString(baseType);
      if (isMutable) {
        return `${baseTypeStr}*`; // Mutable pointer
      } else {
        return `${baseTypeStr}* const`; // Immutable pointer
      }
    }

    return `// Unknown type: ${typeToString(type)}`; // fallback
  }

  private getEnumVariantCName(enumType: EnumType, variantName: string): string {
    const enumCName = this.types[enumType.id]?.cName;
    if (!enumCName) {
      throw new Error(
        `No C type name found for enum ${enumType.typeName} (${typeToString(enumType)})`
      );
    }
    return `${enumCName.toUpperCase()}_${variantName.toUpperCase()}`;
  }

  /**
   * Check if a function is generic (has compile-time type parameters)
   */
  private isGenericFunction(functionValue: FunctionValue): boolean {
    return isFunctionSpecializable(functionValue.type);
  }

  /**
   * Check if a function is for compile-time only
   */
  private isComptFunction(functionValue: FunctionValue): boolean {
    return functionValue.type.return.isCompileTimeOnly;
  }

  /**
   * Generate function declarations (prototypes)
   */
  private generateFunctionDeclarations(): void {
    this.emitter.emitDeclarationLine(`// Function declarations`);

    // Generate declarations for extern functions first
    this.emitter.emitDeclarationLine(`/// Extern functions`);
    for (const key in this.externFunctions) {
      const { cName, type } = this.externFunctions[key]!;
      if (type.isExtern === "yo") {
        continue; // Yo language extern types. No need to generate C declarations for them
      }
      this.generateFunctionDeclaration(type, cName, true);
    }
    this.emitter.emitDeclarationLine("");

    // Generate declarations for other functions
    this.emitter.emitDeclarationLine(`/// Regular functions`);
    for (const funcId in this.functions) {
      const { cName, value } = this.functions[funcId]!;
      if (this.isGenericFunction(value) || this.isComptFunction(value)) {
        continue;
      }
      this.generateFunctionDeclaration(value.type, cName);
    }
  }

  private generateFunctionPrototype(
    functionType: FunctionType,
    cFunctionName: string
  ): string {
    // For non-main functions, generate based on function type
    const returnTypeStr = this.getTypeString(functionType.return.type);

    // Generate parameter list (excluding compile-time parameters)
    const runtimeParams = functionType.parameters.filter(
      (param) => !param.isCompileTimeOnly
    );
    const params = runtimeParams
      .map((param, index) => {
        const paramName = param.label || `param${index}`;

        // Handle function pointer parameters specially
        if (isFunctionType(param.type)) {
          let functionPointerType = this.generateFunctionPrototype(
            param.type,
            "(*)"
          ).replace(" (*)(", ` (*${paramName})(`);

          if (!param.isMutable) {
            functionPointerType = `const ${functionPointerType}`;
          }

          return functionPointerType;
        } else {
          // Handle non-function parameters
          let paramTypeStr = this.getTypeString(param.type);

          if (!param.isMutable) {
            // If the parameter is not mutable, we can use a const pointer
            if (
              isPtrType(param.type) ||
              isMutPtrType(param.type) ||
              isRefType(param.type) ||
              isMutRefType(param.type)
            ) {
              paramTypeStr = `${paramTypeStr} const`;
            } else {
              paramTypeStr = `const ${paramTypeStr}`;
            }
          }

          return `${paramTypeStr} ${paramName}`;
        }
      })
      .join(", ");
    return `${returnTypeStr} ${cFunctionName}(${params})`;
  }

  /**
   * Generate a function declaration (prototype)
   */
  private generateFunctionDeclaration(
    functionType: FunctionType,
    cFunctionName: string,
    isExtern?: boolean
  ): void {
    const functionPrototype = this.generateFunctionPrototype(
      functionType,
      cFunctionName
    );
    const yoTypeStr = typeToString(functionType);
    this.emitter.emitDeclarationLine(
      `${isExtern ? "extern " : ""}${functionPrototype}; // ${yoTypeStr}`
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
      if (this.isGenericFunction(value) || this.isComptFunction(value)) {
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
    const functionType = functionValue.specializedType ?? functionValue.type;

    const functionPrototype = this.generateFunctionPrototype(
      functionType,
      cFunctionName
    );
    this.emitter.emitLine(`${functionPrototype} {`);

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
        const arg = args[i]!;
        const argCode = this.generateExpr(arg, indent);
        if (argCode) {
          // Emit the expression as a statement
          this.emitter.emitLine(`${indent}${argCode};`);
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
      if (isUnitType(functionType.return.type)) {
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
    // compile-time variable
    if (exprIsFunctionCallOf(expr, "::", 2)) {
      return "";
    }

    // bindings
    if (exprIsFunctionCallOf(expr, ":", 2)) {
      let lhs = expr.args[0]!;
      if (
        exprIsFunctionCall(lhs) &&
        exprIsFunctionCallOf(lhs, BuiltinKeywords.compt, 1)
      ) {
        // compile-time variable
        return "";
      }

      if (
        exprIsFunctionCall(lhs) &&
        exprIsFunctionCallOf(lhs, BuiltinKeywords.implicit, 1)
      ) {
        // implicit variable, just use the inner expression
        lhs = lhs.args[0]!;
      }

      let isMutable = false;
      if (
        exprIsFunctionCall(lhs) &&
        exprIsFunctionCallOf(lhs, BuiltinKeywords.mut, 1)
      ) {
        // mutable variable, just use the inner expression
        isMutable = true;
        lhs = lhs.args[0]!;
      }

      if (!lhs.$?.type) {
        return `// Error: No type information for left-hand side ${exprToString(lhs)}\n`;
      }
      const varName = lhs.token.value;
      const varTypeAndName = this.getVariableTypeString(lhs.$.type, varName);

      this.emitter.emitLine(
        // NOTE: We cannot assign "const" here.
        `${indent}${isMutable ? "" : ""}${varTypeAndName};`
      );
      return "";
    }
    // Initialization assignment
    else if (exprIsFunctionCallOf(expr, ":=", 2)) {
      let lhs = expr.args[0]!;
      const rhs = expr.args[1]!;

      if (
        exprIsFunctionCall(lhs) &&
        exprIsFunctionCallOf(lhs, BuiltinKeywords.compt, 1)
      ) {
        // compile-time variable
        return "";
      }

      // Check if it's destructurings
      if (expr.$?.runtimeDestructurings) {
        const runtimeDestructurings = expr.$.runtimeDestructurings;
        const rhsCode = this.generateExpr(rhs, indent);
        const rhsType = rhs.$?.type;
        runtimeDestructurings.forEach(({ label, type, variableName }) => {
          const varTypeAndName = this.getVariableTypeString(type, variableName);
          let fieldName = label.match(/^\d+$/) ? `_${label}` : label;

          if (rhsType && isTupleType(rhsType) && !label.match(/^\d+$/)) {
            const index = rhsType.elements.findIndex(
              (el) => el.label === label
            );
            fieldName = index >= 0 ? `_${index}` : fieldName;
          }

          this.emitter.emitLine(
            `${indent}${varTypeAndName} = ${rhsCode}.${fieldName}; // Destructuring ${label}`
          );
        });
        return "";
      }

      let isMutable = false;
      // let isImplicit = false;
      if (
        exprIsFunctionCall(lhs) &&
        exprIsFunctionCallOf(lhs, BuiltinKeywords.implicit, 1)
      ) {
        // isImplicit = true;
        lhs = lhs.args[0]!; // Get the actual variable being assigned
      }

      if (
        exprIsFunctionCall(lhs) &&
        exprIsFunctionCallOf(lhs, BuiltinKeywords.mut, 1)
      ) {
        isMutable = true;
        lhs = lhs.args[0]!; // Get the actual variable being mutated
      }

      if (exprIsAtom(lhs)) {
        const varName = lhs.token.value;
        if (!lhs.$?.type) {
          return `// Error: No type information for variable ${varName}\n`;
        }

        // Handle array initialization specially
        if (isArrayType(lhs.$.type)) {
          const arrayType = lhs.$.type;
          const arrayLength = arrayType.length;

          // Check if RHS is an array literal
          if (
            exprIsFunctionCall(rhs) &&
            exprIsFunctionCallOf(rhs, BuiltinKeywords.array)
          ) {
            // Direct initialization with array literal
            const varTypeAndName = this.getVariableTypeString(
              lhs.$.type,
              varName
            );
            const rhsCode = this.generateExpr(rhs, indent);
            this.emitter.emitLine(
              `${indent}${isMutable ? "" : "const "}${varTypeAndName} = ${rhsCode};`
            );
          } else {
            // Copying from another array - declare then copy element by element
            const varTypeAndName = this.getVariableTypeString(
              lhs.$.type,
              varName
            );
            // NOTE: We cannot assign "const" here because we will mutate the array later
            this.emitter.emitLine(`${indent}${varTypeAndName};`);

            // Copy elements
            const rhsCode = this.generateExpr(rhs, indent);
            if (isNumberValue(arrayLength)) {
              for (let i = 0; i < arrayLength.value; i++) {
                this.emitter.emitLine(
                  `${indent}${varName}[${i}] = ${rhsCode}[${i}];`
                );
              }
            }
          }
        } else {
          // Non-array initialization - use existing logic
          const varTypeAndName = this.getVariableTypeString(
            lhs.$.type,
            varName
          );
          const rhsCode = this.generateExpr(rhs, indent);
          if (!isUnitType(lhs.$.type)) {
            this.emitter.emitLine(
              `${indent}${isMutable ? "" : "const "}${varTypeAndName} = ${rhsCode};`
            );
          }
        }
        return "";
      }
    }
    // Assignent with mutability or initialization
    else if (exprIsFunctionCallOf(expr, "=", 2)) {
      let lhs = expr.args[0]!;
      const rhs = expr.args[1]!;

      let isInitialization = false;
      let isMutable = false;
      if (exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, ":", 2)) {
        isInitialization = true;
        lhs = lhs.args[0]!; // Get the actual variable being assigned
      }
      if (
        exprIsFunctionCall(lhs) &&
        exprIsFunctionCallOf(lhs, BuiltinKeywords.compt)
      ) {
        // compile-time variable
        return "";
      }
      if (
        exprIsFunctionCall(lhs) &&
        exprIsFunctionCallOf(lhs, BuiltinKeywords.implicit, 1)
      ) {
        // implicit variable, just use the inner expression
        lhs = lhs.args[0]!;
      }
      if (
        exprIsFunctionCall(lhs) &&
        exprIsFunctionCallOf(lhs, BuiltinKeywords.mut, 1)
      ) {
        // mutable variable, just use the inner expression
        isMutable = true;
        lhs = lhs.args[0]!;
      }

      if (!lhs.$?.type) {
        return `// Error: No type information for left-hand side ${exprToString(lhs)}\n`;
      }
      const lhsCode = this.generateExpr(lhs, indent);

      // Check if we need to save the old value into temp variable
      if (expr.$?.variableName) {
        const tempVarName = expr.$.variableName;
        const tempVarNameAndType = this.getVariableTypeString(
          lhs.$.type,
          tempVarName
        );

        // Handle array assignment specially
        if (isArrayType(lhs.$.type)) {
          const arrayType = lhs.$.type;
          const arrayLength = arrayType.length;
          this.emitter.emitLine(
            `${indent}${tempVarNameAndType}; // Save old value for later use`
          );

          if (isNumberValue(arrayLength)) {
            // For array, we need to copy each element
            for (let i = 0; i < arrayLength.value; i++) {
              this.emitter.emitLine(
                `${indent}${tempVarName}[${i}] = ${lhsCode}[${i}];`
              );
            }
          }
        } else {
          if (!isUnitType(lhs.$.type)) {
            this.emitter.emitLine(
              `${indent}${tempVarNameAndType} = ${lhsCode}; // Save old value for later use`
            );
          }
        }
      }

      // Handle array assignments specially
      if (isArrayType(lhs.$.type)) {
        const arrayType = lhs.$.type;
        const arrayLength = arrayType.length;

        if (isInitialization) {
          // For initialization, use the variable type string which handles arrays correctly
          const varTypeAndName = this.getVariableTypeString(
            lhs.$.type,
            this.generateExpr(lhs, indent)
          );
          const rhsCode = this.generateExpr(rhs, indent);
          this.emitter.emitLine(
            `${indent}${isMutable ? "" : "const "}${varTypeAndName} = ${rhsCode};`
          );
        } else {
          // For assignment to existing array, we need element-by-element assignment
          const rhsCode = this.generateExpr(rhs, indent);

          // Check if RHS is an array literal that we can unpack
          if (
            exprIsFunctionCall(rhs) &&
            exprIsFunctionCallOf(rhs, BuiltinKeywords.array)
          ) {
            const runtimeArgExprs = rhs.$?.runtimeArgExprsInOrder;
            if (runtimeArgExprs && isNumberValue(arrayLength)) {
              // Generate element-by-element assignment
              for (
                let i = 0;
                i < runtimeArgExprs.length && i < arrayLength.value;
                i++
              ) {
                const elemCode = this.generateExpr(runtimeArgExprs[i]!, indent);
                this.emitter.emitLine(
                  `${indent}${lhsCode}[${i}] = ${elemCode};`
                );
              }
            }
          } else {
            // For other RHS expressions (like copying from another array), do element-by-element copy
            if (isNumberValue(arrayLength)) {
              for (let i = 0; i < arrayLength.value; i++) {
                this.emitter.emitLine(
                  `${indent}${lhsCode}[${i}] = ${rhsCode}[${i}];`
                );
              }
            }
          }
        }
      } else {
        // Non-array assignment - use existing logic
        const rhsCode = this.generateExpr(rhs, indent);
        if (!isUnitType(lhs.$.type)) {
          this.emitter.emitLine(
            `${indent}${isInitialization && !isMutable ? "const " : ""}${isInitialization ? this.getTypeString(lhs.$.type) + " " : ""}${lhsCode} = ${rhsCode};`
          );
        }
      }

      return expr.$?.variableName ?? "";
    }
    // already computed
    // NOTE: This has to be below the assignment checks
    else if (expr.$?.value && !isUnknownValue(expr.$?.value)) {
      const value: Value = expr.$.value;
      return this.generateComptValue(value);
    }
    // . field access
    else if (exprIsFunctionCallOf(expr, ".", 2)) {
      return this.generateFieldAccess(expr, indent);
    }
    // begin
    else if (exprIsFunctionCallOf(expr, BuiltinKeywords.begin)) {
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
        argsCode.forEach((argCode) => {
          if (argCode) {
            this.emitter.emitLine(`${indent}  ${argCode}`);
          }
        });
        if (!isUnitType(valueType)) {
          this.emitter.emitLine(
            `${indent}  ${tempVariableName} = ${argsCode[argsCode.length - 1]};`
          );
        }
        this.emitter.emitLine(`${indent}} // end begin block`);

        return isUnitType(valueType) ? "" : tempVariableName;
      }
    }
    // cond
    else if (exprIsFunctionCallOf(expr, BuiltinKeywords.cond)) {
      return this.generateCondExpression(expr, indent);
    }
    // match
    else if (exprIsFunctionCallOf(expr, BuiltinKeywords.match)) {
      return this.generateMatchExpression(expr, indent);
    }
    // ptr or ref value
    else if (
      exprIsFunctionCallOf(expr, BuiltinKeywords.Ptr, 1) ||
      exprIsFunctionCallOf(expr, BuiltinKeywords.MutPtr, 1) ||
      exprIsFunctionCallOf(expr, BuiltinKeywords.Ref, 1) ||
      exprIsFunctionCallOf(expr, BuiltinKeywords.MutRef, 1)
    ) {
      const type = expr.$?.type;
      if (!type) {
        return `// Error: No type information for pointer/reference expression ${exprToString(expr)}\n`;
      }
      const arg = expr.args[0]!;
      const argCode = this.generateExpr(arg, indent);

      // For pointer/reference creation, we need to be careful about constness
      // Simply use the address-of operator without an explicit cast to avoid const issues
      return `(&${argCode})`;
    }
    // (anonymous) tuple value
    else if (exprIsFunctionCallOf(expr, BuiltinKeywords.tuple)) {
      const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
      const cName = this.types[expr.$?.type?.id ?? ""]?.cName;
      if (runtimeArgExprs && cName) {
        // Generate tuple initialization
        const argsList = runtimeArgExprs
          .map((arg) => this.generateExpr(arg, indent))
          .join(", ");
        return `(${cName}){ ${argsList} }`;
      } else if (expr.args.length === 0) {
        // unit
        return "";
      }
    }
    // (anonymous) array value
    else if (exprIsFunctionCallOf(expr, BuiltinKeywords.array)) {
      const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
      const arrayType = expr.$?.type;
      if (isArrayType(arrayType) && runtimeArgExprs) {
        // Generate tuple initialization
        const argsList = runtimeArgExprs
          .map((arg) => this.generateExpr(arg, indent))
          .join(", ");
        // return `(${this.getTypeString(arrayType)}){ ${argsList} }`;
        return `{ ${argsList} }`;
      }
    }
    // recur
    else if (exprIsFunctionCallOf(expr, BuiltinKeywords.recur)) {
      const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
      if (runtimeArgExprs) {
        // Generate recur call with arguments
        const argsList = runtimeArgExprs
          .map((arg) => this.generateExpr(arg, indent))
          .join(", ");
        return `${this.currentFunctionName}(${argsList})`;
      } else {
        return `// Error: No arguments for recur call ${exprToString(expr)}\n`;
      }
    }
    // sizeof
    else if (exprIsFunctionCallOf(expr, BuiltinFunctions.sizeof, 1)) {
      const arg = expr.args[0]!;
      const argCode = this.generateExpr(arg, indent);
      return `sizeof(${argCode})`; // Use sizeof operator on the argument
    }
    // Builtin C operator functions
    else if (exprIsFunctionCallOf(expr, BuiltinCOperatorFunctions)) {
      const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
      if (runtimeArgExprs) {
        const args = runtimeArgExprs.map((arg) => {
          return this.generateExpr(arg, indent);
        });

        // +
        if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_add)) {
          return `((${args[0]!}) + (${args[1]!}))`;
        }
        // -
        else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_sub)) {
          return `((${args[0]!}) - (${args[1]!}))`;
        }
        // *
        else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_mul)) {
          return `((${args[0]!}) * (${args[1]!}))`;
        }
        // /
        else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_div)) {
          return `((${args[0]!}) / (${args[1]!}))`;
        }
        // %
        else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_mod)) {
          return `((${args[0]!}) % (${args[1]!}))`;
        }
        // neg -
        else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_neg)) {
          return `(-(${args[0]!}))`;
        }
        // ==
        else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_eq)) {
          return `((${args[0]!}) == (${args[1]!}))`;
        }
        // !=
        else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_neq)) {
          return `((${args[0]!}) != (${args[1]!}))`;
        }
        // <
        else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_lt)) {
          return `((${args[0]!}) < (${args[1]!}))`;
        }
        // <=
        else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_lte)) {
          return `((${args[0]!}) <= (${args[1]!}))`;
        }
        // >
        else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_gt)) {
          return `((${args[0]!}) > (${args[1]!}))`;
        }
        // >=
        else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_gte)) {
          return `((${args[0]!}) >= (${args[1]!}))`;
        }
        // and
        else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_and)) {
          return `((${args[0]!}) && (${args[1]!}))`;
        }
        // >=
        else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_or)) {
          return `((${args[0]!}) || (${args[1]!}))`;
        }
        // !
        else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_not)) {
          return `(!(${args[0]!}))`;
        }
        // &
        else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_bit_and)) {
          return `((${args[0]!}) & (${args[1]!}))`;
        }
        // |
        else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_bit_or)) {
          return `((${args[0]!}) | (${args[1]!}))`;
        }
        // ^
        else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_xor)) {
          return `((${args[0]!}) ^ (${args[1]!}))`;
        }
        // ~
        else if (
          exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_bit_complement)
        ) {
          return `(~(${args[0]!}))`;
        }
        // <<
        else if (
          exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_bit_left_shift)
        ) {
          return `((${args[0]!}) << (${args[1]!}))`;
        }
        // >>
        else if (
          exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_op_bit_right_shift)
        ) {
          return `((${args[0]!}) >> (${args[1]!}))`;
        }
      }
    }
    // anonymous function (fn(x) -> body)
    else if (
      exprIsFunctionCallOf(expr, "->", 2) &&
      exprIsFunctionCall(expr.args[0]) &&
      exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.fn)
    ) {
      // Anonymous functions should have been evaluated and have a function value
      const functionValue = expr.$?.value;
      if (isFunctionValue(functionValue)) {
        return this.generateComptValue(functionValue);
      } else {
        return `// Error: Anonymous function missing function value`;
      }
    }
    // other function call
    else {
      const functionType = expr.func.$?.type;
      const functionValue = expr.func.$?.value;
      if (isFunctionType(functionType)) {
        const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
        if (runtimeArgExprs) {
          // Generate arg list
          const argsList = runtimeArgExprs
            .map((arg) => {
              return this.generateExpr(arg, indent);
            })
            .join(", ");

          if (isFunctionValue(functionValue)) {
            // Get new function type, which might be specialized.
            const functionType =
              functionValue.specializedType ?? functionValue.type;
            // Normal function call
            const cFuncName = this.functions[functionValue.funcId]?.cName;
            if (cFuncName) {
              // Generate function call
              if (isUnitType(functionType.return.type)) {
                // If the function returns unit, just call it without assignment
                this.emitter.emitLine(`${indent}${cFuncName}(${argsList});`);
                return ""; // No return value
              } else {
                // If it returns a value, assign to a temp variable
                const tempVar = expr.$?.variableName;
                if (tempVar) {
                  this.emitter.emitLine(
                    `${indent}${this.getTypeString(functionType.return.type)} ${tempVar} = ${cFuncName}(${argsList});`
                  );
                  return tempVar; // Return the temp variable name
                }
              }
            }
          } else {
            // Might be extern function, a built-in, or a function parameter
            const externFunction = this.externFunctions[functionType.id];
            if (externFunction) {
              // Generate extern function call
              const cFuncName = externFunction.cName;
              return `${cFuncName}(${argsList})`;
            } else {
              // Function parameter call (e.g., callback(x))
              const funcCode = this.generateExpr(expr.func, indent);
              if (isUnitType(functionType.return.type)) {
                // If the function returns unit, just call it without assignment
                this.emitter.emitLine(`${indent}${funcCode}(${argsList});`);
                return ""; // No return value
              } else {
                // If it returns a value, assign to a temp variable or return directly
                const tempVar = expr.$?.variableName;
                if (tempVar) {
                  this.emitter.emitLine(
                    `${indent}${this.getTypeString(functionType.return.type)} ${tempVar} = ${funcCode}(${argsList});`
                  );
                  return tempVar; // Return the temp variable name
                } else {
                  return `${funcCode}(${argsList})`;
                }
              }
            }
          }
        }
      } else if (isTypeValue(functionValue)) {
        // struct
        if (isStructType(functionValue.value)) {
          const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
          const cName = this.types[functionValue.value.id]?.cName;
          const labels = functionValue.value.elements.map(
            (element) => element.label
          );
          if (
            runtimeArgExprs &&
            cName &&
            labels.length === runtimeArgExprs.length
          ) {
            // Generate struct initialization
            const argsList = runtimeArgExprs
              .map((arg, index) => {
                return `.${labels[index]!} = ` + this.generateExpr(arg, indent);
              })
              .join(", ");
            return `(${cName}){ ${argsList} }`;
          }
        }
        // union
        // union is supposed to have only one member initialized
        else if (isUnionType(functionValue.value)) {
          const arg = expr.args[0]!;
          if (
            arg &&
            exprIsFunctionCall(arg) &&
            exprIsFunctionCallOf(arg, ":", 2)
          ) {
            const labelExpr = arg.args[0]!;
            const fieldExpr = arg.args[1]!;
            const cName = this.types[functionValue.value.id]?.cName;
            if (cName && exprIsAtom(labelExpr) && fieldExpr) {
              const label = labelExpr.token.value;
              const fieldCode = this.generateExpr(fieldExpr, indent);
              return `(${cName}){ .${label} = ${fieldCode} }`;
            }
          }
        }
        // enum
        else if (isEnumType(functionValue.value)) {
          const enumType = functionValue.value;
          const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
          const cName = this.types[enumType.id]?.cName;
          if (enumType.selectedVariantName && runtimeArgExprs && cName) {
            // Generate enum initialization
            const variantName = enumType.selectedVariantName;
            const variant = enumType.variants.find(
              (v) => v.name === variantName
            );
            if (variant) {
              const argsList = runtimeArgExprs
                .map((arg, index) => {
                  if (variant.elements) {
                    const element = variant.elements[index];
                    if (element) {
                      return (
                        `.${element.label} = ` + this.generateExpr(arg, indent)
                      );
                    }
                    return ""; // Skip if no element matches
                  } else {
                    return "";
                  }
                })
                .filter((s) => s) // Remove empty strings
                .join(", ");
              return `(${cName}){ .tag = ${this.getEnumVariantCName(enumType, variantName)}, .data = { .${variantName} = { ${argsList} } } }`;
            }
          }
        }
      } else if (isArrayType(functionType)) {
        // Array access by index
        const arrayCode = this.generateExpr(expr.func!, indent);
        const indexCode = this.generateExpr(expr.args[0]!, indent);
        // Generate array access
        return `${arrayCode}[${indexCode}]`; // Access the element at the index
      }
    }

    return `// Failed to transpile ${exprToString(expr)}`;
  }

  /**
   * Generate C code for an atom expression
   */
  private generateAtom(expr: AtomExpr): string {
    if (expr.$?.value && !isUnknownValue(expr.$.value)) {
      return this.generateComptValue(expr.$.value);
    }

    return expr.token.value;
  }

  /**
   * Generate C code for a compile-time value
   */
  private generateComptValue(value: Value): string {
    if (isNumberValue(value)) {
      // For numbers, we can directly return the value as a string
      return valueToString(value);
    } else if (isBooleanValue(value)) {
      // For booleans, return true/false
      return value.value ? "true" : "false";
    } else if (isStructValue(value)) {
      // For structs, we need to generate a struct initialization
      const type = value.type;
      if (type && isStructType(type)) {
        const cName = this.types[type.id]?.cName;
        if (!cName) {
          return `// Error: No C type name found for struct ${typeToString(type)}\n`;
        }

        const fields = value.elements.map((element, index) => {
          const fieldValue = element;
          const fieldName = type.elements[index]!.label;
          const fieldCode = this.generateComptValue(fieldValue);
          return `.${fieldName} = ${fieldCode}`;
        });

        return `(${cName}){ ${fields.join(", ")} }`;
      }
    } else if (isFunctionValue(value)) {
      // For function values, we need to register them and return their C function name
      const cName = this.functions[value.funcId]?.cName;
      if (cName) {
        return cName; // Return the function name as a function pointer
      } else {
        return `// Error: No C function name found for function value with ID ${value.funcId}\n`;
      }
    } else if (isTypeValue(value)) {
      // For type values, we can return the C type name if available
      const type = value.value;
      if (type) {
        if (this.types[type.id]) {
          return this.types[type.id]!.cName;
        } else {
          return `/* Error: No C type name found for type ${typeToString(type)} */`;
        }
      }
    }

    return ""; // No need to generate. It might be module value, etc
  }

  /**
   * Generate field access for structs, unions, and enums
   */
  private generateFieldAccess(expr: FuncCallExpr, indent: string): string {
    if (expr.args.length !== 2) {
      return "/* ERROR: field access requires exactly 2 arguments */";
    }

    const objectExpr = expr.args[0];
    const fieldExpr = expr.args[1];

    if (!objectExpr || !fieldExpr) {
      return "/* ERROR: invalid field access arguments */";
    }

    const objectCode = this.generateExpr(objectExpr, indent);
    const objectType = objectExpr.$?.type;
    const objectValue = objectExpr.$?.value;

    if (exprIsAtom(fieldExpr)) {
      const fieldName = fieldExpr.token.value;

      // Check if the object is an enum type
      if (isEnumType(objectType)) {
        const enumType = objectType;

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
      } else if (isTypeValue(objectValue) && isEnumType(objectValue.value)) {
        const enumType = objectValue.value;
        const variant = enumType.variants.find((v) => v.name === fieldName);
        const cName = this.types[enumType.id]?.cName;

        // Accessing variant that has no elements.
        // Like: Color.Red
        if (!!variant && !variant.elements && cName) {
          const tagName = this.getEnumVariantCName(enumType, variant.name);
          return `(${cName}){ .tag = ${tagName}, .data = {  } }`;
        }
      }
      // Check if the object is pointer or reference
      else if (
        isPtrType(objectType) ||
        isMutPtrType(objectType) ||
        isRefType(objectType) ||
        isMutRefType(objectType)
      ) {
        if (fieldName === "*") {
          // Dereference the pointer/reference
          return `*(${objectCode})`; // Dereference the pointer/reference
        } else {
          // Dereference until not a pointer/reference
          let dereferenceLevel = 0;
          let currentType: Type = objectType;
          while (
            isPtrType(currentType) ||
            isMutPtrType(currentType) ||
            isRefType(currentType) ||
            isMutRefType(currentType)
          ) {
            dereferenceLevel++;
            currentType = currentType.type;
          }
          if (dereferenceLevel > 0) {
            // Dereference the pointer/reference
            const dereferencedObjectCode = `${"*".repeat(dereferenceLevel)}(${objectCode})`;
            // Access the field on the dereferenced object
            return `${dereferencedObjectCode}.${fieldName}`;
          } else {
            // If no dereferencing is needed, just access the field
            return `${objectCode}.${fieldName}`;
          }
        }
      }
      // For tuple type, we need to convert the field to index
      else if (isTupleType(objectType)) {
        if (fieldName.match(/^\d+$/)) {
          return `${objectCode}._${fieldName}`;
        } else {
          const index = objectType.elements.findIndex(
            (element) => element.label === fieldName
          );
          return `${objectCode}._${index}`;
        }
      } else {
        // For C structs and unions, access fields directly
        return `${objectCode}.${fieldName}`;
      }
    }

    return "/* ERROR: field name must be an identifier */";
  }

  /**
   * Generate a conditional expression (cond) as a value expression
   */
  private generateCondExpression(expr: FuncCallExpr, indent: string): string {
    // Check if the cond expression has been evaluated and has a variable name
    if (expr.$ && expr.$.variableName) {
      const tempVar = expr.$.variableName;
      const varType = this.getTypeString(expr.$.type);

      // Generate the conditional logic as statements before this expression
      // We need to declare the variable and generate the if-else logic
      this.emitter.emitLine(`${indent}${varType} ${tempVar};`);

      // Generate if-else chain for each condition => value pair
      for (let i = 0; i < expr.args.length; i++) {
        const arg = expr.args[i];
        if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=>", 2)) {
          // This is a condition => value pair
          const condition = arg.args[0];
          const value = arg.args[1];

          if (condition && value) {
            const ifKeyword = i === 0 ? "if" : "else if";

            if (
              isBooleanValue(condition.$?.value) &&
              condition.$.value.value === true
            ) {
              this.emitter.emitLine(`${indent}else {`);
            } else {
              // Generate condition outside the block
              const conditionCode = this.generateExpr(condition, indent);
              this.emitter.emitLine(
                `${indent}${ifKeyword} (${conditionCode}) {`
              );
            }

            // Generate the value expression INSIDE the conditional block
            const valueCode = this.generateExpr(value, indent + "  ");
            this.emitter.emitLine(`${indent}  ${tempVar} = ${valueCode};`);
            this.emitter.emitLine(`${indent}}`);
          }
        }
      }

      return tempVar;
    }

    // Fallback for non-evaluated expressions
    return '/* "cond" expression is missing $.variableName */';
  }

  /**
   * Generate a match expression as a value (C switch statement)
   */
  private generateMatchExpression(expr: FuncCallExpr, indent: string): string {
    const tempVariableName = expr.$?.variableName;
    const valueType = expr.$?.type;
    if (!tempVariableName || !valueType) {
      return `// Error: "match" expression is missing $.variableName or $.type`;
    }

    // Create temp variable declaration
    this.emitter.emitLine(
      `${indent}${this.getTypeString(valueType)} ${tempVariableName};`
    );

    // Generate the matched value
    const matchedValueCode = this.generateExpr(expr.args[0]!, indent);
    const matchValueType = expr.args[0]!.$?.type;
    if (!matchValueType) {
      return `// Error: "match" expression requires an enum type`;
    }

    // Check if it's a pointer/reference type
    // If yes, then automatically dereference one-level of it.
    let ptrOrRefType:
      | TypeTag.Ptr
      | TypeTag.MutPtr
      | TypeTag.Ref
      | TypeTag.MutRef
      | undefined = undefined;

    let enumType: Type;
    if (
      isPtrType(matchValueType) ||
      isMutPtrType(matchValueType) ||
      isRefType(matchValueType) ||
      isMutRefType(matchValueType)
    ) {
      enumType = matchValueType.type;
      ptrOrRefType = matchValueType.tag;
    } else {
      enumType = matchValueType;
    }

    if (!isEnumType(enumType)) {
      return `// Error: "match" expression requires an enum type`;
    }
    const enumCName = this.types[enumType.id]?.cName;
    if (!enumCName) {
      return `// Error: "match" expression enum type ${enumType.typeName} has no C name`;
    }

    this.emitter.emitLine(
      `${indent}switch (${ptrOrRefType ? "*" : ""}(${matchedValueCode}).tag) {`
    );

    const caseExprs = expr.args.slice(1);
    for (let i = 0; i < caseExprs.length; i++) {
      const caseExpr = caseExprs[i];
      if (
        exprIsFunctionCall(caseExpr) &&
        exprIsFunctionCallOf(caseExpr, "=>", 2)
      ) {
        // This is a case => value pair
        const caseValue = caseExpr.args[0];
        let caseBody = caseExpr.args[1];

        if (
          caseValue &&
          caseBody &&
          // caseValue now has to be a variant:
          exprIsFunctionCall(caseValue) &&
          exprIsFunctionCallOf(caseValue, ".", 1)
        ) {
          const variantName = caseValue.args[0]!.token.value; // Get the variant name
          const variantTag = this.getEnumVariantCName(enumType, variantName);

          // Generate the case label
          this.emitter.emitLine(`${indent}case ${variantTag}:`);

          if (
            exprIsFunctionCall(caseBody) &&
            exprIsFunctionCallOf(caseBody, "=>", 2)
          ) {
            const renameExpr = caseBody.args[0]!;
            this.emitter.emitLine(
              `${indent}  ${this.getTypeString(matchValueType)} ${renameExpr.token.value} = ${matchedValueCode};`
            );

            caseBody = caseBody.args[1]!; // Get the value part of the case
          }

          // Generate the body of the case
          const bodyCode = this.generateExpr(caseBody, indent + "  ");
          this.emitter.emitLine(
            `${indent}  ${tempVariableName} = ${bodyCode};`
          );
          this.emitter.emitLine(`${indent}  break;`);
        }
      }
    }

    this.emitter.emitLine(`${indent}}`);
    return tempVariableName; // Return the temp variable name
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
  private generateSpecializedFunctionDeclarations(): void {
    const generated = new Set<FuncValueId>(); // Track already generated declarations
    for (const funcId in this.functions) {
      const { value: functionValue, cName: cFunctionName } =
        this.functions[funcId]!;
      const specializedFunctionType = functionValue.specializedType;

      if (this.isComptFunction(functionValue)) {
        // Skip compile-time only functions
        continue;
      }

      if (!specializedFunctionType || !this.isGenericFunction(functionValue)) {
        continue; // Skip non-generic functions
      }

      // Skip if already generated
      if (generated.has(funcId)) {
        continue;
      }
      generated.add(funcId);

      // Emit the function declaration
      this.emitter.emitDeclarationLine(
        `${this.generateFunctionPrototype(specializedFunctionType, cFunctionName)}; // specialized function: ${typeToString(functionValue.type)}`
      );
    }
  }

  /**
   * Generate the bodies of specialized (monomorphized) functions
   */
  private generateSpecializedFunctions(): void {
    for (const funcId in this.functions) {
      const { value: functionValue, cName: cFunctionName } =
        this.functions[funcId]!;

      if (this.isComptFunction(functionValue)) {
        // Skip compile-time only functions
        continue;
      }

      // Skip if not a generic function
      if (
        !functionValue.specializedType ||
        !this.isGenericFunction(functionValue)
      ) {
        continue;
      }

      // Generate the specialized function body
      this.generateFunction(functionValue, cFunctionName);
    }
  }

  public print(): string {
    return this.emitter.print();
  }
}
