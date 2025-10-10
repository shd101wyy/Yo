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

  // Forward declaration for unit coroutine spawn function (used by main wrapper)
  emitter.emitDeclarationLine(
    `void __yo_coro_spawn_unit_function(void (*func)(void)); // Spawn unit function as coroutine`
  );

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
        isClosureType(t.type) &&
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
 * Generate a main() wrapper that calls yo_user_main() and then __yo_coro_wait_all()
 * This ensures all cooperative coroutines complete before the program exits
 * REQUIREMENT: main function must return unit (void)
 */
function generateMainWrapper(context: FunctionGenerationContext): void {
  const emitter = context.emitter;

  // Check if user defined a main function
  let hasMain = false;
  let mainFunctionValue: FunctionValue | null = null;
  for (const funcId in context.functions) {
    const { cName, value } = context.functions[funcId]!;
    if (cName === "yo_user_main") {
      hasMain = true;
      mainFunctionValue = value;
      break;
    }
  }

  if (!hasMain || !mainFunctionValue) {
    return; // No main function, nothing to wrap
  }

  // REQUIREMENT: main must return unit
  const returnType = mainFunctionValue.type.return.type;
  const returnsUnit = isUnitType(returnType);

  if (!returnsUnit) {
    throw new Error(
      `main function must return unit, but it returns ${typeToString(returnType)}. ` +
        `Use 'main :: (fn() -> unit)' instead. ` +
        `For exit codes, use 'exit(code)' from std/libc/stdlib.yo`
    );
  }

  // Main returns unit - generate wrapper that spawns main as a task
  emitter.emitLine(`
// Main wrapper - spawns yo_user_main as a coroutine and waits for completion
int main(void) {
  // Spawn yo_user_main as a coroutine so all channel operations use coroutine wait queues
  __yo_coro_spawn_unit_function(yo_user_main);
  
  // Wait for all cooperative coroutines (including main) to complete before exiting
  if (yo_coro_scheduler_initialized) {
    __yo_coro_wait_all();
  }
  
  return 0;
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
    // This is a closure function - find the closure type by matching the function being generated
    // The closure's callType points to the same function value (by funcId)
    // We need to find the STRUCT VARIANT closure type (with captures), not the basetype
    const closureTypeEntry = Object.values(context.types).find((t) => {
      if (!isClosureType(t.type)) return false;
      const closureType = t.type;

      // Skip basetype closures without captures - look for struct variants
      if (!closureType.captureType) return false;

      // Find the function entry for this closure's callType
      // The callType's function value should have the same funcId as the function we're generating
      for (const funcEntry of Object.values(context.functions)) {
        const entryFunctionType =
          funcEntry.value.specializedType ?? funcEntry.value.type;
        if (
          entryFunctionType === closureType.callType &&
          funcEntry.value.funcId === functionValue.funcId
        ) {
          return true;
        }
      }
      return false;
    });

    if (
      closureTypeEntry &&
      (closureTypeEntry.type as ClosureType).captureType
    ) {
      const closureType = closureTypeEntry.type as ClosureType;
      const captureType = closureType.captureType;
      (context as FunctionGenerationContext).currentClosureType = closureType;

      if (captureType && isStructType(captureType)) {
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

  // Generate cooperative coroutine scheduler runtime
  emitter.emitLine(`
// Cooperative Task Scheduler Runtime using llco (Low-Level Coroutines)
// Note: _FORTIFY_SOURCE=0 is defined before includes to disable fortification checks

#include <setjmp.h>
#include "vendor/llco/llco.h"

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
  #ifdef __linux__
    #include <sys/syscall.h>  // For syscall() and SYS_* constants
    #include <sys/epoll.h>    // For epoll async I/O
  #elif defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
    #include <sys/event.h>    // For kqueue async I/O
  #endif
  #include <fcntl.h>          // For fcntl() to set O_NONBLOCK
  #include <errno.h>          // For errno, EAGAIN, EINTR
  typedef pthread_t yo_thread_handle_t;
  typedef pthread_t yo_thread_id_t;
  typedef pthread_mutex_t yo_mutex_t;
  #define YO_MUTEX_INIT(m) pthread_mutex_init(m, NULL)
  #define YO_MUTEX_DESTROY(m) pthread_mutex_destroy(m)
  #define YO_MUTEX_LOCK(m) pthread_mutex_lock(m)
  #define YO_MUTEX_UNLOCK(m) pthread_mutex_unlock(m)
  #define YO_THREAD_ID() ((yo_thread_id_t)pthread_self())
  #ifdef __APPLE__
    #include <mach/thread_policy.h>
    #include <mach/thread_act.h>
  #endif
#endif

typedef struct yo_coro yo_coro_t;
typedef struct yo_coro_queue yo_coro_queue_t;
typedef struct yo_worker_thread yo_worker_thread_t;

// Coroutine state
typedef enum {
  YO_CORO_READY,      // Ready to run
  YO_CORO_RUNNING,    // Currently running
  YO_CORO_BLOCKED,    // Blocked on channel operation
  YO_CORO_COMPLETED   // Finished execution
} yo_coro_state_t;

// Select case information
typedef struct yo_select_case {
  void* channel;              // Channel for this case
  bool is_send;               // true = send, false = receive
  void* value_ptr;            // For send: pointer to value, for recv: pointer to store result
  int case_index;             // Which case this is (for switch statement)
} yo_select_case_t;

// Select state for a coroutine blocked in select
typedef struct {
  yo_select_case_t* cases;    // Array of select cases
  int num_cases;              // Number of cases
  int ready_case;             // Which case is ready (-1 if none)
  bool has_default;           // Whether there's a default case
} yo_select_state_t;

// Stack size for each coroutine (default 16KB - configurable per coroutine)
// llco requires minimum LLCO_MINSTACKSIZE (16KB)
#define YO_CORO_DEFAULT_STACK_SIZE (16 * 1024)

// Stack overflow detection - canary value placed at bottom of stack
// Stack grows DOWN from high to low addresses, so overflow writes below stack_base
#define YO_STACK_GUARD_SIZE 16  // 16 bytes for guard (2 x uint64_t)
#define YO_STACK_CANARY 0xDEADBEEFCAFEBABEULL

// Forward declarations
static yo_coro_t* __yo_coro_pool_get(size_t stack_size);
static void __yo_coro_pool_put(yo_coro_t* coro);
static void __yo_set_thread_affinity(size_t core_id);
static void __yo_check_stack_overflow(yo_coro_t* coro);

// Coroutine structure with llco coroutine support
struct yo_coro {
  void (*func)(void*);           // Function to execute
  void* data;                    // Task-specific data
  yo_coro_state_t state;         // Current state
  void* wait_channel;            // Channel this coroutine is waiting on (NULL if not waiting)
  yo_select_state_t* select_state; // Select state if blocked in select (NULL otherwise)
  void* recv_data_ptr;           // For channel recv: points to receiver's local variable (like neco's cmsg)
  void* send_data_ptr;           // For channel send: points to sender's value to send
  size_t send_data_size;         // Size of send data (for validation)
  struct llco* coro;             // llco coroutine handle
  char* stack;                   // Separate stack for this task
  size_t stack_size;             // Size of allocated stack
  yo_worker_thread_t* owner_worker; // Worker thread that owns this task
  yo_coro_t* next;               // Next coroutine in queue (for ready/blocked queues)
  yo_coro_t* next_wait;          // Next coroutine in channel wait queue
};

// Coroutine queue (simple linked list)
struct yo_coro_queue {
  yo_coro_t* head;
  yo_coro_t* tail;
  size_t count;
};

// I/O wait modes for async I/O
#define YO_WAIT_READ  1
#define YO_WAIT_WRITE 2

// Maximum number of file descriptors we can wait on
#define YO_MAX_FDS 1024

// Worker thread structure with per-thread coroutine queue and I/O poller
struct yo_worker_thread {
  yo_thread_handle_t handle;
  yo_thread_id_t id;
  bool active;
  size_t core_id;                  // CPU core this worker is pinned to
  yo_coro_queue_t ready_queue;     // Each worker has its own ready queue
  yo_coro_queue_t blocked_queue;   // Each worker has its own blocked queue
  yo_mutex_t queue_mutex;          // Protects this worker's queues
  
  // Async I/O support (epoll on Linux, kqueue on macOS/BSD)
  int qfd;                         // Event queue file descriptor (epoll_fd or kqueue_fd)
  yo_coro_t* ev_read_waiters[YO_MAX_FDS];  // Map fd -> coroutine waiting for read
  yo_coro_t* ev_write_waiters[YO_MAX_FDS]; // Map fd -> coroutine waiting for write
};

// Global coroutine scheduler state
static _Thread_local yo_coro_t* yo_coro_current = NULL;  // Thread-local current task
static _Thread_local yo_worker_thread_t* yo_coro_current_worker = NULL;  // Thread-local worker pointer
static size_t yo_coro_max_threads = 0;
static bool yo_coro_scheduler_initialized = false;
static _Thread_local yo_coro_t* yo_coro_to_cleanup = NULL;  // Thread-local cleanup task

// Coroutine pool (thread-local) - segregated free lists for different stack sizes
// Each worker thread has its own pools - no mutex needed, zero contention!
// Common stack sizes get their own list for O(1) lookup
static _Thread_local yo_coro_t* yo_coro_pool_16kb = NULL;   // 16KB (default)
static _Thread_local yo_coro_t* yo_coro_pool_32kb = NULL;   // 32KB
static _Thread_local yo_coro_t* yo_coro_pool_64kb = NULL;   // 64KB
static _Thread_local yo_coro_t* yo_coro_pool_128kb = NULL;  // 128KB
static _Thread_local yo_coro_t* yo_coro_pool_256kb = NULL;  // 256KB
static _Thread_local yo_coro_t* yo_coro_pool_512kb = NULL;  // 512KB
static _Thread_local yo_coro_t* yo_coro_pool_1mb = NULL;    // 1MB
static _Thread_local yo_coro_t* yo_coro_pool_custom = NULL; // Other sizes (sorted by size)
#ifdef YO_DEBUG_CONCURRENCY
static _Thread_local size_t yo_coro_pool_size = 0;
#endif
// No size limit - pool grows as needed and is cleaned up only at shutdown

// Thread pool state
static yo_worker_thread_t* yo_worker_threads = NULL;
static size_t yo_worker_thread_count = 0;
static size_t yo_coro_active_worker_limit = 0;  // Limit for coroutine distribution (set by set_maximum_threads)
static _Atomic bool yo_worker_shutdown = false;
static _Atomic size_t yo_next_worker_index = 0;  // For round-robin coroutine distribution
static _Atomic size_t yo_active_coro_count = 0;  // Total number of active coroutines (spawned but not completed)

// Helper function to clean up a completed task
// This is called after we've switched away from the coroutine's stack
// NOTE: We only free the stack, not the coroutine structure itself!
// The coroutine structure stays allocated so that checks on coro->state remain valid
// Helper function to clean up a completed task (like neco's cleanup callback)
// This is called after we've switched away from the coroutine's stack
// Following neco's approach: return coroutine to pool instead of freeing
static void __yo_cleanup_completed_coro(yo_coro_t* coro) {
  if (!coro) return;
  CONCURRENCY_DEBUG("[CLEANUP] Returning coro=%p to pool\\n", coro);
  // Return to pool for reuse (like neco)
  __yo_coro_pool_put(coro);
}

// Cleanup callback for llco - called when coroutine is finalized
static void __yo_coro_llco_cleanup(void* stack, size_t stack_size, void* udata) {
  CONCURRENCY_DEBUG("[CLEANUP] llco cleanup callback: stack=%p, size=%zu\\n", stack, stack_size);
  // Coroutine will be returned to pool by __yo_cleanup_completed_coro
  // This callback is just for llco bookkeeping
}

// Coroutine entry function - called by llco when coroutine starts
static void __yo_coro_entry(void* udata) {
  yo_coro_t* coro = (yo_coro_t*)udata;
  
  // Capture this coroutine's handle for future resume operations
  coro->coro = llco_current();
  
  CONCURRENCY_DEBUG("[CORO] Entry: coro=%p starting execution\\n", coro);
  
  // Execute the actual coroutine function
  coro->func(coro->data);
  CONCURRENCY_DEBUG("[CORO] Coroutine=%p completed execution\\n", coro);
  
  // Check for stack overflow immediately after function execution (before marking completed)
  // This is critical - local variables are allocated during func execution, not before!
  __yo_check_stack_overflow(coro);
  
  // Coroutine completed - mark it and switch back
  coro->state = YO_CORO_COMPLETED;
  coro->coro = NULL;  // NULL out coroutine so any dequeue checks will catch it
  yo_coro_current = NULL;
  
  // Decrement active coroutine counter
  atomic_fetch_sub(&yo_active_coro_count, 1);
  CONCURRENCY_DEBUG("[CORO] Active coroutine count decremented\\n");
  
  // Mark this coroutine for cleanup (it will be cleaned up after we switch away)
  yo_coro_to_cleanup = coro;
  
  // Switch back to scheduler (NULL means return to caller)
  CONCURRENCY_DEBUG("[CORO] Completed, switching back to scheduler\\n");
  llco_switch(NULL, true);  // final=true means we're done with this coroutine
}

// Initialize coroutine scheduler
static void __yo_coro_scheduler_init(void) {
  if (!yo_coro_scheduler_initialized) {
    yo_coro_scheduler_initialized = true;
    // Thread-local pool needs no mutex initialization
  }
}

// Get a coroutine from the thread-local pool or allocate a new one
// Uses segregated free lists for common sizes (O(1)), best-fit for custom sizes (O(n))
// No mutex needed - each worker has its own pool!
static yo_coro_t* __yo_coro_pool_get(size_t stack_size) {
  yo_coro_t* coro = NULL;
  yo_coro_t** pool_head = NULL;
  
  // Try exact match from segregated pools (O(1))
  if (stack_size == 16 * 1024) {
    pool_head = &yo_coro_pool_16kb;
  } else if (stack_size == 32 * 1024) {
    pool_head = &yo_coro_pool_32kb;
  } else if (stack_size == 64 * 1024) {
    pool_head = &yo_coro_pool_64kb;
  } else if (stack_size == 128 * 1024) {
    pool_head = &yo_coro_pool_128kb;
  } else if (stack_size == 256 * 1024) {
    pool_head = &yo_coro_pool_256kb;
  } else if (stack_size == 512 * 1024) {
    pool_head = &yo_coro_pool_512kb;
  } else if (stack_size == 1024 * 1024) {
    pool_head = &yo_coro_pool_1mb;
  }
  
  if (pool_head && *pool_head) {
    // Found exact match in segregated pool
    coro = *pool_head;
    *pool_head = coro->next;
    #ifdef YO_DEBUG_CONCURRENCY
    yo_coro_pool_size--;
    CONCURRENCY_DEBUG("[POOL] Reusing coroutine from segregated pool, coro=%p, stack_size=%zu, pool_size=%zu\\n", 
                      coro, coro->stack_size, yo_coro_pool_size);
    #else
    CONCURRENCY_DEBUG("[POOL] Reusing coroutine from segregated pool, coro=%p, stack_size=%zu\\n", 
                      coro, coro->stack_size);
    #endif
  } else if (!coro) {
    // No exact match - try custom pool for best-fit (first fit with size >= requested)
    yo_coro_t** prev = &yo_coro_pool_custom;
    for (yo_coro_t* candidate = *prev; candidate; prev = &candidate->next, candidate = *prev) {
      if (candidate->stack_size >= stack_size) {
        // Found suitable coroutine - unlink from pool
        *prev = candidate->next;
        coro = candidate;
        #ifdef YO_DEBUG_CONCURRENCY
        yo_coro_pool_size--;
        CONCURRENCY_DEBUG("[POOL] Reusing coroutine from custom pool, coro=%p, stack_size=%zu (requested=%zu), pool_size=%zu\\n", 
                          coro, coro->stack_size, stack_size, yo_coro_pool_size);
        #else
        CONCURRENCY_DEBUG("[POOL] Reusing coroutine from custom pool, coro=%p, stack_size=%zu (requested=%zu)\\n", 
                          coro, coro->stack_size, stack_size);
        #endif
        break;
      }
    }
  }
  
  if (!coro) {
    // Allocate new coroutine with requested stack size PLUS bottom guard zone
    // Stack grows DOWN from (stack_base + stack_size) toward stack_base
    // Overflow writes BELOW stack_base, into the guard zone
    size_t total_size = YO_STACK_GUARD_SIZE + stack_size;
    char* buffer = (char*)__yo_malloc(total_size);
    
    coro = (yo_coro_t*)__yo_malloc(sizeof(yo_coro_t));
    coro->stack = buffer + YO_STACK_GUARD_SIZE;  // Skip bottom guard to get usable stack
    coro->stack_size = stack_size;
    
    // Initialize stack canary at bottom (before usable stack, in guard zone)
    uint64_t* canary = (uint64_t*)buffer;
    *canary = YO_STACK_CANARY;
    *(canary + 1) = YO_STACK_CANARY;
    
    CONCURRENCY_DEBUG("[POOL] Allocated new coroutine, coro=%p, usable_stack=%p, stack_size=%zu, guard=%p\\n", 
                      coro, coro->stack, stack_size, canary);
  }
  
  // Reset coroutine state
  coro->state = YO_CORO_READY;
  coro->wait_channel = NULL;
  coro->next = NULL;
  coro->coro = NULL;
  coro->select_state = NULL;
  coro->next_wait = NULL;
  coro->recv_data_ptr = NULL;
  coro->send_data_ptr = NULL;
  coro->send_data_size = 0;
  
  return coro;
}

// Return a coroutine to the thread-local pool
// Uses segregated free lists for O(1) return
// No mutex needed - zero contention!
static void __yo_coro_pool_put(yo_coro_t* coro) {
  if (!coro) return;
  
  // Free the llco coroutine handle if it exists
  if (coro->coro) {
    coro->coro = NULL;
  }
  
  // ALWAYS add to pool during execution (never free during execution to avoid use-after-free)
  // We'll free all pooled coroutines during shutdown in __yo_coro_wait_all()
  
  // Return to appropriate segregated pool based on stack size
  yo_coro_t** pool_head = NULL;
  size_t stack_size = coro->stack_size;
  
  if (stack_size == 16 * 1024) {
    pool_head = &yo_coro_pool_16kb;
  } else if (stack_size == 32 * 1024) {
    pool_head = &yo_coro_pool_32kb;
  } else if (stack_size == 64 * 1024) {
    pool_head = &yo_coro_pool_64kb;
  } else if (stack_size == 128 * 1024) {
    pool_head = &yo_coro_pool_128kb;
  } else if (stack_size == 256 * 1024) {
    pool_head = &yo_coro_pool_256kb;
  } else if (stack_size == 512 * 1024) {
    pool_head = &yo_coro_pool_512kb;
  } else if (stack_size == 1024 * 1024) {
    pool_head = &yo_coro_pool_1mb;
  } else {
    // Custom size - insert sorted by stack_size (ascending) for best-fit reuse
    pool_head = &yo_coro_pool_custom;
    yo_coro_t** prev = pool_head;
    while (*prev && (*prev)->stack_size < stack_size) {
      prev = &(*prev)->next;
    }
    coro->next = *prev;
    *prev = coro;
    #ifdef YO_DEBUG_CONCURRENCY
    yo_coro_pool_size++;
    CONCURRENCY_DEBUG("[POOL] Returned coroutine to custom pool (sorted), coro=%p, stack_size=%zu, pool_size=%zu\\n", 
                      coro, stack_size, yo_coro_pool_size);
    #else
    CONCURRENCY_DEBUG("[POOL] Returned coroutine to custom pool (sorted), coro=%p, stack_size=%zu\\n", 
                      coro, stack_size);
    #endif
    return;
  }
  
  // Return to segregated pool (common sizes)
  coro->next = *pool_head;
  *pool_head = coro;
  #ifdef YO_DEBUG_CONCURRENCY
  yo_coro_pool_size++;
  CONCURRENCY_DEBUG("[POOL] Returned coroutine to segregated pool, coro=%p, stack_size=%zu, pool_size=%zu\\n", 
                    coro, stack_size, yo_coro_pool_size);
  #else
  CONCURRENCY_DEBUG("[POOL] Returned coroutine to segregated pool, coro=%p, stack_size=%zu\\n", 
                    coro, stack_size);
  #endif
}

// Helper function to free a segregated pool list (used by worker cleanup and main thread cleanup)
static void __yo_free_coro_pool_list(yo_coro_t* head) {
  yo_coro_t* coro = head;
  while (coro != NULL) {
    yo_coro_t* next = coro->next;
    CONCURRENCY_DEBUG("[POOL] Freeing pooled coroutine coro=%p, stack_size=%zu\\n", coro, coro->stack_size);
    if (coro->stack) {
      // Free the full buffer including guard zone (starts at coro->stack - YO_STACK_GUARD_SIZE)
      __yo_free(coro->stack - YO_STACK_GUARD_SIZE);
    }
    __yo_free(coro);
    coro = next;
  }
}

// ========== Async I/O Functions ==========

// Set file descriptor to non-blocking mode
// Returns 0 on success, -1 on error
static int __yo_setnonblock(int fd, bool nonblock) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags == -1) {
    return -1;
  }
  
  int new_flags = nonblock ? (flags | O_NONBLOCK) : (flags & ~O_NONBLOCK);
  return fcntl(fd, F_SETFL, new_flags);
}

