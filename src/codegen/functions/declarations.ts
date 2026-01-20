import { Expr } from "../../expr";
import { FuncValueId } from "../../function-value";
import {
  FunctionType,
  isFunctionSpecializable,
  isFunctionType,
  isSomeType,
  isStructType,
  typeContainsSomeType,
  typeImplementsFuture,
  typeToString,
} from "../../types";
import {
  CodeGenContext,
  findReturnedAsyncBlock,
  getTypeString,
  isComptFunction,
  isFunctionValueWithOnlyBuiltinYoInlineFunctionCall,
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
  // NOTE: yo_async_register_continuation removed - continuation registration is now inline
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
      isFunctionSpecializable(value.type) ||
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
      functionType.return.type.requiredTraits.length > 0;

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
      let paramTypeStr: string;
      if (isSomeType(param.type) && typeImplementsFuture(param.type)) {
        // For Future types, we must have a resolved concrete type (the state machine)
        if (!param.type.resolvedConcreteType) {
          throw new Error(
            `Impl(Future) parameter '${param.label}' has no resolvedConcreteType. ` +
              `Function: ${cFunctionName}. ` +
              `SomeType ID: ${param.type.id}. ` +
              `This indicates the function wasn't properly specialized - generic Impl(Future) functions should not reach codegen.`
          );
        }
        // Use the concrete state machine pointer type
        paramTypeStr =
          getTypeString(param.type.resolvedConcreteType, context) + "*";
      } else {
        paramTypeStr = getTypeString(param.type, context);
      }

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

    if (
      !specializedFunctionType ||
      !isFunctionSpecializable(functionValue.type)
    ) {
      continue; // Skip non-generic functions
    }

    // Skip if the specialized type still has unresolved type parameters
    // This can happen when type substitution is incomplete or when collecting
    // methods from generic modules that weren't properly specialized
    if (isFunctionSpecializable(specializedFunctionType)) {
      continue;
    }

    // Also skip if any parameter type contains SomeType (generic type parameters)
    // This happens when a function specialization wasn't completed properly
    const hasGenericParams = specializedFunctionType.parameters.some((p) =>
      typeContainsSomeType(p.type)
    );
    const hasGenericReturnType = typeContainsSomeType(
      specializedFunctionType.return.type
    );
    if (hasGenericParams || hasGenericReturnType) {
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
