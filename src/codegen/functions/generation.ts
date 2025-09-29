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
 * Generate builtin function implementations with atomic reference counting
 */
export function generateBuiltinFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Generate BRC __yo_decr_rc function following the paper's algorithm with split words
  emitter.emitLine(`void __yo_decr_rc(void* ptr, void (*dispose_fn)(void*)) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  // Get current thread ID for BRC logic using fast inline assembly
  size_t current_thread_id = yo_get_thread_id();
  
  size_t owner_tid = header->owner_thread_id;
  
  if (owner_tid == current_thread_id /* && owner_tid != 0 */) {
    // FAST DECREMENT (Owner access) - non-atomic biased_word access
    uint32_t biased_word = header->biased_word;
    uint32_t biased_counter = BRC_GET_BIASED_COUNTER(biased_word);
    header->biased_word = BRC_SET_BIASED_COUNTER(biased_word, biased_counter - 1);
    
    if (biased_counter - 1 > 0) {
      return; // Still have biased references - no atomic operations!
    }
    
    // Biased counter reached zero - set merged flag (following paper's algorithm)
    uint32_t old_shared_word, new_shared_word;
    do {
      old_shared_word = atomic_load_explicit(&header->shared_word, memory_order_acquire);
      new_shared_word = BRC_SET_FLAG(old_shared_word, BRC_FLAG_MERGED);
    } while (!atomic_compare_exchange_weak_explicit(&header->shared_word, &old_shared_word, new_shared_word, memory_order_acq_rel, memory_order_relaxed));
    
    if (BRC_GET_SHARED_COUNTER(new_shared_word) == 0) {
      // No shared references - deallocate
      __yo_gc_unregister(ptr);
      if (dispose_fn) {
        dispose_fn(ptr);
      }
      yo_free(ptr);
    } else {
      // Give up ownership - object becomes shared
      header->owner_thread_id = 0;
    }
    
  } else {
    // SLOW DECREMENT (Non-owner access) - atomic shared_word access
    uint32_t old_shared_word, new_shared_word;
    
    do {
      old_shared_word = atomic_load_explicit(&header->shared_word, memory_order_acquire);
      int32_t shared_counter = BRC_GET_SHARED_COUNTER(old_shared_word);
      shared_counter--; // Decrement shared counter
      
      new_shared_word = BRC_SET_SHARED_COUNTER(old_shared_word, shared_counter);
      
      if (shared_counter < 0) { // Counter went negative - this should not happen in Yo!
        // Abort immediately - this indicates a compiler bug or unsafe FFI usage
        fprintf(stderr, "BRC Error: Shared counter went negative (%d) for object %p. This should never happen in Yo!\\n", 
                shared_counter, ptr);
        abort();
      }
    } while (!atomic_compare_exchange_weak_explicit(&header->shared_word, &old_shared_word, new_shared_word, memory_order_acq_rel, memory_order_relaxed));
    
    if (BRC_HAS_FLAG(new_shared_word, BRC_FLAG_MERGED) && BRC_GET_SHARED_COUNTER(new_shared_word) == 0) {
      // Counters are merged and shared counter is zero - deallocate
      __yo_gc_unregister(ptr);
      if (dispose_fn) {
        dispose_fn(ptr);
      }
      yo_free(ptr);
    }
  }
}

void* __yo_incr_rc(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  // Get current thread ID for BRC logic using fast inline assembly
  size_t current_thread_id = yo_get_thread_id();
  
  size_t owner_tid = header->owner_thread_id;
  
  if (owner_tid == current_thread_id && owner_tid != 0) {
    // FAST INCREMENT (Owner access) - non-atomic biased_word access
    uint32_t biased_word = header->biased_word;
    uint32_t biased_counter = BRC_GET_BIASED_COUNTER(biased_word);
    header->biased_word = BRC_SET_BIASED_COUNTER(biased_word, biased_counter + 1); // Non-atomic!
  } else {
    // SLOW INCREMENT (Non-owner access) - atomic shared_word access
    uint32_t old_shared_word, new_shared_word;
    do {
      old_shared_word = atomic_load_explicit(&header->shared_word, memory_order_acquire);
      int32_t shared_counter = BRC_GET_SHARED_COUNTER(old_shared_word);
      shared_counter++; // Increment shared counter
      new_shared_word = BRC_SET_SHARED_COUNTER(old_shared_word, shared_counter);
    } while (!atomic_compare_exchange_weak_explicit(&header->shared_word, &old_shared_word, new_shared_word, memory_order_acq_rel, memory_order_relaxed));
  }
  
  return ptr;
}`);

  // Generate thread-safe GC runtime functions
  generateAtomicGCRuntimeFunctions(emitter);
}