// Core async wait primitive
// Adds fd to epoll/kqueue, parks coroutine, resumes when fd is ready
// Returns 0 on success, -1 on error
int yo_async_wait(int fd, int mode) {
  yo_coro_t* coro = yo_coro_current;
  yo_worker_thread_t* worker = yo_coro_current_worker;
  
  if (!coro || !worker) {
    errno = EPERM;  // Not in coroutine context
    return -1;
  }
  
  if (fd < 0 || fd >= YO_MAX_FDS) {
    errno = EINVAL;  // Invalid fd
    return -1;
  }
  
  if (mode != YO_WAIT_READ && mode != YO_WAIT_WRITE) {
    errno = EINVAL;  // Invalid mode
    return -1;
  }
  
  if (worker->qfd < 0) {
    errno = ENOSYS;  // Async I/O not supported on this platform
    return -1;
  }
  
  #ifdef __linux__
    // Linux epoll implementation
    struct epoll_event ev = {0};
    ev.data.fd = fd;
    ev.events = EPOLLONESHOT;  // One-shot mode: auto-remove after trigger
    
    // Check if we're already waiting on this fd
    if (mode == YO_WAIT_READ) {
      ev.events |= EPOLLIN;
      // Also include write if someone's waiting for write
      if (worker->ev_write_waiters[fd] != NULL) {
        ev.events |= EPOLLOUT;
      }
    } else {
      ev.events |= EPOLLOUT;
      // Also include read if someone's waiting for read
      if (worker->ev_read_waiters[fd] != NULL) {
        ev.events |= EPOLLIN;
      }
    }
    
    // Try to modify first, if that fails then add
    int ret = epoll_ctl(worker->qfd, EPOLL_CTL_MOD, fd, &ev);
    if (ret == -1) {
      ret = epoll_ctl(worker->qfd, EPOLL_CTL_ADD, fd, &ev);
      if (ret == -1) {
        return -1;
      }
    }
  
  #elif defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
    // BSD kqueue implementation
    struct kevent ev;
    int filter = (mode == YO_WAIT_READ) ? EVFILT_READ : EVFILT_WRITE;
    EV_SET(&ev, fd, filter, EV_ADD | EV_ONESHOT, 0, 0, NULL);
    
    int ret = kevent(worker->qfd, &ev, 1, NULL, 0, NULL);
    if (ret == -1) {
      return -1;
    }
  #else
    // Unsupported platform
    errno = ENOSYS;
    return -1;
  #endif
  
  // Save this coroutine in the waiters array
  if (mode == YO_WAIT_READ) {
    worker->ev_read_waiters[fd] = coro;
  } else {
    worker->ev_write_waiters[fd] = coro;
  }
  
  // Park this coroutine and switch back to worker
  coro->state = YO_CORO_BLOCKED;
  llco_switch(NULL, false);  // Switch back to worker (NULL = return to caller)
  
  // When we resume, the fd is ready
  return 0;
}

