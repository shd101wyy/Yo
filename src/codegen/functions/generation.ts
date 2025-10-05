import {
  BuiltinFunctions,
  BuiltinKeywords,
  Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
} from "../../expr";
import { FunctionValue, FuncValueId } from "../../function-value";
import {
  ChanType,
  ClosureType,
  DynType,
  EnumType,
  FunctionType,
  isChanType,
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

  // Generate constructor functions for objects
  emitter.emitDeclarationLine(`/// Object constructors`);
  generateObjectConstructorDeclarations(context);
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

  // Generate thread-safe GC runtime functions
  generateAtomicGCRuntimeFunctions(context);

  // Generate channel function implementations
  generateChannelFunctions(context);

  // Generate object constructor functions
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

  // Generate main wrapper if user defined a main function
  generateMainWrapper(context);
}

/**
 * Generate a main() wrapper that calls yo_user_main() and then __yo_task_wait_all()
 * This ensures all cooperative tasks complete before the program exits
 */
function generateMainWrapper(context: FunctionGenerationContext): void {
  const emitter = context.emitter;

  // Check if user defined a main function
  let hasMain = false;
  for (const funcId in context.functions) {
    const { cName } = context.functions[funcId]!;
    if (cName === "yo_user_main") {
      hasMain = true;
      break;
    }
  }

  if (!hasMain) {
    return; // No main function, nothing to wrap
  }

  emitter.emitLine(`
// Main wrapper - automatically calls __yo_task_wait_all() on exit
int main(void) {
  int result = yo_user_main();
  
  // Wait for all cooperative tasks to complete before exiting
  if (yo_task_scheduler_initialized) {
    __yo_task_wait_all();
  }
  
  return result;
}
`);
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
        // For unit/void functions, generate the expression as a statement
        const exprCode = generateExpr(lastExpr, indent, context);
        if (exprCode) {
          emitter.emitLine(`${indent}${exprCode};`);
        }
      } else if (lastExpr) {
        // Check if the last expression has control flow (like return statements)
        const hasControlFlow = lastExpr.$?.controlFlow;

        // Check if last expr is unit - either by type or by being a tuple() call with no args
        const isLastExprUnit =
          isUnitType(lastExpr.$?.type) ||
          (exprIsFunctionCall(lastExpr) &&
            exprIsFunctionCallOf(lastExpr, BuiltinKeywords.tuple) &&
            lastExpr.args.length === 0);
        const prevExpr = args.length > 1 ? args[args.length - 2] : null;
        const prevExprHasControlFlow = prevExpr?.$?.controlFlow;

        if (isLastExprUnit && prevExprHasControlFlow) {
          // Don't generate return for unit if previous expression has control flow or is borrow
          // Skip generating anything - the control flow already happened in the previous expression
        } else if (hasControlFlow) {
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
      // For unit/void functions, generate the expression as a statement
      const exprCode = generateExpr(expr, indent, context);
      if (exprCode) {
        emitter.emitLine(`${indent}${exprCode};`);
      }
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

  // Generate monomorphized thread wrapper functions after all expressions have been processed
  generateThreadWrapperFunctions(context);
}

/**
 * Generate constructor function declarations for objects
 */
export function generateObjectConstructorDeclarations(
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
  emitter.emitDeclarationLine(
    `void __yo_cleanup_thread_gc(); // Clean up thread-local GC state`
  );
  emitter.emitDeclarationLine(
    `static void yo_init_process_cleanup(void); // Initialize process cleanup`
  );
  emitter.emitDeclarationLine(
    `static void __yo_brc_queue_object(void* ptr, size_t owner_tid); // Queue object to owner thread for BRC`
  );

  // Generate dispose function declarations for channel types (forward declarations)
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (isChanType(type)) {
      emitter.emitDeclarationLine(
        `void __yo_dispose_${cName}(void* ptr); // Channel dispose function`
      );
    }
  }

  // Generate constructor declarations for each object
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
  size_t current_thread_id = __yo_get_thread_id();
  
  size_t owner_tid = header->owner_thread_id;
  
  if (owner_tid == current_thread_id /* && owner_tid != 0 */) {
    // FAST DECREMENT (Owner access) - non-atomic biased_word access
    uint32_t biased_word = header->biased_word;
    uint32_t biased_counter = BRC_GET_BIASED_COUNTER(biased_word);
    BRC_DEBUG("FastDecr: ptr=%p, tid=%zu, biased=%u->%u\\n", ptr, current_thread_id, biased_counter, biased_counter - 1);
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
      BRC_DEBUG("FastDecr: Deallocating ptr=%p (biased=0, shared=0)\\n", ptr);
      __yo_gc_unregister(ptr);
      if (dispose_fn) {
        dispose_fn(ptr);
      }
      __yo_free(ptr);
    } else {
      // Give up ownership - object becomes shared
      BRC_DEBUG("FastDecr: Giving up ownership ptr=%p (biased=0, shared=%d)\\n", ptr, BRC_GET_SHARED_COUNTER(new_shared_word));
      header->owner_thread_id = 0;
    }
    
  } else {
    // SLOW DECREMENT (Non-owner access) - atomic shared_word access
    uint32_t old_shared_word, new_shared_word;
    bool was_queued_before, is_queued_now;
    
    do {
      old_shared_word = atomic_load_explicit(&header->shared_word, memory_order_acquire);
      int32_t shared_counter = BRC_GET_SHARED_COUNTER(old_shared_word);
      BRC_DEBUG("SlowDecr: ptr=%p, tid=%zu (owner=%zu), shared=%d->%d\\n", ptr, current_thread_id, owner_tid, shared_counter, shared_counter - 1);
      shared_counter--; // Decrement shared counter
      
      new_shared_word = BRC_SET_SHARED_COUNTER(old_shared_word, shared_counter);
      
      // If counter went negative, set queued flag
      if (shared_counter < 0) {
        new_shared_word = BRC_SET_FLAG(new_shared_word, BRC_FLAG_QUEUED);
      }
    } while (!atomic_compare_exchange_weak_explicit(&header->shared_word, &old_shared_word, new_shared_word, memory_order_acq_rel, memory_order_relaxed));
    
    // Check if queued flag was just set (first time)
    was_queued_before = BRC_HAS_FLAG(old_shared_word, BRC_FLAG_QUEUED);
    is_queued_now = BRC_HAS_FLAG(new_shared_word, BRC_FLAG_QUEUED);
    
    if (!was_queued_before && is_queued_now) {
      // Queued flag was just set - queue the object to owner thread
      BRC_DEBUG("SlowDecr: Queueing ptr=%p to owner tid=%zu (shared=%d)\\n", ptr, owner_tid, BRC_GET_SHARED_COUNTER(new_shared_word));
      __yo_brc_queue_object(ptr, owner_tid);
    } else if (BRC_HAS_FLAG(new_shared_word, BRC_FLAG_MERGED) && BRC_GET_SHARED_COUNTER(new_shared_word) == 0) {
      // Counters are merged and shared counter is zero - deallocate
      __yo_gc_unregister(ptr);
      if (dispose_fn) {
        dispose_fn(ptr);
      }
      __yo_free(ptr);
    }
  }
}

void* __yo_incr_rc(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  // Get current thread ID for BRC logic using fast inline assembly
  size_t current_thread_id = __yo_get_thread_id();
  
  size_t owner_tid = header->owner_thread_id;
  
  if (owner_tid == current_thread_id && owner_tid != 0) {
    // FAST INCREMENT (Owner access) - non-atomic biased_word access
    uint32_t biased_word = header->biased_word;
    uint32_t biased_counter = BRC_GET_BIASED_COUNTER(biased_word);
    BRC_DEBUG("FastIncr: ptr=%p, tid=%zu, biased=%u->%u\\n", ptr, current_thread_id, biased_counter, biased_counter + 1);
    header->biased_word = BRC_SET_BIASED_COUNTER(biased_word, biased_counter + 1); // Non-atomic!
  } else {
    // SLOW INCREMENT (Non-owner access) - atomic shared_word access
    uint32_t old_shared_word, new_shared_word;
    do {
      old_shared_word = atomic_load_explicit(&header->shared_word, memory_order_acquire);
      int32_t shared_counter = BRC_GET_SHARED_COUNTER(old_shared_word);
      BRC_DEBUG("SlowIncr: ptr=%p, tid=%zu (owner=%zu), shared=%d->%d\\n", ptr, current_thread_id, owner_tid, shared_counter, shared_counter + 1);
      shared_counter++; // Increment shared counter
      new_shared_word = BRC_SET_SHARED_COUNTER(old_shared_word, shared_counter);
    } while (!atomic_compare_exchange_weak_explicit(&header->shared_word, &old_shared_word, new_shared_word, memory_order_acq_rel, memory_order_relaxed));
  }
  
  return ptr;
}`);

  // Generate cooperative task scheduler runtime
  emitter.emitLine(`
// Cooperative Task Scheduler Runtime using setjmp/longjmp
// Note: _FORTIFY_SOURCE=0 is defined before includes to disable fortification checks
#include <setjmp.h>

// Thread support
#ifdef _WIN32
  #include <windows.h>
  #include <process.h>
  typedef HANDLE yo_thread_handle_t;
  typedef DWORD yo_thread_id_t;
  typedef CRITICAL_SECTION yo_mutex_t;
  #define YO_MUTEX_INIT(m) InitializeCriticalSection(m)
  #define YO_MUTEX_DESTROY(m) DeleteCriticalSection(m)
  #define YO_MUTEX_LOCK(m) EnterCriticalSection(m)
  #define YO_MUTEX_UNLOCK(m) LeaveCriticalSection(m)
  #define YO_THREAD_ID() ((yo_thread_id_t)GetCurrentThreadId())
