import {
  BuiltinFunctions,
  BuiltinKeywords,
  Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
} from "../../expr";
import { FunctionValue, FuncValueId } from "../../function-value";
import {
  ClosureType,
  DynType,
  FunctionType,
  isClosureType,
  isDynType,
  isFunctionType,
  isStructType,
  isUnitType,
  typeContainsSomeType,
  TypeId,
  TypeTag,
  typeToString,
} from "../../types";
import { isFunctionValue } from "../../value";
import { generateExpr, generateReturnStatement } from "../expressions";
import {
  CodeGenContext,
  getTypeString,
  isComptFunction,
  isFunctionValueWithOnlyBuiltinYoInlineFunctionCall,
  isGenericFunction,
  sanitizeForCIdentifier,
} from "../utils";

export interface FunctionGenerationContext extends CodeGenContext {
  functions: Record<FuncValueId, { value: FunctionValue; cName: string }>;
  externFunctions: Record<
    TypeId,
    { type: FunctionType; cName: string; cInclude?: string }
  >;
  currentFunctionName: string;
  currentClosureCaptures?: string[]; // Variables captured by current closure function
  currentClosureCaptureFrameLevel?: number; // Frame level of the captured variables
  currentClosureType?: ClosureType; // Current closure type being generated
}

/**
 * Generate function declarations (prototypes)
 */
export function generateFunctionDeclarations(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;
  emitter.emitDeclarationLine(`// Function declarations`);

  // Generate declarations for extern functions first
  emitter.emitDeclarationLine(`/// Extern functions`);
  for (const key in context.externFunctions) {
    const { cName, type } = context.externFunctions[key]!;
    if (type.isExtern === "yo") {
      continue; // Yo language extern types. No need to generate C declarations for them
    }
    if (type.isExtern === "c" && type.cInclude) {
      continue; // C extern types with cInclude are defined in header files, no need to generate extern declarations
    }
    generateFunctionDeclaration(type, cName, true, context);
  }
  emitter.emitDeclarationLine("");

  // Generate constructor functions for ref structs
  emitter.emitDeclarationLine(`/// Ref struct constructors`);
  generateRefStructConstructorDeclarations(context);
  emitter.emitDeclarationLine("");

  // Generate constructor functions for closures
  emitter.emitDeclarationLine(`/// Closure constructors`);
  generateClosureConstructorDeclarations(context);
  emitter.emitDeclarationLine("");

  // Generate declarations for other functions
  emitter.emitDeclarationLine(`/// Regular functions`);
  for (const funcId in context.functions) {
    const { cName, value } = context.functions[funcId]!;
    if (
      isGenericFunction(value) ||
      isComptFunction(value) ||
      isFunctionValueWithOnlyBuiltinYoInlineFunctionCall(value)
    ) {
      continue;
    }
    generateFunctionDeclaration(value.type, cName, false, context);
  }

  // Generate vtable instance declarations for closures (after function declarations)
  emitter.emitDeclarationLine(`/// Closure vtable instances`);
  generateClosureVtableDeclarations(context);
  emitter.emitDeclarationLine("");
}

/**
 * Generate function prototype
 */
export function generateFunctionPrototype(
  functionType: FunctionType,
  cFunctionName: string,
  context: CodeGenContext
): string {
  // For non-main functions, generate based on function type
  const returnTypeStr = getTypeString(functionType.return.type, context);

  // Generate parameter list (excluding compile-time parameters)
  const runtimeParams = functionType.parameters.filter(
    (param) => !param.isCompileTimeOnly
  );

  const paramStrings: string[] = [];

  // For closure functions, add the closure struct as the first parameter
  if (functionType.isClosure) {
    // Find the closure type that uses this function type
    const closureTypeEntry = Object.values(context.types).find(
      (t) =>
        t.type.tag === TypeTag.Closure &&
        (t.type as ClosureType).callType === functionType
    );

    if (closureTypeEntry) {
      // Use the closure type directly (which is now the same as the capture struct)
      const closureTypeStr = closureTypeEntry.cName;

      // All closures use move semantics - pass by pointer since closures are reference-counted
      const closureParamStr = `${closureTypeStr}* closure_context`;

      paramStrings.push(closureParamStr);
    }
  }

  // Add regular parameters
  const regularParamStrings = runtimeParams.map((param, index) => {
    const paramName = param.label || `param${index}`;

    // Handle function pointer parameters specially
    if (isFunctionType(param.type)) {
      const functionPointerType = generateFunctionPrototype(
        param.type,
        "(*)",
        context
      ).replace(" (*)(", ` (*${paramName})(`);

      return functionPointerType;
    } else {
      // Handle non-function parameters
      const paramTypeStr = getTypeString(param.type, context);

      return `${paramTypeStr} ${paramName}`;
    }
  });

  paramStrings.push(...regularParamStrings);
  const params = paramStrings.join(", ");
  return `${returnTypeStr} ${cFunctionName}(${params})`;
}