// Async read - reads from fd without blocking other coroutines
// Returns number of bytes read, 0 for EOF, -1 for error (check errno)
ssize_t yo_async_read(int fd, void* buf, size_t count) {
  // Ensure fd is non-blocking
  if (__yo_setnonblock(fd, true) == -1) {
    return -1;
  }
  
  // Try to read, retry on EAGAIN
  while (true) {
    ssize_t n = read(fd, buf, count);
    
    if (n >= 0) {
      // Success or EOF
      return n;
    }
    
    // Check error
    if (errno == EINTR) {
      // Interrupted, retry immediately
      continue;
    }
    
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      // Would block, yield coroutine and wait for fd to be readable
      int ret = yo_async_wait(fd, YO_WAIT_READ);
      if (ret != 0) {
        // Wait failed
        return -1;
      }
      continue;  // Retry read
    }
    
    // Other error
    return -1;
  }
}

// Async write - writes to fd without blocking other coroutines
// Returns number of bytes written, -1 for error (check errno)
ssize_t yo_async_write(int fd, const void* buf, size_t count) {
  // Ensure fd is non-blocking
  if (__yo_setnonblock(fd, true) == -1) {
    return -1;
  }
  
  // Try to write, retry on EAGAIN
  while (true) {
    ssize_t n = write(fd, buf, count);
    
    if (n >= 0) {
      // Success
      return n;
    }
    
    // Check error
    if (errno == EINTR) {
      // Interrupted, retry immediately
      continue;
    }
    
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      // Would block, yield coroutine and wait for fd to be writable
      int ret = yo_async_wait(fd, YO_WAIT_WRITE);
      if (ret != 0) {
        // Wait failed
        return -1;
      }
      continue;  // Retry write
    }
    
    // Other error
    return -1;
  }
}

// ========== End Async I/O Functions ==========

// Check for stack overflow by verifying the stack guard canary at bottom
// Stack grows DOWN, so overflow writes into bottom guard zone
static void __yo_check_stack_overflow(yo_coro_t* coro) {
  if (!coro || !coro->stack) return;
  
  // Canary is at the bottom (before usable stack)
  uint64_t* canary = (uint64_t*)(coro->stack - YO_STACK_GUARD_SIZE);
  
  if (*canary != YO_STACK_CANARY || *(canary + 1) != YO_STACK_CANARY) {
    fprintf(stderr, "\\n\\n");
    fprintf(stderr, "╔═══════════════════════════════════════════════════════════════╗\\n");
    fprintf(stderr, "║                   STACK OVERFLOW DETECTED!                    ║\\n");
    fprintf(stderr, "╠═══════════════════════════════════════════════════════════════╣\\n");
    fprintf(stderr, "║ Coroutine: %p                                         ║\\n", coro);
    fprintf(stderr, "║ Stack size allocated: %-7zu bytes                          ║\\n", coro->stack_size);
    fprintf(stderr, "║ Stack address range: %p - %p             ║\\n", coro->stack, coro->stack + coro->stack_size);
    fprintf(stderr, "║ Bottom guard zone: %p (corrupted!)                    ║\\n", canary);
    fprintf(stderr, "║                                                               ║\\n");
    fprintf(stderr, "║ The coroutine has exceeded its allocated stack space.        ║\\n");
    fprintf(stderr, "║ This usually happens when:                                    ║\\n");
    fprintf(stderr, "║  1. Large local arrays are allocated on the stack             ║\\n");
    fprintf(stderr, "║  2. Deep recursion occurs                                     ║\\n");
    fprintf(stderr, "║  3. The stack_size parameter is too small                     ║\\n");
    fprintf(stderr, "║                                                               ║\\n");
    fprintf(stderr, "║ Solutions:                                                    ║\\n");
    fprintf(stderr, "║  • Increase stack_size in async { }, { stack_size: ... }     ║\\n");
    fprintf(stderr, "║  • Move large arrays to heap allocation                       ║\\n");
    fprintf(stderr, "║  • Reduce recursion depth or use iteration                    ║\\n");
    fprintf(stderr, "╚═══════════════════════════════════════════════════════════════╝\\n");
    fprintf(stderr, "\\n");
    abort();
  }
}

// Enqueue a coroutine to a worker's ready queue (called from spawn)
static void __yo_coro_enqueue_to_worker(yo_worker_thread_t* worker, yo_coro_t* coro) {
  YO_MUTEX_LOCK(&worker->queue_mutex);
  
  coro->next = NULL;
  if (worker->ready_queue.tail) {
    worker->ready_queue.tail->next = coro;
  } else {
    worker->ready_queue.head = coro;
  }
  worker->ready_queue.tail = coro;
  worker->ready_queue.count++;
  
  YO_MUTEX_UNLOCK(&worker->queue_mutex);
}

// Dequeue a coroutine from current worker's ready queue (called by worker itself)
static yo_coro_t* __yo_coro_dequeue_from_worker(yo_worker_thread_t* worker) {
  YO_MUTEX_LOCK(&worker->queue_mutex);
  
  yo_coro_t* coro = worker->ready_queue.head;
  if (coro) {
    worker->ready_queue.head = coro->next;
    if (!worker->ready_queue.head) {
      worker->ready_queue.tail = NULL;
    }
    worker->ready_queue.count--;
  }
  
  YO_MUTEX_UNLOCK(&worker->queue_mutex);
  return coro;
}

// Enqueue a coroutine to current worker's blocked queue
static void __yo_coro_block(yo_coro_t* coro, void* channel) {
  yo_worker_thread_t* worker = yo_coro_current_worker;
  if (!worker) {
    CONCURRENCY_DEBUG("[BLOCK] Error: No current worker for coro=%p\\n", coro);
    return;
  }
  
  YO_MUTEX_LOCK(&worker->queue_mutex);
  
  coro->state = YO_CORO_BLOCKED;
  coro->wait_channel = channel;
  coro->next = NULL;
  if (worker->blocked_queue.tail) {
    worker->blocked_queue.tail->next = coro;
  } else {
    worker->blocked_queue.head = coro;
  }
  worker->blocked_queue.tail = coro;
  worker->blocked_queue.count++;
  
  YO_MUTEX_UNLOCK(&worker->queue_mutex);
}

// Wake up coroutines waiting on a specific channel (in current worker's blocked queue)
static void __yo_coro_wakeup(void* channel) {
  if (!yo_coro_scheduler_initialized) {
    return;
  }
  
  CONCURRENCY_DEBUG("[WAKEUP] Waking coroutines on channel=%p across all workers\\n", channel);
  
  // Wake up blocked coroutines on ALL workers, not just current worker
  // This is necessary because sender might be on different worker than receiver
  for (size_t i = 0; i < yo_worker_thread_count; i++) {
    yo_worker_thread_t* worker = &yo_worker_threads[i];
    
    YO_MUTEX_LOCK(&worker->queue_mutex);
    
    yo_coro_t* coro = worker->blocked_queue.head;
    yo_coro_t* prev = NULL;
    
    while (coro != NULL) {
      yo_coro_t* next = coro->next;
      
      if (coro->wait_channel == channel) {
        // Skip if coroutine is already completed or stack was freed
        if (coro->state == YO_CORO_COMPLETED || coro->stack == NULL) {
          CONCURRENCY_DEBUG("[WAKEUP] Skipping completed/freed coro=%p (state=%d, stack=%p)\\n", coro, coro->state, coro->stack);
          // Remove from blocked queue and free
          if (prev == NULL) {
            worker->blocked_queue.head = next;
          } else {
            prev->next = next;
          }
          if (worker->blocked_queue.tail == coro) {
            worker->blocked_queue.tail = prev;
          }
          worker->blocked_queue.count--;
          // Free the completed coroutine structure if not already freed
          if (coro->stack == NULL) {
            __yo_free(coro);
          }
          coro = next;
          continue;
        }
        
        CONCURRENCY_DEBUG("[WAKEUP] Moving coro=%p to ready queue on worker %zu\\n", coro, i);
        // Remove from blocked queue
        if (prev == NULL) {
          worker->blocked_queue.head = next;
        } else {
          prev->next = next;
        }
        if (worker->blocked_queue.tail == coro) {
          worker->blocked_queue.tail = prev;
        }
        worker->blocked_queue.count--;
        
        // Add to ready queue (unlocked version since we hold the lock)
        coro->wait_channel = NULL;
        coro->state = YO_CORO_READY;
        coro->next = NULL;
        if (worker->ready_queue.tail) {
          worker->ready_queue.tail->next = coro;
        } else {
          worker->ready_queue.head = coro;
        }
        worker->ready_queue.tail = coro;
        worker->ready_queue.count++;
        
        // Don't increment prev since we removed current node
        coro = next;
      } else {
        prev = coro;
        coro = next;
      }
    }
    
    YO_MUTEX_UNLOCK(&worker->queue_mutex);
  }
}