#else
  #include <pthread.h>
  #include <unistd.h>
  typedef pthread_t yo_thread_handle_t;
  typedef pthread_t yo_thread_id_t;
  typedef pthread_mutex_t yo_mutex_t;
  #define YO_MUTEX_INIT(m) pthread_mutex_init(m, NULL)
  #define YO_MUTEX_DESTROY(m) pthread_mutex_destroy(m)
  #define YO_MUTEX_LOCK(m) pthread_mutex_lock(m)
  #define YO_MUTEX_UNLOCK(m) pthread_mutex_unlock(m)
  #define YO_THREAD_ID() ((yo_thread_id_t)pthread_self())
#endif

typedef struct yo_task yo_task_t;
typedef struct yo_task_queue yo_task_queue_t;

// Task state
typedef enum {
  YO_TASK_READY,      // Ready to run
  YO_TASK_RUNNING,    // Currently running
  YO_TASK_BLOCKED,    // Blocked on channel operation
  YO_TASK_COMPLETED   // Finished execution
} yo_task_state_t;

// Stack size for each task (64KB default, can be tuned)
#define YO_TASK_STACK_SIZE (64 * 1024)

// Forward declarations
static yo_task_t* __yo_task_dequeue(void);
static void __yo_task_entry(void);

// Minimal assembly: switch stack and call a function (x86_64 only for now)
// This is the ONLY place we use assembly - just to bootstrap onto new stack
#if defined(__x86_64__)
static void __yo_switch_to_stack(void* stack_top, void (*func)(void*), void* arg) {
  __asm__ volatile(
    "movq %0, %%rsp\\n"       // Switch to new stack
    "movq %2, %%rdi\\n"       // First argument (System V ABI)
    "callq *%1\\n"            // Call function
    :
    : "r"(stack_top), "r"(func), "r"(arg)
    : "rsp", "rdi", "memory"
  );
}

// Switch to task stack and longjmp to saved context
// This is needed to resume tasks without creating new stack frames
static void __yo_switch_stack_and_longjmp(void* stack_top, jmp_buf* env) {
  // Reserve 128 bytes below stack_top for red zone and call frame
  // We do this in assembly to avoid using local variables after switching stacks
  
  __asm__ volatile(
    "movq %0, %%rax\\n"              // Load stack_top into rax
    "subq $128, %%rax\\n"            // Reserve 128 bytes for red zone
    "movq %%rax, %%rsp\\n"           // Switch to task's stack
    "movq %1, %%rdi\\n"              // First argument: jmp_buf pointer  
    "movl $1, %%esi\\n"              // Second argument: return value 1
    "call longjmp@PLT\\n"            // Call longjmp via PLT (PIC-safe, noreturn)
    :
    : "r"(stack_top), "r"(env)
    : "rsp", "rdi", "rsi", "rax", "memory"
  );
  __builtin_unreachable();  // Tell compiler this never returns
}
#else
#error "Cooperative scheduler requires x86_64 architecture (for now)"
#endif

// Task structure with context switching support
struct yo_task {
  void (*func)(void*);           // Function to execute
  void* data;                    // Task-specific data
  yo_task_state_t state;         // Current state
  void* wait_channel;            // Channel this task is waiting on (NULL if not waiting)
  jmp_buf context;               // Saved execution context (setjmp/longjmp)
  char* stack;                   // Separate stack for this task
  size_t stack_size;             // Size of allocated stack
  bool context_initialized;      // Whether context has been set up
  yo_task_t* next;               // Next task in queue
};

// Task queue (simple linked list)
struct yo_task_queue {
  yo_task_t* head;
  yo_task_t* tail;
  size_t count;
};

// Worker thread structure with per-thread task queue
typedef struct {
  yo_thread_handle_t handle;
  yo_thread_id_t id;
  bool active;
  yo_task_queue_t ready_queue;     // Each worker has its own ready queue
  yo_task_queue_t blocked_queue;   // Each worker has its own blocked queue
  yo_mutex_t queue_mutex;          // Protects this worker's queues
} yo_worker_thread_t;

// Global task scheduler state
static _Thread_local yo_task_t* yo_task_current = NULL;  // Thread-local current task
static _Thread_local yo_worker_thread_t* yo_task_current_worker = NULL;  // Thread-local worker pointer
static size_t yo_task_max_threads = 0;
static bool yo_task_scheduler_initialized = false;
static _Thread_local jmp_buf yo_task_main_context;  // Thread-local context (main or worker)
static _Thread_local bool yo_task_main_context_set = false;  // Thread-local flag
static _Thread_local yo_task_t* yo_task_to_cleanup = NULL;  // Thread-local cleanup task

// Thread pool state
static yo_worker_thread_t* yo_worker_threads = NULL;
static size_t yo_worker_thread_count = 0;
static _Atomic bool yo_worker_shutdown = false;
static _Atomic size_t yo_next_worker_index = 0;  // For round-robin task distribution

// Helper function to clean up a completed task
// This is called after we've switched away from the task's stack
static void __yo_cleanup_completed_task(yo_task_t* task) {
  if (!task) return;
  CONCURRENCY_DEBUG("[CLEANUP] Freeing stack=%p of task=%p\\n", task->stack, task);
  if (task->stack) {
    __yo_free(task->stack);
  }
  __yo_free(task);
  CONCURRENCY_DEBUG("[CLEANUP] Task cleanup complete\\n");
}

// Bootstrap function - called on new stack to initialize task context
// This runs on the task's stack, so setjmp will save the right stack pointer
static void __yo_task_bootstrap(void* arg) {
  yo_task_t* task = (yo_task_t*)arg;
  CONCURRENCY_DEBUG("[TASK] Bootstrap: task=%p on its own stack\\n", task);
  
  // Save context on the task's stack
  // When we longjmp to this context later, we'll skip past this and start executing
  if (setjmp(task->context) == 0) {
    // First time: mark as initialized
    task->context_initialized = true;
    CONCURRENCY_DEBUG("[TASK] Context saved, task ready to execute\\n");
    // Don't return to scheduler - continue to execute the task!
  } else {
    // Resumed via longjmp - check if there's a completed task to clean up
    if (yo_task_to_cleanup) {
      __yo_cleanup_completed_task(yo_task_to_cleanup);
      yo_task_to_cleanup = NULL;
    }
  }
  
  // Execution continues here both:
  // 1. First time after setjmp (falls through)
  // 2. When resumed via longjmp (jumps here)
  CONCURRENCY_DEBUG("[TASK] Task=%p starting execution\\n", task);
  
  // Execute the actual task function
  task->func(task->data);
  CONCURRENCY_DEBUG("[TASK] Task=%p completed execution\\n", task);
  
  // Task completed - we need to switch away BEFORE freeing our stack!
  task->state = YO_TASK_COMPLETED;
  yo_task_current = NULL;
  
  // Mark this task for cleanup (it will be cleaned up after we switch away)
  yo_task_to_cleanup = task;
  
  // Return to the context that started this task (main thread or worker thread)
  // In thread pool mode, return to worker's context
  // In single-threaded mode, return to main context
  if (yo_task_main_context_set) {
    CONCURRENCY_DEBUG("[TASK] Completed, returning to caller context\\n");
    longjmp(yo_task_main_context, 1);
  }
  
  // Should not reach here
  CONCURRENCY_DEBUG("Error: Task bootstrap reached end without context\\n");
  abort();
}

// Initialize task scheduler
static void __yo_task_scheduler_init(void) {
  if (!yo_task_scheduler_initialized) {
    yo_task_scheduler_initialized = true;
  }
}

// Enqueue a task to a worker's ready queue (called from spawn)
static void __yo_task_enqueue_to_worker(yo_worker_thread_t* worker, yo_task_t* task) {
  YO_MUTEX_LOCK(&worker->queue_mutex);
  
  task->next = NULL;
  if (worker->ready_queue.tail) {
    worker->ready_queue.tail->next = task;
  } else {
    worker->ready_queue.head = task;
  }
  worker->ready_queue.tail = task;
  worker->ready_queue.count++;
  
  YO_MUTEX_UNLOCK(&worker->queue_mutex);
}

// Dequeue a task from current worker's ready queue (called by worker itself)
static yo_task_t* __yo_task_dequeue_from_worker(yo_worker_thread_t* worker) {
  YO_MUTEX_LOCK(&worker->queue_mutex);
  
  yo_task_t* task = worker->ready_queue.head;
  if (task) {
    worker->ready_queue.head = task->next;
    if (!worker->ready_queue.head) {
      worker->ready_queue.tail = NULL;
    }
    worker->ready_queue.count--;
  }
  
  YO_MUTEX_UNLOCK(&worker->queue_mutex);
  return task;
}

// Enqueue a task to current worker's blocked queue
static void __yo_task_block(yo_task_t* task, void* channel) {
  yo_worker_thread_t* worker = yo_task_current_worker;
  if (!worker) {
    CONCURRENCY_DEBUG("[BLOCK] Error: No current worker for task=%p\\n", task);
    return;
  }
  
  YO_MUTEX_LOCK(&worker->queue_mutex);
  
  task->state = YO_TASK_BLOCKED;
  task->wait_channel = channel;
  task->next = NULL;
  if (worker->blocked_queue.tail) {
    worker->blocked_queue.tail->next = task;
  } else {
    worker->blocked_queue.head = task;
  }
  worker->blocked_queue.tail = task;
  worker->blocked_queue.count++;
  
  YO_MUTEX_UNLOCK(&worker->queue_mutex);
}

