import {
  BuiltinFunctions,
  BuiltinKeywords,
  Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  FuncCallExpr,
} from "../../expr";
import { FunctionValue, FuncValueId } from "../../function-value";
import {
  EnumType,
  FunctionType,
  isBoxedType,
  isEnumType,
  isFnModuleType,
  isFunctionSpecializable,
  isFunctionType,
  isFutureModuleType,
  isPtrType,
  isSomeType,
  isStructType,
  isUnitType,
  isVoidType,
  typeContainsSomeType,
  typeToString,
} from "../../types";
import { canTypeFormGcCycle, typeImplementsFuture } from "../../types/utils";
import { isTempVariableName } from "../../utils";
import { isFunctionValue } from "../../value";
import { generateAsyncRuntime } from "../async/runtime";
import {
  generateDeferredDropExpressions,
  generateDeferredDupExpressions,
  generateExpr,
  generateReturnStatement,
} from "../expressions";
import { generateParallelismRuntime } from "../parallelism/runtime";
import { generateIsoTypeDeclarations } from "../types";
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

    // Skip functions with SomeType in parameters (truly generic)
    // Or with SomeType in return type that isn't an Impl(Module) or Impl(Future)
    // Use specializedType if available, otherwise use type
    const functionType = value.specializedType ?? value.type;
    const hasGenericParams =
      functionType.parameters.some((p) => typeContainsSomeType(p.type)) ||
      functionType.forallParameters.length > 0;
    const hasGenericReturnType = typeContainsSomeType(functionType.return.type);

    // Allow functions returning plain Impl(Module) existential types (SomeType at top level)
    // These are not truly generic - the concrete type is determined from the function body
    const returnsPlainImpl =
      isSomeType(functionType.return.type) &&
      functionType.return.type.requiredModules.length > 0;

    if (hasGenericParams || (hasGenericReturnType && !returnsPlainImpl)) {
      continue;
    }

    generateFunctionDeclaration(
      functionType,
      cName,
      false,
      context,
      value.body
    );
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
  context: CodeGenContext,
  overrideReturnType?: string
): string {
  // For non-main functions, generate based on function type
  const returnTypeStr =
    overrideReturnType || getTypeString(functionType.return.type, context);

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
    const paramName = sanitizeForCIdentifier(param.label || `param${index}`);

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
 * Find async blocks in an expression that might be returned.
 * Returns the first async block found in the function body.
 * For functions returning Impl(Future(T)), any async block in the body
 * could potentially be the return value, so we return the first one we find.
 */
function findReturnedAsyncBlock(expr: Expr | undefined): Expr | undefined {
  if (!expr) return undefined;

  // If this is an async block itself, return it
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.async)) {
    return expr;
  }

  // Recursively search in function call arguments
  if (exprIsFunctionCall(expr)) {
    const funcCallExpr = expr as FuncCallExpr;
    for (const arg of funcCallExpr.args) {
      const found = findReturnedAsyncBlock(arg);
      if (found) return found;
    }
  }

  return undefined;
}

/**
 * Generate a function declaration (prototype)
 */