// Worker thread function - runs coroutines from its own ready queue
#ifdef _WIN32
static unsigned __stdcall __yo_worker_thread_func(void* arg) {
#else
static void* __yo_worker_thread_func(void* arg) {
#endif
  yo_worker_thread_t* worker = (yo_worker_thread_t*)arg;
  yo_thread_id_t thread_id = YO_THREAD_ID();
  
  // Set thread-local worker pointer
  yo_coro_current_worker = worker;
  
  // Set CPU affinity to pin this worker to its dedicated core
  __yo_set_thread_affinity(worker->core_id);
  
  CONCURRENCY_DEBUG("[WORKER] Thread %lu started on core %zu (worker=%p)\\n", (unsigned long)thread_id, worker->core_id, worker);
  
  while (!atomic_load(&yo_worker_shutdown)) {
    // Poll for I/O events (non-blocking)
    #if defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
    if (worker->qfd >= 0) {
      #ifdef __linux__
        struct epoll_event events[32];
        int nevents = epoll_wait(worker->qfd, events, 32, 0);  // 0 timeout = non-blocking
        
        for (int i = 0; i < nevents; i++) {
          int fd = events[i].data.fd;
          bool can_read = events[i].events & EPOLLIN;
          bool can_write = events[i].events & EPOLLOUT;
          
          // Resume waiting coroutines
          if (can_read && fd < YO_MAX_FDS && worker->ev_read_waiters[fd]) {
            yo_coro_t* waiting_coro = worker->ev_read_waiters[fd];
            worker->ev_read_waiters[fd] = NULL;
            waiting_coro->state = YO_CORO_READY;
            __yo_coro_enqueue_to_worker(worker, waiting_coro);
          }
          
          if (can_write && fd < YO_MAX_FDS && worker->ev_write_waiters[fd]) {
            yo_coro_t* waiting_coro = worker->ev_write_waiters[fd];
            worker->ev_write_waiters[fd] = NULL;
            waiting_coro->state = YO_CORO_READY;
            __yo_coro_enqueue_to_worker(worker, waiting_coro);
          }
        }
      
      #elif defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
        struct kevent events[32];
        struct timespec timeout = {0, 0};  // Non-blocking
        int nevents = kevent(worker->qfd, NULL, 0, events, 32, &timeout);
        
        for (int i = 0; i < nevents; i++) {
          int fd = (int)events[i].ident;
          bool can_read = events[i].filter == EVFILT_READ;
          bool can_write = events[i].filter == EVFILT_WRITE;
          
          // Resume waiting coroutines
          if (can_read && fd < YO_MAX_FDS && worker->ev_read_waiters[fd]) {
            yo_coro_t* waiting_coro = worker->ev_read_waiters[fd];
            worker->ev_read_waiters[fd] = NULL;
            waiting_coro->state = YO_CORO_READY;
            __yo_coro_enqueue_to_worker(worker, waiting_coro);
          }
          
          if (can_write && fd < YO_MAX_FDS && worker->ev_write_waiters[fd]) {
            yo_coro_t* waiting_coro = worker->ev_write_waiters[fd];
            worker->ev_write_waiters[fd] = NULL;
            waiting_coro->state = YO_CORO_READY;
            __yo_coro_enqueue_to_worker(worker, waiting_coro);
          }
        }
      #endif
    }
    #endif
    
    yo_coro_t* coro = __yo_coro_dequeue_from_worker(worker);
    
    if (!coro) {
      // No coroutines available - clean up any completed coroutine before sleeping
      if (yo_coro_to_cleanup) {
        __yo_cleanup_completed_coro(yo_coro_to_cleanup);
        yo_coro_to_cleanup = NULL;
      }
      
      // Sleep briefly to avoid busy-waiting
      #ifdef _WIN32
      Sleep(0);  // Yield timeslice
      #else
      usleep(10);  // 10 microseconds (0.01ms)
      #endif
      continue;
    }
    
    CONCURRENCY_DEBUG("[WORKER] Thread %lu executing coro=%p\\n", (unsigned long)thread_id, coro);
    
    // Clean up any completed coroutine from previous iteration
    if (yo_coro_to_cleanup) {
      __yo_cleanup_completed_coro(yo_coro_to_cleanup);
      yo_coro_to_cleanup = NULL;
    }
    
    // Skip completed coroutines (cleanup will handle them)
    if (coro->state == YO_CORO_COMPLETED) {
      CONCURRENCY_DEBUG("[WORKER] Task=%p already completed, skipping (will be returned to pool)\\n", coro);
      continue;
    }
    
    yo_coro_current = coro;
    coro->state = YO_CORO_RUNNING;
    
    if (!coro->coro) {
      // First time running - start the coroutine with llco
      CONCURRENCY_DEBUG("[WORKER] Starting new coro=%p\\n", coro);
      
      struct llco_desc desc = {
        .stack = coro->stack,
        .stack_size = coro->stack_size,
        .entry = __yo_coro_entry,
        .cleanup = __yo_coro_llco_cleanup,
        .udata = coro
      };
      
      llco_start(&desc, false);  // final=false, we may resume this coroutine later
      // Note: coro->coro is set inside __yo_coro_entry via llco_current()
    } else {
      // Resume coroutine from where it yielded
      CONCURRENCY_DEBUG("[WORKER] Resuming coro=%p coro=%p\\n", coro, coro->coro);
      llco_switch(coro->coro, false);  // Switch to coroutine's llco handle
    }
    
    // Coroutine returned (either completed, blocked, or yielded)
    CONCURRENCY_DEBUG("[WORKER] Returned from coro=%p, state=%d\\n", coro, coro->state);
    
    // Check if shutdown was signaled while we were running
    if (atomic_load(&yo_worker_shutdown)) {
      CONCURRENCY_DEBUG("[WORKER] Shutdown detected, stopping cleanup and exiting\\n");
      break;
    }
    
    // Check if a coroutine completed and needs cleanup
    if (yo_coro_to_cleanup) {
      CONCURRENCY_DEBUG("[WORKER] Task completed, will cleanup on next iteration\\n");
      yo_coro_current = NULL;
      continue;
    }
    
    // Check if current coroutine was blocked
    if (yo_coro_current && yo_coro_current->state == YO_CORO_BLOCKED) {
      CONCURRENCY_DEBUG("[WORKER] Task=%p blocked, fetching next coroutine\\n", yo_coro_current);
      yo_coro_current = NULL;
      continue;
    }
    
    yo_coro_current = NULL;
  }
  
  // Clean up this worker's thread-local coroutine pools before exiting
  CONCURRENCY_DEBUG("[WORKER] Thread %lu cleaning up thread-local pools\\n", (unsigned long)thread_id);
  
  // Free all segregated pools for this worker thread
  __yo_free_coro_pool_list(yo_coro_pool_16kb);
  __yo_free_coro_pool_list(yo_coro_pool_32kb);
  __yo_free_coro_pool_list(yo_coro_pool_64kb);
  __yo_free_coro_pool_list(yo_coro_pool_128kb);
  __yo_free_coro_pool_list(yo_coro_pool_256kb);
  __yo_free_coro_pool_list(yo_coro_pool_512kb);
  __yo_free_coro_pool_list(yo_coro_pool_1mb);
  __yo_free_coro_pool_list(yo_coro_pool_custom);
  
  // Reset all pool heads (thread-local cleanup)
  yo_coro_pool_16kb = NULL;
  yo_coro_pool_32kb = NULL;
  yo_coro_pool_64kb = NULL;
  yo_coro_pool_128kb = NULL;
  yo_coro_pool_256kb = NULL;
  yo_coro_pool_512kb = NULL;
  yo_coro_pool_1mb = NULL;
  yo_coro_pool_custom = NULL;
  
  #ifdef YO_DEBUG_CONCURRENCY
  yo_coro_pool_size = 0;
  #endif
  
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

// Set thread affinity to bind worker to specific CPU core
static void __yo_set_thread_affinity(size_t core_id) {
  #ifdef _WIN32
  // Windows: SetThreadAffinityMask
  DWORD_PTR mask = 1ULL << core_id;
  SetThreadAffinityMask(GetCurrentThread(), mask);
  CONCURRENCY_DEBUG("[AFFINITY] Set thread affinity to core %zu (Windows)\\n", core_id);
  
  #elif defined(__APPLE__)
  // macOS: thread_policy_set with THREAD_AFFINITY_POLICY
  thread_affinity_policy_data_t policy = { (integer_t)core_id };
  kern_return_t result = thread_policy_set(pthread_mach_thread_np(pthread_self()), 
                    THREAD_AFFINITY_POLICY, 
                    (thread_policy_t)&policy, 
                    THREAD_AFFINITY_POLICY_COUNT);
  if (result == KERN_SUCCESS) {
    CONCURRENCY_DEBUG("[AFFINITY] Set thread affinity to core %zu (macOS)\\n", core_id);
  } else {
    CONCURRENCY_DEBUG("[AFFINITY] Failed to set thread affinity to core %zu (macOS, error=%d)\\n", core_id, result);
  }
  
  #elif defined(__linux__)
  // Linux: Use sched_setaffinity syscall directly (no GNU extensions needed)
  // We'll build a simple cpu_set manually without using CPU_* macros
  unsigned long mask = 1UL << core_id;
  // syscall numbers from linux/unistd.h
  #if defined(__x86_64__)
    // x86_64: sched_setaffinity is syscall 203
    long result = syscall(203, 0, sizeof(unsigned long), &mask);
  #elif defined(__aarch64__)
    // ARM64: sched_setaffinity is syscall 122
    long result = syscall(122, 0, sizeof(unsigned long), &mask);
  #elif defined(__i386__)
    // x86 32-bit: sched_setaffinity is syscall 241
    long result = syscall(241, 0, sizeof(unsigned long), &mask);
  #elif defined(__arm__)
    // ARM 32-bit: sched_setaffinity is syscall 241
    long result = syscall(241, 0, sizeof(unsigned long), &mask);
  #else
    // Unknown architecture - try common syscall number 203
    long result = syscall(203, 0, sizeof(unsigned long), &mask);
  #endif
  
  if (result == 0) {
    CONCURRENCY_DEBUG("[AFFINITY] Set thread affinity to core %zu (Linux)\\n", core_id);
  } else {
    CONCURRENCY_DEBUG("[AFFINITY] Failed to set thread affinity to core %zu (Linux, errno=%d)\\n", core_id, (int)result);
  }
  
  #else
  // Other POSIX systems: no affinity support
  CONCURRENCY_DEBUG("[AFFINITY] Thread affinity not supported on this platform (core %zu requested)\\n", core_id);
  (void)core_id; // Suppress unused parameter warning
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
  
  // Initialize each worker and pin to a CPU core
  for (size_t i = 0; i < num_threads; i++) {
    yo_worker_threads[i].active = true;
    yo_worker_threads[i].core_id = i;  // Pin worker i to core i
    yo_worker_threads[i].ready_queue = (yo_coro_queue_t){NULL, NULL, 0};
    yo_worker_threads[i].blocked_queue = (yo_coro_queue_t){NULL, NULL, 0};
    YO_MUTEX_INIT(&yo_worker_threads[i].queue_mutex);
    
    // Initialize async I/O event queue
    #ifdef __linux__
      yo_worker_threads[i].qfd = epoll_create1(0);
    #elif defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
      yo_worker_threads[i].qfd = kqueue();
    #else
      yo_worker_threads[i].qfd = -1;  // No async I/O support on this platform
    #endif
    
    // Initialize event waiters arrays to NULL
    for (int j = 0; j < YO_MAX_FDS; j++) {
      yo_worker_threads[i].ev_read_waiters[j] = NULL;
      yo_worker_threads[i].ev_write_waiters[j] = NULL;
    }
    
    #ifdef _WIN32
    yo_worker_threads[i].handle = (HANDLE)_beginthreadex(
      NULL, 0, __yo_worker_thread_func, &yo_worker_threads[i], 0, NULL
    );
    #else
    pthread_create(&yo_worker_threads[i].handle, NULL, __yo_worker_thread_func, &yo_worker_threads[i]);
    #endif
    
    CONCURRENCY_DEBUG("[POOL] Spawned worker thread %zu (will pin to core %zu)\\n", i, i);
  }
}

// Set maximum number of threads for coroutine scheduler
// This limits how many workers will be used for distributing new tasks
void __yo_concurrency_set_maximum_threads(size_t num) {
  __yo_coro_scheduler_init();
  
  // If num is 0, use hardware thread count
  if (num == 0) {
    num = __yo_concurrency_get_hardware_threads();
  }
  
  yo_coro_max_threads = num;
  
  // If thread pool isn't initialized yet, initialize it with hardware thread count
  if (yo_worker_thread_count == 0) {
    size_t hardware_threads = __yo_concurrency_get_hardware_threads();
    __yo_thread_pool_init(hardware_threads);
  }
  
  // Set the active worker limit to restrict coroutine distribution
  // Tasks will only be distributed to the first 'num' workers
  if (num <= yo_worker_thread_count) {
    yo_coro_active_worker_limit = num;
    CONCURRENCY_DEBUG("[POOL] Limited coroutine distribution to first %zu workers\\n", num);
  } else {
    yo_coro_active_worker_limit = yo_worker_thread_count;
    CONCURRENCY_DEBUG("[POOL] Cannot limit to %zu workers (only %zu available)\\n", num, yo_worker_thread_count);
  }
}

// Yield is no longer used with per-thread queues - coroutines run cooperatively within each worker
// Blocking/wakeup happens via __yo_coro_block_and_yield which is called by channel operations

// Yield control to allow other coroutines to run (like Go's runtime.Gosched)
// This allows a coroutine to voluntarily give up the CPU to other coroutines on the same worker
void __yo_coro_yield(void) {
  if (!yo_coro_scheduler_initialized || !yo_coro_current) {
    return; // Not in a coroutine context
  }
  
  yo_worker_thread_t* worker = yo_coro_current_worker;
  if (!worker) {
    return;
  }
  
  yo_coro_t* current = yo_coro_current;
  
  // Re-enqueue the current coroutine so it can be resumed later
  // IMPORTANT: We must re-enqueue for cooperative multitasking to work
  // If the coroutine completes after this yield, the worker will detect COMPLETED state and skip it
  
  YO_MUTEX_LOCK(&worker->queue_mutex);
  
  current->state = YO_CORO_READY;
  current->next = NULL;
  if (worker->ready_queue.tail) {
    worker->ready_queue.tail->next = current;
  } else {
    worker->ready_queue.head = current;
  }
  worker->ready_queue.tail = current;
  worker->ready_queue.count++;
  CONCURRENCY_DEBUG("[YIELD] Task=%p re-enqueued to ready queue\\n", current);
  
  YO_MUTEX_UNLOCK(&worker->queue_mutex);
  
  // Get next ready coroutine from this worker's queue
  yo_coro_t* next = __yo_coro_dequeue_from_worker(worker);
  if (next) {
    yo_coro_current = next;
    next->state = YO_CORO_RUNNING;
    
    if (next->coro) {
      // Resume next task
      CONCURRENCY_DEBUG("[SWITCH] Resuming next coro=%p\\n", next);
      llco_switch(next->coro, false);
    } else {
      // First time running next task
      CONCURRENCY_DEBUG("[SWITCH] Starting next coro=%p\\n", next);
      struct llco_desc desc = {
        .stack = next->stack,
        .stack_size = next->stack_size,
        .entry = __yo_coro_entry,
        .cleanup = __yo_coro_llco_cleanup,
        .udata = next
      };
      llco_start(&desc, false);
      // Note: next->coro is set inside __yo_coro_entry via llco_current()
    }
  } else {
    // No ready coroutines - return to worker (switch to NULL)
    CONCURRENCY_DEBUG("[SWITCH] No ready coroutines, returning to worker\\n");
    llco_switch(NULL, false);
  }
}

// Wait for all spawned coroutines to complete
// This should be called from the main thread to run all pending tasks
void __yo_coro_wait_all(void) {
  if (!yo_coro_scheduler_initialized) {
    return; // No coroutines to wait for
  }
  
  CONCURRENCY_DEBUG("[WAIT_ALL] Waiting for all coroutines to complete\\n");
  
  // If using thread pool, wait for all coroutines to complete then join threads
  if (yo_worker_thread_count > 0) {
    CONCURRENCY_DEBUG("[WAIT_ALL] Waiting for thread pool to finish\\n");
    
    // Wait until all active coroutines complete (use atomic counter, not queue polling)
    while (atomic_load(&yo_active_coro_count) > 0) {
      // Sleep briefly to avoid busy waiting
      #ifdef _WIN32
      Sleep(0);  // Yield timeslice
      #else
      usleep(10);  // 10 microseconds (0.01ms)
      #endif
    }
    
    CONCURRENCY_DEBUG("[WAIT_ALL] All coroutines completed, shutting down workers\\n");
    
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
    
    // After all workers stopped, clean up the main thread's coroutine pool
    // Note: Each worker thread cleans up its own thread-local pool when it exits
    CONCURRENCY_DEBUG("[WAIT_ALL] Cleaning up main thread's coroutine pools\\n");
    
    // Free all segregated pools
    __yo_free_coro_pool_list(yo_coro_pool_16kb);
    __yo_free_coro_pool_list(yo_coro_pool_32kb);
    __yo_free_coro_pool_list(yo_coro_pool_64kb);
    __yo_free_coro_pool_list(yo_coro_pool_128kb);
    __yo_free_coro_pool_list(yo_coro_pool_256kb);
    __yo_free_coro_pool_list(yo_coro_pool_512kb);
    __yo_free_coro_pool_list(yo_coro_pool_1mb);
    __yo_free_coro_pool_list(yo_coro_pool_custom);
    
    // Reset all pool heads
    yo_coro_pool_16kb = NULL;
    yo_coro_pool_32kb = NULL;
    yo_coro_pool_64kb = NULL;
    yo_coro_pool_128kb = NULL;
    yo_coro_pool_256kb = NULL;
    yo_coro_pool_512kb = NULL;
    yo_coro_pool_1mb = NULL;
    yo_coro_pool_custom = NULL;
    
    #ifdef YO_DEBUG_CONCURRENCY
    yo_coro_pool_size = 0;
    #endif
    
    CONCURRENCY_DEBUG("[WAIT_ALL] Thread pool shut down\\n");
    return;
  }
  
  // Single-threaded mode not supported with per-thread queues
  CONCURRENCY_DEBUG("[WAIT_ALL] Error: No worker threads initialized\\n");
}

// Block current coroutine on a channel and yield to another task
// This is a specialized version of yield that also marks the coroutine as blocked
static void __yo_coro_block_and_yield(void* channel) {
  if (!yo_coro_scheduler_initialized || !yo_coro_current) {
    return;
  }
  
  yo_worker_thread_t* worker = yo_coro_current_worker;
  if (!worker) {
    CONCURRENCY_DEBUG("[BLOCK] Error: No current worker\\n");
    return;
  }
  
  yo_coro_t* current = yo_coro_current;
  CONCURRENCY_DEBUG("[BLOCK] Blocking coro=%p on channel=%p\\n", current, channel);
  
  // Check for stack overflow before switching away
  __yo_check_stack_overflow(current);
  
  // Mark coroutine as blocked and move to blocked queue
  __yo_coro_block(current, channel);
  
  // Get next ready coroutine from this worker's queue
  yo_coro_t* next = __yo_coro_dequeue_from_worker(worker);
  if (next) {
    yo_coro_current = next;
    next->state = YO_CORO_RUNNING;
    CONCURRENCY_DEBUG("[BLOCK] Switching to next=%p\\n", next);
    
    if (next->coro) {
      // Resume next task
      llco_switch(next->coro, false);
    } else {
      // First time running next task
      struct llco_desc desc = {
        .stack = next->stack,
        .stack_size = next->stack_size,
        .entry = __yo_coro_entry,
        .cleanup = __yo_coro_llco_cleanup,
        .udata = next
      };
      llco_start(&desc, false);
      // Note: next->coro is set inside __yo_coro_entry
    }
  } else {
    // No ready coroutines - return to worker
    CONCURRENCY_DEBUG("[BLOCK] No ready coroutines, returning to worker\\n");
    llco_switch(NULL, false);
  }
  
  // Returns here when unblocked and resumed
  CONCURRENCY_DEBUG("[BLOCK] Returned from block_and_yield, coro=%p\\n", yo_coro_current);
  
  // Clean up any completed task
  if (yo_coro_to_cleanup) {
    __yo_cleanup_completed_coro(yo_coro_to_cleanup);
    yo_coro_to_cleanup = NULL;
  }
}
`);
}

/**
 * Generate specialized coroutine spawn functions for cooperative multitasking
 */
function generateThreadWrapperFunctions(context: CodeGenContext): void {
  const emitter = context.emitter;

  // Generate coroutine spawn function declarations
  emitter.emitDeclarationLine(`/// Coroutine spawn function declarations`);
  const generatedDeclarationSignatures = new Set<string>();

  for (const [signatureStr, signature] of context.spawnedFunctionSignatures) {
    const { parameterTypes } = signature;

    if (generatedDeclarationSignatures.has(signatureStr)) {
      continue;
    }
    generatedDeclarationSignatures.add(signatureStr);

    // Generate declaration for coroutine spawn function
    const paramDecls = parameterTypes
      .map((paramType, index) => {
        const paramTypeStr = getTypeString(paramType, context);
        return `${paramTypeStr} arg${index}`;
      })
      .join(", ");

    const spawnFunctionName = `__yo_coro_spawn_${signatureStr}`;
    emitter.emitDeclarationLine(
      `void ${spawnFunctionName}(void* func${
        paramDecls ? `, ${paramDecls}` : ""
      }); // Coroutine spawn function for ${signatureStr}`
    );
  }
  emitter.emitDeclarationLine("");

  // Generate coroutine data structures and spawn functions
  const generatedSignatures = new Set<string>();

  for (const [signatureStr, signature] of context.spawnedFunctionSignatures) {
    const { parameterTypes } = signature;

    if (generatedSignatures.has(signatureStr)) {
      continue;
    }
    generatedSignatures.add(signatureStr);

    // Generate coroutine data structure
    const structName = `yo_coro_data_${signatureStr}_t`;

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

    // Generate coroutine execution function
    // Note: We ignore the return value since spawned coroutines are fire-and-forget
    const executeFnName = `__yo_coro_execute_${signatureStr}`;
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

    // Generate coroutine spawn function
    const spawnFunctionName = `__yo_coro_spawn_${signatureStr}`;
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
  __yo_coro_scheduler_init();
  
  // Auto-initialize thread pool with hardware threads if not already done
  if (yo_worker_thread_count == 0) {
    __yo_concurrency_set_maximum_threads(0);  // 0 = use hardware threads
  }
  
  // Allocate coroutine data
  ${structName}* data = (${structName}*)__yo_malloc(sizeof(${structName}));
  data->function = func;
${paramAssignments}
  
  // Create task (get from pool or allocate new)
  yo_coro_t* coro = __yo_coro_pool_get();
  coro->func = ${executeFnName};
  coro->data = data;
  
  // Distribute coroutine to worker thread round-robin (limited by active_worker_limit)
  if (yo_worker_thread_count > 0) {
    size_t limit = yo_coro_active_worker_limit > 0 ? yo_coro_active_worker_limit : yo_worker_thread_count;
    size_t worker_idx = atomic_fetch_add(&yo_next_worker_index, 1) % limit;
    coro->owner_worker = &yo_worker_threads[worker_idx];  // Set owner
    CONCURRENCY_DEBUG("[SPAWN] Assigning coro=%p to worker %zu (limit=%zu)\\n", coro, worker_idx, limit);
    __yo_coro_enqueue_to_worker(&yo_worker_threads[worker_idx], coro);
  } else {
    CONCURRENCY_DEBUG("[SPAWN] Error: No workers available\\n");
    __yo_coro_pool_put(coro);  // Return to pool instead of freeing
    __yo_free(coro);
    __yo_free(data);
  }
}
`);
  }

  // Generate a simple spawn function for unit functions (void -> void)
  emitter.emitLine(`void __yo_coro_spawn_unit_function(void (*func)(void)) {
  __yo_coro_scheduler_init();
  
  if (yo_worker_thread_count == 0) {
    __yo_concurrency_set_maximum_threads(0);
  }
  
  yo_coro_t* coro = __yo_coro_pool_get(YO_CORO_DEFAULT_STACK_SIZE);
  coro->func = (void (*)(void*))func;
  coro->data = NULL;
  
  // Increment active coroutine counter BEFORE enqueueing
  atomic_fetch_add(&yo_active_coro_count, 1);
  
  if (yo_worker_thread_count > 0) {
    size_t limit = yo_coro_active_worker_limit > 0 ? yo_coro_active_worker_limit : yo_worker_thread_count;
    size_t worker_idx = atomic_fetch_add(&yo_next_worker_index, 1) % limit;
    coro->owner_worker = &yo_worker_threads[worker_idx];  // Set owner
    CONCURRENCY_DEBUG("[SPAWN] Assigning main coro=%p to worker %zu (limit=%zu)\\n", coro, worker_idx, limit);
    __yo_coro_enqueue_to_worker(&yo_worker_threads[worker_idx], coro);
  } else {
    CONCURRENCY_DEBUG("[SPAWN] Error: No workers available\\n");
    atomic_fetch_sub(&yo_active_coro_count, 1);  // Decrement since coroutine failed
    __yo_coro_pool_put(coro);  // Return to pool
    __yo_free(coro);
  }
}
`);

  // Generate coroutine spawn functions for closures (async keyword)
  emitter.emitDeclarationLine(
    `/// Coroutine spawn function declarations for closures`
  );
  const generatedClosureDeclarationSignatures = new Set<string>();

  for (const [signatureStr, signature] of context.spawnedClosureSignatures) {
    if (generatedClosureDeclarationSignatures.has(signatureStr)) {
      continue;
    }
    generatedClosureDeclarationSignatures.add(signatureStr);

    const { closureType } = signature;
    const closureTypeCName = context.types[closureType.id]?.cName;
    if (!closureTypeCName) {
      continue;
    }

    const spawnFunctionName = `__yo_coro_spawn_${signatureStr}`;
    emitter.emitDeclarationLine(
      `void ${spawnFunctionName}(${closureTypeCName}* closure, size_t stack_size); // Coroutine spawn function for closure ${signatureStr}`
    );
  }
  emitter.emitDeclarationLine("");

  // Generate closure coroutine spawn implementations
  const generatedClosureSignatures = new Set<string>();

  for (const [signatureStr, signature] of context.spawnedClosureSignatures) {
    if (generatedClosureSignatures.has(signatureStr)) {
      continue;
    }
    generatedClosureSignatures.add(signatureStr);

    const { closureType } = signature;
    const closureTypeCName = context.types[closureType.id]?.cName;
    if (!closureTypeCName) {
      continue;
    }

    // Generate coroutine data structure for closure
    const structName = `yo_coro_data_${signatureStr}_t`;
    emitter.emitLine(`typedef struct ${structName} {
  ${closureTypeCName}* closure;
} ${structName};
`);

    // Generate coroutine execution function for closure
    const executeFnName = `__yo_coro_execute_${signatureStr}`;
    emitter.emitLine(`static void ${executeFnName}(void* task_data) {
  ${structName}* data = (${structName}*)task_data;
  ${closureTypeCName}* closure = data->closure;
  
  // Call the closure: closure->vtable.call(closure)
  (void)closure->vtable.call(closure);  // Explicitly ignore return value
  
  // Drop the closure (decrement reference count)
  __yo_decr_rc(closure, (void(*)(void*))closure->vtable.dispose);
  
  __yo_free(data);
}
`);

    // Generate coroutine spawn function for closure
    const spawnFunctionName = `__yo_coro_spawn_${signatureStr}`;
    emitter.emitLine(`void ${spawnFunctionName}(${closureTypeCName}* closure, size_t stack_size) {
  __yo_coro_scheduler_init();
  
  // Auto-initialize thread pool with hardware threads if not already done
  if (yo_worker_thread_count == 0) {
    __yo_concurrency_set_maximum_threads(0);  // 0 = use hardware threads
  }
  
  // NOTE: We use move semantics here - the closure ownership is transferred to the task
  // The closure is created with RC=1, and we pass that reference to the task
  // No need to increment RC since we're transferring ownership
  
  // Allocate coroutine data
  ${structName}* data = (${structName}*)__yo_malloc(sizeof(${structName}));
  data->closure = closure;
  
  // Create task (get from pool with requested stack size or allocate new)
  yo_coro_t* coro = __yo_coro_pool_get(stack_size);
  coro->func = ${executeFnName};
  coro->data = data;
  
  // Increment active coroutine counter BEFORE enqueueing
  atomic_fetch_add(&yo_active_coro_count, 1);
  
  // Distribute coroutine to worker thread round-robin (limited by active_worker_limit)
  if (yo_worker_thread_count > 0) {
    size_t limit = yo_coro_active_worker_limit > 0 ? yo_coro_active_worker_limit : yo_worker_thread_count;
    size_t worker_idx = atomic_fetch_add(&yo_next_worker_index, 1) % limit;
    coro->owner_worker = &yo_worker_threads[worker_idx];  // Set owner
    CONCURRENCY_DEBUG("[SPAWN] Assigning closure coro=%p to worker %zu (limit=%zu, stack_size=%zu)\\n", coro, worker_idx, limit, stack_size);
    __yo_coro_enqueue_to_worker(&yo_worker_threads[worker_idx], coro);
  } else {
    CONCURRENCY_DEBUG("[SPAWN] Error: No workers available\\n");
    atomic_fetch_sub(&yo_active_coro_count, 1);  // Decrement since coroutine failed
    __yo_coro_pool_put(coro);  // Return to pool instead of freeing
    __yo_free(data);
    // On error, decrement the reference we received since we won't use it
    __yo_decr_rc(closure, (void(*)(void*))closure->vtable.dispose);
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
        // The caller is responsible for duplicating ARC types before passing them
        // so we can directly assign the parameters here
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
  let isFirstChannelType = true;
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

    for (const typeId in context.types) {
      const typeEntry = context.types[typeId]!;
      if (isEnumType(typeEntry.type)) {
        const enumType = typeEntry.type;

        // Use typeName for exact matching - this is more reliable
        if (enumType.typeName === expectedOptionTypeName) {
          optionReturnTypeStr = typeEntry.cName;

          // Find the tag values for None and Some variants
          const noneVariantIndex = enumType.variants.findIndex(
            (v) => v.name === "None"
          );
          const someVariantIndex = enumType.variants.findIndex(
            (v) => v.name === "Some"
          );

          // Update the tag values
          noneTag = noneVariantIndex;
          someTag = someVariantIndex;

          break;
        }
      }
    }
    emitter.emitLine(`// Channel wait queue operations (operate on head/tail pointers directly)

// Add coroutine to channel's wait queue
static void __yo_chan_wait_queue_add(yo_coro_t** head, yo_coro_t** tail, yo_coro_t* coro) {
  coro->next_wait = NULL;
  if (*tail) {
    (*tail)->next_wait = coro;
  } else {
    *head = coro;
  }
  *tail = coro;
}

// Remove coroutine from channel's wait queue
static bool __yo_chan_wait_queue_remove(yo_coro_t** head, yo_coro_t** tail, yo_coro_t* coro) {
  yo_coro_t* curr = *head;
  yo_coro_t* prev = NULL;
  
  while (curr) {
    if (curr == coro) {
      if (prev) {
        prev->next_wait = curr->next_wait;
      } else {
        *head = curr->next_wait;
      }
      if (*tail == curr) {
        *tail = prev;
      }
      return true;
    }
    prev = curr;
    curr = curr->next_wait;
  }
  return false;
}

// Pop first coroutine from channel's wait queue
static yo_coro_t* __yo_chan_wait_queue_pop(yo_coro_t** head, yo_coro_t** tail) {
  yo_coro_t* coro = *head;
  if (coro) {
    *head = coro->next_wait;
    if (!*head) {
      *tail = NULL;
    }
    coro->next_wait = NULL;
  }
  return coro;
}

// Check if wait queue is empty
static bool __yo_chan_wait_queue_empty(yo_coro_t* head) {
  return head == NULL;
}

// Channel functions for ${cName}

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
  
  // Initialize wait queues for select support (using head/tail pointers directly)
  chan->send_queue_head = NULL;
  chan->send_queue_tail = NULL;
  chan->recv_queue_head = NULL;
  chan->recv_queue_tail = NULL;

  // Following neco's approach: allocate capacity+1 slots
  // - The extra slot is for select-case operations
  // - For unbuffered channels (capacity=0), we allocate 1 slot but don't use it for normal send/recv
  // - Normal unbuffered send/recv use direct copy to receiver's recv_data_ptr (like neco's cmsg)
  size_t buffer_size = capacity + 1;
  
  if (buffer_size > 0) {
    chan->buffer = (${elementTypeStr}*)__yo_malloc(sizeof(${elementTypeStr}) * buffer_size);
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

    // Channel send function - following neco's approach
    emitter.emitLine(`void __yo_chan_send_${safeCName}(${cName}* chan, ${elementTypeStr} value) {
  if (!chan || atomic_load_explicit(&chan->closed, memory_order_acquire)) {
    return;
  }

  if (yo_coro_scheduler_initialized && yo_coro_current) {
    // Coroutine context - use wait queues and park (neco-style)
    
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

    // Check if receiver is waiting (neco: single queue mode)
    if (!__yo_chan_wait_queue_empty(chan->recv_queue_head)) {
      // Receiver waiting - do direct handoff
      yo_coro_t* receiver = __yo_chan_wait_queue_pop(&chan->recv_queue_head, &chan->recv_queue_tail);
      
      if (receiver->select_state != NULL) {
        // Receiver is in select - find which case matches this channel
        for (int i = 0; i < receiver->select_state->num_cases; i++) {
          if (receiver->select_state->cases[i].channel == chan && 
              !receiver->select_state->cases[i].is_send) {
            // This is the receive case - write to Option result
            ${optionReturnTypeStr}* recv_result = (${optionReturnTypeStr}*)receiver->select_state->cases[i].value_ptr;
            recv_result->tag = ${someTag};
            recv_result->data.Some.value = value;
            receiver->select_state->ready_case = i;
            break;
          }
        }
      } else if (receiver->recv_data_ptr != NULL) {
        // Regular receive - copy directly to receiver's result struct (KEY: neco's cmsg pattern)
        // This is the magic: no buffer race, direct copy to receiver's stack!
        // recv_data_ptr points to the Option result struct
        ${optionReturnTypeStr}* recv_result = (${optionReturnTypeStr}*)receiver->recv_data_ptr;
        recv_result->tag = ${someTag};
        recv_result->data.Some.value = value;
        receiver->recv_data_ptr = NULL;  // Clear after use
      }
      
#if defined(_WIN32)
      LeaveCriticalSection(&chan->mutex);
#else
      pthread_mutex_unlock(&chan->mutex);
#endif
      
      // Wake the receiver task (only if not already completed and stack not freed)
      if (receiver->owner_worker && receiver->state != YO_CORO_COMPLETED && receiver->stack != NULL) {
        receiver->state = YO_CORO_READY;
        receiver->wait_channel = NULL;
        __yo_coro_enqueue_to_worker(receiver->owner_worker, receiver);
      }
      
#if defined(_WIN32)
      WakeConditionVariable(&chan->recv_cond);
#else
      pthread_cond_signal(&chan->recv_cond);
#endif
      
      // Sender completes immediately (neco line 5993)
      return;
    }

    // No receiver waiting - check if buffer has space (neco line 6006)
    if (chan->size < chan->capacity) {
      // Buffer has space - add to buffer using ring buffer (tail for write, head for read)
      chan->buffer[chan->tail] = value;
      chan->tail = (chan->tail + 1) % chan->capacity;
      chan->size++;
      
#if defined(_WIN32)
      LeaveCriticalSection(&chan->mutex);
#else
      pthread_mutex_unlock(&chan->mutex);
#endif
      
      // Wake up any blocked receivers
      // NOTE: This must be called AFTER unlocking to avoid deadlock
      // (wakeup locks worker queues while we hold channel mutex)
      __yo_coro_wakeup(chan);
      return;
    }

    // Buffer full or unbuffered - must park sender (neco line 6012)
    __yo_chan_wait_queue_add(&chan->send_queue_head, &chan->send_queue_tail, yo_coro_current);
    yo_coro_current->wait_channel = chan;
    
    // NEW: Store value pointer in coroutine instead of shared buffer
    // Allocate temp storage for the value (will be freed when sender resumes)
    ${elementTypeStr}* value_storage = (${elementTypeStr}*)__yo_malloc(sizeof(${elementTypeStr}));
    *value_storage = value;
    yo_coro_current->send_data_ptr = value_storage;
    yo_coro_current->send_data_size = sizeof(${elementTypeStr});
    
    CONCURRENCY_DEBUG("[CHAN_SEND] Task=%p parking, stored value=%d at %p\\n", yo_coro_current, value, value_storage);
    
#if defined(_WIN32)
    LeaveCriticalSection(&chan->mutex);
#else
    pthread_mutex_unlock(&chan->mutex);
#endif
    
    // Check for stack overflow before parking
    __yo_check_stack_overflow(yo_coro_current);
    
    // Park this task
    yo_coro_current->state = YO_CORO_BLOCKED;
    yo_coro_current = NULL;
    llco_switch(NULL, false);
    
    // Resumed - receiver took the value, free our temp storage
    if (yo_coro_current && yo_coro_current->send_data_ptr) {
      __yo_free(yo_coro_current->send_data_ptr);
      yo_coro_current->send_data_ptr = NULL;
      yo_coro_current->send_data_size = 0;
    }
    return;
  }
}
`);

    // Channel receive function - uses output parameter to avoid struct return issues with longjmp
    emitter.emitLine(`void __yo_chan_recv_${safeCName}(${cName}* chan, ${optionReturnTypeStr}* result) {
  memset(result, 0, sizeof(*result)); // Initialize to zero (None case)

  if (!chan) {
    return; // Return None for null channel
  }

  if (chan->capacity == 0) {
    // Unbuffered channel - direct handoff using wait queues
    
    if (yo_coro_scheduler_initialized && yo_coro_current) {
      // Coroutine context - use wait queues and park
      
#if defined(_WIN32)
      EnterCriticalSection(&chan->mutex);
#else
      pthread_mutex_lock(&chan->mutex);
#endif
      
      if (atomic_load_explicit(&chan->closed, memory_order_acquire)) {
        result->tag = ${noneTag};
#if defined(_WIN32)
        LeaveCriticalSection(&chan->mutex);
#else
        pthread_mutex_unlock(&chan->mutex);
#endif
        return;
      }
      
      // Check if sender is waiting
      if (!__yo_chan_wait_queue_empty(chan->send_queue_head)) {
        CONCURRENCY_DEBUG("[CHAN_RECV] Found sender=%p in send_queue\\n", chan->send_queue_head);
        // Sender waiting - take value directly
        yo_coro_t* sender = __yo_chan_wait_queue_pop(&chan->send_queue_head, &chan->send_queue_tail);
        CONCURRENCY_DEBUG("[CHAN_RECV] Popped sender=%p, select_state=%p\\n", sender, sender->select_state);
        
        // Check if sender is in a select statement
        if (sender->select_state) {
          CONCURRENCY_DEBUG("[CHAN_RECV] Sender has select_state, num_cases=%d\\n", sender->select_state->num_cases);
          // Sender is in select - find the send case for this channel and take value
          bool found = false;
          for (int i = 0; i < sender->select_state->num_cases; i++) {
            CONCURRENCY_DEBUG("[CHAN_RECV] Checking case %d: channel=%p (want %p), is_send=%d\\n", 
              i, sender->select_state->cases[i].channel, chan, sender->select_state->cases[i].is_send);
            if (sender->select_state->cases[i].channel == chan && 
                sender->select_state->cases[i].is_send) {
              ${elementTypeStr} val = *(${elementTypeStr}*)sender->select_state->cases[i].value_ptr;
              CONCURRENCY_DEBUG("[CHAN_RECV] Found send case %d, value=%d\\n", i, val);
              result->tag = ${someTag};
              result->data.Some.value = val;
              sender->select_state->ready_case = i;
              found = true;
              break;
            }
          }
          if (!found) {
            CONCURRENCY_DEBUG("[CHAN_RECV] ERROR: No matching send case found!\\n");
            result->tag = ${noneTag};
          }
        } else {
          // Regular send - read value from sender's send_data_ptr
          if (sender->send_data_ptr != NULL && sender->send_data_size == sizeof(${elementTypeStr})) {
            result->tag = ${someTag};
            result->data.Some.value = *(${elementTypeStr}*)sender->send_data_ptr;
            CONCURRENCY_DEBUG("[CHAN_RECV] Got value=%d from parked sender's send_data_ptr=%p\\n", 
              result->data.Some.value, sender->send_data_ptr);
          } else {
            CONCURRENCY_DEBUG("[CHAN_RECV] ERROR: Parked sender has no send_data_ptr! ptr=%p, size=%zu\\n", 
              sender->send_data_ptr, sender->send_data_size);
            result->tag = ${noneTag};
          }
        }
        
#if defined(_WIN32)
        LeaveCriticalSection(&chan->mutex);
#else
        pthread_mutex_unlock(&chan->mutex);
#endif
        
        // Wake the sender coroutine by enqueueing it back to its owner worker's ready queue (only if not already completed and stack not freed)
        if (sender->owner_worker && sender->state != YO_CORO_COMPLETED && sender->stack != NULL) {
          sender->state = YO_CORO_READY;
          sender->wait_channel = NULL;
          __yo_coro_enqueue_to_worker(sender->owner_worker, sender);
        }
        
        // Also signal pthread condition variable in case non-task threads are waiting
#if defined(_WIN32)
        WakeConditionVariable(&chan->send_cond);
#else
        pthread_cond_signal(&chan->send_cond);
#endif
        
        return;
      }
      
      // Check if value is available from parked sender
      if (chan->size > 0 && chan->buffer != NULL) {
        result->tag = ${someTag};
        // Parked sender always stores value in buffer[0]
        result->data.Some.value = chan->buffer[0];
        chan->size = 0;

#if defined(_WIN32)
        LeaveCriticalSection(&chan->mutex);
        WakeConditionVariable(&chan->send_cond);
#else
        pthread_mutex_unlock(&chan->mutex);
        pthread_cond_signal(&chan->send_cond);
#endif

        // Pop and wake the sender from wait queue (only if not already completed and stack not freed)
        if (!__yo_chan_wait_queue_empty(chan->send_queue_head)) {
          yo_coro_t* sender = __yo_chan_wait_queue_pop(&chan->send_queue_head, &chan->send_queue_tail);
          if (sender && sender->owner_worker && sender->state != YO_CORO_COMPLETED && sender->stack != NULL) {
            sender->state = YO_CORO_READY;
            sender->wait_channel = NULL;
            __yo_coro_enqueue_to_worker(sender->owner_worker, sender);
          }
        }
        return;
      }
      
      // No sender waiting - must park
      CONCURRENCY_DEBUG("[CHAN_RECV] No sender waiting, no buffer value, parking...\\n");
      __yo_chan_wait_queue_add(&chan->recv_queue_head, &chan->recv_queue_tail, yo_coro_current);
      yo_coro_current->wait_channel = chan;
      // KEY FIX: Set recv_data_ptr to point to result (like neco's cmsg pattern)
      yo_coro_current->recv_data_ptr = result;
      
#if defined(_WIN32)
      LeaveCriticalSection(&chan->mutex);
#else
      pthread_mutex_unlock(&chan->mutex);
#endif
      
      // Check for stack overflow before parking
      __yo_check_stack_overflow(yo_coro_current);
      
      // Park this coroutine - switch directly back to worker without re-enqueuing
      // The coroutine is already in the channel's recv_queue and will be woken up by a sender
      yo_coro_current->state = YO_CORO_BLOCKED;
      yo_coro_current = NULL;  // Clear current coroutine since we're blocking
      CONCURRENCY_DEBUG("[CHAN_RECV] Switching back to worker (coro blocked)\\n");
      llco_switch(NULL, false);  // Return to worker loop
      
      // Resumed - value should be available
      // Sender copied value directly to result via recv_data_ptr (neco's cmsg pattern)
      CONCURRENCY_DEBUG("[CHAN_RECV] Task resumed after parking, value should be in result\\n");
      
      // Value was already written by sender to result (via recv_data_ptr)
      // Just return - no need to lock mutex or check buffer
      // The result struct already has the value with tag set by sender
      return;
    }
  }  // Close: if (chan->capacity == 0)

  // Buffered channel
  if (yo_coro_scheduler_initialized && yo_coro_current) {
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
      __yo_coro_block_and_yield(chan);
      
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
      result->tag = ${someTag}; // SOME variant
      result->data.Some.value = value;
    } else {
      // No data available - return None
      result->tag = ${noneTag}; // NONE variant
    }

#if defined(_WIN32)
    LeaveCriticalSection(&chan->mutex);
#else
    pthread_mutex_unlock(&chan->mutex);
#endif

    // Wake up any coroutines waiting to send
    __yo_coro_wakeup(chan);
    return;
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
    result->tag = ${someTag}; // SOME variant
    result->data.Some.value = value;
  } else {
    // No data available - return None
    result->tag = ${noneTag}; // NONE variant
  }

#if defined(_WIN32)
  WakeConditionVariable(&chan->send_cond);
  LeaveCriticalSection(&chan->mutex);
#else
  pthread_cond_signal(&chan->send_cond);
  pthread_mutex_unlock(&chan->mutex);
#endif

  return;
}
`);

    // Generic select runtime function (works for all channel types)
    if (isFirstChannelType) {
      emitter.emitLine(`
// Go-style select implementation
// Following neco's select implementation:
// 1. Poll all channels to see if any are ready (has sender/receiver waiting OR has buffered data)
// 2. If ready, perform the operation immediately and return
// 3. If not ready, add coroutine to ALL channel wait queues and park
// 4. When ANY channel operation completes, wake the coroutine and set ready_case in select_state
// 5. Remove from all wait queues and return which case was ready
//
// Extension: We support both send and receive in select (neco only supports receive)
int __yo_select(yo_select_case_t* cases, int num_cases, bool has_default) {
  if (!yo_coro_scheduler_initialized || !yo_coro_current) {
    // Not in coroutine context - cannot use select
    if (has_default) {
      return -2; // Default case
    }
    return -1; // Error
  }
  
  CONCURRENCY_DEBUG("[SELECT] Task=%p entering select with %d cases\\n", yo_coro_current, num_cases);
  
  // PHASE 1: Poll all channels to see if any are ready
  // We need to lock each channel to check atomically
  for (int i = 0; i < num_cases; i++) {
    void* chan_ptr = cases[i].channel;
    if (!chan_ptr) continue;
    
    ${cName}* chan = (${cName}*)chan_ptr;
    
    CONCURRENCY_DEBUG("[SELECT] Checking case %d: is_send=%d, chan=%p\\n", i, cases[i].is_send, chan);
    
#if defined(_WIN32)
    EnterCriticalSection(&chan->mutex);
#else
    pthread_mutex_lock(&chan->mutex);
#endif
    
    bool is_ready = false;
    
    if (cases[i].is_send) {
      // Send case - ready if receiver waiting (unbuffered) or buffer has space (buffered)
      if (chan->capacity == 0) {
        // Unbuffered - ready if receiver in queue
        is_ready = !__yo_chan_wait_queue_empty(chan->recv_queue_head);
        CONCURRENCY_DEBUG("[SELECT] Send case: unbuffered, recv_queue_empty=%d, is_ready=%d\\n", 
          __yo_chan_wait_queue_empty(chan->recv_queue_head), is_ready);
      } else {
        // Buffered - ready if space available  
        is_ready = (chan->size < chan->capacity);
        CONCURRENCY_DEBUG("[SELECT] Send case: buffered, size=%d, capacity=%d, is_ready=%d\\n", 
          chan->size, chan->capacity, is_ready);
      }
    } else {
      // Receive case - ready if sender waiting (unbuffered) or buffer has data (buffered)
      if (chan->capacity == 0) {
        // Unbuffered - ready if sender in queue
        is_ready = !__yo_chan_wait_queue_empty(chan->send_queue_head);
        CONCURRENCY_DEBUG("[SELECT] Recv case: unbuffered, send_queue_empty=%d, is_ready=%d\\n", 
          __yo_chan_wait_queue_empty(chan->send_queue_head), is_ready);
      } else {
        // Buffered - ready if data available
        is_ready = (chan->size > 0);
        CONCURRENCY_DEBUG("[SELECT] Recv case: buffered, size=%d, is_ready=%d\\n", 
          chan->size, is_ready);
      }
    }
    
#if defined(_WIN32)
    LeaveCriticalSection(&chan->mutex);
#else
    pthread_mutex_unlock(&chan->mutex);
#endif
    
    if (is_ready) {
      CONCURRENCY_DEBUG("[SELECT] Case %d is ready, executing now\\n", i);
      // Perform the operation immediately
      if (cases[i].is_send) {
        ${elementTypeStr} value = *(${elementTypeStr}*)cases[i].value_ptr;
        __yo_chan_send_${safeCName}(chan, value);
      } else {
        ${optionReturnTypeStr}* result_ptr = (${optionReturnTypeStr}*)cases[i].value_ptr;
        __yo_chan_recv_${safeCName}(chan, result_ptr);
      }
      CONCURRENCY_DEBUG("[SELECT] Case %d completed, returning\\n", i);
      return i;
    }
  }
  
  // PHASE 2: No case is ready - check for default
  if (has_default) {
    CONCURRENCY_DEBUG("[SELECT] No case ready, using default\\n");
    return -2; // Execute default case
  }
  
  CONCURRENCY_DEBUG("[SELECT] No case ready, no default, parking on all channels\\n");
  
  // PHASE 3: No case ready and no default - must park on all channels
  // Create select_state and store in current task
  yo_select_state_t* state = (yo_select_state_t*)__yo_malloc(sizeof(yo_select_state_t));
  state->cases = cases;
  state->num_cases = num_cases;
  state->ready_case = -1;
  state->has_default = has_default;
  
  yo_coro_current->select_state = state;
  
  // CRITICAL: Lock ALL channels first to prevent TOCTOU bugs
  // Then re-check if any are ready, then add to wait queues atomically
  for (int i = 0; i < num_cases; i++) {
    ${cName}* chan = (${cName}*)cases[i].channel;
    if (!chan) continue;
#if defined(_WIN32)
    EnterCriticalSection(&chan->mutex);
#else
    pthread_mutex_lock(&chan->mutex);
#endif
  }
  
  // Re-check if any case is now ready (TOCTOU fix)
  int ready_idx = -1;
  for (int i = 0; i < num_cases; i++) {
    ${cName}* chan = (${cName}*)cases[i].channel;
    if (!chan) continue;
    
    bool is_ready = false;
    if (cases[i].is_send) {
      if (chan->capacity == 0) {
        is_ready = !__yo_chan_wait_queue_empty(chan->recv_queue_head);
      } else {
        is_ready = (chan->size < chan->capacity);
      }
    } else {
      if (chan->capacity == 0) {
        is_ready = !__yo_chan_wait_queue_empty(chan->send_queue_head);
      } else {
        is_ready = (chan->size > 0);
      }
    }
    
    if (is_ready) {
      ready_idx = i;
      break;
    }
  }
  
  if (ready_idx >= 0) {
    // Found a ready case after locking - unlock all and perform operation
    CONCURRENCY_DEBUG("[SELECT] Found ready case %d after locking all channels\\n", ready_idx);
    for (int i = 0; i < num_cases; i++) {
      ${cName}* chan = (${cName}*)cases[i].channel;
      if (!chan) continue;
#if defined(_WIN32)
      LeaveCriticalSection(&chan->mutex);
#else
      pthread_mutex_unlock(&chan->mutex);
#endif
    }
    
    __yo_free(state);
    yo_coro_current->select_state = NULL;
    
    // Perform the ready operation
    ${cName}* ready_chan = (${cName}*)cases[ready_idx].channel;
    if (cases[ready_idx].is_send) {
      ${elementTypeStr} value = *(${elementTypeStr}*)cases[ready_idx].value_ptr;
      __yo_chan_send_${safeCName}(ready_chan, value);
    } else {
      ${optionReturnTypeStr}* result_ptr = (${optionReturnTypeStr}*)cases[ready_idx].value_ptr;
      __yo_chan_recv_${safeCName}(ready_chan, result_ptr);
    }
    return ready_idx;
  }
  
  // Still no ready case - add to all wait queues while holding all locks
  CONCURRENCY_DEBUG("[SELECT] Still no ready case, adding to all wait queues\\n");
  for (int i = 0; i < num_cases; i++) {
    ${cName}* chan = (${cName}*)cases[i].channel;
    if (!chan) continue;
    
    if (cases[i].is_send) {
      __yo_chan_wait_queue_add(&chan->send_queue_head, &chan->send_queue_tail, yo_coro_current);
    } else {
      __yo_chan_wait_queue_add(&chan->recv_queue_head, &chan->recv_queue_tail, yo_coro_current);
    }
  }
  
  // Now unlock all channels
  for (int i = 0; i < num_cases; i++) {
    ${cName}* chan = (${cName}*)cases[i].channel;
    if (!chan) continue;
#if defined(_WIN32)
    LeaveCriticalSection(&chan->mutex);
#else
    pthread_mutex_unlock(&chan->mutex);
#endif
  }
  
  // Check for stack overflow before parking
  __yo_check_stack_overflow(yo_coro_current);
  
  // Park the coroutine (will be woken when any channel operation completes)
  CONCURRENCY_DEBUG("[SELECT] Parking coroutine\\n");
  yo_coro_current->state = YO_CORO_BLOCKED;
  yo_coro_current->wait_channel = NULL; // Waiting on multiple channels
  yo_coro_current = NULL;
  llco_switch(NULL, false); // Switch back to worker
  
  // ===== RESUMED - one channel is ready =====
  // Worker loop has restored yo_coro_current
  
  int ready_case = yo_coro_current->select_state->ready_case;
  
  // Remove from all wait queues (important - we might still be in other queues!)
  for (int i = 0; i < num_cases; i++) {
    ${cName}* chan = (${cName}*)cases[i].channel;
    if (!chan) continue;
    
#if defined(_WIN32)
    EnterCriticalSection(&chan->mutex);
#else
    pthread_mutex_lock(&chan->mutex);
#endif
    
    // Note: The channel that woke us already dequeued us, but we need to remove from others
    if (cases[i].is_send) {
      __yo_chan_wait_queue_remove(&chan->send_queue_head, &chan->send_queue_tail, yo_coro_current);
    } else {
      __yo_chan_wait_queue_remove(&chan->recv_queue_head, &chan->recv_queue_tail, yo_coro_current);
    }
    
#if defined(_WIN32)
    LeaveCriticalSection(&chan->mutex);
#else
    pthread_mutex_unlock(&chan->mutex);
#endif
  }
  
  // Free select state
  __yo_free(state);
  yo_coro_current->select_state = NULL;
  
  return ready_case;
}
`);
    }

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

    isFirstChannelType = false;
  }
}