// Wake up tasks waiting on a specific channel (in current worker's blocked queue)
static void __yo_task_wakeup(void* channel) {
  yo_worker_thread_t* worker = yo_task_current_worker;
  if (!worker) {
    CONCURRENCY_DEBUG("[WAKEUP] Error: No current worker\\n");
    return;
  }
  
  YO_MUTEX_LOCK(&worker->queue_mutex);
  
  CONCURRENCY_DEBUG("[WAKEUP] Waking tasks on channel=%p\\n", channel);
  yo_task_t* task = worker->blocked_queue.head;
  yo_task_t* prev = NULL;
  
  while (task != NULL) {
    yo_task_t* next = task->next;
    
    if (task->wait_channel == channel) {
      CONCURRENCY_DEBUG("[WAKEUP] Moving task=%p to ready queue\\n", task);
      // Remove from blocked queue
      if (prev == NULL) {
        worker->blocked_queue.head = next;
      } else {
        prev->next = next;
      }
      if (worker->blocked_queue.tail == task) {
        worker->blocked_queue.tail = prev;
      }
      worker->blocked_queue.count--;
      
      // Add to ready queue (unlocked version since we hold the lock)
      task->state = YO_TASK_READY;
      task->wait_channel = NULL;
      task->next = NULL;
      if (worker->ready_queue.tail) {
        worker->ready_queue.tail->next = task;
      } else {
        worker->ready_queue.head = task;
      }
      worker->ready_queue.tail = task;
      worker->ready_queue.count++;
      
      // Don't update prev since we removed this node
      task = next;
    } else {
      prev = task;
      task = next;
    }
  }
  
  YO_MUTEX_UNLOCK(&worker->queue_mutex);
}

// Wake up only ONE task waiting on a specific channel (for rendezvous)
static void __yo_task_wakeup_one(void* channel) {
  yo_worker_thread_t* worker = yo_task_current_worker;
  if (!worker) {
    CONCURRENCY_DEBUG("[WAKEUP_ONE] Error: No current worker\\n");
    return;
  }
  
  YO_MUTEX_LOCK(&worker->queue_mutex);
  
  CONCURRENCY_DEBUG("[WAKEUP_ONE] Waking one task on channel=%p\\n", channel);
  yo_task_t* task = worker->blocked_queue.head;
  yo_task_t* prev = NULL;
  
  while (task != NULL) {
    yo_task_t* next = task->next;
    
    if (task->wait_channel == channel) {
      CONCURRENCY_DEBUG("[WAKEUP_ONE] Moving task=%p to ready queue\\n", task);
      // Remove from blocked queue
      if (prev == NULL) {
        worker->blocked_queue.head = next;
      } else {
        prev->next = next;
      }
      if (worker->blocked_queue.tail == task) {
        worker->blocked_queue.tail = prev;
      }
      worker->blocked_queue.count--;
      
      // Add to ready queue (unlocked version since we hold the lock)
      task->state = YO_TASK_READY;
      task->wait_channel = NULL;
      task->next = NULL;
      if (worker->ready_queue.tail) {
        worker->ready_queue.tail->next = task;
      } else {
        worker->ready_queue.head = task;
      }
      worker->ready_queue.tail = task;
      worker->ready_queue.count++;
      
      YO_MUTEX_UNLOCK(&worker->queue_mutex);
      // Only wake one task, then stop
      return;
    } else {
      prev = task;
      task = next;
    }
  }
  
  YO_MUTEX_UNLOCK(&worker->queue_mutex);
}

// Wake up ONE task from ANY worker's blocked queue (global wakeup)
// Used when main thread or non-task context needs to wake a task
static void __yo_task_wakeup_one_global(void* channel) {
  if (yo_worker_thread_count == 0) {
    return;
  }
  
  // Try each worker in sequence until we find a task to wake
  for (size_t i = 0; i < yo_worker_thread_count; i++) {
    yo_worker_thread_t* worker = &yo_worker_threads[i];
    
    YO_MUTEX_LOCK(&worker->queue_mutex);
    
    yo_task_t* task = worker->blocked_queue.head;
    yo_task_t* prev = NULL;
    
    while (task != NULL) {
      yo_task_t* next = task->next;
      
      if (task->wait_channel == channel) {
        CONCURRENCY_DEBUG("[WAKEUP_GLOBAL] Worker %zu waking task=%p\\n", i, task);
        // Remove from blocked queue
        if (prev == NULL) {
          worker->blocked_queue.head = next;
        } else {
          prev->next = next;
        }
        if (worker->blocked_queue.tail == task) {
          worker->blocked_queue.tail = prev;
        }
        worker->blocked_queue.count--;
        
        // Add to ready queue
        task->state = YO_TASK_READY;
        task->wait_channel = NULL;
        task->next = NULL;
        if (worker->ready_queue.tail) {
          worker->ready_queue.tail->next = task;
        } else {
          worker->ready_queue.head = task;
        }
        worker->ready_queue.tail = task;
        worker->ready_queue.count++;
        
        YO_MUTEX_UNLOCK(&worker->queue_mutex);
        return; // Found and woke one task, done
      } else {
        prev = task;
        task = next;
      }
    }
    
    YO_MUTEX_UNLOCK(&worker->queue_mutex);
  }
}


