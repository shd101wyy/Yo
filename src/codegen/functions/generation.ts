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
  FutureType,
  isClosureType,
  isDynType,
  isEnumType,
  isFunctionType,
  isFutureType,
  isStructType,
  isUnitType,
  typeContainsSomeType,
  typeToString,
} from "../../types";
import { canRefStructFormCycles } from "../../types/utils";
import { isTempVariableName } from "../../utils";
import { isFunctionValue } from "../../value";
import { generateAsyncRuntime } from "../async/runtime";
import {
  generateDeferredDropExpressions,
  generateExpr,
  generateReturnStatement,
} from "../expressions";
import {
  canOptimizeAsNullablePointer,
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
    // Skip GCC/Clang atomic builtins - the compiler already knows about them
    if (cName.startsWith("__atomic_") || cName.startsWith("__sync_")) {
      continue;
    }
    generateFunctionDeclaration(type, cName, true, context);
  }
  emitter.emitDeclarationLine("");

  // Generate forward declarations for async runtime functions
  emitter.emitDeclarationLine(`/// Async runtime functions`);
  emitter.emitDeclarationLine(
    `void yo_async_spawn_task(void (*resume_fn)(void*), void* state_machine);`
  );
  emitter.emitDeclarationLine(
    `void yo_async_register_continuation(void* future, void (*resume_fn)(void*), void* state_machine);`
  );
  emitter.emitDeclarationLine(`void yo_future_dispose(void* ptr);`);
  emitter.emitDeclarationLine("");

  // Generate constructor functions for objects
  emitter.emitDeclarationLine(`/// Object constructors`);
  generateObjectConstructorDeclarations(context);
  emitter.emitDeclarationLine("");

  // Generate constructor functions for closures
  emitter.emitDeclarationLine(`/// Closure constructors`);
  generateClosureConstructorDeclarations(context);
  emitter.emitDeclarationLine("");

  // Generate capture dispose function declarations
  emitter.emitDeclarationLine(`/// Capture dispose functions`);
  generateCaptureDisposeFunctionDeclarations(context);
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
      isFunctionValueWithOnlyBuiltinYoInlineFunctionCall(value) ||
      typeContainsSomeType(value.type)
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

  // For closure functions, add a generic closure context as the first parameter
  // The function body will cast this to the correct capture struct type
  if (functionType.isClosure) {
    paramStrings.push(`void* closure_context`);
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

  // Generate async/await runtime first (defines yo_continuation_t used by worker threads)
  generateAsyncRuntime(context.emitter, context.debugAsyncAwait);

  // Generate thread-safe GC runtime functions
  generateAtomicGCRuntimeFunctions(context);

  // Generate object constructor functions
  generateRefStructConstructorFunctions(context);

  // Generate closure constructor and ARC functions
  generateClosureConstructorFunctions(context);

  // NOTE: Don't generate capture dispose functions here yet!
  // They will be generated after deferred async blocks are processed
  // because closure creation happens during async block generation

  // Generate dyn type constructor and ARC functions
  generateDynConstructorFunctions(context);

  for (const funcId in context.functions) {
    const { value, cName } = context.functions[funcId]!;

    // If the function is generic, we will handle it later
    if (
      isGenericFunction(value) ||
      isComptFunction(value) ||
      isFunctionValueWithOnlyBuiltinYoInlineFunctionCall(value) ||
      typeContainsSomeType(value.type)
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
 * Generate a main() wrapper that calls yo_user_main() and then __yo_async_wait_all()
 * This ensures all async tasks complete before the program exits
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

  // REQUIREMENT: main must return unit (or Future(unit) for async)
  const returnType = mainFunctionValue.type.return.type;
  const returnsUnit = isUnitType(returnType);

  if (!returnsUnit) {
    throw new Error(
      `main function must return unit, but it returns ${typeToString(returnType)}. ` +
        `Use 'main :: (fn() -> unit)' instead. ` +
        `For exit codes, use 'exit(code)' from std/libc/stdlib.yo`
    );
  }

  {
    // Sync main - call it directly and wait for any async tasks
    emitter.emitLine(`
// Main wrapper - calls yo_user_main directly
int main(void) {
  // Initialize async runtime (in case async blocks are used)
  __yo_async_scheduler_init();
  
  // Call sync main
  yo_user_main();
  
  // Wait for all async tasks to complete
  // This ensures any async blocks spawned in main finish before exit
  __yo_async_wait_all();
  
  return 0;
}
`);
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

  // Regular function generation (async blocks within the function handle their own state machines)
  const functionPrototype = generateFunctionPrototype(
    functionType,
    cFunctionName,
    context
  );
  emitter.emitLine(`${functionPrototype} {`);

  // Set current function name and type for recur support and async handling
  const previousFunctionName = context.currentFunctionName;
  const previousFunctionType = (context as FunctionGenerationContext)
    .currentFunctionType;
  context.currentFunctionName = functionName;
  (context as FunctionGenerationContext).currentFunctionType = functionType;

  // Set closure capture context if this is a closure function
  const previousClosureCaptures = context.currentClosureCaptures;
  const previousClosureCaptureFrameLevel =
    context.currentClosureCaptureFrameLevel;
  const previousClosureType = (context as FunctionGenerationContext)
    .currentClosureType;
  const previousClosureCaptureTypeCName = (context as FunctionGenerationContext)
    .currentClosureCaptureTypeCName;

  if (functionType.isClosure) {
    // Use the closure info stored on the function value (set during evaluation)
    const closureInfo = functionValue.closureInfo;

    if (closureInfo && isClosureType(closureInfo.closureType)) {
      const closureType = closureInfo.closureType as ClosureType;
      const captureType = closureInfo.captureType;

      (context as FunctionGenerationContext).currentClosureType = closureType;

      // Get captured variables from the capture type
      if (
        captureType &&
        isStructType(captureType) &&
        captureType.fields.length > 0
      ) {
        // Extract variable names from the capture struct fields
        const capturedVarNames = captureType.fields.map((field) => field.label);
        context.currentClosureCaptures = capturedVarNames;

        // Get the frame level - use the function's frame level as the capture frame level
        context.currentClosureCaptureFrameLevel = functionValue.frameLevel;

        // Get the C name of the capture type
        const captureTypeCName = context.types[captureType.id]?.cName;
        if (captureTypeCName) {
          (
            context as FunctionGenerationContext
          ).currentClosureCaptureTypeCName = captureTypeCName;
        }
      }
    }
  }

  // Generate function body with proper return handling
  generateFunctionBody(functionValue.body, functionType, "  ", context);

  // Restore previous function name, type, and closure captures
  context.currentFunctionName = previousFunctionName;
  (context as FunctionGenerationContext).currentFunctionType =
    previousFunctionType;
  context.currentClosureCaptures = previousClosureCaptures;
  context.currentClosureCaptureFrameLevel = previousClosureCaptureFrameLevel;
  (context as FunctionGenerationContext).currentClosureType =
    previousClosureType;
  (context as FunctionGenerationContext).currentClosureCaptureTypeCName =
    previousClosureCaptureTypeCName;

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

      // Check if this is an async function - async functions return Future(T)
      const isAsyncFunction = isFutureType(functionType.return.type);

      if (isAsyncFunction && lastExpr) {
        // Check if the last expression is an async block
        // If it is, we should return it directly without wrapping
        const isAsyncBlock = exprIsFunctionCallOf(
          lastExpr,
          BuiltinFunctions.async
        );

        // Check if the last expression already returns a Future type
        // If so, return it directly without wrapping (e.g., from Option.unwrap())
        const lastExprType = lastExpr.$?.type;
        const isAlreadyFuture = lastExprType && isFutureType(lastExprType);

        if (isAsyncBlock || isAlreadyFuture) {
          // Last expression is an async block or already returns a Future - return it directly
          const resultCode = generateExpr(lastExpr, indent, context);
          emitter.emitLine(`${indent}return ${resultCode};`);
        } else {
          // For async functions, wrap the return value in a Future
          const futureType = functionType.return.type as FutureType;
          const childType = futureType.childType;
          const isUnitResult = isUnitType(childType);

          // Get the Future type C name
          const futureTypeCName = context.types[futureType.id]?.cName;
          if (!futureTypeCName) {
            emitter.emitLine(
              `${indent}// Error: Future type not found in context`
            );
            return;
          }

          // Generate the result expression (if not unit)
          if (!isUnitResult) {
            const resultCode = generateExpr(lastExpr, indent, context);
            emitter.emitLine(
              `${indent}${getTypeString(childType, context)} _yo_async_result = ${resultCode};`
            );
          } else {
            // For unit, just execute the expression as a statement
            const exprCode = generateExpr(lastExpr, indent, context);
            if (exprCode) {
              emitter.emitLine(`${indent}${exprCode};`);
            }
          }

          // Allocate and initialize the Future
          emitter.emitLine(
            `${indent}${futureTypeCName}* _yo_future = (${futureTypeCName}*)__yo_malloc(sizeof(${futureTypeCName}));`
          );
          emitter.emitLine(
            `${indent}_yo_future->header.owner_thread_id = __yo_get_thread_id();`
          );
          emitter.emitLine(
            `${indent}_yo_future->header.biased_word = BRC_SET_BIASED_COUNTER(0, 1);`
          );
          emitter.emitLine(`${indent}_yo_future->header.shared_word = 0;`);
          emitter.emitLine(`${indent}_yo_future->header.gc_next = NULL;`);
          emitter.emitLine(`${indent}_yo_future->header.gc_prev = NULL;`);
          emitter.emitLine(
            `${indent}_yo_future->header.dispose_fn = yo_future_dispose;`
          );
          emitter.emitLine(`${indent}_yo_future->header.traverse_fn = NULL;`);
          emitter.emitLine(
            `${indent}atomic_store_explicit(&_yo_future->state, YO_FUTURE_COMPLETED, memory_order_relaxed);`
          );
          emitter.emitLine(
            `${indent}_yo_future->state_machine = NULL;  // No state machine for immediate completion`
          );

          if (!isUnitResult) {
            emitter.emitLine(`${indent}_yo_future->result = _yo_async_result;`);
          }

          emitter.emitLine(`${indent}return _yo_future;`);
        }
      } else if (lastExpr && isUnitType(functionType.return.type)) {
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

      // Generate deferred drop expressions AFTER generating the last expression
      // This ensures that variables used in the last expression are not dropped prematurely
      generateDeferredDropExpressions(expr, indent, context);
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
    `void __yo_decr_rc(void* ptr); // Decrement reference count`
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

  // Generate constructor declarations for each object
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (isStructType(type) && type.isReferenceSemantics) {
      // Skip generic structs that contain SomeType parameters
      const hasGenericTypes = type.fields.some((field) =>
        typeContainsSomeType(field.type)
      );

      if (hasGenericTypes) {
        continue; // Skip generic structs - only generate constructors for concrete types
      }

      // Generate constructor function declaration
      const constructorName = `__yo_new_${cName}`;
      const paramTypes = type.fields
        .map((field) => {
          const fieldType = getTypeString(field.type, context);
          const fieldName = sanitizeForCIdentifier(field.label);
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
      // Note: captureType is no longer on ClosureType, look it up by naming convention
      const captureTypeName = `${cName}_capture`;
      const captureTypeEntry = Object.values(context.types).find(
        (entry) => entry.cName === captureTypeName
      );
      const captureType = captureTypeEntry?.type;

      if (
        captureType &&
        isStructType(captureType) &&
        captureType.fields.length > 0
      ) {
        // Constructor takes captured values, call function, and drop function
        const captureParams = captureType.fields
          .map((field) => {
            const fieldType = getTypeString(field.type, context);
            const fieldName = sanitizeForCIdentifier(field.label);
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
 * Generate declarations for capture-specific dispose functions
 */
export function generateCaptureDisposeFunctionDeclarations(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Generate forward declarations for closure dispose functions
  // These are generated from closureCaptureMap which is populated during closure creation
  if (context.closureCaptureMap && context.closureCaptureMap.size > 0) {
    for (const [closureInstanceId] of context.closureCaptureMap) {
      const disposeFunctionName = `__yo_dispose_closure_${closureInstanceId}`;
      emitter.emitDeclarationLine(
        `void ${disposeFunctionName}(void* closure_ptr);`
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
 * Generate Biased reference counting (BRC) runtime functions.
 * Generate per-thread garbage collection runtime functions with stop-the-world collection
 */
function generateAtomicGCRuntimeFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Generate BRC __yo_decr_rc function following the paper's algorithm with split words
  emitter.emitLine(`void __yo_decr_rc(void* ptr) {
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
      if (header->dispose_fn) {
        header->dispose_fn(ptr);
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
      if (header->dispose_fn) {
        header->dispose_fn(ptr);
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
    // Need to initialize process cleanup before creating first GC state
    // This is normally done in yo_init_thread_gc(), but we're creating GC state
    // from a different thread (during cross-thread drop), so we need to do it here
    static bool process_cleanup_initialized = false;
    if (!process_cleanup_initialized) {
      process_cleanup_initialized = true;
      yo_init_process_cleanup();
    }
    
    thread_gc = (yo_thread_gc_state_t*)__yo_malloc(sizeof(yo_thread_gc_state_t));
    thread_gc->thread_id = owner_tid;
    thread_gc->tracked_objects = NULL;
    thread_gc->tracked_count = 0;
    thread_gc->next = yo_all_thread_gcs;
    thread_gc->prev = NULL;
    if (yo_all_thread_gcs != NULL) {
      yo_all_thread_gcs->prev = thread_gc;
    }
    yo_all_thread_gcs = thread_gc;
    atomic_fetch_add_explicit(&yo_total_thread_count, 1, memory_order_relaxed);
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
  yo_mutex_lock(&yo_thread_list_mutex);
  
  // Find GC state for current thread (may not be in yo_current_thread_gc if created by another thread)
  size_t current_tid = __yo_get_thread_id();
  yo_thread_gc_state_t* my_gc_state = yo_current_thread_gc;
  
  // If yo_current_thread_gc is NULL, search the global list by thread ID
  // This handles the case where another thread created a GC state for us via __yo_brc_queue_object
  if (my_gc_state == NULL) {
    yo_thread_gc_state_t* thread_gc = yo_all_thread_gcs;
    while (thread_gc != NULL) {
      if (thread_gc->thread_id == current_tid) {
        my_gc_state = thread_gc;
        break;
      }
      thread_gc = thread_gc->next;
    }
  }
  
  if (my_gc_state == NULL) {
    yo_mutex_unlock(&yo_thread_list_mutex);
    return; // No GC state to clean up
  }
  
  BRC_DEBUG("CleanupThread: tid=%zu, tracked_count=%zu\\n", 
            my_gc_state->thread_id, 
            my_gc_state->tracked_count);
  
  // Find a main/long-lived thread to merge objects to, or distribute among remaining threads
  yo_thread_gc_state_t* target_thread = NULL;
  yo_thread_gc_state_t* thread_gc = yo_all_thread_gcs;
  
  // Try to find the main thread (usually the first one, with smallest thread ID)
  size_t min_thread_id = SIZE_MAX;
  while (thread_gc != NULL) {
    if (thread_gc != my_gc_state && thread_gc->thread_id < min_thread_id) {
      min_thread_id = thread_gc->thread_id;
      target_thread = thread_gc;
    }
    thread_gc = thread_gc->next;
  }
  
  BRC_DEBUG("CleanupThread: target_thread=%p (tid=%zu)\\n", 
            (void*)target_thread, 
            target_thread ? target_thread->thread_id : 0);
  
  // If we have objects to transfer and found a target thread
  if (target_thread != NULL && my_gc_state->tracked_objects != NULL) {
    // Transfer all tracked objects to target thread
    yo_ref_header_t* current = my_gc_state->tracked_objects;
    yo_ref_header_t* last = NULL;
    
    // Find the end of our list
    while (current != NULL) {
      last = current;
      current = (yo_ref_header_t*)current->gc_next;
    }
    
    if (last != NULL) {
      // Append our list to target thread's list
      last->gc_next = target_thread->tracked_objects;
      target_thread->tracked_objects = my_gc_state->tracked_objects;
      target_thread->tracked_count += my_gc_state->tracked_count;
      BRC_DEBUG("CleanupThread: Transferred %zu objects to target thread tid=%zu\\n", 
                my_gc_state->tracked_count, target_thread->thread_id);
    }
  } else if (my_gc_state->tracked_objects != NULL) {
    // No target thread found - force immediate collection of our objects
    // This is a safety measure to prevent memory leaks
    BRC_DEBUG("CleanupThread: No target thread, disposing %zu objects immediately\\n", 
              my_gc_state->tracked_count);
    yo_ref_header_t* current = my_gc_state->tracked_objects;
    while (current != NULL) {
      yo_ref_header_t* next = (yo_ref_header_t*)current->gc_next;
      
      BRC_DEBUG("CleanupThread: Disposing object ptr=%p\\n", current);
      // Force dispose the object
      if (current->dispose_fn) {
        current->dispose_fn(current);
      }
      __yo_free(current);
      
      current = next;
    }
  }
  
  // Remove current thread from global list (O(1) operation with doubly-linked list)
  if (my_gc_state->prev != NULL) {
    my_gc_state->prev->next = my_gc_state->next;
  } else {
    // We're the head of the list
    yo_all_thread_gcs = my_gc_state->next;
  }
  
  if (my_gc_state->next != NULL) {
    my_gc_state->next->prev = my_gc_state->prev;
  }
  
  atomic_fetch_sub_explicit(&yo_total_thread_count, 1, memory_order_relaxed);
  
  yo_mutex_unlock(&yo_thread_list_mutex);
  
  // Free the thread GC state
  __yo_free(my_gc_state);
  
  // Clear yo_current_thread_gc if it was pointing to the state we just freed
  if (yo_current_thread_gc == my_gc_state) {
    yo_current_thread_gc = NULL;
  }
}

// Process cleanup - clean up remaining threads and resources
static void yo_process_cleanup(void) {
  // Note: On some systems (Unix with pthreads), TSS destructors may run BEFORE atexit handlers
  // In that case, yo_current_thread_gc may already be NULL here
  // However, worker threads should have transferred their queued objects to the main thread
  // So we check if there are any remaining thread GC states to process
  
  BRC_DEBUG("ProcessCleanup: Called\\n");
  BRC_DEBUG("ProcessCleanup: Current thread GC state: %p\\n", (void*)yo_current_thread_gc);
  
  // If we still have a GC state (main thread hasn't been cleaned up yet), run final GC
  if (yo_current_thread_gc != NULL) {
    BRC_DEBUG("ProcessCleanup: Running final GC collection\\n");
    BRC_DEBUG("ProcessCleanup: Tracked objects: %p, count: %zu\\n", 
            (void*)yo_current_thread_gc->tracked_objects, 
            yo_current_thread_gc->tracked_count);
    __yo_gc_collect();
    __yo_cleanup_thread_gc();
  } else {
    BRC_DEBUG("ProcessCleanup: Main thread already cleaned up by TSS destructor\\n");
  }
  
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
      const hasGenericTypes = type.fields.some((field) =>
        typeContainsSomeType(field.type)
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
      for (const field of type.fields) {
        const fieldName = sanitizeForCIdentifier(field.label);
        const fieldType = field.type;

        if (isStructType(fieldType) && fieldType.isReferenceSemantics) {
          // This field is a direct reference to another object
          emitter.emitLine(`  if (obj->${fieldName}) {`);
          emitter.emitLine(`    visit(obj->${fieldName});`);
          emitter.emitLine(`  }`);
        } else if (isEnumType(fieldType)) {
          // This field is an enum - we need to check if any variants contain references
          const enumType = fieldType as EnumType;

          // Check if this enum is optimized as a nullable pointer
          const nullablePointerType = canOptimizeAsNullablePointer(enumType);

          if (nullablePointerType) {
            // This is a nullable pointer optimization - just check if it's non-null
            // No need to visit the pointer itself since it's not a reference-counted object
            // (it's just a raw pointer or primitive value wrapped in Option)
          } else {
            // Generate switch statement to handle enum variants
            emitter.emitLine(`  switch (obj->${fieldName}.tag) {`);

            for (const variant of enumType.variants || []) {
              // Check if any of the variant's fields contain references
              if (variant.fields && variant.fields.length > 0) {
                for (const field of variant.fields) {
                  if (
                    isStructType(field.type) &&
                    field.type.isReferenceSemantics
                  ) {
                    // This variant contains a reference
                    const enumConstantName = `YO_${enumType.id?.toUpperCase()}_${variant.name.toUpperCase()}`;
                    emitter.emitLine(`  case ${enumConstantName}:`);
                    emitter.emitLine(
                      `    if (obj->${fieldName}.data.${variant.name}.${sanitizeForCIdentifier(field.label)}) {`
                    );
                    emitter.emitLine(
                      `      visit(obj->${fieldName}.data.${variant.name}.${sanitizeForCIdentifier(field.label)});`
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
      const hasGenericTypes = type.fields.some((field) =>
        typeContainsSomeType(field.type)
      );

      if (hasGenericTypes) {
        continue; // Skip generic structs - only generate constructors for concrete types
      }

      // Generate constructor function implementation
      const constructorName = `__yo_new_${cName}`;
      const paramTypes = type.fields
        .map((field) => {
          const fieldType = getTypeString(field.type, context);
          const fieldName = sanitizeForCIdentifier(field.label);
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
      const disposeFunctionElement = type.module.fields.find(
        (field) =>
          field.label === BuiltinFunctions.dispose[0]! &&
          field.assignedValue &&
          isFunctionValue(field.assignedValue)
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
      type.fields.forEach((field) => {
        const fieldName = sanitizeForCIdentifier(field.label);
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

      // For closures, we only generate the __yo_create function that takes void* data
      // We don't generate parameterized constructors since capture types can vary
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
      emitter.emitLine(`  obj->header.owner_thread_id = __yo_get_thread_id();`);
      emitter.emitLine(
        `  obj->header.biased_word = BRC_SET_BIASED_COUNTER(0, 1);`
      );
      emitter.emitLine(
        `  atomic_store_explicit(&obj->header.shared_word, 0, memory_order_relaxed);`
      );
      emitter.emitLine(`  obj->header.gc_next = NULL;`);
      emitter.emitLine(`  obj->header.gc_prev = NULL;`);
      emitter.emitLine(`  obj->header.dispose_fn = dispose;`);
      emitter.emitLine(`  obj->header.traverse_fn = NULL;`);
      emitter.emitLine(`  obj->data = data;`);

      // Set vtable function pointers directly
      emitter.emitLine(`  obj->vtable.call = call;`);

      emitter.emitLine(`  return obj;`);
      emitter.emitLine(`}`);
      emitter.emitLine(``);

      // Generate a generic dispose function that frees the data pointer
      // Note: The actual dispose logic should be in a capture-specific function
      // passed when creating the closure
      const disposeFunctionName = `__yo_dispose_${cName}`;
      emitter.emitLine(`void ${disposeFunctionName}(${cName}* self) {`);
      emitter.emitLine(`  // Generic dispose - just free the data pointer`);
      emitter.emitLine(
        `  // Actual cleanup should be done by capture-specific dispose function`
      );
      emitter.emitLine(`  if (self->data) {`);
      emitter.emitLine(`    __yo_free(self->data);`);
      emitter.emitLine(`  }`);
      emitter.emitLine(`}`);
      emitter.emitLine(``);
    }
  }
}

/**
 * Generate dispose functions for closures
 * Each closure instance (closure type + capture type combination) gets its own dispose function
 * that handles cleanup of its specific capture type.
 *
 * The dispose function:
 * 1. Receives a closure pointer (void*)
 * 2. Casts it to the specific closure type
 * 3. Casts the closure->data to the specific capture type
 * 4. Calls the capture type's drop function
 * 5. Frees the capture data
 */
export function generateClosureDisposeFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  if (!context.closureCaptureMap || context.closureCaptureMap.size === 0) {
    return;
  }

  emitter.emitLine(
    `// Closure dispose functions - one per closure instance (closure type + capture type)`
  );
  emitter.emitLine(``);

  // First, emit forward declarations to the declaration section
  for (const [closureInstanceId] of context.closureCaptureMap) {
    const disposeFunctionName = `__yo_dispose_closure_${closureInstanceId}`;
    emitter.emitDeclarationLine(
      `void ${disposeFunctionName}(void* closure_ptr);`
    );
  }

  // Then generate function implementations
  for (const [
    closureInstanceId,
    { closureCName, captureType, captureCName },
  ] of context.closureCaptureMap) {
    const disposeFunctionName = `__yo_dispose_closure_${closureInstanceId}`;

    // Get the drop function for the capture type
    const dropFunction = captureType.module.fields.find(
      (field) => field.label === BuiltinFunctions.___drop[0]
    );

    if (!dropFunction || !dropFunction.assignedValue) {
      continue; // Skip if no drop function
    }

    if (!isFunctionValue(dropFunction.assignedValue)) {
      continue;
    }

    const dropFunctionValue = dropFunction.assignedValue;
    const dropFunctionCName =
      context.functions[dropFunctionValue.funcId]?.cName;

    if (!dropFunctionCName) {
      continue; // Skip if drop function C name not found
    }

    // Generate the dispose function
    // Signature: void dispose(void* closure_ptr)
    // This function receives the CLOSURE pointer (not capture pointer),
    // extracts the capture data, calls drop, and frees it
    emitter.emitLine(
      `void ${disposeFunctionName}(void* closure_ptr) { // Dispose for ${closureCName} with ${captureCName}`
    );
    emitter.emitLine(`  if (closure_ptr) {`);
    emitter.emitLine(
      `    ${closureCName}* closure = (${closureCName}*)closure_ptr;`
    );
    emitter.emitLine(`    if (closure->data) {`);
    emitter.emitLine(
      `      ${dropFunctionCName}(*(${captureCName}*)closure->data); // Drop the capture struct (dereference pointer to pass by value)`
    );
    emitter.emitLine(
      `      __yo_free(closure->data); // Free the capture data`
    );
    emitter.emitLine(`    }`);
    emitter.emitLine(`  }`);
    emitter.emitLine(`}`);
    emitter.emitLine(``);
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
        for (const field of moduleType.fields) {
          // Skip 'Self' and 'This' type declarations (compile-time only)
          if (field.label === "Self") {
            continue;
          }

          // Avoid duplicate methods from different modules
          if (processedMethods.has(field.label)) {
            continue;
          }
          processedMethods.add(field.label);

          const methodName = sanitizeForCIdentifier(field.label);
          emitter.emitLine(
            `  obj->vtable.${methodName} = va_arg(args, void*);`
          );
        }
      }

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
      emitter.emitLine(`  __yo_decr_rc(self->data);`);
      emitter.emitLine(`}`);
      emitter.emitLine(``);
      emitter.emitLine(``);
    }
  }
}