export function generateFunctionDeclaration(
  functionType: FunctionType,
  cFunctionName: string,
  isExtern: boolean,
  context: CodeGenContext,
  functionBody?: Expr
): void {
  // For functions returning Impl(Future(T)), find the async block that produces the return value
  // and use its state machine struct name as the return type
  let overrideReturnType: string | undefined;

  if (functionBody && typeImplementsFuture(functionType.return.type)) {
    const asyncBlock = findReturnedAsyncBlock(functionBody);
    if (asyncBlock?.$?.asyncStateMachineStructName) {
      overrideReturnType = `${asyncBlock.$.asyncStateMachineStructName}*`;
    }
  }

  // For functions returning Impl(Module) (SomeType), use the concrete type from the body
  // This is for static dispatch - the body's actual return type is the function's return type
  if (
    functionBody &&
    isSomeType(functionType.return.type) &&
    !typeImplementsFuture(functionType.return.type)
  ) {
    // The body should have the concrete return type
    if (functionBody.$?.type) {
      overrideReturnType = getTypeString(functionBody.$.type, context);
    }
  }

  // For specialized functions where the body's return type is more specific than the signature's
  // (e.g., when generic type parameters have been substituted but the signature still uses generic types)
  // Use the body's concrete return type
  if (
    !overrideReturnType &&
    functionBody &&
    functionBody.$?.type &&
    !typeImplementsFuture(functionType.return.type)
  ) {
    const signatureReturnTypeCName = getTypeString(
      functionType.return.type,
      context
    );
    const bodyReturnTypeCName = getTypeString(functionBody.$.type, context);
    if (signatureReturnTypeCName !== bodyReturnTypeCName) {
      overrideReturnType = bodyReturnTypeCName;
    }
  }

  const functionPrototype = overrideReturnType
    ? generateFunctionPrototype(
        functionType,
        cFunctionName,
        context,
        overrideReturnType
      )
    : generateFunctionPrototype(functionType, cFunctionName, context);

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

  // Generate parallelism runtime (Worker, Channel for multi-threaded execution)
  generateParallelismRuntime(context.emitter, context.debugParallelism);

  // Generate thread-safe GC runtime functions
  generateAtomicGCRuntimeFunctions(context);

  // Generate object constructor functions
  generateRefStructConstructorFunctions(context);

  // Generate closure constructor and Gc functions
  generateClosureConstructorFunctions(context);

  // NOTE: Don't generate capture dispose functions here yet!
  // They will be generated after deferred async blocks are processed
  // because closure creation happens during async block generation

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

    // Skip functions with SomeType in parameters (truly generic)
    // Or with SomeType in return type that isn't an Impl(Module) or Impl(Future)
    // Use specializedType if available, otherwise use type
    const functionType = value.specializedType ?? value.type;
    const hasGenericParams =
      functionType.parameters.some((p) => typeContainsSomeType(p.type)) ||
      functionType.forallParameters.length > 0;
    const hasGenericReturnType = typeContainsSomeType(functionType.return.type);

    // Allow functions returning plain Impl(Module) existential types (SomeType at top level)
    // These are not truly generic - the concrete type is determined from the function body
    const returnsPlainImpl =
      isSomeType(functionType.return.type) &&
      functionType.return.type.requiredModules.length > 0;

    if (hasGenericParams || (hasGenericReturnType && !returnsPlainImpl)) {
      continue;
    }

    // Generate the function body
    generateFunction(value, cName, context);
  }

  // Generate Iso type declarations if any were collected during expression generation
  generateIsoTypeDeclarations(context);

  // NOTE: Main wrapper is generated after deferred async blocks
  // since async main returns a Future type that's defined in the deferred blocks
}

/**
 * Generate dup/drop functions for dyn types
 */
export function generateDynDupDrop(context: FunctionGenerationContext): void {
  const emitter = context.emitter;

  if (context.dynImpls.size === 0) {
    return;
  }

  emitter.emitLine("");
  emitter.emitLine("// === Dyn Dup/Drop Functions ===");
  emitter.emitLine("");

  const generatedTypes = new Set<string>();

  for (const [, impl] of context.dynImpls) {
    const dynTypeCName =
      context.types[impl.dynType.id]?.cName || `yo_dyn_${impl.dynType.id}`;

    if (generatedTypes.has(dynTypeCName)) {
      continue;
    }
    generatedTypes.add(dynTypeCName);

    // Dup
    emitter.emitLine(
      `${dynTypeCName} __yo_dup_${dynTypeCName}(${dynTypeCName} dyn) {`
    );
    emitter.emitLine(`  if (dyn.data) {`);
    emitter.emitLine(`    __yo_incr_rc(dyn.data);`);
    emitter.emitLine(`  }`);
    emitter.emitLine(`  return dyn;`);
    emitter.emitLine(`}`);
    emitter.emitLine("");

    // Drop
    emitter.emitLine(`void __yo_drop_${dynTypeCName}(${dynTypeCName} dyn) {`);
    emitter.emitLine(`  if (dyn.data) {`);
    emitter.emitLine(`    __yo_decr_rc(dyn.data);`);
    emitter.emitLine(`  }`);
    emitter.emitLine(`}`);
    emitter.emitLine("");
  }
}

/**
 * Generate a main() wrapper that calls yo_user_main() and then __yo_async_wait_all()
 * This ensures all async tasks complete before the program exits
 * REQUIREMENT: main function must return unit (void)
 */