// Worker thread function - runs tasks from its own ready queue
#ifdef _WIN32
static unsigned __stdcall __yo_worker_thread_func(void* arg) {
#else
static void* __yo_worker_thread_func(void* arg) {
#endif
  yo_worker_thread_t* worker = (yo_worker_thread_t*)arg;
  yo_thread_id_t thread_id = YO_THREAD_ID();
  
  // Set thread-local worker pointer
  yo_task_current_worker = worker;
  
  CONCURRENCY_DEBUG("[WORKER] Thread %lu started (worker=%p)\\n", (unsigned long)thread_id, worker);
  
  while (!atomic_load(&yo_worker_shutdown)) {
    yo_task_t* task = __yo_task_dequeue_from_worker(worker);
    
    if (!task) {
      // No tasks available, sleep briefly
      #ifdef _WIN32
      Sleep(1);
      #else
      usleep(1000);  // 1ms
      #endif
      continue;
    }
    
    CONCURRENCY_DEBUG("[WORKER] Thread %lu executing task=%p\\n", (unsigned long)thread_id, task);
    
    yo_task_current = task;
    task->state = YO_TASK_RUNNING;
    
    // Set this thread's context for tasks to return to
    yo_task_main_context_set = true;
    
    if (setjmp(yo_task_main_context) == 0) {
      // First time - clean up any previous task
      if (yo_task_to_cleanup) {
        __yo_cleanup_completed_task(yo_task_to_cleanup);
        yo_task_to_cleanup = NULL;
      }
      
      // Execute task cooperatively using its stack
      if (!task->context_initialized) {
        // First time running - bootstrap on task's stack
        char* stack_top = task->stack + task->stack_size;
        stack_top = (char*)((uintptr_t)stack_top & ~0xFUL);
        __yo_switch_to_stack(stack_top, __yo_task_bootstrap, task);
      } else {
        // Resume task from saved context
        CONCURRENCY_DEBUG("[WORKER] Resuming task=%p from saved context\\n", task);
        // Just longjmp - it will restore the stack pointer from the saved context
        // No need to switch stacks first!
        longjmp(task->context, 1);
      }
      
      // Should not reach here - tasks return via longjmp
      CONCURRENCY_DEBUG("[WORKER] Error: reached end of task execution\\n");
      abort();
    } else {
      // Returned from a task via longjmp
      CONCURRENCY_DEBUG("[WORKER] Returned from task via longjmp\\n");
      
      // Check if a task completed and needs cleanup
      if (yo_task_to_cleanup) {
        CONCURRENCY_DEBUG("[WORKER] Task=%p completed, cleaning up and fetching next\\n", yo_task_to_cleanup);
        __yo_cleanup_completed_task(yo_task_to_cleanup);
        yo_task_to_cleanup = NULL;
        yo_task_current = NULL;
        continue; // Fetch next task
      }
      
      // Check if current task was blocked - it's been moved to blocked queue
      if (yo_task_current && yo_task_current->state == YO_TASK_BLOCKED) {
        CONCURRENCY_DEBUG("[WORKER] Task=%p blocked, fetching next task\\n", yo_task_current);
        yo_task_current = NULL;
        continue; // Fetch next task
      }
      
      // If yo_task_current is NULL, task was cleaned up elsewhere
      if (!yo_task_current) {
        CONCURRENCY_DEBUG("[WORKER] Current task is NULL, fetching next\\n");
        continue;
      }
      
      // Task returned but didn't complete or block - should not happen
      CONCURRENCY_DEBUG("[WORKER] Warning: Task=%p returned via longjmp but not completed/blocked\\n", yo_task_current);
    }
    
    yo_task_current = NULL;
  }
  
  CONCURRENCY_DEBUG("[WORKER] Thread %lu exiting\\n", (unsigned long)thread_id);
  #ifdef _WIN32
  return 0;
  #else
  return NULL;
  #endif
}

// Get number of hardware threads available
size_t __yo_concurrency_get_hardware_threads(void) {
  #ifdef _WIN32
  SYSTEM_INFO sysinfo;
  GetSystemInfo(&sysinfo);
  return (size_t)sysinfo.dwNumberOfProcessors;
  #else
  // Use sysconf on POSIX systems
  long nprocs = sysconf(_SC_NPROCESSORS_ONLN);
  if (nprocs < 1) {
    return 1;  // Fallback to 1 if detection fails
  }
  return (size_t)nprocs;
  #endif
}

// Initialize thread pool
static void __yo_thread_pool_init(size_t num_threads) {
  if (num_threads < 1 || yo_worker_thread_count > 0) {
    return;  // Already initialized or invalid count
  }
  
  CONCURRENCY_DEBUG("[POOL] Initializing %zu worker threads\\n", num_threads);
  
  // Allocate worker thread array
  yo_worker_threads = (yo_worker_thread_t*)__yo_malloc(sizeof(yo_worker_thread_t) * num_threads);
  yo_worker_thread_count = num_threads;
  atomic_store(&yo_worker_shutdown, false);
  atomic_store(&yo_next_worker_index, 0);
  
  // Initialize each worker
  for (size_t i = 0; i < num_threads; i++) {
    yo_worker_threads[i].active = true;
    yo_worker_threads[i].ready_queue = (yo_task_queue_t){NULL, NULL, 0};
    yo_worker_threads[i].blocked_queue = (yo_task_queue_t){NULL, NULL, 0};
    YO_MUTEX_INIT(&yo_worker_threads[i].queue_mutex);
    
    #ifdef _WIN32
    yo_worker_threads[i].handle = (HANDLE)_beginthreadex(
      NULL, 0, __yo_worker_thread_func, &yo_worker_threads[i], 0, NULL
    );
    #else
    pthread_create(&yo_worker_threads[i].handle, NULL, __yo_worker_thread_func, &yo_worker_threads[i]);
    #endif
    
    CONCURRENCY_DEBUG("[POOL] Spawned worker thread %zu\\n", i);
  }
}

// Set maximum number of threads for task scheduler
void __yo_concurrency_set_maximum_threads(size_t num) {
  __yo_task_scheduler_init();
  
  // If num is 0, use hardware thread count
  if (num == 0) {
    num = __yo_concurrency_get_hardware_threads();
  }
  
  yo_task_max_threads = num;
  
  // Always initialize thread pool (even for num=1)
  __yo_thread_pool_init(num);
}

// Yield is no longer used with per-thread queues - tasks run cooperatively within each worker
// Blocking/wakeup happens via __yo_task_block_and_yield which is called by channel operations

// Wait for all spawned tasks to complete
// This should be called from the main thread to run all pending tasks
void __yo_task_wait_all(void) {
  if (!yo_task_scheduler_initialized) {
    return; // No tasks to wait for
  }
  
  CONCURRENCY_DEBUG("[WAIT_ALL] Waiting for all tasks to complete\\n");
  
  // If using thread pool, wait for all tasks to complete then join threads
  if (yo_worker_thread_count > 0) {
    CONCURRENCY_DEBUG("[WAIT_ALL] Waiting for thread pool to finish\\n");
    
    // Wait until all worker queues are empty (both ready and blocked)
    while (true) {
      size_t total_tasks = 0;
      
      for (size_t i = 0; i < yo_worker_thread_count; i++) {
        YO_MUTEX_LOCK(&yo_worker_threads[i].queue_mutex);
        total_tasks += yo_worker_threads[i].ready_queue.count;
        total_tasks += yo_worker_threads[i].blocked_queue.count;
        YO_MUTEX_UNLOCK(&yo_worker_threads[i].queue_mutex);
      }
      
      if (total_tasks == 0) {
        break;
      }
      
      // Sleep briefly to avoid busy waiting
      #ifdef _WIN32
      Sleep(1);
      #else
      usleep(1000);  // 1ms
      #endif
    }
    
    // Signal workers to shutdown
    atomic_store(&yo_worker_shutdown, true);
    
    // Join all worker threads
    for (size_t i = 0; i < yo_worker_thread_count; i++) {
      if (yo_worker_threads[i].active) {
        #ifdef _WIN32
        WaitForSingleObject(yo_worker_threads[i].handle, INFINITE);
        CloseHandle(yo_worker_threads[i].handle);
        #else
        pthread_join(yo_worker_threads[i].handle, NULL);
        #endif
        YO_MUTEX_DESTROY(&yo_worker_threads[i].queue_mutex);
      }
    }
    
    // Clean up thread pool
    __yo_free(yo_worker_threads);
    yo_worker_threads = NULL;
    yo_worker_thread_count = 0;
    
    CONCURRENCY_DEBUG("[WAIT_ALL] Thread pool shut down\\n");
    return;
  }
  
  // Single-threaded mode not supported with per-thread queues
  CONCURRENCY_DEBUG("[WAIT_ALL] Error: No worker threads initialized\\n");
}

// Block current task on a channel and yield to another task
// This is a specialized version of yield that also marks the task as blocked
static void __yo_task_block_and_yield(void* channel) {
  if (!yo_task_scheduler_initialized || !yo_task_current) {
    return;
  }
  
  yo_worker_thread_t* worker = yo_task_current_worker;
  if (!worker) {
    CONCURRENCY_DEBUG("[BLOCK] Error: No current worker\\n");
    return;
  }
  
  yo_task_t* current = yo_task_current;
  CONCURRENCY_DEBUG("[BLOCK] Blocking task=%p on channel=%p\\n", current, channel);
  
  // Save current context before blocking
  if (setjmp(current->context) == 0) {
    // Mark task as blocked and move to blocked queue
    __yo_task_block(current, channel);
    
    // Get next ready task from this worker's queue
    yo_task_t* next = __yo_task_dequeue_from_worker(worker);
    if (next) {
      yo_task_current = next;
      next->state = YO_TASK_RUNNING;
      CONCURRENCY_DEBUG("[BLOCK] Switching to next=%p\\n", next);
      
      if (next->context_initialized) {
        // Resume next task - just longjmp, it will restore stack from saved context
        longjmp(next->context, 1);
      } else {
        // First time running next task
        char* stack_top = next->stack + next->stack_size;
        stack_top = (char*)((uintptr_t)stack_top & ~0xFUL);
        __yo_switch_to_stack(stack_top, __yo_task_bootstrap, next);
      }
    } else {
      // No ready tasks - return to worker's main context
      // Don't set yo_task_current = NULL here - let the worker check the state
      if (yo_task_main_context_set) {
        CONCURRENCY_DEBUG("[BLOCK] No ready tasks, returning to worker\\n");
        longjmp(yo_task_main_context, 1);
      }
      // If no main context, we're deadlocked - but let the channel code handle it
    }
  } else {
    // Resumed via longjmp - restore yo_task_current and check for cleanup
    // NOTE: When we longjmp, thread-local variables ARE preserved!
    CONCURRENCY_DEBUG("[BLOCK] Task resumed after blocking (setjmp returned 1), task=%p\\n", yo_task_current);
    if (yo_task_to_cleanup) {
      __yo_cleanup_completed_task(yo_task_to_cleanup);
      yo_task_to_cleanup = NULL;
    }
    CONCURRENCY_DEBUG("[BLOCK] About to return, task=%p\\n", yo_task_current);
  }
  
  // Returns here when unblocked and resumed
  CONCURRENCY_DEBUG("[BLOCK] Returned from block_and_yield, task=%p\\n", yo_task_current);
}
`);
}

/**
 * Generate specialized task spawn functions for cooperative multitasking
 */
function generateThreadWrapperFunctions(context: CodeGenContext): void {
  const emitter = context.emitter;

  // Generate task spawn function declarations
  emitter.emitDeclarationLine(`/// Task spawn function declarations`);
  const generatedDeclarationSignatures = new Set<string>();

  for (const [signatureStr, signature] of context.spawnedFunctionSignatures) {
    const { parameterTypes } = signature;

    if (generatedDeclarationSignatures.has(signatureStr)) {
      continue;
    }
    generatedDeclarationSignatures.add(signatureStr);

    // Generate declaration for task spawn function
    const paramDecls = parameterTypes
      .map((paramType, index) => {
        const paramTypeStr = getTypeString(paramType, context);
        return `${paramTypeStr} arg${index}`;
      })
      .join(", ");

    const spawnFunctionName = `__yo_task_spawn_${signatureStr}`;
    emitter.emitDeclarationLine(
      `void ${spawnFunctionName}(void* func${
        paramDecls ? `, ${paramDecls}` : ""
      }); // Task spawn function for ${signatureStr}`
    );
  }
  emitter.emitDeclarationLine("");

  // Generate task data structures and spawn functions
  const generatedSignatures = new Set<string>();

  for (const [signatureStr, signature] of context.spawnedFunctionSignatures) {
    const { parameterTypes } = signature;

    if (generatedSignatures.has(signatureStr)) {
      continue;
    }
    generatedSignatures.add(signatureStr);

    // Generate task data structure
    const structName = `yo_task_data_${signatureStr}_t`;

    const paramFields = parameterTypes
      .map((paramType, index) => {
        const paramTypeStr = getTypeString(paramType, context);
        return `  ${paramTypeStr} arg${index};\n`;
      })
      .join("");

    emitter.emitLine(`typedef struct ${structName} {
  void* function;
${paramFields}} ${structName};
`);

    // Generate task execution function
    // Note: We ignore the return value since spawned tasks are fire-and-forget
    const executeFnName = `__yo_task_execute_${signatureStr}`;
    const paramTypesStr = parameterTypes
      .map((paramType) => getTypeString(paramType, context))
      .join(", ");

    let executeBody: string;
    if (parameterTypes.length === 0) {
      // Call function and explicitly ignore return value with (void) cast
      executeBody = `  void (*func)(void) = (void (*)(void))data->function;
  (void)func();  // Explicitly ignore return value`;
    } else {
      const argsList = parameterTypes
        .map((_, index) => `data->arg${index}`)
        .join(", ");
      // Call function and explicitly ignore return value with (void) cast
      executeBody = `  void (*func)(${paramTypesStr}) = (void (*)(${paramTypesStr}))data->function;
  (void)func(${argsList});  // Explicitly ignore return value`;
    }

    emitter.emitLine(`static void ${executeFnName}(void* task_data) {
  ${structName}* data = (${structName}*)task_data;
${executeBody}
  __yo_free(data);
}
`);

    // Generate task spawn function
    const spawnFunctionName = `__yo_task_spawn_${signatureStr}`;
    const constructorParams = [
      "void* func",
      ...parameterTypes.map((paramType, index) => {
        const paramTypeStr = getTypeString(paramType, context);
        return `${paramTypeStr} arg${index}`;
      }),
    ].join(", ");

    const paramAssignments = parameterTypes
      .map((_, index) => {
        return `  data->arg${index} = arg${index};\n`;
      })
      .join("");

    emitter.emitLine(`void ${spawnFunctionName}(${constructorParams}) {
  __yo_task_scheduler_init();
  
  // Auto-initialize thread pool with hardware threads if not already done
  if (yo_worker_thread_count == 0) {
    __yo_concurrency_set_maximum_threads(0);  // 0 = use hardware threads
  }
  
  // Allocate task data
  ${structName}* data = (${structName}*)__yo_malloc(sizeof(${structName}));
  data->function = func;
${paramAssignments}
  
  // Create task
  yo_task_t* task = (yo_task_t*)__yo_malloc(sizeof(yo_task_t));
  task->func = ${executeFnName};
  task->data = data;
  task->state = YO_TASK_READY;
  task->wait_channel = NULL;
  task->next = NULL;
  task->context_initialized = false;
  
  // Allocate separate stack for cooperative scheduling
  task->stack = (char*)__yo_malloc(YO_TASK_STACK_SIZE);
  task->stack_size = YO_TASK_STACK_SIZE;
  
  // Distribute task to worker thread round-robin
  if (yo_worker_thread_count > 0) {
    size_t worker_idx = atomic_fetch_add(&yo_next_worker_index, 1) % yo_worker_thread_count;
    CONCURRENCY_DEBUG("[SPAWN] Assigning task=%p to worker %zu\\n", task, worker_idx);
    __yo_task_enqueue_to_worker(&yo_worker_threads[worker_idx], task);
  } else {
    CONCURRENCY_DEBUG("[SPAWN] Error: No workers available\\n");
    __yo_free(task->stack);
    __yo_free(task);
    __yo_free(data);
  }
}
`);
  }
}

