import {
  BuiltinFunctions,
  BuiltinKeywords,
  Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
} from "../../expr";
import { FunctionValue, FuncValueId } from "../../function-value";
import {
  DynType,
  EnumType,
  FunctionType,
  FutureType,
  isDynType,
  isEnumType,
  isFunctionType,
  isFutureType,
  isStructType,
  isUnitType,
  typeContainsSomeType,
  typeToString,
} from "../../types";
import {
  canRefStructFormCycles,
  extractFnModuleFromType,
  typeImplementsFn,
} from "../../types/utils";
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

  // Generate closure constructor and Ref functions
  generateClosureConstructorFunctions(context);

  // NOTE: Don't generate capture dispose functions here yet!
  // They will be generated after deferred async blocks are processed
  // because closure creation happens during async block generation

  // Generate dyn type constructor and Ref functions
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

    if (closureInfo) {
      const closureType = closureInfo.closureType.isFn;
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
          emitter.emitLine(`${indent}_yo_future->header.ref_count = 1;`);
          emitter.emitLine(`${indent}_yo_future->header.gc_flags = 0;`);
          emitter.emitLine(
            `${indent}_yo_future->header.gc_mark = YO_GC_UNMARKED;`
          );
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

    if (typeImplementsFn(type)) {
      const fnModule = extractFnModuleFromType(type)!;
      const closureType = fnModule.isFn;

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

        const callType = closureType;
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
        const callType = closureType;
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
      const callType = closureType;
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
 * Generate non-atomic reference counting runtime functions.
 * Generate thread-local garbage collection with QuickJS-style trial deletion for cycle collection.
 * See CYCLE_COLLECTION.md for design details.
 */
function generateAtomicGCRuntimeFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Generate simple non-atomic __yo_decr_rc and __yo_incr_rc functions
  emitter.emitLine(`// Non-atomic reference counting functions (thread-local)
void __yo_decr_rc(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  if (header->ref_count == 1) {
    // Last reference - deallocate immediately without decrementing
    GC_DEBUG("Decr: Deallocating ptr=%p (last ref)\\n", ptr);
    __yo_gc_unregister(ptr);
    if (header->dispose_fn) {
      header->dispose_fn(ptr);
    }
    __yo_free(ptr);
  } else {
    // More than one reference - just decrement
    header->ref_count--;
  }
}

void* __yo_incr_rc(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  header->ref_count++;
  return ptr;
}`);

  // Per-thread GC tracking state (simplified - no stop-the-world coordination needed for thread-local)
  emitter.emitLine(`// Per-thread GC tracking state for cycle collection
static _Thread_local yo_thread_gc_state_t* yo_current_thread_gc = NULL;  // Current thread's GC state
static yo_thread_gc_state_t* yo_all_thread_gcs = NULL;  // Global list of all thread GC states (for cleanup)
#if defined(_WIN32)
static YO_THREAD_SYNC_TYPE yo_thread_list_mutex;
#elif defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
static YO_THREAD_SYNC_TYPE yo_thread_list_mutex = YO_THREAD_SYNC_INIT;
#endif
static size_t yo_gc_min_threshold = 256;       // Minimum threshold for adaptive scaling
static size_t yo_gc_collect_threshold = 256;   // Adaptive: starts at min, grows to 2x live objects after each GC

// Thread cleanup infrastructure
#if defined(_WIN32)
static tss_t yo_thread_cleanup_key;
static once_flag yo_thread_cleanup_once = ONCE_FLAG_INIT;

static void yo_thread_cleanup_destructor(void* value) {
  if (value != NULL) {
    __yo_cleanup_thread_gc();
  }
}

static void yo_init_thread_cleanup_key(void) {
  tss_create(&yo_thread_cleanup_key, yo_thread_cleanup_destructor);
}
#elif defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
static pthread_key_t yo_thread_cleanup_key = (pthread_key_t)(-1);
static pthread_once_t yo_thread_cleanup_once = PTHREAD_ONCE_INIT;

static void yo_pthread_cleanup(void* value) {
  if (value != NULL) {
    __yo_cleanup_thread_gc();
  }
}

static void yo_init_thread_cleanup_key(void) {
  pthread_key_create(&yo_thread_cleanup_key, yo_pthread_cleanup);
}
#endif

// Initialize thread-local GC state
static void yo_init_thread_gc() {
  if (yo_current_thread_gc != NULL) return;

#if defined(_WIN32)
  call_once(&yo_thread_cleanup_once, yo_init_thread_cleanup_key);
  tss_set(yo_thread_cleanup_key, (void*)1);
#elif defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
  pthread_once(&yo_thread_cleanup_once, yo_init_thread_cleanup_key);
  if (yo_thread_cleanup_key != (pthread_key_t)(-1)) {
    pthread_setspecific(yo_thread_cleanup_key, (void*)1);
  }
#endif
  
  yo_init_process_cleanup();

  yo_current_thread_gc = (yo_thread_gc_state_t*)__yo_malloc(sizeof(yo_thread_gc_state_t));
  yo_current_thread_gc->tracked_objects = NULL;
  yo_current_thread_gc->tracked_count = 0;
  yo_current_thread_gc->thread_id = yo_thread_self();
  yo_current_thread_gc->alloc_count = 0;

  // Add to global thread list (for cleanup coordination)
  yo_mutex_lock(&yo_thread_list_mutex);
  yo_current_thread_gc->next = yo_all_thread_gcs;
  yo_current_thread_gc->prev = NULL;
  if (yo_all_thread_gcs != NULL) {
    yo_all_thread_gcs->prev = yo_current_thread_gc;
  }
  yo_all_thread_gcs = yo_current_thread_gc;
  yo_mutex_unlock(&yo_thread_list_mutex);
}`);

  // Generate __yo_gc_register and __yo_gc_unregister functions
  emitter.emitLine(`void __yo_gc_register(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  if (yo_current_thread_gc == NULL) {
    yo_init_thread_gc();
  }
  
  GC_DEBUG("GC Register: ptr=%p\\n", ptr);
  
  // Check if already tracked
  if (header->gc_flags & YO_GC_TRACKED) {
    return;
  }
  
  header->gc_flags |= YO_GC_TRACKED;
  header->gc_mark = YO_GC_UNMARKED;
  
  // Add to thread-local tracking list
  header->gc_next = yo_current_thread_gc->tracked_objects;
  header->gc_prev = NULL;
  if (yo_current_thread_gc->tracked_objects != NULL) {
    yo_current_thread_gc->tracked_objects->gc_prev = header;
  }
  yo_current_thread_gc->tracked_objects = header;
  yo_current_thread_gc->tracked_count++;
  
  // Check if we should trigger GC
  if (yo_current_thread_gc->tracked_count >= yo_gc_collect_threshold) {
    __yo_gc_collect();
  }
}

void __yo_gc_unregister(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  if (yo_current_thread_gc == NULL) {
    return;
  }
  
  if (!(header->gc_flags & YO_GC_TRACKED)) {
    return;
  }
  
  // Remove from tracking list (O(1) with doubly-linked list)
  if (header->gc_prev != NULL) {
    header->gc_prev->gc_next = header->gc_next;
  } else {
    yo_current_thread_gc->tracked_objects = header->gc_next;
  }
  
  if (header->gc_next != NULL) {
    header->gc_next->gc_prev = header->gc_prev;
  }

  yo_current_thread_gc->tracked_count--;
  header->gc_flags &= ~YO_GC_TRACKED;
}`);

  // Generate QuickJS-style trial deletion cycle collection
  emitter.emitLine(`// QuickJS-style trial deletion for cycle collection
// Phase 1: Trial deletion - decrement ref counts for internal references
static void yo_gc_trial_delete_visitor(void* ptr) {
  if (ptr == NULL) return;
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  // Only process tracked objects
  if (!(header->gc_flags & YO_GC_TRACKED)) return;
  
  // Trial decrement
  if (header->ref_count > 0) {
    header->ref_count--;
    GC_DEBUG("TrialDelete: ptr=%p, ref_count->%zu\\n", ptr, header->ref_count);
  }
}

// Phase 2: Restore ref counts for live objects
static void yo_gc_restore_visitor(void* ptr) {
  if (ptr == NULL) return;
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  // Only restore for objects that were trial-deleted
  if (header->gc_mark == YO_GC_LIVE) {
    header->ref_count++;
    GC_DEBUG("Restore: ptr=%p, ref_count->%zu\\n", ptr, header->ref_count);
  }
}

void __yo_gc_collect() {
  if (yo_current_thread_gc == NULL) return;
  
  yo_ref_header_t* head = yo_current_thread_gc->tracked_objects;
  if (head == NULL) return;
  
  GC_DEBUG("GC: Starting collection, tracked_count=%zu\\n", yo_current_thread_gc->tracked_count);
  
  size_t collected = 0;
  
  // Phase 1: Mark all as candidates and trial-delete
  yo_ref_header_t* obj = head;
  while (obj != NULL) {
    obj->gc_mark = YO_GC_CANDIDATE;
    obj = obj->gc_next;
  }
  
  // Trial deletion: decrement RC for all internal references
  obj = head;
  while (obj != NULL) {
    if (obj->traverse_fn) {
      obj->traverse_fn(obj, yo_gc_trial_delete_visitor);
    }
    obj = obj->gc_next;
  }
  
  // Phase 2: Identify garbage (RC == 0) and live objects (RC > 0)
  obj = head;
  while (obj != NULL) {
    if (obj->ref_count == 0) {
      obj->gc_mark = YO_GC_GARBAGE;
      GC_DEBUG("GC: Marked as garbage: ptr=%p\\n", obj);
    } else {
      obj->gc_mark = YO_GC_LIVE;
      GC_DEBUG("GC: Marked as live: ptr=%p (ref_count=%zu)\\n", obj, obj->ref_count);
    }
    obj = obj->gc_next;
  }
  
  // Phase 3: Restore ref counts for live objects
  obj = head;
  while (obj != NULL) {
    if (obj->gc_mark == YO_GC_LIVE && obj->traverse_fn) {
      obj->traverse_fn(obj, yo_gc_restore_visitor);
    }
    obj = obj->gc_next;
  }
  
  // Phase 4: Sweep - collect garbage objects
  yo_ref_header_t* current = head;
  yo_ref_header_t* prev = NULL;
  
  while (current != NULL) {
    yo_ref_header_t* next = current->gc_next;
    
    if (current->gc_mark == YO_GC_GARBAGE) {
      GC_DEBUG("GC: Collecting garbage: ptr=%p\\n", current);
      
      // Remove from tracking list
      if (prev == NULL) {
        yo_current_thread_gc->tracked_objects = next;
      } else {
        prev->gc_next = next;
      }
      if (next != NULL) {
        next->gc_prev = prev;
      }
      
      yo_current_thread_gc->tracked_count--;
      collected++;
      
      // Call dispose and free
      if (current->dispose_fn) {
        current->dispose_fn(current);
      }
      __yo_free(current);
      
      current = next;
    } else {
      // Reset mark for next collection
      current->gc_mark = YO_GC_UNMARKED;
      prev = current;
      current = next;
    }
  }
  
  // Adaptive threshold: set to max(min_threshold, 2 * remaining_objects)
  size_t new_threshold = yo_current_thread_gc->tracked_count * 2;
  if (new_threshold < yo_gc_min_threshold) {
    new_threshold = yo_gc_min_threshold;
  }
  yo_gc_collect_threshold = new_threshold;
  
  GC_DEBUG("GC: Collection complete, collected=%zu, remaining=%zu, next_threshold=%zu\\n", collected, yo_current_thread_gc->tracked_count, yo_gc_collect_threshold);
}

size_t __yo_gc_tracked_count() {
  if (yo_current_thread_gc == NULL) return 0;
  return yo_current_thread_gc->tracked_count;
}`);

  // Generate thread cleanup function
  emitter.emitLine(`// Clean up thread-local GC state
void __yo_cleanup_thread_gc() {
  yo_mutex_lock(&yo_thread_list_mutex);
  
  yo_thread_gc_state_t* my_gc_state = yo_current_thread_gc;
  
  if (my_gc_state == NULL) {
    yo_mutex_unlock(&yo_thread_list_mutex);
    return;
  }
  
  GC_DEBUG("CleanupThread: tracked_count=%zu\\n", my_gc_state->tracked_count);
  
  // Force dispose all remaining tracked objects
  yo_ref_header_t* current = my_gc_state->tracked_objects;
  while (current != NULL) {
    yo_ref_header_t* next = current->gc_next;
    
    GC_DEBUG("CleanupThread: Disposing object ptr=%p\\n", current);
    if (current->dispose_fn) {
      current->dispose_fn(current);
    }
    __yo_free(current);
    
    current = next;
  }
  
  // Remove from global list
  if (my_gc_state->prev != NULL) {
    my_gc_state->prev->next = my_gc_state->next;
  } else {
    yo_all_thread_gcs = my_gc_state->next;
  }
  
  if (my_gc_state->next != NULL) {
    my_gc_state->next->prev = my_gc_state->prev;
  }
  
  yo_mutex_unlock(&yo_thread_list_mutex);
  
  __yo_free(my_gc_state);
  yo_current_thread_gc = NULL;
}

// Process cleanup
static void yo_process_cleanup(void) {
  GC_DEBUG("ProcessCleanup: Called\\n");
  
  if (yo_current_thread_gc != NULL) {
    __yo_gc_collect();
    __yo_cleanup_thread_gc();
  }
  
#if defined(_WIN32)
  tss_delete(yo_thread_cleanup_key);
#elif defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
  if (yo_thread_cleanup_key != (pthread_key_t)(-1)) {
    pthread_key_delete(yo_thread_cleanup_key);
  }
#endif
}

static void yo_init_process_cleanup(void) {
  static bool cleanup_initialized = false;
  if (cleanup_initialized) return;
  cleanup_initialized = true;
  
#if defined(_WIN32)
  mtx_init(&yo_thread_list_mutex, mtx_plain);
#endif
  
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
      // Initialize non-atomic RC fields
      emitter.emitLine(
        `  obj->header.ref_count = 1;  // Start with one reference`
      );
      emitter.emitLine(`  obj->header.gc_flags = 0;`);
      emitter.emitLine(`  obj->header.gc_mark = YO_GC_UNMARKED;`);
      emitter.emitLine(`  obj->header.gc_next = NULL;`);
      emitter.emitLine(`  obj->header.gc_prev = NULL;`);

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
 * Generate constructor function implementations for closures and their Ref functions
 */
export function generateClosureConstructorFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Generate closure constructor functions
  for (const typeEntry of Object.values(context.types)) {
    const type = typeEntry.type;
    const cName = typeEntry.cName;

    if (typeImplementsFn(type)) {
      const fnModule = extractFnModuleFromType(type)!;
      const closureType = fnModule.isFn;

      // Skip generic closures that contain SomeType parameters
      if (typeContainsSomeType(type)) {
        continue;
      }

      // Generate closure constructor function
      const constructorName = `__yo_new_${cName}`;

      // For closures, we only generate the __yo_create function that takes void* data
      // We don't generate parameterized constructors since capture types can vary
      const callType = closureType;
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
      emitter.emitLine(`  obj->header.ref_count = 1;`);
      emitter.emitLine(`  obj->header.gc_flags = 0;`);
      emitter.emitLine(`  obj->header.gc_mark = YO_GC_UNMARKED;`);
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
 * Generate constructor function implementations for dyn types and their Ref functions
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
      emitter.emitLine(`  obj->header.ref_count = 1;`);
      emitter.emitLine(`  obj->header.gc_flags = 0;`);
      emitter.emitLine(`  obj->header.gc_mark = YO_GC_UNMARKED;`);
      emitter.emitLine(`  obj->header.gc_next = NULL;`);
      emitter.emitLine(`  obj->header.gc_prev = NULL;`);
      emitter.emitLine(`  obj->header.dispose_fn = dispose_fn;`);
      emitter.emitLine(`  obj->header.traverse_fn = NULL;`);

      emitter.emitLine(`  va_list args;`);
      emitter.emitLine(`  va_start(args, dispose_fn);`);

      // Initialize vtable with function pointers from variadic arguments
      const processedMethods = new Set<string>();
      for (const moduleType of dynType.requiredModules) {
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