export function generateMainWrapper(context: FunctionGenerationContext): void {
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

  // REQUIREMENT: main must return unit or Impl(Future(unit))
  const returnType = mainFunctionValue.type.return.type;
  const returnsUnit = isUnitType(returnType);

  if (!returnsUnit) {
    throw new Error(
      `main function must return unit , but it returns ${typeToString(returnType)}. ` +
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

  // For functions returning Impl(Future(T)), find the async block that produces the return value
  // and use its state machine struct name as the return type
  let overrideReturnType: string | undefined;

  if (functionValue.body && typeImplementsFuture(functionType.return.type)) {
    const asyncBlock = findReturnedAsyncBlock(functionValue.body);
    if (asyncBlock?.$?.asyncStateMachineStructName) {
      overrideReturnType = `${asyncBlock.$.asyncStateMachineStructName}*`;
    }
  }

  // For functions returning Impl(Module) (SomeType), use the concrete type from the body
  // This is for static dispatch - the body's actual return type is the function's return type
  if (
    functionValue.body &&
    isSomeType(functionType.return.type) &&
    !typeImplementsFuture(functionType.return.type)
  ) {
    // The body should have the concrete return type
    if (functionValue.body.$?.type) {
      overrideReturnType = getTypeString(functionValue.body.$.type, context);
    }
  }

  // For specialized functions where the body's return type is more specific than the signature's
  // (e.g., when generic type parameters have been substituted but the signature still uses generic types)
  // Use the body's concrete return type
  if (
    !overrideReturnType &&
    functionValue.body &&
    functionValue.body.$?.type &&
    functionValue.specializedType
  ) {
    const signatureReturnTypeCName = getTypeString(
      functionType.return.type,
      context
    );
    const bodyReturnTypeCName = getTypeString(
      functionValue.body.$.type,
      context
    );
    if (signatureReturnTypeCName !== bodyReturnTypeCName) {
      overrideReturnType = bodyReturnTypeCName;
    }
  }

  // Regular function generation (async blocks within the function handle their own state machines)
  const functionPrototype = overrideReturnType
    ? generateFunctionPrototype(
        functionType,
        cFunctionName,
        context,
        overrideReturnType
      )
    : generateFunctionPrototype(functionType, cFunctionName, context);

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

      (context as FunctionGenerationContext).currentClosureType =
        closureType.callType;

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
        (!arg.$ || !isTempVariableName(arg.$.env.modulePath, argCode)) // Prevent emit meaningless line like `_yof4ca7ba3_temp_127;`
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
      const isAsyncFunction = isFutureModuleType(functionType.return.type);

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
        const isAlreadyFuture =
          lastExprType && isFutureModuleType(lastExprType);

        if (isAsyncBlock || isAlreadyFuture) {
          // Last expression is an async block or already returns a Future - return it directly
          const resultCode = generateExpr(lastExpr, indent, context);
          emitter.emitLine(`${indent}return ${resultCode};`);
        } else {
          // FIXME: OUTDATED
          /// // For async functions, wrap the return value in a Future
          /// const futureType = functionType.return.type as FutureType;
          /// const childType = futureType.childType;
          /// const isUnitResult = isUnitType(childType);
          ///
          /// // Get the Future type C name
          /// const futureTypeCName = context.types[futureType.id]?.cName;
          /// if (!futureTypeCName) {
          ///   emitter.emitLine(
          ///     `${indent}// Error: Future type not found in context`
          ///   );
          ///   return;
          /// }
          ///
          /// // Generate the result expression (if not unit)
          /// if (!isUnitResult) {
          ///   const resultCode = generateExpr(lastExpr, indent, context);
          ///   emitter.emitLine(
          ///     `${indent}${getTypeString(childType, context)} _yo_async_result = ${resultCode};`
          ///   );
          /// } else {
          ///   // For unit, just execute the expression as a statement
          ///   const exprCode = generateExpr(lastExpr, indent, context);
          ///   if (exprCode) {
          ///     emitter.emitLine(`${indent}${exprCode};`);
          ///   }
          /// }
          ///
          /// // Allocate and initialize the Future
          /// emitter.emitLine(
          ///   `${indent}${futureTypeCName}* _yo_future = (${futureTypeCName}*)__yo_malloc(sizeof(${futureTypeCName}));`
          /// );
          /// emitter.emitLine(`${indent}_yo_future->header.ref_count = 1;`);
          /// emitter.emitLine(`${indent}_yo_future->header.gc_flags = 0;`);
          /// emitter.emitLine(
          ///   `${indent}_yo_future->header.gc_mark = YO_GC_UNMARKED;`
          /// );
          /// emitter.emitLine(`${indent}_yo_future->header.gc_next = NULL;`);
          /// emitter.emitLine(`${indent}_yo_future->header.gc_prev = NULL;`);
          /// emitter.emitLine(
          ///   `${indent}_yo_future->header.dispose_fn = yo_future_dispose;`
          /// );
          /// emitter.emitLine(`${indent}_yo_future->header.traverse_fn = NULL;`);
          /// emitter.emitLine(
          ///   `${indent}atomic_store_explicit(&_yo_future->state, YO_FUTURE_COMPLETED, memory_order_relaxed);`
          /// );
          /// emitter.emitLine(
          ///   `${indent}_yo_future->state_machine = NULL;  // No state machine for immediate completion`
          /// );
          ///
          /// if (!isUnitResult) {
          ///   emitter.emitLine(`${indent}_yo_future->result = _yo_async_result;`);
          /// }
          ///
          /// emitter.emitLine(`${indent}return _yo_future;`);
        }
      } else if (lastExpr && isUnitType(functionType.return.type)) {
        // For unit/void functions, generate the expression as a statement
        const exprCode = generateExpr(lastExpr, indent, context);
        if (exprCode) {
          emitter.emitLine(`${indent}${exprCode};`);
        }
        // Generate deferred drop expressions after the last statement
        generateDeferredDropExpressions(expr, indent, context);
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
          // Generate deferred dup expressions for the last expression (e.g., field access that needs duping)
          if (
            lastExpr.$?.deferredDupExpressions &&
            lastExpr.$.deferredDupExpressions.length > 0
          ) {
            // First, generate the expression and store it in its temp variable
            if (lastExpr.$?.variableName) {
              const exprType = getTypeString(lastExpr.$.type!, context);
              const exprTempVar = sanitizeForCIdentifier(
                lastExpr.$.variableName
              );
              const rawCode = generateExpr(lastExpr, indent, context);
              if (exprTempVar !== rawCode) {
                emitter.emitLine(
                  `${indent}${exprType} ${exprTempVar} = ${rawCode};`
                );
              }
            }

            // Then generate the deferred dup expressions
            generateDeferredDupExpressions(lastExpr, indent, context);

            // Use the duped value's variable name for the return
            const dupExpr = lastExpr.$.deferredDupExpressions[0]!;
            if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
              const dupedValue = sanitizeForCIdentifier(dupExpr.$.variableName);
              // Then generate deferred drop expressions for the begin block before the return
              generateDeferredDropExpressions(expr, indent, context);
              // Finally, emit the return statement
              emitter.emitLine(`${indent}return ${dupedValue};`);
              return;
            }
          }

          // For other functions, generate the expression first
          const exprCode = generateExpr(lastExpr, indent, context);

          // Then generate deferred drop expressions before the return
          generateDeferredDropExpressions(expr, indent, context);

          // Finally, emit the return statement
          if (exprCode) {
            emitter.emitLine(`${indent}return ${exprCode};`);
          }
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

    // Skip if the specialized type still has unresolved type parameters
    // This can happen when type substitution is incomplete or when collecting
    // methods from generic modules that weren't properly specialized
    if (isFunctionSpecializable(specializedFunctionType)) {
      continue;
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

    // Skip if the specialized type still has unresolved type parameters
    if (isFunctionSpecializable(functionValue.specializedType)) {
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
    `void __yo_gc_init_thread(); // Initialize thread-local GC state (for worker threads)`
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
  // No-op: Impl(Fn(...)) closures use concrete capture structs + direct calls.
  // Dyn(Fn(...)) uses dyn constructors (generated elsewhere).
  void context;
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

  // Atomic reference counting functions for Iso types (thread-safe)
  emitter.emitLine(`
// Atomic reference counting functions for Iso types (thread-safe)
void* __yo_incr_rc_atomic(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  atomic_fetch_add(((_Atomic size_t*)&header->ref_count), 1);
  return ptr;
}

void __yo_decr_rc_atomic(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  size_t old_count = atomic_fetch_sub(((_Atomic size_t*)&header->ref_count), 1);
  
  if (old_count == 1) {
    // Last reference - deallocate
    // Note: No GC tracking needed for Iso types (they don't participate in cycles)
    if (header->dispose_fn) {
      header->dispose_fn(ptr);
    }
    __yo_free(ptr);
  }
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
}

// Public function to initialize thread-local GC (for worker threads)
void __yo_gc_init_thread() {
  yo_init_thread_gc();
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

      // Set dispose function pointer to ___dispose, which handles both user cleanup and field dropping.
      // ___dispose will call user's dispose() if it exists, then drop all GC-containing fields.
      const disposeInternalFunctionElement = type.module.fields.find(
        (field) =>
          field.label === BuiltinFunctions.___dispose[0]! &&
          field.assignedValue &&
          isFunctionValue(field.assignedValue)
      );

      if (
        disposeInternalFunctionElement &&
        isFunctionValue(disposeInternalFunctionElement.assignedValue)
      ) {
        const disposeFunctionValue =
          disposeInternalFunctionElement.assignedValue;
        const disposeFunctionCName =
          context.functions[disposeFunctionValue.funcId]?.cName ||
          disposeFunctionValue.funcId;
        emitter.emitLine(
          `  obj->header.dispose_fn = (void(*)(void*))${disposeFunctionCName};`
        );
      } else {
        // Fallback to NULL if no ___dispose function found
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
      if (canTypeFormGcCycle(type)) {
        emitter.emitLine(`  __yo_gc_register(obj);`);
      }

      emitter.emitLine(`  return obj;`);
      emitter.emitLine(`}`);
      emitter.emitLine(``);
    }
  }
}

/**
 * Generate constructor function implementations for closures and their Gc functions
 */
export function generateClosureConstructorFunctions(
  context: FunctionGenerationContext
): void {
  // No-op: Impl(Fn(...)) closures use concrete capture structs + direct calls.
  // Dyn(Fn(...)) uses dyn constructors (generated elsewhere).
  void context;
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

    // Generate the dispose function for Impl closures (value types)
    // For Impl closures, captures are stack-allocated, so we only call drop, NOT free
    // Signature: void dispose(void* closure_ptr)
    // This function receives the CLOSURE pointer (not capture pointer),
    // extracts the capture data, and calls drop (no free needed for stack-allocated capture)
    emitter.emitLine(
      `void ${disposeFunctionName}(void* closure_ptr) { // Dispose for ${closureCName} with ${captureCName} (Impl closure - value type)`
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
      `      // Note: capture data is stack-allocated for Impl closures, no __yo_free needed`
    );
    emitter.emitLine(`    }`);
    emitter.emitLine(`  }`);
    emitter.emitLine(`}`);
    emitter.emitLine(``);
  }
}

/**
 * Generate box constructor and dispose functions for dyn implementations
 */
export function generateDynBoxFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  if (context.dynImpls.size === 0) {
    return; // No dyn() calls to generate boxes for
  }

  emitter.emitLine("");
  emitter.emitLine("// === Dyn Box Functions ===");
  emitter.emitLine("// Constructor and dispose functions for dyn boxes");
  emitter.emitLine("");

  // Track generated box functions to avoid duplicates
  const generatedBoxFunctions = new Set<string>();

  for (const [, impl] of context.dynImpls) {
    const concreteTypeCName =
      context.types[impl.concreteType.id]?.cName ||
      `unknown_${impl.concreteType.id}`;
    const boxTypeName = `yo_dyn_box_${concreteTypeCName}`;

    // Skip if already generated
    if (generatedBoxFunctions.has(boxTypeName)) {
      continue;
    }
    generatedBoxFunctions.add(boxTypeName);

    const valueTypeStr = getTypeString(impl.concreteType, context);

    // Generate box constructor
    emitter.emitLine(
      `${boxTypeName}* __yo_new_${boxTypeName}(${valueTypeStr} value) {`
    );
    emitter.emitLine(
      `  ${boxTypeName}* box = (${boxTypeName}*)__yo_malloc(sizeof(${boxTypeName}));`
    );
    emitter.emitLine(`  box->header.ref_count = 1;`);
    emitter.emitLine(`  box->header.gc_flags = 0;`);
    emitter.emitLine(`  box->header.gc_mark = YO_GC_UNMARKED;`);
    emitter.emitLine(`  box->header.gc_next = NULL;`);
    emitter.emitLine(`  box->header.gc_prev = NULL;`);
    emitter.emitLine(`  box->header.dispose_fn = __yo_dispose_${boxTypeName};`);
    emitter.emitLine(
      `  box->header.traverse_fn = NULL; // TODO: Set if value contains GC types`
    );
    emitter.emitLine(`  box->value = value;`);
    emitter.emitLine(`  return box;`);
    emitter.emitLine(`}`);
    emitter.emitLine("");

    // Generate box dispose
    emitter.emitLine(`void __yo_dispose_${boxTypeName}(void* ptr) {`);
    emitter.emitLine(`  ${boxTypeName}* box = (${boxTypeName}*)ptr;`);

    // Drop box->value if it has a drop function
    // For SomeType, we need to use the resolved concrete type
    const concreteType =
      isSomeType(impl.concreteType) && impl.concreteType.resolvedConcreteType
        ? impl.concreteType.resolvedConcreteType
        : impl.concreteType;

    const dropFn = concreteType.module?.fields.find(
      (field) => field.label === BuiltinFunctions.___drop[0]
    );
    if (
      dropFn &&
      dropFn.assignedValue &&
      isFunctionValue(dropFn.assignedValue)
    ) {
      const dropFnCName = context.functions[dropFn.assignedValue.funcId]?.cName;
      if (dropFnCName) {
        emitter.emitLine(`  ${dropFnCName}(box->value);`);
      }
    }

    emitter.emitLine(`}`);
    emitter.emitLine("");
  }
}

/**
 * Generate wrapper functions for dyn method dispatch
 */
export function generateDynWrapperFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  if (context.dynImpls.size === 0) {
    return;
  }

  emitter.emitDeclarationLine("");
  emitter.emitDeclarationLine("// === Dyn Wrapper Functions ===");
  emitter.emitDeclarationLine(
    "// Wrappers that unwrap boxed values and call impl methods"
  );
  emitter.emitDeclarationLine("");

  for (const [implKey, impl] of context.dynImpls) {
    const dataType = impl.dataType;
    const reservedDynMethodLabels = new Set<string>([
      BuiltinFunctions.___dup[0]!,
      BuiltinFunctions.___drop[0]!,
      BuiltinFunctions.___dispose[0]!,
      BuiltinFunctions.dispose[0]!,
    ]);

    // Special-case Dyn(Fn(...)): the vtable uses a synthetic `call` slot derived from FnModuleType.isFn,
    // not from module fields. For boxed closures, we can dispatch directly to the embedded call pointer.
    for (const requiredModule of impl.dynType.requiredModules) {
      if (!isFnModuleType(requiredModule)) {
        continue;
      }

      const callType = requiredModule.isFn.callType;
      const returnTypeStr = getTypeString(callType.return.type, context);
      const wrapperName = `yo_wrap_${implKey}_call`;

      const params: string[] = ["void* self_ptr"];
      for (let i = 0; i < callType.parameters.length; i++) {
        const param = callType.parameters[i]!;
        const paramTypeStr = getTypeString(param.type, context);
        params.push(`${paramTypeStr} arg${i + 1}`);
      }

      emitter.emitDeclarationLine(
        `static ${returnTypeStr} ${wrapperName}(${params.join(", ")}) {`
      );

      if (isBoxedType(dataType)) {
        const boxedCName =
          context.types[dataType.id]?.cName || `unknown_${dataType.id}`;
        const fieldName = sanitizeForCIdentifier(dataType.fields[0]!.label);
        emitter.emitDeclarationLine(
          `  ${boxedCName}* box = (${boxedCName}*)self_ptr;`
        );

        // `Box(Impl(Fn...))` stores the capture struct by value.
        // Dispatch by calling the compiled closure function with `&box->value` as the closure context.
        // (Legacy representation: if the boxed value is a module fat pointer with `.data`/`.call`, fall back.)
        const boxedValueType = dataType.fields[0]!.type;
        const captureType =
          isSomeType(boxedValueType) && boxedValueType.resolvedConcreteType
            ? boxedValueType.resolvedConcreteType
            : boxedValueType;
        const closureInfo = context.implClosureCallMap.get(captureType.id);
        const discoveredClosureCName = (() => {
          if (closureInfo) {
            return closureInfo.functionCName;
          }

          // Fallback discovery: find a generated closure impl function whose capture type matches.
          // This avoids relying on FnModuleType/FunctionType IDs being stable across instantiations
          // (e.g. when `test` blocks add extra evaluation paths).
          for (const [, entry] of Object.entries(context.functions)) {
            const fv = entry.value;
            const ci = fv.closureInfo;
            if (ci?.captureType?.id === captureType.id) {
              return entry.cName;
            }
          }
          return undefined;
        })();

        const callArgs: string[] = [];
        if (discoveredClosureCName) {
          callArgs.push(`(void*)&box->${fieldName}`);
          for (let i = 0; i < callType.parameters.length; i++) {
            callArgs.push(`arg${i + 1}`);
          }

          if (isVoidType(callType.return.type)) {
            emitter.emitDeclarationLine(
              `  ${discoveredClosureCName}(${callArgs.join(", ")});`
            );
          } else {
            emitter.emitDeclarationLine(
              `  return ${discoveredClosureCName}(${callArgs.join(", ")});`
            );
          }
        } else {
          // Fallback for older closure/module representations
          callArgs.push(`box->${fieldName}.data`);
          for (let i = 0; i < callType.parameters.length; i++) {
            callArgs.push(`arg${i + 1}`);
          }

          if (isVoidType(callType.return.type)) {
            emitter.emitDeclarationLine(
              `  box->${fieldName}.call(${callArgs.join(", ")});`
            );
          } else {
            emitter.emitDeclarationLine(
              `  return box->${fieldName}.call(${callArgs.join(", ")});`
            );
          }
        }
      } else {
        // Non-box Dyn(Fn(...)) is not expected for anonymous closures; keep a clear failure mode.
        // (Dyn design requires `.data` to always point at an object type; closures are value types -> must be boxed.)
        emitter.emitDeclarationLine(
          `  (void)self_ptr; /* Dyn(Fn): expected Box(...) data */`
        );
        for (let i = 0; i < callType.parameters.length; i++) {
          emitter.emitDeclarationLine(`  (void)arg${i + 1};`);
        }
        if (isVoidType(callType.return.type)) {
          emitter.emitDeclarationLine(`  return;`);
        } else {
          emitter.emitDeclarationLine(
            `  ${returnTypeStr} zero = (${returnTypeStr})0;`
          );
          emitter.emitDeclarationLine(`  return zero;`);
        }
      }

      emitter.emitDeclarationLine(`}`);
      emitter.emitDeclarationLine("");
    }

    // Regular dyn method wrappers (non-Fn modules)
    const moduleType = impl.moduleValue.type;
    const moduleFields = moduleType.fields;

    for (let i = 0; i < moduleFields.length; i++) {
      const field = moduleFields[i]!;

      // Skip 'Self' type declarations as they're not methods
      if (field.label === "Self") {
        continue;
      }

      // Skip reserved ARC/GC hooks; Dyn dup/drop are generated separately.
      if (reservedDynMethodLabels.has(field.label)) {
        continue;
      }

      const fieldValue = impl.moduleValue.fields[i];

      if (!fieldValue || !isFunctionValue(fieldValue)) {
        emitter.emitDeclarationLine(
          `/* Warning: Module field ${field.label} is not a function value */`
        );
        continue;
      }

      const funcType = field.type;
      if (!isFunctionType(funcType)) {
        emitter.emitDeclarationLine(
          `/* Warning: Module field ${field.label} is not a function type */`
        );
        continue;
      }

      // Get the impl function name
      const implFuncId = fieldValue.funcId;
      const implFuncCName = context.functions[implFuncId]?.cName;
      if (!implFuncCName) {
        emitter.emitDeclarationLine(
          `/* Warning: Impl function for ${field.label} not found */`
        );
        continue;
      }

      // Generate wrapper function
      const wrapperName = `yo_wrap_${implKey}_${field.label}`;

      // Build parameter list
      const returnTypeStr = getTypeString(funcType.return.type, context);
      const params = ["void* self_ptr"];
      for (let j = 1; j < funcType.parameters.length; j++) {
        const param = funcType.parameters[j]!;
        const paramTypeStr = getTypeString(param.type, context);
        params.push(`${paramTypeStr} arg${j}`);
      }

      emitter.emitDeclarationLine(
        `static ${returnTypeStr} ${wrapperName}(${params.join(", ")}) {`
      );

      // Unwrap the boxed value and prepare first argument
      // The first parameter of the impl function determines what we pass
      const implFirstParamType = funcType.parameters[0]?.type;

      let firstArg: string;

      if (isBoxedType(dataType)) {
        // Dyn wraps Box(T) from the prelude.
        const boxedCName =
          context.types[dataType.id]?.cName || `unknown_${dataType.id}`;
        const fieldName = sanitizeForCIdentifier(dataType.fields[0]!.label);
        emitter.emitDeclarationLine(
          `  ${boxedCName}* box = (${boxedCName}*)self_ptr;`
        );

        // If the impl expects a borrow, pass pointer to the field inside Box.
        if (implFirstParamType && isPtrType(implFirstParamType)) {
          firstArg = `&box->${fieldName}`;
        } else {
          firstArg = `box->${fieldName}`;
        }
      } else {
        // Dyn wraps a normal object type (already a pointer in C).
        const concreteTypeStr = getTypeString(impl.concreteType, context);
        emitter.emitDeclarationLine(
          `  ${concreteTypeStr} concrete_value = (${concreteTypeStr})self_ptr;`
        );

        // If the impl expects a pointer to the object type, take the address
        if (implFirstParamType && isPtrType(implFirstParamType)) {
          firstArg = `&concrete_value`;
        } else {
          firstArg = `concrete_value`;
        }
      }

      // Build argument list for impl call
      const args = [firstArg];
      for (let j = 1; j < funcType.parameters.length; j++) {
        args.push(`arg${j}`);
      }

      // Call the impl function
      if (isVoidType(funcType.return.type)) {
        emitter.emitDeclarationLine(`  ${implFuncCName}(${args.join(", ")});`);
      } else {
        emitter.emitDeclarationLine(
          `  return ${implFuncCName}(${args.join(", ")});`
        );
      }

      emitter.emitDeclarationLine(`}`);
      emitter.emitDeclarationLine("");
    }
  }
}