/**
 * Generate per-thread garbage collection runtime functions with stop-the-world collection
 */
function generateAtomicGCRuntimeFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Per-thread GC tracking state
  emitter.emitLine(`// Per-thread GC tracking state for better scalability
static _Thread_local yo_thread_gc_state_t* yo_current_thread_gc = NULL;  // Current thread's GC state
static yo_thread_gc_state_t* yo_all_thread_gcs = NULL;  // Global list of all thread GC states
#if defined(_WIN32)
// Windows: C11 threads - no static initializers available
static YO_THREAD_SYNC_TYPE yo_thread_list_mutex;  // Protects thread list
static YO_THREAD_SYNC_TYPE yo_gc_pause_mutex;  // For GC pause coordination
static YO_COND_TYPE yo_gc_pause_cond;  // Condition for GC pause synchronization
#elif defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
// Unix-like: pthreads with static initializers
static YO_THREAD_SYNC_TYPE yo_thread_list_mutex = YO_THREAD_SYNC_INIT;  // Protects thread list
static YO_THREAD_SYNC_TYPE yo_gc_pause_mutex = YO_THREAD_SYNC_INIT;  // For GC pause coordination
static YO_COND_TYPE yo_gc_pause_cond = YO_COND_INIT;  // Condition for GC pause synchronization
#endif
static _Atomic(size_t) yo_gc_collect_threshold = ATOMIC_VAR_INIT(1000);  // Collect when this many objects tracked
static _Atomic(int) yo_gc_collection_in_progress = ATOMIC_VAR_INIT(0);  // Prevents concurrent GC collections
static _Atomic(int) yo_threads_paused_count = ATOMIC_VAR_INIT(0);  // Count of threads paused for GC
static _Atomic(int) yo_total_thread_count = ATOMIC_VAR_INIT(0);  // Total number of registered threads

// Thread cleanup infrastructure - automatically call __yo_cleanup_thread_gc when threads exit
#if defined(_WIN32)
// Windows: Use C11 threads.h TSS (Thread-Specific Storage)
static tss_t yo_thread_cleanup_key;
static once_flag yo_thread_cleanup_once = ONCE_FLAG_INIT;

// Called automatically when a thread exits (via TSS destructor)
static void yo_thread_cleanup_destructor(void* value) {
  if (value != NULL) {
    __yo_cleanup_thread_gc();
  }
}

// Initialize TSS key for thread cleanup (called once)
static void yo_init_thread_cleanup_key(void) {
  tss_create(&yo_thread_cleanup_key, yo_thread_cleanup_destructor);
}
#elif defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
// Unix-like systems: Use pthreads
static pthread_key_t yo_thread_cleanup_key = (pthread_key_t)(-1);
static pthread_once_t yo_thread_cleanup_once = PTHREAD_ONCE_INIT;

// Called automatically when a thread exits (via pthread key destructor)
static void yo_pthread_cleanup(void* value) {
  if (value != NULL) {
    __yo_cleanup_thread_gc();
  }
}

// Initialize pthread key for thread cleanup (called once)
static void yo_init_thread_cleanup_key(void) {
  pthread_key_create(&yo_thread_cleanup_key, yo_pthread_cleanup);
}
#endif

// Initialize thread-local GC state (called automatically on first GC operation)
static void yo_init_thread_gc() {
  if (yo_current_thread_gc != NULL) return;  // Already initialized

  // Initialize thread cleanup infrastructure
#if defined(_WIN32)
  call_once(&yo_thread_cleanup_once, yo_init_thread_cleanup_key);
  // Set a non-NULL value for this thread so the destructor gets called
  tss_set(yo_thread_cleanup_key, (void*)1);
#elif defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
  pthread_once(&yo_thread_cleanup_once, yo_init_thread_cleanup_key);
  // Set a non-NULL value for this thread so the destructor gets called
  if (yo_thread_cleanup_key != (pthread_key_t)(-1)) {
    pthread_setspecific(yo_thread_cleanup_key, (void*)1);
  }
#endif
  
  // Initialize process cleanup on first thread init (usually main thread)
  yo_init_process_cleanup();

  yo_current_thread_gc = (yo_thread_gc_state_t*)__yo_malloc(sizeof(yo_thread_gc_state_t));
  yo_current_thread_gc->tracked_objects = NULL;
  yo_current_thread_gc->tracked_count = 0;
  yo_current_thread_gc->thread_id = __yo_get_thread_id();  // Use fast thread ID function
  atomic_store_explicit(&yo_current_thread_gc->gc_paused, 0, memory_order_relaxed);

  // Add to global thread list
  yo_mutex_lock(&yo_thread_list_mutex);
  yo_current_thread_gc->next = yo_all_thread_gcs;
  yo_current_thread_gc->prev = NULL;
  if (yo_all_thread_gcs != NULL) {
    yo_all_thread_gcs->prev = yo_current_thread_gc;
  }
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
  
  BRC_DEBUG("GC Register: ptr=%p, tid=%zu\\\\n", ptr, __yo_get_thread_id());
  
  // Check if already tracked (non-atomic since we're the owner or during STW)
  uint32_t biased_word = header->biased_word;
  if (YO_GC_HAS_FLAG(biased_word, YO_GC_TRACKED)) {
    return; // Already tracked
  }
  
  // Set the TRACKED flag (non-atomic update since we're the owner)
  header->biased_word = YO_GC_SET_FLAG(biased_word, YO_GC_TRACKED);
  
  // Add to thread-local tracking list (doubly-linked, no synchronization needed)
  header->gc_next = yo_current_thread_gc->tracked_objects;
  header->gc_prev = NULL;
  if (yo_current_thread_gc->tracked_objects != NULL) {
    yo_current_thread_gc->tracked_objects->gc_prev = header;
  }
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
  
  // Remove from thread-local tracking list using doubly-linked pointers (O(1) deletion)
  if (header->gc_prev != NULL) {
    // Not the head node - update previous node's next pointer
    header->gc_prev->gc_next = header->gc_next;
  } else {
    // Head node - update thread's tracked_objects pointer
    yo_current_thread_gc->tracked_objects = (yo_ref_header_t*)header->gc_next;
  }
  
  if (header->gc_next != NULL) {
    // Update next node's prev pointer (works for both head and non-head removal)
    header->gc_next->gc_prev = header->gc_prev;
  }

  yo_current_thread_gc->tracked_count--;
}`);

  // Generate BRC queue function for handling queued objects
  emitter.emitLine(`// BRC helper function to queue objects to owner thread
static void __yo_brc_queue_object(void* ptr, size_t owner_tid) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  // If already queued (gc_next is not NULL), no need to queue again
  if (header->gc_next != NULL) {
    return;
  }
  
  // Find the owner thread's GC state and add object to its tracked list
  yo_mutex_lock(&yo_thread_list_mutex);
  yo_thread_gc_state_t* thread_gc = yo_all_thread_gcs;
  while (thread_gc != NULL) {
    if (thread_gc->thread_id == owner_tid) {
      break;
    }
    thread_gc = thread_gc->next;
  }
  
  // If owner thread's GC state doesn't exist, initialize it
  if (thread_gc == NULL) {
    thread_gc = (yo_thread_gc_state_t*)__yo_malloc(sizeof(yo_thread_gc_state_t));
    thread_gc->thread_id = owner_tid;
    thread_gc->tracked_objects = NULL;
    thread_gc->tracked_count = 0;
    thread_gc->next = yo_all_thread_gcs;
    yo_all_thread_gcs = thread_gc;
#ifdef YO_DEBUG_BRC
    BRC_DEBUG("BRC: QueueObj: Initialized GC state for owner tid=%zu\\n", owner_tid);
#endif
  }
  
  // Add to owner thread's tracked objects (this serves as the QueuedObjects list)
  header->gc_next = thread_gc->tracked_objects;
  header->gc_prev = NULL;
  if (thread_gc->tracked_objects != NULL) {
    thread_gc->tracked_objects->gc_prev = header;
  }
  thread_gc->tracked_objects = header;
  thread_gc->tracked_count++;
  
  yo_mutex_unlock(&yo_thread_list_mutex);
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
  
  BRC_DEBUG("GC: Starting collection\\n");
  
  // Stop the world - pause all other threads
  yo_gc_pause_all_threads();
  
  size_t total_collected __attribute__((unused)) = 0;
  
  // Collect from all thread-local GC lists
  yo_mutex_lock(&yo_thread_list_mutex);
  yo_thread_gc_state_t* thread_gc = yo_all_thread_gcs;
  
  while (thread_gc != NULL) {
    yo_ref_header_t* head = thread_gc->tracked_objects;
    BRC_DEBUG("GC: Processing thread tid=%zu, tracked_count=%zu\\\\n", thread_gc->thread_id, thread_gc->tracked_count);
    if (head == NULL) {
      thread_gc = thread_gc->next;
      continue; // This thread has no tracked objects
    }
    
    // Phase 0: BRC explicit merge - handle queued objects during stop-the-world
    yo_ref_header_t* merge_obj = head;
    yo_ref_header_t* merge_prev = NULL;
    
    while (merge_obj != NULL) {
      yo_ref_header_t* merge_next = (yo_ref_header_t*)merge_obj->gc_next;
      
      // Check if this object is queued for explicit merge (non-atomic since STW)
      uint32_t shared_word = atomic_load_explicit(&merge_obj->shared_word, memory_order_relaxed);
      if (BRC_HAS_FLAG(shared_word, BRC_FLAG_QUEUED)) {
        // Perform explicit merge using split words (safe during STW)
        uint32_t biased_word = merge_obj->biased_word;  // Non-atomic read (STW)
        uint32_t biased_counter = BRC_GET_BIASED_COUNTER(biased_word);
        
        // Merge counters: add biased_counter to shared_counter
        int32_t shared_counter = BRC_GET_SHARED_COUNTER(shared_word);
        int32_t merged_counter = shared_counter + biased_counter;
        
        BRC_DEBUG("GC ExplicitMerge: ptr=%p, biased=%u, shared=%d, merged=%d\\n", merge_obj, biased_counter, shared_counter, merged_counter);
        
        // Update shared word with merged counter and clear queued flag, set merged flag
        uint32_t new_shared_word = BRC_SET_SHARED_COUNTER(shared_word, merged_counter);
        new_shared_word = BRC_SET_FLAG(new_shared_word, BRC_FLAG_MERGED);
        new_shared_word = BRC_CLEAR_FLAG(new_shared_word, BRC_FLAG_QUEUED);
        atomic_store_explicit(&merge_obj->shared_word, new_shared_word, memory_order_relaxed);
        
        // Clear biased counter since it's now merged
        merge_obj->biased_word = BRC_SET_BIASED_COUNTER(biased_word, 0);
        
        if (merged_counter == 0) {
          // Object can be deallocated immediately
          BRC_DEBUG("GC ExplicitMerge: Deallocating ptr=%p (merged=0)\\n", merge_obj);
          if (merge_obj->dispose_fn) {
            merge_obj->dispose_fn(merge_obj);
          }
          __yo_free(merge_obj);
          
          // Remove from tracking list
          if (merge_prev == NULL) {
            thread_gc->tracked_objects = merge_next;
            head = merge_next; // Update head pointer
          } else {
            merge_prev->gc_next = merge_next;
          }
          thread_gc->tracked_count--;
          total_collected++;
          
          // Continue with next, don't update prev
          merge_obj = merge_next;
          continue;
        } else {
          // Give up ownership since counters are merged
          BRC_DEBUG("GC ExplicitMerge: Giving up ownership ptr=%p (merged=%d)\\n", merge_obj, merged_counter);
          merge_obj->owner_thread_id = 0;
        }
      }
      
      merge_prev = merge_obj;
      merge_obj = merge_next;
    }
    
    // Update head after potential removals in explicit merge
    head = thread_gc->tracked_objects;
    if (head == NULL) {
      thread_gc = thread_gc->next;
      continue; // No objects left after explicit merge
    }
    
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
        
        __yo_free(current);
        
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
      __yo_free(current);
      
      current = next;
    }
  }
  
  // Remove current thread from global list (O(1) operation with doubly-linked list)
  if (yo_current_thread_gc->prev != NULL) {
    yo_current_thread_gc->prev->next = yo_current_thread_gc->next;
  } else {
    // We're the head of the list
    yo_all_thread_gcs = yo_current_thread_gc->next;
  }
  
  if (yo_current_thread_gc->next != NULL) {
    yo_current_thread_gc->next->prev = yo_current_thread_gc->prev;
  }
  
  atomic_fetch_sub_explicit(&yo_total_thread_count, 1, memory_order_relaxed);
  
  yo_mutex_unlock(&yo_thread_list_mutex);
  
  // Free the thread GC state
  __yo_free(yo_current_thread_gc);
  yo_current_thread_gc = NULL;
}

// Process cleanup - clean up remaining threads and resources
static void yo_process_cleanup(void) {
  // Clean up the main thread's GC state
  __yo_cleanup_thread_gc();
  
  // Clean up thread cleanup key
#if defined(_WIN32)
  tss_delete(yo_thread_cleanup_key);
#elif defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
  if (yo_thread_cleanup_key != (pthread_key_t)(-1)) {
    pthread_key_delete(yo_thread_cleanup_key);
  }
#endif

  // Clean up mutexes and condition variables
#if defined(_WIN32)
  mtx_destroy(&yo_thread_list_mutex);
  mtx_destroy(&yo_gc_pause_mutex);
  cnd_destroy(&yo_gc_pause_cond);
#endif
  // Unix systems with static initializers don't need explicit cleanup
}

// Initialize process cleanup (call this from main or constructor)
static void yo_init_process_cleanup(void) {
  static bool cleanup_initialized = false;
  if (cleanup_initialized) return;
  cleanup_initialized = true;
  
  // Initialize mutexes and condition variables (only needed on Windows)
#if defined(_WIN32)
  mtx_init(&yo_thread_list_mutex, mtx_plain);
  mtx_init(&yo_gc_pause_mutex, mtx_plain);
  cnd_init(&yo_gc_pause_cond);
#endif
  // Unix systems use static initializers, no need to initialize explicitly
  
  atexit(yo_process_cleanup);
}`);
}