/**
 * Generate a function declaration (prototype)
 */
export function generateFunctionDeclaration(
  functionType: FunctionType,
  cFunctionName: string,
  isExtern: boolean,
  context: CodeGenContext
): void {
  const functionPrototype = generateFunctionPrototype(
    functionType,
    cFunctionName,
    context
  );
  const yoTypeStr = typeToString(functionType);
  context.emitter.emitDeclarationLine(
    `${isExtern ? "extern " : ""}${functionPrototype}; // ${yoTypeStr}`
  );
}

/**
 * Generate all collected functions
 */
export function generateAllFunctions(context: FunctionGenerationContext): void {
  context.emitter.emitLine(`// Function implementations`);

  // Generate builtin functions first
  generateBuiltinFunctions(context);

  // Generate ref struct constructor functions
  generateRefStructConstructorFunctions(context);

  for (const funcId in context.functions) {
    const { value, cName } = context.functions[funcId]!;

    // If the function is generic, we will handle it later
    if (
      isGenericFunction(value) ||
      isComptFunction(value) ||
      isFunctionValueWithOnlyBuiltinYoInlineFunctionCall(value)
    ) {
      continue;
    }

    // Generate the function body
    generateFunction(value, cName, context);
  }
}

/**
 * Generate C code for a function
 */
export function generateFunction(
  functionValue: FunctionValue,
  cFunctionName: string,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Use provided C function name or default to label
  const functionName = cFunctionName;
  const functionType = functionValue.specializedType ?? functionValue.type;

  const functionPrototype = generateFunctionPrototype(
    functionType,
    cFunctionName,
    context
  );
  emitter.emitLine(`${functionPrototype} {`);

  // Set current function name for recur support
  const previousFunctionName = context.currentFunctionName;
  context.currentFunctionName = functionName;

  // Set closure capture context if this is a closure function
  const previousClosureCaptures = context.currentClosureCaptures;
  const previousClosureCaptureFrameLevel =
    context.currentClosureCaptureFrameLevel;
  const previousClosureType = (context as FunctionGenerationContext)
    .currentClosureType;
  if (functionType.isClosure) {
    // This is a closure function - find the closure type to get capture info
    const closureTypeEntry = Object.values(context.types).find(
      (t) =>
        t.type.tag === TypeTag.Closure &&
        (t.type as ClosureType).callType === functionType
    );

    if (
      closureTypeEntry &&
      (closureTypeEntry.type as ClosureType).captureType
    ) {
      const closureType = closureTypeEntry.type as ClosureType;
      const captureType = closureType.captureType;
      (context as FunctionGenerationContext).currentClosureType = closureType;

      if (captureType && captureType.tag === TypeTag.Struct) {
        // Extract field names as captured variables
        // Store the frame level separately
        const captureFrameLevel = captureType.env.frames.length - 1;
        context.currentClosureCaptures = captureType.elements.map(
          (elem) => elem.label
        );
        context.currentClosureCaptureFrameLevel = captureFrameLevel;
      }
    }
  }

  // Generate function body with proper return handling
  generateFunctionBody(functionValue.body, functionType, "  ", context);

  // Restore previous function name and closure captures
  context.currentFunctionName = previousFunctionName;
  context.currentClosureCaptures = previousClosureCaptures;
  context.currentClosureCaptureFrameLevel = previousClosureCaptureFrameLevel;
  (context as FunctionGenerationContext).currentClosureType =
    previousClosureType;

  emitter.emitLine(`}`);
}

/**
 * Generate function body with proper return handling
 */