/**
 * Generate per-thread garbage collection runtime functions with stop-the-world collection
 */
function generateAtomicGCRuntimeFunctions(emitter: Emitter): void {
  // Per-thread GC tracking state
  emitter.emitLine(`// Per-thread GC tracking state for better scalability
static _Thread_local yo_thread_gc_state_t* yo_current_thread_gc = NULL;  // Current thread's GC state
static yo_thread_gc_state_t* yo_all_thread_gcs = NULL;  // Global list of all thread GC states
static YO_THREAD_SYNC_TYPE yo_thread_list_mutex = YO_THREAD_SYNC_INIT;  // Protects thread list
static _Atomic(size_t) yo_gc_collect_threshold = ATOMIC_VAR_INIT(1000);  // Collect when this many objects tracked
static _Atomic(int) yo_gc_collection_in_progress = ATOMIC_VAR_INIT(0);  // Prevents concurrent GC collections
static _Atomic(int) yo_threads_paused_count = ATOMIC_VAR_INIT(0);  // Count of threads paused for GC
static _Atomic(int) yo_total_thread_count = ATOMIC_VAR_INIT(0);  // Total number of registered threads
static YO_THREAD_SYNC_TYPE yo_gc_pause_mutex = YO_THREAD_SYNC_INIT;  // For GC pause coordination
static YO_COND_TYPE yo_gc_pause_cond = YO_COND_INIT;  // Condition for GC pause synchronization

// Initialize thread-local GC state (called automatically on first GC operation)
static void yo_init_thread_gc() {
  if (yo_current_thread_gc != NULL) return;  // Already initialized

  yo_current_thread_gc = (yo_thread_gc_state_t*)yo_malloc(sizeof(yo_thread_gc_state_t));
  yo_current_thread_gc->tracked_objects = NULL;
  yo_current_thread_gc->tracked_count = 0;
  yo_current_thread_gc->thread_id = yo_get_thread_id();  // Use fast thread ID function
  atomic_store_explicit(&yo_current_thread_gc->gc_paused, 0, memory_order_relaxed);

  // Add to global thread list
  yo_mutex_lock(&yo_thread_list_mutex);
  yo_current_thread_gc->next = yo_all_thread_gcs;
  yo_all_thread_gcs = yo_current_thread_gc;
  atomic_fetch_add_explicit(&yo_total_thread_count, 1, memory_order_relaxed);
  yo_mutex_unlock(&yo_thread_list_mutex);
}`);

  // Generate per-thread __yo_gc_register and __yo_gc_unregister functions
  emitter.emitLine(`void __yo_gc_register(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  // Initialize thread GC state if needed
  if (yo_current_thread_gc == NULL) {
    yo_init_thread_gc();
  }
  
  // Check if already tracked (non-atomic since we're the owner or during STW)
  uint32_t biased_word = header->biased_word;
  if (YO_GC_HAS_FLAG(biased_word, YO_GC_TRACKED)) {
    return; // Already tracked
  }
  
  // Set the TRACKED flag (non-atomic update since we're the owner)
  header->biased_word = YO_GC_SET_FLAG(biased_word, YO_GC_TRACKED);
  
  // Add to thread-local tracking list (no synchronization needed)
  header->gc_next = yo_current_thread_gc->tracked_objects;
  yo_current_thread_gc->tracked_objects = header;
  yo_current_thread_gc->tracked_count++;
  
  // Check if we should trigger GC based on thread-local count
  size_t threshold = atomic_load_explicit(&yo_gc_collect_threshold, memory_order_relaxed);
  if (yo_current_thread_gc->tracked_count >= threshold) {
    __yo_gc_collect();
  }
}

void __yo_gc_unregister(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  // If no thread GC state, object can't be tracked
  if (yo_current_thread_gc == NULL) {
    return;
  }
  
  // Check if tracked
  uint32_t biased_word = header->biased_word;
  if (!YO_GC_HAS_FLAG(biased_word, YO_GC_TRACKED)) {
    return; // Not tracked
  }
  
  // Remove from thread-local tracking list (no synchronization needed)
  yo_ref_header_t* current = yo_current_thread_gc->tracked_objects;
  yo_ref_header_t* prev = NULL;
  
  while (current != NULL) {
    if (current == header) {
      // Found the node to remove
      if (prev == NULL) {
        // Removing head node
        yo_current_thread_gc->tracked_objects = (yo_ref_header_t*)current->gc_next;
      } else {
        // Removing middle/tail node
        prev->gc_next = current->gc_next;
      }
      
      // Clear the node's flags and pointers
      current->gc_next = NULL;
      
      // Clear TRACKED flag (non-atomic since we're the owner or during STW)
      current->biased_word = YO_GC_CLEAR_FLAG(current->biased_word, YO_GC_TRACKED);
      
      yo_current_thread_gc->tracked_count--;
      break;
    }
    
    prev = current;
    current = (yo_ref_header_t*)current->gc_next;
  }
}`);

  // Generate stop-the-world coordination functions
  emitter.emitLine(`// Stop-the-world GC coordination
static void yo_gc_pause_all_threads() {
  yo_mutex_lock(&yo_thread_list_mutex);
  
  // Signal all threads to pause for GC
  yo_thread_gc_state_t* thread_gc = yo_all_thread_gcs;
  int expected_pauses = 0;
  
  while (thread_gc != NULL) {
    if (thread_gc != yo_current_thread_gc) {  // Don't pause the GC thread
      atomic_store_explicit(&thread_gc->gc_paused, 1, memory_order_release);
      expected_pauses++;
    }
    thread_gc = thread_gc->next;
  }
  
  yo_mutex_unlock(&yo_thread_list_mutex);
  
  // Wait for all threads to acknowledge pause
  yo_mutex_lock(&yo_gc_pause_mutex);
  while (atomic_load_explicit(&yo_threads_paused_count, memory_order_acquire) < expected_pauses) {
    yo_cond_wait(&yo_gc_pause_cond, &yo_gc_pause_mutex);
  }
  yo_mutex_unlock(&yo_gc_pause_mutex);
}

static void yo_gc_resume_all_threads() {
  yo_mutex_lock(&yo_thread_list_mutex);
  
  // Signal all threads to resume
  yo_thread_gc_state_t* thread_gc = yo_all_thread_gcs;
  while (thread_gc != NULL) {
    atomic_store_explicit(&thread_gc->gc_paused, 0, memory_order_release);
    thread_gc = thread_gc->next;
  }
  
  yo_mutex_unlock(&yo_thread_list_mutex);
  
  // Reset pause counter
  atomic_store_explicit(&yo_threads_paused_count, 0, memory_order_release);
  yo_cond_broadcast(&yo_gc_pause_cond);
}

static void yo_gc_check_pause() {
  if (yo_current_thread_gc != NULL) {
    int should_pause = atomic_load_explicit(&yo_current_thread_gc->gc_paused, memory_order_acquire);
    if (should_pause) {
      // Acknowledge pause and wait for resume
      yo_mutex_lock(&yo_gc_pause_mutex);
      atomic_fetch_add_explicit(&yo_threads_paused_count, 1, memory_order_acq_rel);
      yo_cond_broadcast(&yo_gc_pause_cond);
      
      // Wait until resume signal
      while (atomic_load_explicit(&yo_current_thread_gc->gc_paused, memory_order_acquire)) {
        yo_cond_wait(&yo_gc_pause_cond, &yo_gc_pause_mutex);
      }
      
      yo_mutex_unlock(&yo_gc_pause_mutex);
    }
  }
}`);

  // Generate helper functions for QuickJS-style cycle detection
  emitter.emitLine(`// Helper function to decrement references during trial deletion
static void per_thread_trial_decref_visitor(void* ptr) {
  if (ptr == NULL) return;

  yo_ref_header_t* header = (yo_ref_header_t*)ptr;

  // Safe to modify non-atomically since we're in stop-the-world phase
  uint32_t biased_word = header->biased_word;
  uint32_t biased_counter = BRC_GET_BIASED_COUNTER(biased_word);
  
  if (biased_counter > 0) {
    // Decrement biased counter and set flag to remember we did this
    header->biased_word = BRC_SET_BIASED_COUNTER(biased_word, biased_counter - 1);
    header->biased_word = YO_GC_SET_FLAG(header->biased_word, YO_GC_TRIAL_DECREMENTED);
  } else {
    // Biased counter is 0, decrement shared counter instead
    uint32_t shared_word = atomic_load_explicit(&header->shared_word, memory_order_relaxed);  // Non-atomic is safe in STW
    int32_t shared_counter = BRC_GET_SHARED_COUNTER(shared_word);
    if (shared_counter > 0) {
      uint32_t new_shared_word = BRC_SET_SHARED_COUNTER(shared_word, shared_counter - 1);
      atomic_store_explicit(&header->shared_word, new_shared_word, memory_order_relaxed);  // Non-atomic is safe in STW
    }
    // Don't set YO_GC_TRIAL_DECREMENTED flag - this means we decremented shared counter
  }
}

// Helper function to restore references after trial deletion
static void per_thread_restore_refcount_visitor(void* ptr) {
  if (ptr == NULL) return;

  yo_ref_header_t* header = (yo_ref_header_t*)ptr;

  // Safe to modify non-atomically since we're in stop-the-world phase
  uint32_t biased_word = header->biased_word;
  
  if (YO_GC_HAS_FLAG(biased_word, YO_GC_TRIAL_DECREMENTED)) {
    // We decremented biased counter during trial - restore it and clear flag
    uint32_t biased_counter = BRC_GET_BIASED_COUNTER(biased_word);
    header->biased_word = BRC_SET_BIASED_COUNTER(biased_word, biased_counter + 1);
    header->biased_word = YO_GC_CLEAR_FLAG(header->biased_word, YO_GC_TRIAL_DECREMENTED);
  } else {
    // We decremented shared counter during trial - restore it
    uint32_t shared_word = atomic_load_explicit(&header->shared_word, memory_order_relaxed);  // Non-atomic is safe in STW
    int32_t shared_counter = BRC_GET_SHARED_COUNTER(shared_word);
    uint32_t new_shared_word = BRC_SET_SHARED_COUNTER(shared_word, shared_counter + 1);
    atomic_store_explicit(&header->shared_word, new_shared_word, memory_order_relaxed);  // Non-atomic is safe in STW
  }
}`);

  // Generate stop-the-world GC collection
  emitter.emitLine(`void __yo_gc_collect() {
  // Atomic test-and-set to prevent concurrent GC collections
  int expected_not_running = 0;
  if (!atomic_compare_exchange_strong_explicit(&yo_gc_collection_in_progress, 
                                               &expected_not_running, 
                                               1, 
                                               memory_order_acq_rel, 
                                               memory_order_relaxed)) {
    return;  // Another thread is already running GC
  }
  
  // Stop the world - pause all other threads
  yo_gc_pause_all_threads();
  
  size_t total_collected = 0;
  
  // Collect from all thread-local GC lists
  yo_mutex_lock(&yo_thread_list_mutex);
  yo_thread_gc_state_t* thread_gc = yo_all_thread_gcs;
  
  while (thread_gc != NULL) {
    yo_ref_header_t* head = thread_gc->tracked_objects;
    if (head == NULL) {
      thread_gc = thread_gc->next;
      continue; // This thread has no tracked objects
    }
    
    // No explicit merge phase needed - negative counters abort immediately
    // All objects in tracked list have valid biased counters that can be processed normally
    
    // Phase 1: Trial deletion - temporarily remove internal references
    yo_ref_header_t* obj = head;
    while (obj != NULL) {
      if (obj->traverse_fn) {
        obj->traverse_fn(obj, per_thread_trial_decref_visitor);
      }
      obj = (yo_ref_header_t*)obj->gc_next;
    }
    
    // Phase 2: Identify and collect unreachable cycles
    yo_ref_header_t* current = head;
    yo_ref_header_t* prev = NULL;
    
    while (current != NULL) {
      yo_ref_header_t* next = (yo_ref_header_t*)current->gc_next;
      
      // Check total reference count using BRC split words
      uint32_t biased_word = current->biased_word;
      uint32_t shared_word = atomic_load_explicit(&current->shared_word, memory_order_relaxed);
      uint32_t biased_counter = BRC_GET_BIASED_COUNTER(biased_word);
      int32_t shared_counter = BRC_GET_SHARED_COUNTER(shared_word);
      int32_t total_refs = biased_counter + shared_counter;
      
      if (total_refs <= 0) {
        // This object is only referenced by other objects in the cycle - collect it
        
        // Remove from thread's tracking list
        if (prev == NULL) {
          // Removing head of list
          thread_gc->tracked_objects = next;
        } else {
          // Removing middle/end of list
          prev->gc_next = next;
        }
        
        thread_gc->tracked_count--;
        total_collected++;
        
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
          current->traverse_fn(current, per_thread_restore_refcount_visitor);
        }
        
        // Keep this object, move to next
        prev = current;
        current = next;
      }
    }
    
    thread_gc = thread_gc->next;
  }
  
  yo_mutex_unlock(&yo_thread_list_mutex);
  
  // Resume all threads
  yo_gc_resume_all_threads();
  
  // Release the GC collection lock
  atomic_store_explicit(&yo_gc_collection_in_progress, 0, memory_order_release);
}`);

  // Generate thread cleanup function for when threads die
  emitter.emitLine(`// Called when a thread is about to exit to merge its GC state
void __yo_cleanup_thread_gc() {
  if (yo_current_thread_gc == NULL) {
    return; // No GC state to clean up
  }
  
  yo_mutex_lock(&yo_thread_list_mutex);
  
  // Find a main/long-lived thread to merge objects to, or distribute among remaining threads
  yo_thread_gc_state_t* target_thread = NULL;
  yo_thread_gc_state_t* thread_gc = yo_all_thread_gcs;
  
  // Try to find the main thread (usually the first one, with smallest thread ID)
  size_t min_thread_id = SIZE_MAX;
  while (thread_gc != NULL) {
    if (thread_gc != yo_current_thread_gc && thread_gc->thread_id < min_thread_id) {
      min_thread_id = thread_gc->thread_id;
      target_thread = thread_gc;
    }
    thread_gc = thread_gc->next;
  }
  
  // If we have objects to transfer and found a target thread
  if (target_thread != NULL && yo_current_thread_gc->tracked_objects != NULL) {
    // Transfer all tracked objects to target thread
    yo_ref_header_t* current = yo_current_thread_gc->tracked_objects;
    yo_ref_header_t* last = NULL;
    
    // Find the end of our list
    while (current != NULL) {
      last = current;
      current = (yo_ref_header_t*)current->gc_next;
    }
    
    if (last != NULL) {
      // Append our list to target thread's list
      last->gc_next = target_thread->tracked_objects;
      target_thread->tracked_objects = yo_current_thread_gc->tracked_objects;
      target_thread->tracked_count += yo_current_thread_gc->tracked_count;
    }
  } else if (yo_current_thread_gc->tracked_objects != NULL) {
    // No target thread found - force immediate collection of our objects
    // This is a safety measure to prevent memory leaks
    yo_ref_header_t* current = yo_current_thread_gc->tracked_objects;
    while (current != NULL) {
      yo_ref_header_t* next = (yo_ref_header_t*)current->gc_next;
      
      // Force dispose the object
      if (current->dispose_fn) {
        current->dispose_fn(current);
      }
      yo_free(current);
      
      current = next;
    }
  }
  
  // Remove current thread from global list
  yo_thread_gc_state_t* prev = NULL;
  thread_gc = yo_all_thread_gcs;
  while (thread_gc != NULL) {
    if (thread_gc == yo_current_thread_gc) {
      if (prev == NULL) {
        yo_all_thread_gcs = thread_gc->next;
      } else {
        prev->next = thread_gc->next;
      }
      break;
    }
    prev = thread_gc;
    thread_gc = thread_gc->next;
  }
  
  atomic_fetch_sub_explicit(&yo_total_thread_count, 1, memory_order_relaxed);
  
  yo_mutex_unlock(&yo_thread_list_mutex);
  
  // Free the thread GC state
  yo_free(yo_current_thread_gc);
  yo_current_thread_gc = NULL;
}`);
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
      // Initialize BRC fields for split design
      emitter.emitLine(
        `  obj->header.owner_thread_id = yo_get_thread_id();  // Set current thread as owner`
      );
      emitter.emitLine(
        `  // Initialize biased_word: 1 biased reference, GC flags (non-atomic)`
      );
      emitter.emitLine(
        `  obj->header.biased_word = BRC_SET_BIASED_COUNTER(0, 1);  // Start with one biased reference`
      );
      emitter.emitLine(
        `  // Initialize shared_word: 0 shared references, NO_BIAS flag (atomic)`
      );
      emitter.emitLine(
        `  atomic_store_explicit(&obj->header.shared_word, BRC_SET_FLAGS(0, BRC_NO_BIAS), memory_order_relaxed);`
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
        emitter.emitLine(
          `  atomic_store_explicit(&obj->header.ref_count, 1, memory_order_relaxed);`
        );
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
        emitter.emitLine(
          `  atomic_store_explicit(&obj->header.ref_count, 1, memory_order_relaxed);`
        );
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
      emitter.emitLine(
        `  // Initialize BRC fields for split design with current thread as owner`
      );
      emitter.emitLine(`  obj->header.thread_id = yo_get_thread_id();`);
      emitter.emitLine(
        `  // Initialize biased_word: 1 biased reference (non-atomic)`
      );
      emitter.emitLine(
        `  obj->header.biased_word = BRC_SET_BIASED_COUNTER(0, 1);  // Start with one biased reference`
      );
      emitter.emitLine(
        `  // Initialize shared_word: 0 shared references, NO_BIAS flag (atomic)`
      );
      emitter.emitLine(
        `  atomic_store_explicit(&obj->header.shared_word, BRC_SET_FLAGS(0, BRC_NO_BIAS), memory_order_relaxed);`
      );

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