/**
 * Generate traversal functions for objects (used by GC for marking)
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
          // This field is a direct reference to another object
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
 * Generate constructor function implementations for objects and ref enums
 */
export function generateRefStructConstructorFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // First, generate traversal functions for each object type
  generateRefStructTraversalFunctions(context);

  // Generate constructor implementations for each object
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
        `  ${cName}* obj = (${cName}*)__yo_malloc(sizeof(${cName}));`
      );
      // Initialize BRC fields for split design
      emitter.emitLine(
        `  obj->header.owner_thread_id = __yo_get_thread_id();  // Set current thread as owner`
      );
      emitter.emitLine(
        `  BRC_DEBUG("ObjCreate: ptr=%p, tid=%zu, biased=1, shared=0\\n", obj, obj->header.owner_thread_id);`
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
          `  ${captureTypeName}* captureData = __yo_malloc(sizeof(${captureTypeName}));`
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
          `  ${cName}* obj = (${cName}*)__yo_malloc(sizeof(${cName}));`
        );
        emitter.emitLine(
          `  obj->header.owner_thread_id = __yo_get_thread_id();`
        );
        emitter.emitLine(
          `  obj->header.biased_word = BRC_SET_BIASED_COUNTER(0, 1);`
        );
        emitter.emitLine(
          `  atomic_store_explicit(&obj->header.shared_word, 0, memory_order_relaxed);`
        );
        emitter.emitLine(`  obj->header.gc_next = NULL;`);
        emitter.emitLine(`  obj->header.gc_prev = NULL;`);
        emitter.emitLine(`  obj->header.dispose_fn = NULL;`);
        emitter.emitLine(`  obj->header.traverse_fn = NULL;`);
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
          `  ${cName}* obj = (${cName}*)__yo_malloc(sizeof(${cName}));`
        );
        emitter.emitLine(
          `  obj->header.owner_thread_id = __yo_get_thread_id();`
        );
        emitter.emitLine(
          `  obj->header.biased_word = BRC_SET_BIASED_COUNTER(0, 1);`
        );
        emitter.emitLine(
          `  atomic_store_explicit(&obj->header.shared_word, 0, memory_order_relaxed);`
        );
        emitter.emitLine(`  obj->header.gc_next = NULL;`);
        emitter.emitLine(`  obj->header.gc_prev = NULL;`);
        emitter.emitLine(`  obj->header.dispose_fn = NULL;`);
        emitter.emitLine(`  obj->header.traverse_fn = NULL;`);
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
            emitter.emitLine(`    __yo_free(self->data);`);
            emitter.emitLine(`  }`);
          } else {
            emitter.emitLine(
              `  // No C function name found for capture type drop function`
            );
            emitter.emitLine(`  if (self->data) { __yo_free(self->data); }`);
          }
        } else {
          emitter.emitLine(
            `  // No drop function found in capture type module`
          );
          emitter.emitLine(`  if (self->data) { __yo_free(self->data); }`);
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
        `  ${cName}* obj = (${cName}*)__yo_malloc(sizeof(${cName}));`
      );
      emitter.emitLine(
        `  // Initialize BRC fields for split design with current thread as owner`
      );
      emitter.emitLine(`  obj->header.owner_thread_id = __yo_get_thread_id();`);
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
      emitter.emitLine(`  obj->header.gc_next = NULL;`);
      emitter.emitLine(`  obj->header.gc_prev = NULL;`);
      emitter.emitLine(`  obj->header.dispose_fn = dispose_fn;`);
      emitter.emitLine(`  obj->header.traverse_fn = NULL;`);

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

/**
 * Generate channel function implementations for all collected channel types
 */