export function generateFunctionBody(
  expr: Expr,
  functionType: FunctionType,
  indent: string,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;
  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.begin)
  ) {
    // Handle begin block - generate all statements except the last, then return the last
    const args = expr.args;

    // Generate all expressions except the last as statements
    let findReturn = false;
    for (let i = 0; i < args.length - 1; i++) {
      const arg = args[i]!;

      if (exprIsFunctionCallOf(arg, BuiltinKeywords.return)) {
        findReturn = true;
      }
      const argCode = generateExpr(arg, indent, context);
      if (argCode) {
        // Emit the expression as a statement
        emitter.emitLine(`${indent}${argCode};`);
      }

      if (findReturn) {
        break;
      }
    }

    // Generate the last expression as a return statement
    if (!findReturn && args.length > 0) {
      const lastExpr = args[args.length - 1];

      if (lastExpr && isUnitType(functionType.return.type)) {
        // For unit/void functions, just generate the expression but don't return
        generateExpr(lastExpr, indent, context);
      } else if (lastExpr) {
        // Check if the last expression has control flow (like return statements)
        const hasControlFlow = lastExpr.$?.controlFlow;

        // Special case: check if it's a borrow expression which might contain returns
        const isBorrowExpression =
          exprIsFunctionCall(lastExpr) &&
          exprIsFunctionCallOf(lastExpr, BuiltinKeywords.borrow);

        // Check if last expr is unit - either by type or by being a tuple() call with no args
        const isLastExprUnit =
          isUnitType(lastExpr.$?.type) ||
          (exprIsFunctionCall(lastExpr) &&
            exprIsFunctionCallOf(lastExpr, BuiltinKeywords.tuple) &&
            lastExpr.args.length === 0);
        const prevExpr = args.length > 1 ? args[args.length - 2] : null;
        const prevExprHasControlFlow = prevExpr?.$?.controlFlow;
        const prevIsBorrow =
          prevExpr &&
          exprIsFunctionCall(prevExpr) &&
          exprIsFunctionCallOf(prevExpr, BuiltinKeywords.borrow);

        if (isLastExprUnit && (prevExprHasControlFlow || prevIsBorrow)) {
          // Don't generate return for unit if previous expression has control flow or is borrow
          // Skip generating anything - the control flow already happened in the previous expression
        } else if (hasControlFlow || isBorrowExpression) {
          // If the expression has control flow or is a borrow, just generate it without adding a return
          const exprCode = generateExpr(lastExpr, indent, context);
          if (exprCode) {
            emitter.emitLine(`${indent}${exprCode};`);
          }
        } else {
          // For other functions, return the last expression
          generateReturnStatement(lastExpr, indent, context);
        }
      }
    } else if (findReturn && args.length > 0) {
      // We found an explicit return statement, but there might be a trailing unit expression
      // that we should ignore (don't generate as a statement)
      const lastExpr = args[args.length - 1];
      if (lastExpr && isUnitType(lastExpr.$?.type)) {
        // Ignore trailing unit expressions after explicit return
        // Don't generate anything for this
      }
    }
  } else {
    // Single expression function body
    if (isUnitType(functionType.return.type)) {
      // For unit/void functions, just generate the expression
      generateExpr(expr, indent, context);
    } else {
      // For other functions, return the expression
      generateReturnStatement(expr, indent, context);
    }
  }
}

/**
 * Generate declarations for specialized (monomorphized) functions
 */
export function generateSpecializedFunctionDeclarations(
  context: CodeGenContext
): void {
  const generated = new Set<FuncValueId>(); // Track already generated declarations
  for (const funcId in context.functions) {
    const { value: functionValue, cName: cFunctionName } =
      context.functions[funcId]!;
    const specializedFunctionType = functionValue.specializedType;

    if (isComptFunction(functionValue)) {
      // Skip compile-time only functions
      continue;
    }

    if (!specializedFunctionType || !isGenericFunction(functionValue)) {
      continue; // Skip non-generic functions
    }

    // Skip if already generated
    if (generated.has(funcId)) {
      continue;
    }
    generated.add(funcId);

    // Emit the function declaration
    context.emitter.emitDeclarationLine(
      `${generateFunctionPrototype(specializedFunctionType, cFunctionName, context)}; // specialized function: ${typeToString(functionValue.type)}`
    );
  }
}