/**
 * Generate static vtables for dyn implementations
 */
export function generateDynVtables(context: FunctionGenerationContext): void {
  const emitter = context.emitter;

  if (context.dynImpls.size === 0) {
    return; // No dyn() calls to generate vtables for
  }

  emitter.emitDeclarationLine("");
  emitter.emitDeclarationLine("// === Dyn Static Vtables ===");
  emitter.emitDeclarationLine("// Static vtables for dynamic dispatch");
  emitter.emitDeclarationLine("");

  for (const [implKey, impl] of context.dynImpls) {
    const dynTypeCName =
      context.types[impl.dynType.id]?.cName || `yo_dyn_${impl.dynType.id}`;
    const concreteTypeCName =
      context.types[impl.concreteType.id]?.cName ||
      `unknown_${impl.concreteType.id}`;
    const vtableName = `yo_vtable_${implKey}`;
    const vtableTypeName = `${dynTypeCName}_vtable`;

    emitter.emitDeclarationLine(
      `// Vtable for impl(${concreteTypeCName}, ${impl.dynType.requiredModules.map((m) => m.typeName || "?").join(" + ")})`
    );
    emitter.emitDeclarationLine(
      `static const ${vtableTypeName} ${vtableName} = {`
    );

    // Initialize vtable slots in the exact same way the vtable type is generated in generateDynDeclaration.
    const processedMethods = new Set<string>();
    const reservedDynMethodLabels = new Set<string>([
      BuiltinFunctions.___dup[0]!,
      BuiltinFunctions.___drop[0]!,
      BuiltinFunctions.___dispose[0]!,
      BuiltinFunctions.dispose[0]!,
    ]);

    for (const moduleType of impl.dynType.requiredModules) {
      if (isFnModuleType(moduleType)) {
        // Fn dyn has a synthetic `call` slot
        const wrapperName = `yo_wrap_${implKey}_call`;
        emitter.emitDeclarationLine(`  .call = ${wrapperName},`);
        processedMethods.add("call");
        continue;
      }

      for (const field of moduleType.fields) {
        if (field.label === "Self") {
          continue;
        }

        if (reservedDynMethodLabels.has(field.label)) {
          continue;
        }

        if (processedMethods.has(field.label)) {
          continue;
        }
        processedMethods.add(field.label);

        if (isFunctionType(field.type)) {
          const functionType = field.type as FunctionType;
          if (functionType.parameters.length > 0) {
            const firstParam = functionType.parameters[0];
            if (firstParam && firstParam.label === "self") {
              const wrapperName = `yo_wrap_${implKey}_${field.label}`;
              emitter.emitDeclarationLine(
                `  .${sanitizeForCIdentifier(field.label)} = ${wrapperName},`
              );
            }
          }
        }
      }
    }

    emitter.emitDeclarationLine(`};`);
    emitter.emitDeclarationLine("");
  }
}
