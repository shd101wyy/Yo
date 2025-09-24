import { Emitter } from "../../emitter";
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
  EnumType,
  FunctionType,
  isClosureType,
  isDynType,
  isEnumType,
  isFunctionType,
  isStructType,
  isUnitType,
  typeContainsSomeType,
  TypeTag,
  typeToString,
} from "../../types";
import { canRefStructFormCycles } from "../../types/utils";
import { isTempVariableName } from "../../utils";
import { isFunctionValue } from "../../value";
import {
  generateDeferredDropExpressions,
  generateExpr,
  generateReturnStatement,
} from "../expressions";
import {
  CodeGenContext,
  getTypeString,
  isComptFunction,
  isFunctionValueWithOnlyBuiltinYoInlineFunctionCall,
  isGenericFunction,
  sanitizeForCIdentifier,
} from "../utils";
import { FunctionGenerationContext } from "./context";

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

  // Generate constructor functions for dyn types
  emitter.emitDeclarationLine(`/// Dyn type constructors`);
  generateDynConstructorDeclarations(context);
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

  // Generate closure constructor and ARC functions
  generateClosureConstructorFunctions(context);

  // Generate dyn type constructor and ARC functions
  generateDynConstructorFunctions(context);

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
      if (
        argCode &&
        !isTempVariableName(arg.$!.env.modulePath, argCode) // Prevent emit meaningless line like `_yof4ca7ba3_temp_127;`
      ) {
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

      // Generate deferred drop expressions before the return statement
      generateDeferredDropExpressions(expr, indent, context);

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
    // Generate deferred drop expressions before the return statement
    generateDeferredDropExpressions(expr, indent, context);

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

  // Generate GC function declarations
  emitter.emitDeclarationLine(
    `void __yo_gc_register(void* ptr); // Register object for cycle detection`
  );
  emitter.emitDeclarationLine(
    `void __yo_gc_unregister(void* ptr); // Unregister object from cycle detection`
  );
  emitter.emitDeclarationLine(
    `void __yo_gc_collect(); // Trigger garbage collection`
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
 * Generate constructor function declarations for dyn types
 */
export function generateDynConstructorDeclarations(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Generate constructor declarations for each dyn type
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;

    if (isDynType(type)) {
      // Skip generic dyn types that contain SomeType parameters
      if (typeContainsSomeType(type)) {
        continue;
      }

      const constructorName = `__yo_new_${cName}`;

      // Declare the constructor function that takes data, dispose function, and function pointers
      emitter.emitDeclarationLine(
        `${cName}* ${constructorName}(void* data, void (*dispose_fn)(void*), ...); // Dyn constructor`
      );

      // Declare the dispose function for this dyn type
      const disposeFunctionName = `__yo_dispose_${cName}`;
      emitter.emitDeclarationLine(
        `void ${disposeFunctionName}(void* ptr); // Dispose dyn and wrapped data`
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
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  header->ref_count--;
  
  if (header->ref_count == 0) {
    // Check if object was already disposed by GC
    if (header->gc_flags & YO_GC_DISPOSED) {
      return; // Already disposed by GC, nothing to do
    }
    
    // Unregister from GC before disposal
    __yo_gc_unregister(ptr);
    
    // dispose_fn should always be provided and not NULL
    dispose_fn(ptr);

    yo_free(ptr);
    return;
  }
}`);
  emitter.emitLine(``);

  // Generate __yo_incr_rc function
  emitter.emitLine(`void* __yo_incr_rc(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  header->ref_count++;
  return ptr;
}`);
  emitter.emitLine(``);

  // Generate GC runtime functions
  generateGCRuntimeFunctions(emitter);
}

/**
 * Generate garbage collection runtime functions for cycle detection
 */
function generateGCRuntimeFunctions(emitter: Emitter): void {
  // Global GC tracking state
  emitter.emitLine(`// Global GC tracking state`);
  emitter.emitLine(
    `static yo_ref_header_t* yo_gc_tracked_objects = NULL;  // Head of tracked objects list`
  );
  emitter.emitLine(
    `static size_t yo_gc_tracked_count = 0;  // Number of tracked objects`
  );
  emitter.emitLine(
    `static size_t yo_gc_collect_threshold = 1000;  // Collect when this many objects tracked`
  );
  emitter.emitLine(
    `static int yo_gc_collection_in_progress = 0;  // Ensures only one GC collection runs at a time`
  );
  emitter.emitLine(``);

  // Generate __yo_gc_register function
  emitter.emitLine(`void __yo_gc_register(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  // Only register if not already tracked
  if (!(header->gc_flags & YO_GC_TRACKED)) {
    // Set the TRACKED flag
    header->gc_flags |= YO_GC_TRACKED;
    
    // Link into tracking list
    header->gc_next = (struct yo_gc_object*)yo_gc_tracked_objects;
    yo_gc_tracked_objects = header;
    
    // Increment count
    yo_gc_tracked_count++;
    
    // Trigger collection if threshold reached
    if (yo_gc_tracked_count >= yo_gc_collect_threshold) {
      __yo_gc_collect();
    }
  }
}`);
  emitter.emitLine(``);

  // Generate __yo_gc_unregister function
  emitter.emitLine(`void __yo_gc_unregister(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  if (header->gc_flags & YO_GC_TRACKED) {
    // Remove from tracked list (simple linked list removal)
    if (yo_gc_tracked_objects == header) {
      // Remove head node
      yo_gc_tracked_objects = (yo_ref_header_t*)header->gc_next;
    } else {
      // Search for the node in the list
      yo_ref_header_t* current = yo_gc_tracked_objects;
      while (current != NULL && current->gc_next != (struct yo_gc_object*)header) {
        current = (yo_ref_header_t*)current->gc_next;
      }
      if (current != NULL) {
        // Found the node to remove - update current's next pointer
        current->gc_next = header->gc_next;
      }
    }
    
    // Decrement count and clear flags
    yo_gc_tracked_count--;
    header->gc_flags &= ~YO_GC_TRACKED;
    header->gc_next = NULL;
  }
}`);
  emitter.emitLine(``);

  // Generate helper functions for QuickJS-style cycle detection
  emitter.emitLine(
    `// Helper function to temporarily decrement references during trial deletion`
  );
  emitter.emitLine(`static void trial_decref_visitor(void* ptr) {`);
  emitter.emitLine(`  if (ptr == NULL) return;`);
  emitter.emitLine(``);
  emitter.emitLine(`  yo_ref_header_t* header = (yo_ref_header_t*)ptr;`);
  emitter.emitLine(``);
  emitter.emitLine(`  // Only decrement if object is being tested for cycles`);
  emitter.emitLine(`  if (header->gc_flags & YO_GC_TRACKED) {`);
  emitter.emitLine(`    header->ref_count--;`);
  emitter.emitLine(`  }`);
  emitter.emitLine(`}`);
  emitter.emitLine(``);

  emitter.emitLine(
    `// Helper function to restore references after trial deletion`
  );
  emitter.emitLine(`static void restore_refcount_visitor(void* ptr) {`);
  emitter.emitLine(`  if (ptr == NULL) return;`);
  emitter.emitLine(``);
  emitter.emitLine(`  yo_ref_header_t* header = (yo_ref_header_t*)ptr;`);
  emitter.emitLine(``);
  emitter.emitLine(`  // Only increment if object was part of cycle test`);
  emitter.emitLine(`  if (header->gc_flags & YO_GC_TRACKED) {`);
  emitter.emitLine(`    header->ref_count++;`);
  emitter.emitLine(`  }`);
  emitter.emitLine(`}`);
  emitter.emitLine(``);

  // Generate __yo_gc_collect function (QuickJS-style cycle detection)
  emitter.emitLine(`void __yo_gc_collect() {
  // Ensure only one GC collection runs at a time
  if (yo_gc_collection_in_progress) {
    return;  // Another thread is already running GC
  }
  yo_gc_collection_in_progress = 1;
  
  if (yo_gc_tracked_objects == NULL) {
    yo_gc_collection_in_progress = 0;  // Release GC lock
    return;  // Nothing to collect
  }
  
  // QuickJS-style cycle detection algorithm
  // Phase 1: Trial deletion - temporarily remove internal references
  yo_ref_header_t* obj = yo_gc_tracked_objects;
  while (obj != NULL) {
    // For each tracked object, temporarily decrement ref counts of all objects it references
    if (obj->traverse_fn) {
      obj->traverse_fn(obj, trial_decref_visitor);
    }
    obj = (yo_ref_header_t*)obj->gc_next;
  }
  
  // Phase 2: Identify unreachable cycles
  // Objects with ref_count == 0 after trial deletion are only referenced by cycle members
  yo_ref_header_t* current = yo_gc_tracked_objects;
  yo_ref_header_t* prev = NULL;
  size_t collected_count = 0;
  
  while (current != NULL) {
    yo_ref_header_t* next = (yo_ref_header_t*)current->gc_next;
    
    if (current->ref_count == 0) {
      // This object is only referenced by other objects in the cycle - collect it
      if (prev == NULL) {
        // Removing head of list
        yo_gc_tracked_objects = next;
      } else {
        // Removing middle/end of list
        prev->gc_next = (struct yo_gc_object*)next;
      }
      
      yo_gc_tracked_count--;
      collected_count++;
      
      // Mark object as disposed by GC to prevent double-free
      current->gc_flags |= YO_GC_DISPOSED;
      current->gc_next = NULL;
      
      // Call user's cleanup function
      if (current->dispose_fn) {
        current->dispose_fn(current);
      }
      
      yo_free(current);
      
      // Continue with next, don't update prev
      current = next;
    } else {
      // This object has external references - restore its internal reference counts
      if (current->traverse_fn) {
        current->traverse_fn(current, restore_refcount_visitor);
      }
      
      // Keep this object, move to next
      prev = current;
      current = next;
    }
  }
  
  // Release the GC collection lock
  yo_gc_collection_in_progress = 0;
}`);
  emitter.emitLine(``);
}

/**
 * Generate traversal functions for ref structs (used by GC for marking)
 */
function generateRefStructTraversalFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (isStructType(type) && type.isReferenceSemantics) {
      // Skip generic structs that contain SomeType parameters
      const hasGenericTypes = type.elements.some((element) =>
        typeContainsSomeType(element.type)
      );

      if (hasGenericTypes) {
        continue; // Skip generic structs
      }

      // Generate traversal function for this struct type
      const traversalFunctionName = `__yo_traverse_${cName}`;
      emitter.emitLine(
        `void ${traversalFunctionName}(void* ptr, void (*visit)(void*)) {`
      );
      emitter.emitLine(`  ${cName}* obj = (${cName}*)ptr;`);

      // Visit each reference field in the struct
      for (const element of type.elements) {
        const fieldName = sanitizeForCIdentifier(element.label);
        const fieldType = element.type;

        if (isStructType(fieldType) && fieldType.isReferenceSemantics) {
          // This field is a direct reference to another ref struct
          emitter.emitLine(`  if (obj->${fieldName}) {`);
          emitter.emitLine(`    visit(obj->${fieldName});`);
          emitter.emitLine(`  }`);
        } else if (isEnumType(fieldType)) {
          // This field is an enum - we need to check if any variants contain references
          const enumType = fieldType as EnumType;

          // Generate switch statement to handle enum variants
          emitter.emitLine(`  switch (obj->${fieldName}.tag) {`);

          for (const variant of enumType.variants || []) {
            // Check if any of the variant's elements contain references
            if (variant.elements && variant.elements.length > 0) {
              for (const element of variant.elements) {
                if (
                  isStructType(element.type) &&
                  element.type.isReferenceSemantics
                ) {
                  // This variant contains a reference
                  const enumConstantName = `YO_${enumType.id?.toUpperCase()}_${variant.name.toUpperCase()}`;
                  emitter.emitLine(`  case ${enumConstantName}:`);
                  emitter.emitLine(
                    `    if (obj->${fieldName}.data.${variant.name}.${sanitizeForCIdentifier(element.label)}) {`
                  );
                  emitter.emitLine(
                    `      visit(obj->${fieldName}.data.${variant.name}.${sanitizeForCIdentifier(element.label)});`
                  );
                  emitter.emitLine(`    }`);
                  emitter.emitLine(`    break;`);
                  break; // Only generate one case per variant
                }
              }
            }
          }

          emitter.emitLine(`  }`);
        }
      }
      emitter.emitLine(`}`);
      emitter.emitLine(``);
    }
  }
}

/**
 * Generate constructor function implementations for ref structs and ref enums
 */
export function generateRefStructConstructorFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // First, generate traversal functions for each ref struct type
  generateRefStructTraversalFunctions(context);

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
        `  ${cName}* obj = (${cName}*)yo_malloc(sizeof(${cName}));`
      );
      emitter.emitLine(`  obj->header.ref_count = 1;`);
      emitter.emitLine(
        `  obj->header.gc_flags = 0;  // Initialize with no flags`
      );
      emitter.emitLine(`  obj->header.gc_next = NULL;`);

      // Set dispose function pointer to user's dispose function (not ___dispose which includes ref counting)
      const disposeFunctionElement = type.module.elements.find(
        (element) =>
          element.label === BuiltinFunctions.dispose[0]! &&
          element.assignedValue &&
          isFunctionValue(element.assignedValue)
      );

      if (
        disposeFunctionElement &&
        isFunctionValue(disposeFunctionElement.assignedValue)
      ) {
        const disposeFunctionValue = disposeFunctionElement.assignedValue;
        const disposeFunctionCName =
          context.functions[disposeFunctionValue.funcId]?.cName ||
          disposeFunctionValue.funcId;
        emitter.emitLine(
          `  obj->header.dispose_fn = (void(*)(void*))${disposeFunctionCName};`
        );
      } else {
        // Fallback to NULL if no dispose function found
        emitter.emitLine(`  obj->header.dispose_fn = NULL;`);
      }

      // Set traversal function pointer for GC
      const traversalFunctionName = `__yo_traverse_${cName}`;
      emitter.emitLine(`  obj->header.traverse_fn = ${traversalFunctionName};`);

      // Initialize fields
      type.elements.forEach((element) => {
        const fieldName = sanitizeForCIdentifier(element.label);
        emitter.emitLine(`  obj->${fieldName} = ${fieldName};`);
      });

      // Register with GC if this type might participate in cycles
      if (canRefStructFormCycles(type)) {
        emitter.emitLine(`  __yo_gc_register(obj);`);
      }

      emitter.emitLine(`  return obj;`);
      emitter.emitLine(`}`);
      emitter.emitLine(``);
    }
  }
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
          `  ${captureTypeName}* captureData = yo_malloc(sizeof(${captureTypeName}));`
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
          `  ${cName}* obj = (${cName}*)yo_malloc(sizeof(${cName}));`
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
          `  ${cName}* obj = (${cName}*)yo_malloc(sizeof(${cName}));`
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
            emitter.emitLine(`    yo_free(self->data);`);
            emitter.emitLine(`  }`);
          } else {
            emitter.emitLine(
              `  // No C function name found for capture type drop function`
            );
            emitter.emitLine(`  if (self->data) { yo_free(self->data); }`);
          }
        } else {
          emitter.emitLine(
            `  // No drop function found in capture type module`
          );
          emitter.emitLine(`  if (self->data) { yo_free(self->data); }`);
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

/**
 * Generate constructor function implementations for dyn types and their ARC functions
 */
export function generateDynConstructorFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Generate dyn constructor functions
  for (const typeEntry of Object.values(context.types)) {
    const type = typeEntry.type;
    const cName = typeEntry.cName;

    if (isDynType(type)) {
      const dynType = type as DynType;

      // Skip generic dyn types that contain SomeType parameters
      if (typeContainsSomeType(type)) {
        continue;
      }

      // Generate dyn constructor function
      const constructorName = `__yo_new_${cName}`;

      emitter.emitLine(
        `${cName}* ${constructorName}(void* data, void (*dispose_fn)(void*), ...) {`
      );
      emitter.emitLine(
        `  ${cName}* obj = (${cName}*)yo_malloc(sizeof(${cName}));`
      );
      emitter.emitLine(`  obj->header.ref_count = 1;`);

      emitter.emitLine(`  va_list args;`);
      emitter.emitLine(`  va_start(args, dispose_fn);`);

      // Initialize vtable with function pointers from variadic arguments
      const processedMethods = new Set<string>();
      for (const moduleType of dynType.moduleTypes) {
        for (const element of moduleType.elements) {
          // Skip 'Self' type declarations
          if (element.label === "Self") {
            continue;
          }

          // Avoid duplicate methods from different modules
          if (processedMethods.has(element.label)) {
            continue;
          }
          processedMethods.add(element.label);

          const methodName = sanitizeForCIdentifier(element.label);
          emitter.emitLine(
            `  obj->vtable.${methodName} = va_arg(args, void*);`
          );
        }
      }

      // Set the dispose function pointer for the dyn object itself
      emitter.emitLine(`  obj->vtable.dispose = dispose_fn;`);

      emitter.emitLine(`  va_end(args);`);

      emitter.emitLine(`  obj->data = data;`);
      emitter.emitLine(`  return obj;`);
      emitter.emitLine(`}`);
      emitter.emitLine(``);

      // Generate dispose function for this dyn type
      const disposeFunctionName = `__yo_dispose_${cName}`;
      emitter.emitLine(`void ${disposeFunctionName}(void* ptr) {`);
      emitter.emitLine(`  ${cName}* self = (${cName}*)ptr;`);
      emitter.emitLine(`  // Call the wrapped object's dispose function`);
      emitter.emitLine(`  __yo_decr_rc(self->data, self->vtable.___dispose);`);
      emitter.emitLine(`}`);
      emitter.emitLine(``);
      emitter.emitLine(``);
    }
  }
}