/**
 * Generate the bodies of specialized (monomorphized) functions
 */
export function generateSpecializedFunctions(context: CodeGenContext): void {
  for (const funcId in context.functions) {
    const { value: functionValue, cName: cFunctionName } =
      context.functions[funcId]!;

    if (isComptFunction(functionValue)) {
      // Skip compile-time only functions
      continue;
    }

    // Skip if not a generic function
    if (!functionValue.specializedType || !isGenericFunction(functionValue)) {
      continue;
    }

    // Generate the specialized function body
    generateFunction(functionValue, cFunctionName, context);
  }
}

/**
 * Generate constructor function declarations for ref structs
 */
export function generateRefStructConstructorDeclarations(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Generate builtin reference counting functions
  emitter.emitDeclarationLine(
    `void __yo_decr_rc(void* ptr, void (*dispose_fn)(void*)); // Decrement reference count`
  );
  emitter.emitDeclarationLine(
    `void* __yo_incr_rc(void* ptr); // Increment reference count`
  );

  // Generate constructor declarations for each ref struct
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (isStructType(type) && type.isReferenceSemantics) {
      // Skip generic structs that contain SomeType parameters
      const hasGenericTypes = type.elements.some((element) =>
        typeContainsSomeType(element.type)
      );

      if (hasGenericTypes) {
        continue; // Skip generic structs - only generate constructors for concrete types
      }

      // Generate constructor function declaration
      const constructorName = `__yo_new_${cName}`;
      const paramTypes = type.elements
        .map((element) => {
          const fieldType = getTypeString(element.type, context);
          const fieldName = sanitizeForCIdentifier(element.label);
          return `${fieldType} ${fieldName}`;
        })
        .join(", ");

      emitter.emitDeclarationLine(
        `${cName}* ${constructorName}(${paramTypes}); // Constructor`
      );
    }

    // Generate constructor declarations for each dyn type
    if (isDynType(type)) {
      // Skip generic dyn types that contain SomeType parameters
      if (typeContainsSomeType(type)) {
        continue;
      }

      const constructorName = `__yo_new_${cName}`;
      emitter.emitDeclarationLine(
        `${cName}* ${constructorName}(void* data, ...); // Dyn constructor`
      );
    }
  }
}

export function generateClosureConstructorDeclarations(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Generate constructor declarations for each closure (they are also reference-counted)
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;

    if (isClosureType(type)) {
      const closureType = type as ClosureType;

      // Skip generic closures that contain SomeType parameters
      if (typeContainsSomeType(type)) {
        continue;
      }

      const constructorName = `__yo_new_${cName}`;

      // Generate closure constructor that takes captured values directly
      const captureType = closureType.captureType;
      if (isStructType(captureType) && captureType.elements.length > 0) {
        // Constructor takes captured values, call function, and drop function
        const captureParams = captureType.elements
          .map((element) => {
            const fieldType = getTypeString(element.type, context);
            const fieldName = sanitizeForCIdentifier(element.label);
            return `${fieldType} ${fieldName}`;
          })
          .join(", ");

        const callType = closureType.callType;
        const returnTypeStr = getTypeString(callType.return.type, context);
        const callParamList = callType.parameters
          .map((param) => {
            const paramTypeStr = getTypeString(param.type, context);
            const paramName = sanitizeForCIdentifier(param.label);
            return `${paramTypeStr} ${paramName}`;
          })
          .join(", ");

        const callFnParam = `${returnTypeStr} (*call)(void* self${callParamList ? ", " + callParamList : ""})`;
        const disposeFnParam = `void (*dispose)(void* self)`;

        const allParams = `${captureParams}, ${callFnParam}, ${disposeFnParam}`;

        emitter.emitDeclarationLine(
          `${cName}* ${constructorName}(${allParams}); // Closure constructor`
        );
      } else {
        // Empty closure (no captures) - just takes call and dispose functions
        const callType = closureType.callType;
        const returnTypeStr = getTypeString(callType.return.type, context);
        const callParamList = callType.parameters
          .map((param) => {
            const paramTypeStr = getTypeString(param.type, context);
            const paramName = sanitizeForCIdentifier(param.label);
            return `${paramTypeStr} ${paramName}`;
          })
          .join(", ");

        const callFnParam = `${returnTypeStr} (*call)(void* self${callParamList ? ", " + callParamList : ""})`;
        const disposeFnParam = `void (*dispose)(void* self)`;

        const allParams = `${callFnParam}, ${disposeFnParam}`;

        emitter.emitDeclarationLine(
          `${cName}* ${constructorName}(${allParams}); // Empty closure constructor`
        );
      }

      // Declare the common create function for this closure type
      const callType = closureType.callType;
      const returnTypeStr = getTypeString(callType.return.type, context);
      const callParamList = callType.parameters
        .map((param) => {
          const paramTypeStr = getTypeString(param.type, context);
          const paramName = sanitizeForCIdentifier(param.label);
          return `${paramTypeStr} ${paramName}`;
        })
        .join(", ");

      const callFnParam = `${returnTypeStr} (*call)(void* self${callParamList ? ", " + callParamList : ""})`;
      const disposeFnParam = `void (*dispose)(void* self)`;

      emitter.emitDeclarationLine(
        `${cName}* __yo_create_${cName}(void* data, ${callFnParam}, ${disposeFnParam}); // Create closure with data`
      );

      // Declare the dispose function for this closure type
      const disposeFunctionName = `__yo_dispose_${cName}`;
      emitter.emitDeclarationLine(
        `void ${disposeFunctionName}(${cName}* self); // Dispose closure and captured data`
      );
    }
  }
}