function generateChannelFunctions(context: FunctionGenerationContext): void {
  const emitter = context.emitter;

  // Collect all channel types from the context
  const channelTypes: Array<{ type: ChanType; cName: string }> = [];

  for (const typeId in context.types) {
    const typeEntry = context.types[typeId]!;
    if (isChanType(typeEntry.type)) {
      channelTypes.push({ type: typeEntry.type, cName: typeEntry.cName });
    }
  }

  if (channelTypes.length === 0) {
    return; // No channel types to generate
  }

  // Generate channel functions for each collected channel type
  for (const { type: chanType, cName } of channelTypes) {
    const elementTypeStr = getTypeString(chanType.elementType, context);
    // Use cName directly - it should already be a valid C identifier without * suffix
    const safeCName = cName;

    // Find the Option type for the element type - this should already be collected
    // Look for Option(elementType) in the context types using typeName
    // Use the original Yo type name, not the C type name, for matching
    const elementYoTypeName = typeToString(chanType.elementType);
    let optionReturnTypeStr = `/* Option(${elementTypeStr}) type not found */`;
    let noneTag = 0; // Default fallback
    let someTag = 1; // Default fallback
    const expectedOptionTypeName = `Option(${elementYoTypeName})`;

    console.log(
      `DEBUG: Looking for Option type with elementTypeStr: "${elementTypeStr}"`
    );
    console.log(`DEBUG: Element Yo type name: "${elementYoTypeName}"`);
    console.log(`DEBUG: Expected Option typeName: "${expectedOptionTypeName}"`);

    for (const typeId in context.types) {
      const typeEntry = context.types[typeId]!;
      if (isEnumType(typeEntry.type)) {
        const enumType = typeEntry.type;
        console.log(
          `DEBUG: Found enum type with typeName: "${enumType.typeName}", variants: ${enumType.variants.map((v) => v.name).join(", ")}`
        );
        console.log(
          `DEBUG: Comparing "${enumType.typeName}" === "${expectedOptionTypeName}": ${enumType.typeName === expectedOptionTypeName}`
        );

        // Use typeName for exact matching - this is more reliable
        if (enumType.typeName === expectedOptionTypeName) {
          console.log(
            `DEBUG: Found matching Option type: ${enumType.typeName} with cName: ${typeEntry.cName}`
          );
          optionReturnTypeStr = typeEntry.cName;

          // Find the tag values for None and Some variants
          const noneVariantIndex = enumType.variants.findIndex(
            (v) => v.name === "None"
          );
          const someVariantIndex = enumType.variants.findIndex(
            (v) => v.name === "Some"
          );

          console.log(
            `DEBUG: None variant index: ${noneVariantIndex}, Some variant index: ${someVariantIndex}`
          );

          // Update the tag values
          noneTag = noneVariantIndex;
          someTag = someVariantIndex;

          break;
        }
      }
    }
    emitter.emitLine(`// Channel functions for ${cName}

${cName}* __yo_chan_create_${safeCName}(size_t capacity) {
  ${cName}* chan = (${cName}*)__yo_malloc(sizeof(${cName}));
  if (!chan) return NULL;

  // Initialize reference counting header
  chan->header.owner_thread_id = __yo_get_thread_id();
  chan->header.biased_word = BRC_SET_BIASED_COUNTER(0, 1);
  atomic_store_explicit(&chan->header.shared_word, 0, memory_order_relaxed);
  chan->header.gc_next = NULL;
  chan->header.gc_prev = NULL;
  chan->header.dispose_fn = __yo_dispose_${safeCName};
  chan->header.traverse_fn = NULL;

  // Initialize channel fields
  chan->capacity = capacity;
  chan->size = 0;
  chan->head = 0;
  chan->tail = 0;
  atomic_store_explicit(&chan->closed, 0, memory_order_relaxed);

  if (capacity > 0) {
    chan->buffer = (${elementTypeStr}*)__yo_malloc(sizeof(${elementTypeStr}) * capacity);
    if (!chan->buffer) {
      __yo_free(chan);
      return NULL;
    }
  } else {
    chan->buffer = NULL;
  }

  // Initialize synchronization primitives
#if defined(_WIN32)
  InitializeCriticalSection(&chan->mutex);
  InitializeConditionVariable(&chan->send_cond);
  InitializeConditionVariable(&chan->recv_cond);
#else
  pthread_mutex_init(&chan->mutex, NULL);
  pthread_cond_init(&chan->send_cond, NULL);
  pthread_cond_init(&chan->recv_cond, NULL);
#endif

  return chan;
}
`);

    // Channel send function
    emitter.emitLine(`void __yo_chan_send_${safeCName}(${cName}* chan, ${elementTypeStr} value) {
  if (!chan || atomic_load_explicit(&chan->closed, memory_order_acquire)) {
    return; // Channel is null or closed
  }

    if (chan->capacity == 0) {
      // Unbuffered channel - synchronous send (rendezvous)
      
      // For cooperative task scheduler: block and switch to another task
      if (yo_task_scheduler_initialized && yo_task_current) {
        
retry_send:  // Label for retrying after being woken up
        
#if defined(_WIN32)
        EnterCriticalSection(&chan->mutex);
#else
        pthread_mutex_lock(&chan->mutex);
#endif

        if (atomic_load_explicit(&chan->closed, memory_order_acquire)) {
#if defined(_WIN32)
          LeaveCriticalSection(&chan->mutex);
#else
          pthread_mutex_unlock(&chan->mutex);
#endif
          return;
        }

        // Check if another sender is already active
        if (chan->size > 0) {
#if defined(_WIN32)
          LeaveCriticalSection(&chan->mutex);
#else
          pthread_mutex_unlock(&chan->mutex);
#endif
          // Another sender is active, block and wait for our turn
          __yo_task_block_and_yield(chan);
          
          // When resumed, try again from the beginning (using goto to avoid recursion)
          goto retry_send;
        }

        // Now we can send (size == 0, no other sender)
        // Allocate temporary storage for the value if not already allocated
        if (chan->buffer == NULL) {
          chan->buffer = (${elementTypeStr}*)__yo_malloc(sizeof(${elementTypeStr}));
        }
        
        // Store the value
        chan->buffer[0] = value;
        chan->size = 1; // Mark that a value is ready

#if defined(_WIN32)
        LeaveCriticalSection(&chan->mutex);
#else
        pthread_mutex_unlock(&chan->mutex);
#endif

        // Signal any pthread-blocked receiver (like main thread) that data is available
#if defined(_WIN32)
        WakeConditionVariable(&chan->recv_cond);
#else
        pthread_cond_signal(&chan->recv_cond);
#endif

        // Wake up ONE receiver task (not all tasks!)
        __yo_task_wakeup_one(chan);
        
        // Block this task until receiver takes our value (receiver will set size back to 0)
        __yo_task_block_and_yield(chan);
        
        CONCURRENCY_DEBUG("[SEND] Task=%p resumed from blocking, about to wake next sender\\n", yo_task_current);
        
        // When we resume, the receiver has taken our value
        // Wake up next sender waiting for their turn (use global wakeup since we might not have current worker set)
        __yo_task_wakeup_one_global(chan);
        
        CONCURRENCY_DEBUG("[SEND] Task=%p completed send, returning\\n", yo_task_current);
        return;
      }    // Fall back to pthread blocking for non-task contexts
#if defined(_WIN32)
    EnterCriticalSection(&chan->mutex);
#else
    pthread_mutex_lock(&chan->mutex);
#endif

    if (atomic_load_explicit(&chan->closed, memory_order_acquire)) {
#if defined(_WIN32)
      LeaveCriticalSection(&chan->mutex);
#else
      pthread_mutex_unlock(&chan->mutex);
#endif
      return;
    }

    // Allocate temporary storage for the value if not already allocated
    if (chan->buffer == NULL) {
      chan->buffer = (${elementTypeStr}*)__yo_malloc(sizeof(${elementTypeStr}));
    }
    
    // Store the value
    chan->buffer[0] = value;
    chan->size = 1; // Mark that a value is ready

    // Signal receiver that data is available and wait for handoff
#if defined(_WIN32)
    WakeConditionVariable(&chan->recv_cond);
    // Wait for receiver to take the value
    while (chan->size > 0 && !atomic_load_explicit(&chan->closed, memory_order_acquire)) {
      SleepConditionVariableCS(&chan->send_cond, &chan->mutex, INFINITE);
    }
    LeaveCriticalSection(&chan->mutex);
#else
    pthread_cond_signal(&chan->recv_cond);
    // Wait for receiver to take the value
    while (chan->size > 0 && !atomic_load_explicit(&chan->closed, memory_order_acquire)) {
      pthread_cond_wait(&chan->send_cond, &chan->mutex);
    }
    pthread_mutex_unlock(&chan->mutex);
#endif
    return;
  }

  // Buffered channel
  if (yo_task_scheduler_initialized && yo_task_current) {
    // Cooperative multitasking: check if buffer is full
    bool buffer_full = false;
    
#if defined(_WIN32)
    EnterCriticalSection(&chan->mutex);
#else
    pthread_mutex_lock(&chan->mutex);
#endif
    
    buffer_full = (chan->size >= chan->capacity);
    
    if (buffer_full && !atomic_load_explicit(&chan->closed, memory_order_acquire)) {
#if defined(_WIN32)
      LeaveCriticalSection(&chan->mutex);
#else
      pthread_mutex_unlock(&chan->mutex);
#endif
      // Block and switch to another task
      __yo_task_block_and_yield(chan);
      
      // When resumed, try again
#if defined(_WIN32)
      EnterCriticalSection(&chan->mutex);
#else
      pthread_mutex_lock(&chan->mutex);
#endif
    }

    if (atomic_load_explicit(&chan->closed, memory_order_acquire)) {
#if defined(_WIN32)
      LeaveCriticalSection(&chan->mutex);
#else
      pthread_mutex_unlock(&chan->mutex);
#endif
      return;
    }

    // Add value to buffer
    chan->buffer[chan->tail] = value;
    chan->tail = (chan->tail + 1) % chan->capacity;
    chan->size++;

#if defined(_WIN32)
      LeaveCriticalSection(&chan->mutex);
#else
      pthread_mutex_unlock(&chan->mutex);
#endif

    // Wake up any tasks waiting to receive
    __yo_task_wakeup(chan);
    return;
  }

  // Fall back to pthread blocking for non-task contexts
#if defined(_WIN32)
  EnterCriticalSection(&chan->mutex);
  while (chan->size >= chan->capacity && !atomic_load_explicit(&chan->closed, memory_order_acquire)) {
    SleepConditionVariableCS(&chan->send_cond, &chan->mutex, INFINITE);
  }
#else
  pthread_mutex_lock(&chan->mutex);
  while (chan->size >= chan->capacity && !atomic_load_explicit(&chan->closed, memory_order_acquire)) {
    pthread_cond_wait(&chan->send_cond, &chan->mutex);
  }
#endif

  if (atomic_load_explicit(&chan->closed, memory_order_acquire)) {
#if defined(_WIN32)
    LeaveCriticalSection(&chan->mutex);
#else
    pthread_mutex_unlock(&chan->mutex);
#endif
    return;
  }

  // Add value to buffer
  chan->buffer[chan->tail] = value;
  chan->tail = (chan->tail + 1) % chan->capacity;
  chan->size++;

#if defined(_WIN32)
  WakeConditionVariable(&chan->recv_cond);
  LeaveCriticalSection(&chan->mutex);
#else
  pthread_cond_signal(&chan->recv_cond);
  pthread_mutex_unlock(&chan->mutex);
#endif
}
`);

    // Channel receive function
    emitter.emitLine(`${optionReturnTypeStr} __yo_chan_recv_${safeCName}(${cName}* chan) {
  ${optionReturnTypeStr} result;
  memset(&result, 0, sizeof(result)); // Initialize to zero (None case)

  if (!chan) {
    return result; // Return None for null channel
  }

  if (chan->capacity == 0) {
    // Unbuffered channel - synchronous receive (rendezvous)
    
    // For cooperative task scheduler: check if data is available, otherwise process tasks
    if (yo_task_scheduler_initialized) {
#if defined(_WIN32)
      EnterCriticalSection(&chan->mutex);
#else
      pthread_mutex_lock(&chan->mutex);
#endif
      
      // Check if data is available (from a blocked sender)
      if (chan->size > 0 && chan->buffer != NULL) {
        // Data is available! Take it and wake the sender
        ${elementTypeStr} value = chan->buffer[0];
        chan->size = 0; // Mark that value has been taken
        
        // Construct Some(value)
        result.tag = ${someTag}; // SOME variant
        result.data.Some.value = value;

#if defined(_WIN32)
        LeaveCriticalSection(&chan->mutex);
#else
        pthread_mutex_unlock(&chan->mutex);
#endif

        // Wake up the ONE sender task that was blocked
        __yo_task_wakeup_one(chan);
        
        return result;
      }
      
      // No data available yet
      bool in_task = (yo_task_current != NULL);
      
#if defined(_WIN32)
      LeaveCriticalSection(&chan->mutex);
#else
      pthread_mutex_unlock(&chan->mutex);
#endif
        
      if (in_task) {
        // We're in a task, block and switch to another task
        __yo_task_block_and_yield(chan);
        
        // When resumed, data should be available - take it
#if defined(_WIN32)
        EnterCriticalSection(&chan->mutex);
#else
        pthread_mutex_lock(&chan->mutex);
#endif

        if (chan->size > 0 && chan->buffer != NULL) {
          ${elementTypeStr} value = chan->buffer[0];
          chan->size = 0;
          result.tag = ${someTag};
          result.data.Some.value = value;
        } else {
          result.tag = ${noneTag};
        }

#if defined(_WIN32)
        LeaveCriticalSection(&chan->mutex);
#else
        pthread_mutex_unlock(&chan->mutex);
#endif

        __yo_task_wakeup(chan);
        return result;
      }
      
      // Not in a task - fall through to pthread blocking below
    }
    
    // Fall back to pthread blocking for non-task contexts
#if defined(_WIN32)
    EnterCriticalSection(&chan->mutex);
    // Wait for sender to provide data
    while (chan->size == 0 && !atomic_load_explicit(&chan->closed, memory_order_acquire)) {
      SleepConditionVariableCS(&chan->recv_cond, &chan->mutex, INFINITE);
    }
#else
    pthread_mutex_lock(&chan->mutex);
    // Wait for sender to provide data
    while (chan->size == 0 && !atomic_load_explicit(&chan->closed, memory_order_acquire)) {
      pthread_cond_wait(&chan->recv_cond, &chan->mutex);
    }
#endif

    if (chan->size > 0 && chan->buffer != NULL) {
      // Get the value
      ${elementTypeStr} value = chan->buffer[0];
      chan->size = 0; // Mark that value has been taken
      
      // Construct Some(value)
      result.tag = ${someTag}; // SOME variant
      result.data.Some.value = value;

      // Signal sender that value has been taken
#if defined(_WIN32)
      WakeConditionVariable(&chan->send_cond);
      LeaveCriticalSection(&chan->mutex);
#else
      pthread_cond_signal(&chan->send_cond);
      pthread_mutex_unlock(&chan->mutex);
#endif

      // Also wake up any task-blocked senders across all workers
      __yo_task_wakeup_one_global(chan);
    } else {
      // Channel closed, return None
      result.tag = ${noneTag}; // NONE variant
#if defined(_WIN32)
      LeaveCriticalSection(&chan->mutex);
#else
      pthread_mutex_unlock(&chan->mutex);
#endif
    }
    
    return result;
  }

  // Buffered channel
  if (yo_task_scheduler_initialized && yo_task_current) {
#if defined(_WIN32)
    EnterCriticalSection(&chan->mutex);
#else
    pthread_mutex_lock(&chan->mutex);
#endif
    
    // Check if buffer is empty
    if (chan->size == 0 && !atomic_load_explicit(&chan->closed, memory_order_acquire)) {
#if defined(_WIN32)
      LeaveCriticalSection(&chan->mutex);
#else
      pthread_mutex_unlock(&chan->mutex);
#endif
      // Buffer empty, block and switch to another task
      __yo_task_block_and_yield(chan);
      
      // When resumed, try again
#if defined(_WIN32)
      EnterCriticalSection(&chan->mutex);
#else
      pthread_mutex_lock(&chan->mutex);
#endif
    }

    if (chan->size > 0) {
      // Get value from buffer
      ${elementTypeStr} value = chan->buffer[chan->head];
      chan->head = (chan->head + 1) % chan->capacity;
      chan->size--;
      
      // Construct Some(value)
      result.tag = ${someTag}; // SOME variant
      result.data.Some.value = value;
    } else {
      // No data available - return None
      result.tag = ${noneTag}; // NONE variant
    }

#if defined(_WIN32)
    LeaveCriticalSection(&chan->mutex);
#else
    pthread_mutex_unlock(&chan->mutex);
#endif

    // Wake up any tasks waiting to send
    __yo_task_wakeup(chan);
    return result;
  }

  // Fall back to pthread blocking for non-task contexts
#if defined(_WIN32)
  EnterCriticalSection(&chan->mutex);
  while (chan->size == 0 && !atomic_load_explicit(&chan->closed, memory_order_acquire)) {
    SleepConditionVariableCS(&chan->recv_cond, &chan->mutex, INFINITE);
  }
#else
  pthread_mutex_lock(&chan->mutex);
  while (chan->size == 0 && !atomic_load_explicit(&chan->closed, memory_order_acquire)) {
    pthread_cond_wait(&chan->recv_cond, &chan->mutex);
  }
#endif

  if (chan->size > 0) {
    // Get value from buffer
    ${elementTypeStr} value = chan->buffer[chan->head];
    chan->head = (chan->head + 1) % chan->capacity;
    chan->size--;
    
    // Construct Some(value)
    result.tag = ${someTag}; // SOME variant
    result.data.Some.value = value;
  } else {
    // No data available - return None
    result.tag = ${noneTag}; // NONE variant
  }

#if defined(_WIN32)
  WakeConditionVariable(&chan->send_cond);
  LeaveCriticalSection(&chan->mutex);
#else
  pthread_cond_signal(&chan->send_cond);
  pthread_mutex_unlock(&chan->mutex);
#endif

  return result;
}
`);

    // Channel close function
    emitter.emitLine(`void __yo_chan_close_${safeCName}(${cName}* chan) {
  if (!chan) return;

#if defined(_WIN32)
  EnterCriticalSection(&chan->mutex);
#else
  pthread_mutex_lock(&chan->mutex);
#endif

  atomic_store_explicit(&chan->closed, 1, memory_order_release);

#if defined(_WIN32)
  WakeAllConditionVariable(&chan->send_cond);
  WakeAllConditionVariable(&chan->recv_cond);
  LeaveCriticalSection(&chan->mutex);
#else
  pthread_cond_broadcast(&chan->send_cond);
  pthread_cond_broadcast(&chan->recv_cond);
  pthread_mutex_unlock(&chan->mutex);
#endif
}
`);

    // Channel dispose function
    emitter.emitLine(`void __yo_dispose_${safeCName}(void* ptr) {
  ${cName}* chan = (${cName}*)ptr;
  if (!chan) return;

  // Close the channel first to wake any waiting threads
  __yo_chan_close_${safeCName}(chan);

  // Free the buffer if allocated
  if (chan->buffer != NULL) {
    __yo_free(chan->buffer);
    chan->buffer = NULL;
  }

  // Destroy synchronization primitives
#if defined(_WIN32)
  DeleteCriticalSection(&chan->mutex);
  // Condition variables don't need explicit cleanup on Windows
#else
  pthread_mutex_destroy(&chan->mutex);
  pthread_cond_destroy(&chan->send_cond);
  pthread_cond_destroy(&chan->recv_cond);
#endif
}
`);
  }
}