/**
 * Generate vtable instance declarations for closures
 */
export function generateClosureVtableDeclarations(
  _context: FunctionGenerationContext
): void {
  // No static vtable instances - closures will create vtables dynamically
  // Each closure instance will have its own vtable with appropriate drop function
}

/**
 * Generate builtin function implementations
 */
export function generateBuiltinFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Generate __yo_decr_rc function
  emitter.emitLine(`void __yo_decr_rc(void* ptr, void (*dispose_fn)(void*)) {
  if (!ptr) return;
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  if (header->ref_count == 1) {
    if (dispose_fn) {
      dispose_fn(ptr);
    }
    free(ptr);
  } else {
    header->ref_count--;
  }
}`);
  emitter.emitLine(``);

  // Generate __yo_incr_rc function
  emitter.emitLine(`void* __yo_incr_rc(void* ptr) {
  if (!ptr) return ptr;
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  header->ref_count++;
  return ptr;
}`);
  emitter.emitLine(``);
}

/**
 * Generate constructor function implementations for ref structs and ref enums
 */
export function generateRefStructConstructorFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Generate constructor implementations for each ref struct
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (isStructType(type) && type.isReferenceSemantics) {
      // Skip generic structs that contain SomeType parameters
      const hasGenericTypes = type.elements.some((element) =>
        typeContainsSomeType(element.type)
      );

      if (hasGenericTypes) {
        continue; // Skip generic structs - only generate constructors for concrete types
      }

      // Generate constructor function implementation
      const constructorName = `__yo_new_${cName}`;
      const paramTypes = type.elements
        .map((element) => {
          const fieldType = getTypeString(element.type, context);
          const fieldName = sanitizeForCIdentifier(element.label);
          return `${fieldType} ${fieldName}`;
        })
        .join(", ");

      emitter.emitLine(`${cName}* ${constructorName}(${paramTypes}) {`);
      emitter.emitLine(
        `  ${cName}* obj = (${cName}*)malloc(sizeof(${cName}));`
      );
      emitter.emitLine(`  obj->header.ref_count = 1;`);

      // Initialize fields
      type.elements.forEach((element) => {
        const fieldName = sanitizeForCIdentifier(element.label);
        emitter.emitLine(`  obj->${fieldName} = ${fieldName};`);
      });

      emitter.emitLine(`  return obj;`);
      emitter.emitLine(`}`);
      emitter.emitLine(``);
    }

    // Generate constructor implementations for each dyn type
    if (isDynType(type)) {
      const dynType = type as DynType;

      // Skip generic dyn types that contain SomeType parameters
      if (typeContainsSomeType(type)) {
        continue;
      }

      const constructorName = `__yo_new_${cName}`;
      const vtableName = `${cName}_vtable`;

      emitter.emitLine(`${cName}* ${constructorName}(void* data, ...) {`);
      emitter.emitLine(
        `  ${cName}* obj = (${cName}*)malloc(sizeof(${cName}));`
      );
      emitter.emitLine(`  obj->header.ref_count = 1;`);
      emitter.emitLine(
        `  ${vtableName}* vtable = (${vtableName}*)malloc(sizeof(${vtableName}));`
      );

      emitter.emitLine(`  va_list args;`);
      emitter.emitLine(`  va_start(args, data);`);

      // Initialize vtable with function pointers from variadic arguments
      const processedMethods = new Set<string>();
      for (const moduleType of dynType.moduleTypes) {
        for (const element of moduleType.elements) {
          // Skip 'Self' type declarations and duplicates
          if (element.label === "Self" || processedMethods.has(element.label)) {
            continue;
          }
          processedMethods.add(element.label);

          if (isFunctionType(element.type)) {
            const functionType = element.type as FunctionType;
            if (
              functionType.parameters.length > 0 &&
              functionType.parameters[0]?.label === "self"
            ) {
              const methodName = sanitizeForCIdentifier(element.label);
              const returnTypeStr = getTypeString(
                functionType.return.type,
                context
              );
              emitter.emitLine(
                `  vtable->${methodName} = (${returnTypeStr} (*)(void*))va_arg(args, void*);`
              );
            }
          }
        }
      }

      emitter.emitLine(`  va_end(args);`);
      emitter.emitLine(`  obj->vtable = vtable;`);
      emitter.emitLine(`  obj->data = __yo_incr_rc(data);`);
      emitter.emitLine(`  return obj;`);
      emitter.emitLine(`}`);
      emitter.emitLine(``);
    }
  }

  // Generate closure constructor and ARC functions
  generateClosureConstructorFunctions(context);
}

/**
 * Generate constructor function implementations for closures and their ARC functions
 */
export function generateClosureConstructorFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Generate closure constructor functions
  for (const typeEntry of Object.values(context.types)) {
    const type = typeEntry.type;
    const cName = typeEntry.cName;

    if (isClosureType(type)) {
      const closureType = type as ClosureType;

      // Skip generic closures that contain SomeType parameters
      if (typeContainsSomeType(type)) {
        continue;
      }

      // Generate closure constructor function
      const constructorName = `__yo_new_${cName}`;

      // Generate constructor implementation
      const captureType = closureType.captureType;
      if (isStructType(captureType) && captureType.elements.length > 0) {
        // Constructor takes captured values directly
        const captureParams = captureType.elements
          .map((element) => {
            const fieldType = getTypeString(element.type, context);
            const fieldName = sanitizeForCIdentifier(element.label);
            return `${fieldType} ${fieldName}`;
          })
          .join(", ");

        const callType = closureType.callType;
        const returnTypeStr = getTypeString(callType.return.type, context);
        const callParamList = callType.parameters
          .map((param) => {
            const paramTypeStr = getTypeString(param.type, context);
            const paramName = sanitizeForCIdentifier(param.label);
            return `${paramTypeStr} ${paramName}`;
          })
          .join(", ");

        const callFnParam = `${returnTypeStr} (*call)(void* self${callParamList ? ", " + callParamList : ""})`;
        const disposeFnParam = `void (*dispose)(void* self)`;

        const allParams = `${captureParams}, ${callFnParam}, ${disposeFnParam}`;

        emitter.emitLine(`${cName}* ${constructorName}(${allParams}) {`);

        // Allocate and initialize capture data using the existing struct type
        const existingCaptureTypeEntry = Object.values(context.types).find(
          (entry) => entry.type === captureType
        );
        const captureTypeName = existingCaptureTypeEntry
          ? existingCaptureTypeEntry.cName
          : `${cName}_capture`; // fallback

        emitter.emitLine(
          `  ${captureTypeName}* captureData = malloc(sizeof(${captureTypeName}));`
        );

        // Initialize capture fields
        captureType.elements.forEach((element) => {
          const fieldName = sanitizeForCIdentifier(element.label);
          emitter.emitLine(`  captureData->${fieldName} = ${fieldName};`);
        });

        // Use common create_closure function
        emitter.emitLine(
          `  return __yo_create_${cName}(captureData, call, dispose);`
        );
        emitter.emitLine(`}`);
        emitter.emitLine(``);

        // Generate the common create_closure function
        emitter.emitLine(
          `${cName}* __yo_create_${cName}(void* data, ${callFnParam}, ${disposeFnParam}) {`
        );
        emitter.emitLine(
          `  ${cName}* obj = (${cName}*)malloc(sizeof(${cName}));`
        );
        emitter.emitLine(`  obj->header.ref_count = 1;`);
        emitter.emitLine(`  obj->data = data;`);

        // Set vtable function pointers directly
        emitter.emitLine(`  obj->vtable.call = call;`);
        emitter.emitLine(`  obj->vtable.dispose = dispose;`);

        emitter.emitLine(`  return obj;`);
        emitter.emitLine(`}`);
        emitter.emitLine(``);
      } else {
        // Empty closure (no captures)
        const callType = closureType.callType;
        const returnTypeStr = getTypeString(callType.return.type, context);
        const callParamList = callType.parameters
          .map((param) => {
            const paramTypeStr = getTypeString(param.type, context);
            const paramName = sanitizeForCIdentifier(param.label);
            return `${paramTypeStr} ${paramName}`;
          })
          .join(", ");

        const callFnParam = `${returnTypeStr} (*call)(void* self${callParamList ? ", " + callParamList : ""})`;
        const disposeFnParam = `void (*dispose)(void* self)`;

        const allParams = `${callFnParam}, ${disposeFnParam}`;

        emitter.emitLine(`${cName}* ${constructorName}(${allParams}) {`);

        // Use common create_closure function with NULL data
        emitter.emitLine(`  return __yo_create_${cName}(NULL, call, dispose);`);
        emitter.emitLine(`}`);
        emitter.emitLine(``);

        // Generate the common create_closure function
        emitter.emitLine(
          `${cName}* __yo_create_${cName}(void* data, ${callFnParam}, ${disposeFnParam}) {`
        );
        emitter.emitLine(
          `  ${cName}* obj = (${cName}*)malloc(sizeof(${cName}));`
        );
        emitter.emitLine(`  obj->header.ref_count = 1;`);
        emitter.emitLine(`  obj->data = data;`);

        // Set vtable function pointers directly
        emitter.emitLine(`  obj->vtable.call = call;`);
        emitter.emitLine(`  obj->vtable.dispose = dispose;`);

        emitter.emitLine(`  return obj;`);
        emitter.emitLine(`}`);
        emitter.emitLine(``);
      }

      // Generate dispose function for this closure type
      const disposeFunctionName = `__yo_dispose_${cName}`;
      emitter.emitLine(`void ${disposeFunctionName}(${cName}* self) {`);

      if (isStructType(captureType) && captureType.elements.length > 0) {
        // Find the drop function in the capture type's module
        const dropFunction = captureType.module.elements.find(
          (element) => element.label === BuiltinFunctions.___drop[0]
        );
        if (
          dropFunction &&
          dropFunction.assignedValue &&
          isFunctionValue(dropFunction.assignedValue)
        ) {
          const dropFunctionValue = dropFunction.assignedValue;
          const dropFunctionCName =
            context.functions[dropFunctionValue.funcId]?.cName;
          if (dropFunctionCName) {
            // Use the existing struct type name instead of generating a new capture type name
            const existingCaptureTypeEntry = Object.values(context.types).find(
              (entry) => entry.type === captureType
            );
            const captureTypeName = existingCaptureTypeEntry
              ? existingCaptureTypeEntry.cName
              : `${cName}_capture`; // fallback

            emitter.emitLine(`  if (self->data) {`);
            emitter.emitLine(
              `    ${dropFunctionCName}(*(${captureTypeName}*)self->data);`
            );
            emitter.emitLine(`    free(self->data);`);
            emitter.emitLine(`  }`);
          } else {
            emitter.emitLine(
              `  // No C function name found for capture type drop function`
            );
            emitter.emitLine(`  if (self->data) { free(self->data); }`);
          }
        } else {
          emitter.emitLine(
            `  // No drop function found in capture type module`
          );
          emitter.emitLine(`  if (self->data) { free(self->data); }`);
        }
      } else {
        // No captures, nothing to dispose
        emitter.emitLine(`  // No captured data to dispose`);
      }

      emitter.emitLine(`}`);
      emitter.emitLine(``);
    }
  }
}
