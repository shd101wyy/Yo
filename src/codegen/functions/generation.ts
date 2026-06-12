import { type Environment, getVariablesFromEnv } from "../../env";
import { isIoAsyncCall } from "../../evaluator/async/await-analysis";
import {
  typeImplementsFn,
  typeImplementsFuture,
} from "../../evaluator/trait-checking";
import { findMatchingGenericImpl } from "../../evaluator/values/impl";
import {
  BuiltinFunctions,
  BuiltinKeywords,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  type FnCallExpr,
  hasAnyControlFlow,
} from "../../expr";
import { type FunctionValue } from "../../function-value";
import { areTypesCompatible } from "../../types/compatibility";
import type {
  EnumType,
  FunctionType,
  TraitType,
  Type,
} from "../../types/definitions";
import { getTraitTypeFromEnv } from "../../types/env-lookup";
import {
  isEnumType,
  isFunctionTypeGeneric,
  isFunctionTypeHardGeneric,
  isSomeType,
  isStructType,
  isUnitType,
} from "../../types/guards";
import {
  canTypeFormRcCycle,
  typeContainsSomeType,
  typeContainsSomeTypeForCodegenParam,
  typeToString,
} from "../../types/utils";
import { isTargetWindows, isTargetPosix } from "../../target";
import { isTempVariableName } from "../../utils";
import { isFunctionValue, isTraitValue, type TraitValue } from "../../value";
import { generateAsyncRuntime } from "../async/runtime";
import { generateSysRuntime } from "../async/runtime-io-common";
import {
  generateDeferredDropExpressions,
  generateDeferredDupExpressions,
} from "../exprs/drop-dup";
import { registerImplClosureCallMappings } from "../exprs/closures";
import { generateExpr } from "../exprs/expr";
import { generateImplicitReturnStatement } from "../exprs/return";
import { generateParallelismRuntime } from "../parallelism/runtime";
import { generateIsoTypeDeclarations } from "../types/generation";
import {
  canOptimizeAsNullablePointer,
  canOptimizeAsSimpleEnum,
  type CodeGenContext,
  findReturnedAsyncBlock,
  getEnumVariantCName,
  getDeferredDropTargetAtomName,
  getRuntimeStructFields,
  getTypeString,
  getVariableNameForCodegen,
  isComptimeFunction,
  isFunctionValueWithOnlyBuiltinYoInlineFunctionCall,
  sanitizeForCIdentifier,
} from "../utils";
import type { FunctionGenerationContext } from "./context";
import {
  type EvidenceParameter,
  generateFunctionPrototype,
  getEvidenceParameters,
} from "./declarations";

/**
 * Find the Dispose trait value attached to a type, if any.
 * Uses trait identity (not just method name) to match Dispose.
 * Also checks generic impl registry for forall impls like:
 *   impl(forall(T : Type), ArrayList(T), Dispose(...))
 */
function findDisposeTraitValue(
  type: Type,
  env: Environment
): TraitValue | undefined {
  const disposeTraitType = getTraitTypeFromEnv(env, "Dispose");
  if (!disposeTraitType) {
    return undefined;
  }

  const expectedTraitWithReceiver: TraitType = {
    ...disposeTraitType,
    receiverType: type,
  };

  // First check if Dispose trait is directly attached to the type
  if (type.trait) {
    for (const field of type.trait.fields) {
      if (!field.assignedValue || !isTraitValue(field.assignedValue)) {
        continue;
      }

      const fieldTraitValue = field.assignedValue;
      const fieldTraitType = fieldTraitValue.type;

      if (
        areTypesCompatible(
          { type: expectedTraitWithReceiver, env },
          { type: fieldTraitType, env }
        )
      ) {
        return fieldTraitValue;
      }
    }
  }

  // Fallback: check generic impl registry for forall impls
  const genericImpl = findMatchingGenericImpl({
    concreteType: type,
    traitType: disposeTraitType,
    env,
  });
  if (genericImpl) {
    return genericImpl.traitValue;
  }

  return undefined;
}

/**
 * Find the user's dispose method from the Dispose trait.
 * Returns the C function name if found, undefined otherwise.
 */
interface DisposeMethodInfo {
  cName: string;
  /** The SelfType of the dispose function (may differ from caller's type for type-function instances) */
  selfType: Type | undefined;
}

function findUserDisposeMethodForType(
  type: Type,
  env: Environment,
  context: CodeGenContext
): DisposeMethodInfo | undefined {
  const traitValue = findDisposeTraitValue(type, env);
  if (!traitValue) {
    return undefined;
  }

  const disposeIndex = traitValue.type.fields.findIndex(
    (field) => field.label === BuiltinFunctions.dispose[0]
  );
  if (disposeIndex < 0) {
    return undefined;
  }

  const disposeValue = traitValue.fields[disposeIndex];
  if (!isFunctionValue(disposeValue)) {
    return undefined;
  }

  // First try direct lookup by funcId
  const directLookup = context.functions[disposeValue.funcId]?.cName;
  if (directLookup) {
    const directType = disposeValue.specializedType ?? disposeValue.type;
    return { cName: directLookup, selfType: directType.SelfType };
  }

  // For generic impls, the dispose function is generic and needs specialization.
  // Search for a specialized version of dispose for this SelfType.
  // Look for functions with funcName === "dispose" and matching SelfType.
  for (const funcId in context.functions) {
    const funcEntry = context.functions[funcId]!;
    const funcValue = funcEntry.value;
    const funcType = funcValue.specializedType ?? funcValue.type;

    if (funcValue.funcName !== BuiltinFunctions.dispose[0]) {
      continue;
    }

    // Check if SelfType matches
    if (
      funcType.SelfType &&
      areTypesCompatible({ type: funcType.SelfType, env }, { type, env })
    ) {
      return { cName: funcEntry.cName, selfType: funcType.SelfType };
    }
  }

  return undefined;
}

/**
 * True if the expression tree contains a `return(expr)` call with an
 * argument (a value-returning return statement). Used by the
 * `isEffectRecordMember` stub-emit gate to detect bodies whose
 * generic-AST `return` lacks the `.$` metadata that generateReturn requires.
 */
function bodyHasExplicitReturn(expr: Expr): boolean {
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.return)) {
    const args = (expr as FnCallExpr).args;
    if (args.length > 0) return true;
  }
  if (exprIsFunctionCall(expr)) {
    for (const arg of (expr as FnCallExpr).args) {
      if (bodyHasExplicitReturn(arg)) return true;
    }
    if (bodyHasExplicitReturn((expr as FnCallExpr).func)) return true;
  }
  return false;
}

/**
 * True if the expression tree contains an `unwind(...)` call anywhere.
 * Used by the `isEffectRecordMember` stub generator to distinguish
 * unwind-only handlers (set the escape flag, return zero) from resume
 * handlers (no escape flag, just return the resume value).
 */
function bodyHasUnwind(expr: Expr): boolean {
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.unwind)) {
    return true;
  }
  if (exprIsFunctionCall(expr)) {
    for (const arg of (expr as FnCallExpr).args) {
      if (bodyHasUnwind(arg)) return true;
    }
    if (bodyHasUnwind((expr as FnCallExpr).func)) return true;
  }
  return false;
}

/**
 * Walk an expression tree and collect the C type string of every non-unit
 * `unwind(value)` argument into `into`. The unwind value is memcpy'd into the
 * thread-local `__yo_unwind_value` buffer at the unwind site and read back at
 * the handler-installation site; the buffer must therefore be large enough for
 * the biggest such value. This pre-pass feeds `emitUnwindValueBuffer`.
 */
function collectUnwindValueCTypesFromExpr(
  expr: Expr,
  context: FunctionGenerationContext,
  into: Set<string>
): void {
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.unwind)) {
    const args = (expr as FnCallExpr).args;
    if (args.length > 0) {
      const argType = args[0]!.$?.type;
      if (argType && !isUnitType(argType)) {
        into.add(getTypeString(argType, context));
      }
    }
  }
  if (exprIsFunctionCall(expr)) {
    for (const arg of (expr as FnCallExpr).args) {
      collectUnwindValueCTypesFromExpr(arg, context, into);
    }
    collectUnwindValueCTypesFromExpr((expr as FnCallExpr).func, context, into);
  }
}

/**
 * Populate `context.unwindValueCTypes` from every function body in the program.
 * MUST run before the unwind-value buffer is declared (i.e. before
 * `generateAtomicGCRuntimeFunctions`), because the buffer declaration string is
 * fixed at emit time and is assembled into the declarations section ahead of all
 * function bodies.
 */
function collectUnwindValueCTypes(context: FunctionGenerationContext): void {
  const into = new Set<string>();
  for (const funcId in context.functions) {
    const body = context.functions[funcId]!.value.body;
    if (body) {
      collectUnwindValueCTypesFromExpr(body, context, into);
    }
  }
  context.unwindValueCTypes = into;
}

/**
 * Emit the thread-local `__yo_unwind_value` buffer declaration. When the program
 * unwinds one or more non-unit values, the buffer is a `union` sized to fit the
 * largest of them (plus a 64-byte floor for parity with the historical default);
 * `__yo_unwind_value` is then a `#define` yielding the union's address as a
 * `char*`, which the existing `memcpy(__yo_unwind_value, ...)` sites use
 * unchanged. With no unwound values, falls back to the plain 64-byte buffer.
 *
 * Fixes the latent overflow where `unwind(value)` with `sizeof(value) > 64`
 * overflowed the fixed `char[64]` buffer (FORTIFY `__memcpy_chk` → SIGTRAP).
 */
function emitUnwindValueBuffer(context: FunctionGenerationContext): void {
  const types = context.unwindValueCTypes;
  if (!types || types.size === 0) {
    context.emitter.emitDeclarationLine(
      `static _Thread_local _Alignas(16) char __yo_unwind_value[64];  // Thread-local buffer for unwind value storage`
    );
    return;
  }
  const members = [...types].map((t, i) => `    ${t} __m${i};`).join("\n");
  context.emitter.emitDeclarationLine(
    `// Thread-local buffer for unwind value storage, sized (via a union) to the\n` +
      `// largest unwound value in the program so 'unwind(v)' never overflows it.\n` +
      `static _Thread_local _Alignas(16) union {\n` +
      `    char __pad[64];\n` +
      `${members}\n` +
      `} __yo_unwind_value_storage;\n` +
      `#define __yo_unwind_value ((char*)&__yo_unwind_value_storage)`
  );
}

/**
 * If the body returns a single parameter via `return(<atom>)`, return
 * that parameter name. Otherwise return undefined. Used by the
 * `isEffectRecordMember` stub generator to emit `return <param>;` for
 * trivial resume handlers like `(val, resume_val) -> return(resume_val)`.
 *
 * Begin-block bodies are unwrapped — the parser appends a unit `()`
 * terminator, so we scan all begin args (not just the last) for the
 * actual `return(...)`. Bodies that aren't begin are checked directly.
 *
 * Returns undefined for any shape that isn't a single direct return of
 * a parameter atom — callers fall back to the unwind stub in that case.
 */
function getResumeReturnParam(
  expr: Expr,
  paramLabels: Set<string>
): string | undefined {
  // Collect candidate return calls: scan begin args (terminator `()`
  // ends up as the last arg), otherwise just the expression itself.
  const candidates: Expr[] = exprIsFunctionCallOf(expr, BuiltinKeywords.begin)
    ? (expr as FnCallExpr).args.slice()
    : [expr];
  let found: string | undefined;
  for (const candidate of candidates) {
    if (!exprIsFunctionCallOf(candidate, BuiltinKeywords.return)) continue;
    const returnArgs = (candidate as FnCallExpr).args;
    if (returnArgs.length !== 1) return undefined;
    const returnArg = returnArgs[0]!;
    if (!exprIsAtom(returnArg)) return undefined;
    const atomName = returnArg.token.value;
    if (!paramLabels.has(atomName)) return undefined;
    if (found && found !== atomName) return undefined; // multiple distinct returns
    found = atomName;
  }
  return found;
}

/**
 * Generate all collected functions
 */
export function generateAllFunctions(context: FunctionGenerationContext): void {
  context.emitter.emitLine(`// Function implementations`);

  // Always emit synchronous system helpers (stat, sync ops, signal, TTY).
  // These have no async/IoFuture dependency.  All functions are `static`, so
  // unused ones are dead-code-eliminated by the C compiler.
  generateSysRuntime(context.emitter, context.targetInfo);

  // Generate async/await runtime only when the program uses async code.
  // This avoids ~8K lines of C runtime overhead for non-async programs.
  if (context.usesAsync) {
    generateAsyncRuntime(
      context.emitter,
      context.targetInfo,
      context.debugAsyncAwait,
      {
        needsCycleGC: context.needsCycleGC ?? false,
        registerDisposeTypeId: (disposeFnName: string) => {
          if (!context.disposeTypeIds) {
            context.disposeTypeIds = new Map();
            context.nextDisposeTypeId = 1;
          }
          let typeId = context.disposeTypeIds.get(disposeFnName);
          if (typeId === undefined) {
            typeId = context.nextDisposeTypeId!;
            context.nextDisposeTypeId = typeId + 1;
            context.disposeTypeIds.set(disposeFnName, typeId);
          }
          return typeId;
        },
      }
    );
  }

  // Generate parallelism runtime only when the program uses threads/workers.
  // This avoids ~450 lines of C thread pool code for single-threaded programs.
  if (context.usesParallelism) {
    generateParallelismRuntime(
      context.emitter,
      context.debugParallelism,
      context.targetInfo,
      context.usesAsync ?? false
    );
  }

  // Pre-pass: collect the C types of all non-unit `unwind(value)` arguments so
  // the `__yo_unwind_value` buffer (declared inside the GC runtime emit below)
  // can be sized to the largest of them. Must run before that emit.
  collectUnwindValueCTypes(context);

  // Generate thread-safe GC runtime functions
  generateAtomicGCRuntimeFunctions(context);

  // Generate object constructor functions
  generateRefStructConstructorFunctions(context);

  // Generate closure constructor and Rc functions
  generateClosureConstructorFunctions(context);

  // Pre-pass: populate `implClosureCallMap` for every Impl(Fn(...)) closure
  // implementation BEFORE any function body is generated. The body loop below
  // iterates `context.functions` in insertion order, which doesn't follow the
  // closure-creator → closure-caller dependency. Without this pre-pass, a
  // call site processed before the closure's construction site falls through
  // to an incorrect fn-pointer-cast fallback.
  registerImplClosureCallMappings(context);

  // NOTE: Don't generate capture dispose functions here yet!
  // They will be generated after deferred async blocks are processed
  // because closure creation happens during async block generation

  for (const funcId in context.functions) {
    const { value, cName } = context.functions[funcId]!;

    // Never skip __yo_user_main - it's the entry point and its implicit
    // Io parameter is resolved at compile time
    const isUserMain = cName === "__yo_user_main";

    // Check if this function's body has effect analysis (it uses algebraic effects).
    // If so, its function-typed implicit parameters are effect handlers that are resolved
    // by the effect system at the call site — they are NOT truly unresolved.
    const bodyEffectAnalysis = value.body?.$?.effectAnalysis;
    const isEffectfulFunction =
      bodyEffectAnalysis && bodyEffectAnalysis.hasEffects;

    // Skip the original (unspecialized) function when it has specialization caches.
    // The specialized versions are separate entries in context.functions and will
    // be generated instead. The original's body was evaluated generically and
    // sub-expressions may lack type annotations, making codegen impossible.
    // This applies even when the function was marked effectful — the effectful
    // generation needs properly annotated sub-expressions too.
    // Exception: isEffectRecordMember functions (e.g., Exception.throw forall handlers)
    // MUST still be emitted in their unspecialized form — their forall params are type-erased
    // (void), the body is just escape(), and the unspecialized name is stored as a void*
    // function pointer in async capture structs by emitEffectRecordInjection in await.ts.
    //
    // Second exception: if the base's cName is still referenced by at least one
    // call site emitted into the C output (call-site codegen uses
    // `context.functions[funcId].cName` which is the base's name when no
    // matching specialization is registered in `context.functions`), skipping
    // the base would leave those call sites unresolved. Detect this by
    // checking whether any *registered* specialized FunctionValue shares the
    // base's funcId — in which case the specialized entry has already
    // replaced the base and we can safely skip; otherwise emit the base.
    if (
      !isUserMain &&
      !value.type.isClosure &&
      !value.isEffectRecordMember &&
      value.specializedFunctionCaches?.length > 0
    ) {
      const baseCName = cName;
      const hasRegisteredReplacement = Object.values(context.functions).some(
        (entry) =>
          entry !== context.functions[funcId] && entry.cName === baseCName
      );
      if (hasRegisteredReplacement) {
        continue;
      }
    }

    // For isEffectRecordMember functions whose generic body cannot be safely
    // emitted, write a minimal stub. The function's address is stored as a
    // void* fn pointer in the effect record's capture struct (see
    // emitEffectRecordInjection in await.ts), so the symbol must exist —
    // but the body is dispatched via the effect runtime (set_effect / unwind),
    // so the stub return is never observed by user code.
    //
    // "Cannot safely emit" covers:
    //   - the base has registered specializations (specializedFunctionCaches > 0):
    //     its generic body has unresolved forall returns and sub-expression
    //     `.$` is only filled in on the specializations.
    //   - the declared type carries a forall AND the body contains an explicit
    //     `return(expr)` statement: the body was deferred at definition time
    //     (`shouldDeferBodyEvaluation`) and the `return`'s `.$` is unpopulated,
    //     so generateReturn would throw "missing metadata". Bodies that only
    //     `unwind(...)` don't need `.$` to emit and so should NOT be stubbed
    //     — emitting their bodies preserves observable side effects (e.g.
    //     `println(msg)` before `unwind(())` in async raise handlers).
    if (value.isEffectRecordMember) {
      const hasRegisteredSpecs =
        (value.specializedFunctionCaches?.length ?? 0) > 0;
      const isUnspecializedForallWithReturn =
        value.type.forallParameters.length > 0 &&
        !!value.body &&
        bodyHasExplicitReturn(value.body);
      if (hasRegisteredSpecs || isUnspecializedForallWithReturn) {
        const proto = generateFunctionPrototype(value.type, cName, context);
        const returnTypeStr = getTypeString(value.type.return.type, context);
        // Distinguish unwind from resume:
        //   - body contains `unwind(...)` → unwind handler. Set the
        //     escape flag so the install site can read __yo_unwind_value.
        //   - body is just `return(<param>)` → resume handler. Return
        //     the named parameter, no flag — the caller of exn.throw
        //     resumes normally with the value.
        //   - anything else → conservative fallback to the unwind stub.
        // See issues/fixed/codegen-forall-resume-handler-stub.md.
        const body = value.body;
        const isUnwindBody = !!body && bodyHasUnwind(body);
        const paramLabels = new Set(
          value.type.parameters
            .map((p) => p.label)
            .filter((l): l is string => !!l)
        );
        const resumeParam =
          !isUnwindBody && !!body
            ? getResumeReturnParam(body, paramLabels)
            : undefined;
        context.emitter.emitLine(`static inline ${proto} {`);
        if (resumeParam !== undefined) {
          const cParam = sanitizeForCIdentifier(resumeParam);
          if (isUnitType(value.type.return.type) || returnTypeStr === "void") {
            // Resume on a unit-returning ctl: just fall through.
            context.emitter.emitLine(`  (void)${cParam};`);
            context.emitter.emitLine(`  return;`);
          } else {
            context.emitter.emitLine(`  return ${cParam};`);
          }
        } else {
          const returnStmt = isUnitType(value.type.return.type)
            ? `return;`
            : returnTypeStr === "void"
              ? `return;`
              : `return (${returnTypeStr}){0};`;
          context.emitter.emitLine(`  __yo_effect_escaped = 1;`);
          context.emitter.emitLine(`  ${returnStmt}`);
        }
        context.emitter.emitLine(`}`);
        continue;
      }
    }

    // If the function is generic or has been specialized, we will handle it later
    // EXCEPTION: Specialized functions from impl methods (not generic at function level)
    // should be generated here, not in generateSpecializedFunctions
    const isSpecializedImplMethod =
      value.specializedType && !isFunctionTypeGeneric(value.type);

    // Check if the function has evidence params (from resolved spread implicits)
    // Functions with evidence params need standalone bodies even if the body
    // doesn't appear effectful (effects were resolved during specialization)
    const functionTypeForCheck = value.specializedType ?? value.type;
    const hasEvidenceParams =
      getEvidenceParameters(functionTypeForCheck).length > 0;

    // Skip hard-generic or comptime-return functions with no specialization.
    // These exist only as compile-time templates — their unspecialized
    // bodies reference comptime bindings not available at runtime.
    // Exception: effect handler functions (isEffectRecordMember) must be
    // generated even when hard-generic — their forall params are erased
    // at runtime and they're stored as void* function pointers.
    // However, module members with comptime parameters MUST still be skipped —
    // comptime params reference compile-time bindings (sizeof, alignof, etc.)
    // that don't exist at runtime, unlike forall params which are just erased.
    const hasComptimeParams = value.type.parameters.some(
      (p) => p.isCompileTimeOnly
    );
    // Comptime functions (compile-time-only return) are never emitted as
    // runtime C functions. This applies even to functions misflagged as
    // module-effect-members (e.g., variadic-quote macros).
    if (
      !isUserMain &&
      !value.specializedType &&
      (value.specializedFunctionCaches?.length ?? 0) === 0 &&
      isComptimeFunction(value)
    ) {
      continue;
    }
    if (
      !isUserMain &&
      (!value.isEffectRecordMember || hasComptimeParams) &&
      !value.specializedType &&
      (value.specializedFunctionCaches?.length ?? 0) === 0 &&
      !value.type.isClosure &&
      isFunctionTypeHardGeneric(value.type)
    ) {
      // Hard-generic comptime-template skip — but closures are per-instance
      // (each io.async / Thread.spawn site gets its own closure value with a
      // concrete capture struct and unique funcId), so they must NOT be
      // skipped here even when their parameter list still mentions forall
      // SomeType (e.g. `e : E` from io.async's Impl(Fn(e : E) -> T)
      // signature). The later carve-out at the hasGenericParams gate already
      // exempts isClosure; mirror it here so the body emission path reaches
      // such closures instead of leaving `closure_*_id_N` undeclared at the
      // io.async sync_fut_t_resume call site.
      continue;
    }

    // Io async state machine closures are always generated via the deferred
    // async block system, never as standalone functions. Skip unconditionally
    // to prevent duplicate struct/function definitions.
    if (!isUserMain && value.isIoAsyncStateMachineClosure) {
      continue;
    }

    if (
      !isUserMain &&
      !isEffectfulFunction &&
      !hasEvidenceParams &&
      !value.isEffectRecordMember &&
      ((isFunctionTypeHardGeneric(value.type) && !value.type.isClosure) ||
        (value.specializedFunctionCaches?.length > 0 &&
          !value.type.isClosure) ||
        (value.specializedType && !isSpecializedImplMethod) ||
        isComptimeFunction(value) ||
        isFunctionValueWithOnlyBuiltinYoInlineFunctionCall(value) ||
        value.isIoAsyncStateMachineClosure)
    ) {
      continue;
    }

    // Skip functions with SomeType in parameters (truly generic)
    // Or with SomeType in return type that isn't a plain Impl(...) or Impl(Future)
    // Use specializedType if available, otherwise use type
    const functionType = value.specializedType ?? value.type;
    // Closures (`isClosure: true`) are per-instance with their own
    // concrete capture struct and distinct C function. Their parameter
    // list may contain `io : Io` or similar effect-record types whose
    // nested fn-pointer fields trip `typeContainsSomeType`, but the
    // closure value itself is not truly generic and its body has
    // been evaluated. Skipping such closures would leave the spawn-
    // wrapper / state-machine references (`closure_*`) undeclared at
    // link time. Let them through to emission.
    const hasGenericParams =
      !isUserMain &&
      !isEffectfulFunction &&
      !value.isEffectRecordMember &&
      !value.type.isClosure &&
      (functionType.parameters.some((p) =>
        typeContainsSomeTypeForCodegenParam(p.type)
      ) ||
        functionType.forallParameters.length > 0);
    // Mirror the parameter check (see declarations.ts): a return type
    // like `IoExn` (struct whose SomeType is confined to nested
    // fn-pointer fields) is concrete at C ABI.
    const hasGenericReturnType = typeContainsSomeTypeForCodegenParam(
      functionType.return.type
    );

    // Allow functions returning plain Impl(...) existential types (SomeType at top level)
    // These are not truly generic - the concrete type is determined from the function body
    const returnsPlainImpl =
      isSomeType(functionType.return.type) &&
      functionType.return.type.requiredTraits.length > 0;

    if (
      hasGenericParams ||
      (hasGenericReturnType &&
        !returnsPlainImpl &&
        !value.isEffectRecordMember &&
        !value.type.isClosure)
    ) {
      continue;
    }

    // Check if this is an effectful function (body has effect call points)
    const effectAnalysis = value.body?.$?.effectAnalysis;
    if (effectAnalysis && effectAnalysis.hasEffects) {
      // All effects use evidence passing (fn ptr params).
      // Fall through to normal function generation.
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
 * Generate a main() wrapper that calls __yo_user_main() and then __yo_async_wait_all()
 * This ensures all async tasks complete before the program exits
 * REQUIREMENT: main function must return unit (void)
 */
/**
 * Emit module-level mutable variable declarations (static vars at file scope).
 * This must run for BOTH binary and library builds so that the C symbols exist.
 * Returns the list of vars for initialization (only used by generateMainWrapper).
 */
export function emitModuleLevelVariableDeclarations(
  context: FunctionGenerationContext
): Array<{ cVarName: string; cTypeStr: string; rhs: Expr }> {
  const emitter = context.emitter;
  const moduleLevelVars: Array<{
    cVarName: string;
    cTypeStr: string;
    rhs: Expr;
  }> = [];

  if (
    !context.moduleLevelInitExprs ||
    context.moduleLevelInitExprs.length === 0
  ) {
    return moduleLevelVars;
  }

  for (const initExpr of context.moduleLevelInitExprs) {
    if (!exprIsFunctionCall(initExpr) || initExpr.args.length < 2) continue;
    const lhs = initExpr.args[0]!;
    const rhs = initExpr.args[1]!;

    // Resolve the variable name and type from LHS.
    // For `:=`: LHS is an atom (the variable name).
    // For `=` with binding: LHS is a `:` call where the first arg is the atom.
    let varAtom: Expr | undefined;
    if (exprIsAtom(lhs) && lhs.$?.type) {
      varAtom = lhs;
    } else if (exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, ":", 2)) {
      const bindingLhs = lhs.args[0]!;
      if (exprIsAtom(bindingLhs) && bindingLhs.$?.type) {
        varAtom = bindingLhs;
      }
    }
    if (!varAtom || !varAtom.$?.type) continue;

    const varName = varAtom.$?.variableName ?? varAtom.token.value;
    const cVarName = getVariableNameForCodegen(varName, varAtom.$.env);
    const cTypeStr = getTypeString(varAtom.$.type, context);

    // Emit file-scope static declaration (no initializer)
    emitter.emitDeclarationLine(
      `static ${cTypeStr} ${cVarName}; // module-level mutable variable`
    );

    moduleLevelVars.push({ cVarName, cTypeStr, rhs });
  }

  return moduleLevelVars;
}

/**
 * Generate a `__yo_module_init()` function for library builds.
 * This initializes module-level mutable variables when the library is loaded.
 * Must be called by the library consumer before using any library functions
 * that depend on module-level mutable state.
 */
export function generateLibraryInitFunction(
  context: FunctionGenerationContext,
  moduleLevelVars: Array<{ cVarName: string; cTypeStr: string; rhs: Expr }>
): void {
  if (moduleLevelVars.length === 0) return;

  const emitter = context.emitter;

  emitter.emitLine(`
// Library initialization - call before using library functions
void __yo_module_init(void) {`);

  emitter.emitLine(`  // Initialize module-level mutable variables`);
  for (const { cVarName, rhs } of moduleLevelVars) {
    const rhsCode = generateExpr(rhs, "  ", context);
    emitter.emitLine(`  ${cVarName} = ${rhsCode};`);
  }

  emitter.emitLine(`}
`);
}

export function generateMainWrapper(context: FunctionGenerationContext): void {
  const emitter = context.emitter;

  // Check if user defined a main function
  let hasMain = false;
  let mainFunctionValue: FunctionValue | null = null;
  for (const funcId in context.functions) {
    const { cName, value } = context.functions[funcId]!;
    if (cName === "__yo_user_main") {
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
    // Build the argument list for __yo_user_main.
    // Each regular parameter of main is matched by type-name:
    //   - Io          → construct from runtime __yo_io_async/await/state/spawn
    //   - Exception   → construct default panic-on-throw handler
    //   - Other       → fail (no automatic injection for unknown effect types)
    //
    // This replaces the old implicit-parameter injection path. With explicit
    // effects, main declares `io : Io, exn : Exception` as regular params and
    // the C wrapper constructs the runtime values.
    const evidenceParams = getEvidenceParameters(mainFunctionValue.type);
    let mainCallArgs: string;
    if (evidenceParams.length > 0) {
      // Legacy path — implicit params still resolve via NULL evidence args.
      mainCallArgs = `(${evidenceParams.map(() => "NULL").join(", ")})`;
    } else {
      const argTokens: string[] = [];
      for (const param of mainFunctionValue.type.parameters) {
        if (param.isCompileTimeOnly) continue;
        const paramType = param.type;
        // Zero-initialize each effect-record parameter. The `io` struct's
        // fields are ioBuiltin markers — calls like `io.async(...)` get
        // inlined to runtime code by codegen, so the struct field values
        // are never actually invoked through function pointers. For
        // `exn : Exception`, the struct's `throw` field IS dispatched via
        // fn-ptr; passing NULL there means `exn.throw(...)` would crash
        // at runtime if reached. The C main wrapper here covers the case
        // where main never invokes `exn.throw`; programs that do should
        // install a real handler at the call site via the explicit-effects
        // machinery (see plans/EXPLICIT_EFFECTS.md §9.3 / §9.6).
        const cType = getTypeString(paramType, context);
        argTokens.push(`(${cType}){0}`);
      }
      mainCallArgs = `(${argTokens.join(", ")})`;
    }

    // Sync main - call it directly and wait for any async tasks
    const asyncInit = context.usesAsync
      ? `
  // Initialize async runtime
  __yo_async_scheduler_init();`
      : "";
    const asyncWait = context.usesAsync
      ? `
  // Wait for all async tasks to complete
  __yo_async_wait_all();`
      : "";

    // Collect module-level mutable variable declarations (static vars at file scope)
    // The declarations have already been emitted by emitModuleLevelVariableDeclarations().
    // Here we just need the list for generating initialization code inside main().
    const moduleLevelVars: Array<{
      cVarName: string;
      cTypeStr: string;
      rhs: Expr;
    }> = [];
    if (
      context.moduleLevelInitExprs &&
      context.moduleLevelInitExprs.length > 0
    ) {
      for (const initExpr of context.moduleLevelInitExprs) {
        if (!exprIsFunctionCall(initExpr) || initExpr.args.length < 2) continue;
        const lhs = initExpr.args[0]!;
        const rhs = initExpr.args[1]!;

        let varAtom: Expr | undefined;
        if (exprIsAtom(lhs) && lhs.$?.type) {
          varAtom = lhs;
        } else if (
          exprIsFunctionCall(lhs) &&
          exprIsFunctionCallOf(lhs, ":", 2)
        ) {
          const bindingLhs = lhs.args[0]!;
          if (exprIsAtom(bindingLhs) && bindingLhs.$?.type) {
            varAtom = bindingLhs;
          }
        }
        if (!varAtom || !varAtom.$?.type) continue;

        const varName = varAtom.$?.variableName ?? varAtom.token.value;
        const cVarName = getVariableNameForCodegen(varName, varAtom.$.env);
        const cTypeStr = getTypeString(varAtom.$.type, context);

        moduleLevelVars.push({ cVarName, cTypeStr, rhs });
      }
    }

    // On POSIX native targets, run the whole program body on a dedicated
    // pthread with a large (1 GiB) stack instead of the OS main thread.
    // The macOS main-thread stack is hard-capped at ~64 MiB, which the
    // deeply-recursive comptime evaluator (notably yo-self checking heavy
    // std files) overruns. A pthread stack is not bound by that cap, and
    // the 1 GiB reservation is virtual-only (pages commit on touch), so it
    // is cheap for ordinary programs.
    //
    // The async runtime's scheduler-init flag and task queue are
    // thread-local, so the scheduler init, `__yo_user_main`, and
    // `__yo_async_wait_all` must all run on this same worker thread. Plain
    // globals (`__yo_argc`/`argv`/`args`) are shared and set on the OS main
    // thread before the worker starts.
    //
    // Windows / WASM keep the direct main-thread call (no pthread there;
    // those targets are not used for the bootstrap workload).
    const useWorkerStack = isTargetPosix(context.targetInfo);
    if (useWorkerStack) {
      // Worker-thread entry: runs scheduler init + module init + user main.
      emitter.emitLine(`
// Program body runs on a large-stack worker thread (see generateMainWrapper).
static void* __yo_main_thread_entry(void* __yo_unused_arg) {
  (void)__yo_unused_arg;${asyncInit}`);
      if (moduleLevelVars.length > 0) {
        emitter.emitLine(`  // Initialize module-level mutable variables`);
        for (const { cVarName, rhs } of moduleLevelVars) {
          const rhsCode = generateExpr(rhs, "  ", context);
          emitter.emitLine(`  ${cVarName} = ${rhsCode};`);
        }
      }
      emitter.emitLine(`  // Call sync main
  __yo_user_main${mainCallArgs};
  ${asyncWait}
  return NULL;
}

// Main wrapper - runs program body on a worker thread (default 1 GiB stack,
// overridable via the YO_MAIN_STACK_MB env var)
int main(int argc, char** argv) {
  // Store command-line arguments (plain globals, shared with the worker)
  __yo_argc = (int32_t)argc;
  __yo_argv = (uint8_t**)argv;
  __yo_args = (Slice_uint8_t_u42_){ .data = (uint8_t**)argv, .length = (size_t)argc };

  pthread_attr_t __yo_main_attr;
  pthread_t __yo_main_tid;
  // Default 1 GiB worker-thread stack (reserved lazily). Optimized builds
  // (-O1+, e.g. --release) shrink frames ~100x via stack coloring, so 1 GiB is
  // far more than enough there. UNOPTIMIZED (-O0) builds of deeply-recursive
  // programs (notably the self-hosted compiler checking itself: a derive over a
  // ~46-variant enum unrolls a compile-time fold ~46 levels deep, each with a
  // multi-MB evaluator frame) can exceed it; raise it with YO_MAIN_STACK_MB
  // (e.g. YO_MAIN_STACK_MB=4096) without recompiling. Kept modest by default so
  // CI runners are not asked to reserve gigabytes.
  size_t __yo_main_stack = (size_t)1024 * 1024 * 1024; // 1 GiB
  {
    const char* __yo_stack_mb = getenv("YO_MAIN_STACK_MB");
    if (__yo_stack_mb != NULL) {
      long __yo_mb = atol(__yo_stack_mb);
      if (__yo_mb > 0) __yo_main_stack = (size_t)__yo_mb * 1024 * 1024;
    }
  }
  if (pthread_attr_init(&__yo_main_attr) == 0
      && pthread_attr_setstacksize(&__yo_main_attr, __yo_main_stack) == 0
      && pthread_create(&__yo_main_tid, &__yo_main_attr, __yo_main_thread_entry, NULL) == 0) {
    pthread_attr_destroy(&__yo_main_attr);
    pthread_join(__yo_main_tid, NULL);
  } else {
    // Fallback: run directly on the main thread if thread creation fails.
    __yo_main_thread_entry(NULL);
  }
  return 0;
}
`);
    } else {
      // Windows / WASM: run directly on the main thread.
      emitter.emitLine(`
// Main wrapper - calls __yo_user_main directly
int main(int argc, char** argv) {
  // Store command-line arguments
  __yo_argc = (int32_t)argc;
  __yo_argv = (uint8_t**)argv;
  __yo_args = (Slice_uint8_t_u42_){ .data = (uint8_t**)argv, .length = (size_t)argc };
  ${asyncInit}`);

      // Generate module-level init code INSIDE main() so temp vars and function calls
      // are valid C (not file-scope initializers).
      if (moduleLevelVars.length > 0) {
        emitter.emitLine(`  // Initialize module-level mutable variables`);
        for (const { cVarName, rhs } of moduleLevelVars) {
          const rhsCode = generateExpr(rhs, "  ", context);
          emitter.emitLine(`  ${cVarName} = ${rhsCode};`);
        }
      }

      emitter.emitLine(`  // Call sync main
  __yo_user_main${mainCallArgs};
  ${asyncWait}
  return 0;
}
`);
    }
  }
}

/**
 * Pre-register all effectful functions across both regular and specialized function sets.
 * This must run BEFORE any function bodies are generated, so that call sites can find
 * the effectStateMachineInfo when generating calls to effectful functions.
 *
 * This pass:
 * 1. Scans all functions for effect analysis
 * 2. Creates SM info and stores it on funcEntries
 * 3. Generates SM struct definitions and forward declarations
 * 4. Defers resume function body generation
 */
export function preRegisterEffectfulFunctions(
  context: FunctionGenerationContext
): void {
  for (const funcId in context.functions) {
    const { value: functionValue } = context.functions[funcId]!;

    if (isComptimeFunction(functionValue)) {
      continue;
    }

    // Check if this function has effect analysis
    const effectAnalysis = functionValue.body?.$?.effectAnalysis;
    if (!effectAnalysis || !effectAnalysis.hasEffects) {
      continue;
    }

    // Skip if the specialized type still has unresolved type parameters
    if (functionValue.specializedType) {
      // Don't use isFunctionTypeGeneric here — it treats implicitParameters as generic,
      // but resolved implicit params (from spread evidence) are NOT generic.
      // Instead, check only for actual generic indicators:
      const st = functionValue.specializedType;
      const hasForallOrCompileTime =
        st.forallParameters.length > 0 ||
        st.parameters.some((p) => p.isCompileTimeOnly);
      const hasSomeTypeParams = st.parameters.some(
        (p) =>
          !p.isCompileTimeOnly &&
          isSomeType(p.type) &&
          !typeImplementsFuture(p.type)
      );
      if (hasForallOrCompileTime || hasSomeTypeParams) {
        continue;
      }
      const hasGenericParams = functionValue.specializedType.parameters.some(
        (p) => typeContainsSomeType(p.type)
      );
      const hasGenericReturnType = typeContainsSomeType(
        functionValue.specializedType.return.type
      );
      if (hasGenericParams || hasGenericReturnType) {
        continue;
      }
    }

    // Check if this function has evidence parameters. If so, it will use
    // evidence passing (fn ptr params) instead of SM-inlining.
    // Try the specialized type first (has expanded effect row spreads),
    // then fall back to the original type (retains implicit parameters
    // that specialization may strip for forall effects only).
    let evidenceParams = getEvidenceParameters(
      functionValue.specializedType ?? functionValue.type
    );
    if (evidenceParams.length === 0 && functionValue.specializedType) {
      const fallbackParams = getEvidenceParameters(functionValue.type);
      if (
        fallbackParams.some(
          (ep) =>
            ep.fieldFunctionType.forallParameters &&
            ep.fieldFunctionType.forallParameters.length > 0
        )
      ) {
        evidenceParams = fallbackParams;
      }
    }

    // Use evidence passing when evidence params are available.
    // Functions with evidence params receive their effects as fn ptr parameters.
    // Direct effect calls in the body compile as fn ptr calls through those params,
    // with escape checking after each call. No SM needed.
    const canUseEvidence = evidenceParams.length > 0;
    if (canUseEvidence) {
      // Skip SM registration — this function will use evidence passing
      continue;
    }

    // No evidence params — this shouldn't happen for current effect patterns.
    // All effects (including forall) use evidence passing.
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
    } else if (
      functionValue.body.$?.type &&
      isSomeType(functionValue.body.$.type) &&
      typeImplementsFuture(functionValue.body.$.type)
    ) {
      // Function delegates to another function returning Impl(Future(T))
      // (e.g., File.open calls File.open_with which contains the io.async block).
      // The body's type SomeType may have resolvedConcreteType pointing to the
      // async block's SomeType, which is registered in context.types.
      overrideReturnType = getTypeString(functionValue.body.$.type, context);
    }
  }

  // For functions returning plain Impl(...) (SomeType), use the concrete type from the body
  // This is for static dispatch - the body's actual return type is the function's return type
  // BUT: Don't do this for specialized functions - their specializedType is already correct
  if (
    functionValue.body &&
    isSomeType(functionType.return.type) &&
    !typeImplementsFuture(functionType.return.type) &&
    !functionValue.specializedType && // Don't override for specialized functions
    !functionValue.isEffectRecordMember // effect record handlers use SomeType → void consistently
  ) {
    // The body should have the concrete return type
    if (functionValue.body.$?.type) {
      overrideReturnType = getTypeString(functionValue.body.$.type, context);
    }
  }

  // For specialized functions where the body's return type is more specific than the signature's
  // (e.g., when generic type parameters have been substituted but the signature still uses generic types)
  // Use the body's concrete return type
  // SKIP THIS: The body type might not be properly updated during specialization
  // The specializedType is already correct, so just use it
  /*
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
  */

  // Regular function generation (async blocks within the function handle their own state machines)
  // After specialization, specializedType includes resolved implicit parameters,
  // so we can use functionType directly (which is specializedType ?? type).
  // Pass the original (pre-specialization) type so evidence params are detected
  // even when specialization strips implicit parameters.
  // Pass original type so evidence params are detected when specialization
  // strips implicit parameters (e.g., for forall effects).
  // Only do this when specializedType has no evidence but the original does,
  // AND the original has forall function evidence params (which need void* passing).
  // Non-forall using params are resolved at specialization time and don't need this.
  const originalFunctionType =
    functionValue.specializedType &&
    getEvidenceParameters(functionType).length === 0 &&
    getEvidenceParameters(functionValue.type).some(
      (ep) =>
        ep.fieldFunctionType.forallParameters &&
        ep.fieldFunctionType.forallParameters.length > 0
    )
      ? functionValue.type
      : undefined;
  const functionPrototype = overrideReturnType
    ? generateFunctionPrototype(
        functionType,
        cFunctionName,
        context,
        overrideReturnType,
        originalFunctionType
      )
    : generateFunctionPrototype(
        functionType,
        cFunctionName,
        context,
        undefined,
        originalFunctionType
      );

  // All functions are 'static' (internal linkage) except __yo_user_main and
  // library exports, since everything compiles to a single C file.
  // RC functions (___drop, ___dup, ___dispose) get __attribute__((always_inline))
  // to ensure the C compiler inlines them even at -Os.
  const isExported =
    cFunctionName === "__yo_user_main" ||
    context.exportedFunctionLabels?.has(functionValue.funcId);
  const isRcFunction =
    !isExported &&
    (cFunctionName.includes("___drop") ||
      cFunctionName.includes("___dup") ||
      cFunctionName.includes("___dispose"));
  const linkagePrefix = isExported
    ? ""
    : isRcFunction
      ? "static inline __attribute__((always_inline)) "
      : "static inline ";
  emitter.emitLine(`${linkagePrefix}${functionPrototype} {`);

  // Set current function name and type for recur support and async handling
  const previousFunctionName = context.currentFunctionName;
  const previousFunctionType = (context as FunctionGenerationContext)
    .currentFunctionType;
  context.currentFunctionName = functionName;
  (context as FunctionGenerationContext).currentFunctionType = functionType;

  // Track if this isan effect record member function (for unwind detection)
  const previousIsEffectRecordMemberFunction = (
    context as FunctionGenerationContext
  ).isEffectRecordMemberFunction;
  const previousOverrideReturnTypeStr = (context as FunctionGenerationContext)
    .overrideReturnTypeStr;
  if (functionValue.isEffectRecordMember) {
    (context as FunctionGenerationContext).isEffectRecordMemberFunction = true;
  }
  // Store override return type for escape codegen (when the C return type
  // differs from the SomeType-based return type in the function signature)
  (context as FunctionGenerationContext).overrideReturnTypeStr =
    overrideReturnType;

  // Set up evidence parameters for module-based effect functions.
  // This maps evidence field accesses (e.g., raise_mod.raise) to the evidence
  // fn ptr parameter names so body codegen can resolve them.
  // Try the specialized type first (has expanded effect row spreads),
  // then fall back to the original type (retains implicit parameters
  // that specialization may strip for forall effects).
  const previousEvidenceParams = (context as FunctionGenerationContext)
    .currentEvidenceParams;
  let evidenceParams = getEvidenceParameters(functionType);
  if (evidenceParams.length === 0 && functionValue.specializedType) {
    const fallbackParams = getEvidenceParameters(functionValue.type);
    if (
      fallbackParams.some(
        (ep) =>
          ep.fieldFunctionType.forallParameters &&
          ep.fieldFunctionType.forallParameters.length > 0
      )
    ) {
      evidenceParams = fallbackParams;
    }
  }
  if (evidenceParams.length > 0) {
    const evidenceMap = new Map<string, EvidenceParameter>();
    for (const ep of evidenceParams) {
      evidenceMap.set(`${ep.implicitLabel}.${ep.fieldLabel}`, ep);
    }
    (context as FunctionGenerationContext).currentEvidenceParams = evidenceMap;
  }

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

  // For ___dispose functions, check if the SelfType has a user-defined dispose method
  // from a Dispose trait and emit a call to it at the start of the function body.
  // This is done in codegen rather than the evaluator to handle traits added via impl
  // after the struct is defined.
  const isDisposeFunction =
    functionValue.funcName === BuiltinFunctions.___dispose[0];
  if (isDisposeFunction && functionType.SelfType) {
    const disposeInfo = findUserDisposeMethodForType(
      functionType.SelfType,
      functionValue.type.env,
      context
    );
    if (disposeInfo) {
      // Get the parameter name for __yo_self
      const selfParamName =
        functionType.parameters[0]?.label === "__yo_self"
          ? "__yo_self"
          : (functionType.parameters[0]?.label ?? "__yo_self");

      // When the dispose function was specialized for a different instance of the
      // same type (e.g., different MapBranch(K,V) struct IDs from type function
      // re-evaluation), we need a pointer cast to avoid incompatible-pointer-types
      // errors (clang 16+ treats this as an error, not a warning).
      let selfArgExpr = selfParamName;
      if (disposeInfo.selfType && functionType.SelfType) {
        const disposeSelfCName = context.types[disposeInfo.selfType.id]?.cName;
        const currentSelfCName = context.types[functionType.SelfType.id]?.cName;
        if (
          disposeSelfCName &&
          currentSelfCName &&
          disposeSelfCName !== currentSelfCName
        ) {
          selfArgExpr = `(${disposeSelfCName}*)(void*)(${selfParamName})`;
        }
      }

      emitter.emitLine(
        `  ${disposeInfo.cName}(${selfArgExpr}); // Call user's dispose method`
      );
    }
  }

  // Generate function body with proper return handling
  generateFunctionBody(functionValue.body, functionType, "  ", context);

  // Restore previous function name, type, closure captures, and parameter aliases
  context.currentFunctionName = previousFunctionName;
  (context as FunctionGenerationContext).currentFunctionType =
    previousFunctionType;
  (context as FunctionGenerationContext).isEffectRecordMemberFunction =
    previousIsEffectRecordMemberFunction;
  (context as FunctionGenerationContext).overrideReturnTypeStr =
    previousOverrideReturnTypeStr;
  (context as FunctionGenerationContext).currentEvidenceParams =
    previousEvidenceParams;
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

  // Reset per-function deferred-drop state so escape / early-return paths
  // inside this body do not pick up drops left over from a previous
  // function's generation. The begin-block branch below overwrites these
  // with the current body's drop expressions; non-begin bodies (e.g.
  // synthetic ctl handlers whose body is a bare `escape(...)`) start
  // empty, since their drop targets live in the caller's scope, not in
  // this function's frame.
  context.pendingDeferredDrops = [];
  context.consumedVarPendingDrops = [];

  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.begin)
  ) {
    // Handle begin block - generate all statements except the last, then return the last
    const args = expr.args;

    // Set pending deferred drops from the function body begin block
    // These need to be generated when early returning from anywhere inside this function
    context.pendingDeferredDrops = [...(expr.$?.deferredDropExpressions ?? [])];
    // Consumed variable drops: RC variables whose drops were optimized away because
    // they're consumed by the return value. Needed for unwind propagation only.
    context.consumedVarPendingDrops = [
      ...(expr.$?.consumedVariableDropExpressions ?? []),
    ];

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

      // Stop generating code after an expression with control flow
      // (e.g., a cond/match where all branches return). Expressions
      // after such a point are dead code and may lack evaluator metadata.
      if (hasAnyControlFlow(arg.$?.controlFlow)) {
        findReturn = true;
        break;
      }
    }

    // Generate the last expression as a return statement
    if (!findReturn && args.length > 0) {
      const lastExpr = args[args.length - 1];

      // Check if this is an async function - async functions return Impl(Future(T)) or Dyn(Future(T))
      const isAsyncFunction = typeImplementsFuture(functionType.return.type);

      if (isAsyncFunction && lastExpr) {
        // Check if the last expression is an async block
        // If it is, we should return it directly without wrapping
        const isAsyncBlock = isIoAsyncCall(lastExpr);

        // Check if the last expression already returns a Future type
        // If so, return it directly without wrapping (e.g., from Option.unwrap())
        const lastExprType = lastExpr.$?.type;
        const isAlreadyFuture =
          lastExprType && typeImplementsFuture(lastExprType);

        if (isAsyncBlock || isAlreadyFuture) {
          // Last expression is an async block or already returns a Future - return it directly
          const resultCode = generateExpr(lastExpr, indent, context);

          // Note: deferred dup expressions for async blocks are handled internally by generateAsyncBlock
          // so we don't need to generate them here

          // Generate deferred drop expressions for temporaries created in this function body
          // (e.g., Path.from_cstr creates a Path temp that needs dropping after the async call)
          if (
            expr.$?.deferredDropExpressions &&
            expr.$.deferredDropExpressions.length > 0 &&
            lastExprType
          ) {
            // Save the result to a temp variable, emit drops, then return
            // Use lastExprType (the concrete type) instead of functionType.return.type
            // (which may be Impl(Future) and not directly resolvable to a C type)
            const returnType = getTypeString(lastExprType, context);
            const tempVarName = `_yo_async_return_${Math.random().toString(36).substr(2, 9)}`;
            emitter.emitLine(
              `${indent}${returnType} ${tempVarName} = ${resultCode};`
            );
            const resultVarName = lastExpr.$?.variableName;
            if (resultVarName) {
              const originalDrops = expr.$.deferredDropExpressions;
              const filteredExpr: Expr = {
                ...expr,
                $: {
                  ...expr.$,
                  deferredDropExpressions: originalDrops.filter(
                    (dropExpr) =>
                      getDeferredDropTargetAtomName(dropExpr) !== resultVarName
                  ),
                },
              };
              generateDeferredDropExpressions(filteredExpr, indent, context);
            } else {
              generateDeferredDropExpressions(expr, indent, context);
            }
            emitter.emitLine(`${indent}return ${tempVarName};`);
          } else {
            emitter.emitLine(`${indent}return ${resultCode};`);
          }
          return; // Exit early - we've handled the return
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
          ///   `${indent}_yo_future->header.gc_mark = __YO_GC_UNMARKED;`
          /// );
          /// emitter.emitLine(`${indent}_yo_future->header.gc_next = NULL;`);
          /// emitter.emitLine(`${indent}_yo_future->header.gc_prev = NULL;`);
          /// emitter.emitLine(
          ///   `${indent}_yo_future->header.dispose_fn = __yo_future_dispose;`
          /// );
          /// emitter.emitLine(`${indent}_yo_future->header.traverse_fn = NULL;`);
          /// emitter.emitLine(
          ///   `${indent}atomic_store_explicit(&_yo_future->state, __YO_FUTURE_COMPLETED, memory_order_relaxed);`
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
        const exprHasControlFlow = hasAnyControlFlow(lastExpr.$?.controlFlow);

        // Check if last expr is unit - either by type or by being a tuple() call with no args
        const isLastExprUnit =
          isUnitType(lastExpr.$?.type) ||
          (exprIsFunctionCall(lastExpr) &&
            exprIsFunctionCallOf(lastExpr, BuiltinKeywords.tuple) &&
            lastExpr.args.length === 0);
        const prevExpr = args.length > 1 ? args[args.length - 2] : null;
        const prevExprHasControlFlow = hasAnyControlFlow(
          prevExpr?.$?.controlFlow
        );

        if (isLastExprUnit && prevExprHasControlFlow) {
          // Don't generate return for unit if previous expression has control flow or is borrow
          // Skip generating anything - the control flow already happened in the previous expression
        } else if (exprHasControlFlow) {
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
              // const exprType = getTypeString(lastExpr.$.type!, context);
              // Use the function's return type instead of expression type for specialized functions
              // because the expression type might still have unresolved type parameters
              const exprType = getTypeString(functionType.return.type, context);
              const exprTempVar = getVariableNameForCodegen(
                lastExpr.$.variableName,
                lastExpr.$.env
              );
              const rawCode = generateExpr(lastExpr, indent, context);

              // Skip the temp-var declaration when the last expression
              // is an ref-param atom — `T name = (*name);` would
              // shadow the pointer parameter. The deferred dup below
              // will reference the inout name directly, which is
              // fine. See plans/MEMORY_SAFETY.md and
              // issues/inout-multi-stmt-body-shadow.md.
              let isInoutAtom = false;
              if (exprIsAtom(lastExpr) && lastExpr.$?.env) {
                const vars = getVariablesFromEnv(
                  lastExpr.$.env,
                  lastExpr.$.variableName
                );
                if (vars.length > 0 && vars[vars.length - 1]!.isRef) {
                  isInoutAtom = true;
                }
              }
              if (!isInoutAtom && exprTempVar !== rawCode) {
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
          let exprCode = generateExpr(lastExpr, indent, context);

          // `-> ref(T)` return slot: the function's C signature returns
          // `T*`. The body's last expression must therefore produce a
          // pointer at the C level. For the simplest case — the body
          // is a `ref`-bound parameter atom — the generator above
          // emits `(*name)` (the standard inout read); strip the
          // deref so we emit the raw pointer instead.
          //
          // More complex flowable expressions (field access on a
          // ref-bound base, projection calls) come in Phase B with
          // the `ref(name) := ...` binding and the flowability rule.
          // See `plans/ITERATOR_REDESIGN.md`.
          if (
            functionType.return.isRef &&
            lastExpr &&
            exprIsAtom(lastExpr) &&
            lastExpr.$?.env &&
            lastExpr.$?.variableName
          ) {
            const vars = getVariablesFromEnv(
              lastExpr.$.env,
              lastExpr.$.variableName
            );
            if (vars.length > 0 && vars[vars.length - 1]!.isRef) {
              exprCode = getVariableNameForCodegen(
                lastExpr.$.variableName,
                lastExpr.$.env
              );
            }
          }

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
      generateImplicitReturnStatement(expr, indent, context);
    }
  }
}

/**
 * Generate the bodies of specialized (monomorphized) functions
 */
export function generateSpecializedFunctions(context: CodeGenContext): void {
  for (const funcId in context.functions) {
    const { value: functionValue, cName: cFunctionName } =
      context.functions[funcId]!;

    if (isComptimeFunction(functionValue)) {
      // Skip compile-time only functions
      continue;
    }

    // Skip if not a generic function
    if (
      !functionValue.specializedType ||
      !isFunctionTypeGeneric(functionValue.type)
    ) {
      continue;
    }

    // Skip if the specialized type still has unresolved type parameters
    // Don't use isFunctionTypeGeneric — it treats implicitParameters as generic,
    // but resolved implicit params (from spread evidence) are NOT generic.
    // SomeType params with resolvedConcreteType are also NOT generic — they
    // were resolved during specialization to a concrete type (e.g., a closure
    // SomeType wrapping its capture struct, or Impl(Fn)/Impl(Future)).
    const isUnresolvedSomeType = (t: Type): boolean => {
      if (!isSomeType(t)) return false;
      if (t.resolvedConcreteType) return false;
      if (typeImplementsFuture(t)) return false;
      if (typeImplementsFn(t)) return false;
      return true;
    };
    const st = functionValue.specializedType;
    const hasForallOrCompileTimeSpec =
      st.forallParameters.length > 0 ||
      st.parameters.some((p) => p.isCompileTimeOnly);
    const hasSomeTypeParamsSpec = st.parameters.some(
      (p) => !p.isCompileTimeOnly && isUnresolvedSomeType(p.type)
    );
    if (hasForallOrCompileTimeSpec || hasSomeTypeParamsSpec) {
      continue;
    }

    // Also skip if any parameter type contains SomeType (generic type parameters)
    // This happens when a function specialization wasn't completed properly.
    // Use the codegen-aware variant: struct fields whose type is a function
    // (effect-record handlers like `throw : ctl(forall, ...)`) are type-erased
    // fn pointers at the C ABI, so their inner forall does NOT make the outer
    // struct "still generic" for codegen purposes.
    const hasGenericParams = functionValue.specializedType.parameters.some(
      (p) => typeContainsSomeTypeForCodegenParam(p.type)
    );
    const hasGenericReturnType = typeContainsSomeTypeForCodegenParam(
      functionValue.specializedType.return.type
    );
    if (hasGenericParams || hasGenericReturnType) {
      continue;
    }

    // If this function is effectful, the main loop already generated it
    // with evidence passing. Skip to avoid redefinition.
    const effectAnalysis = functionValue.body?.$?.effectAnalysis;
    if (effectAnalysis && effectAnalysis.hasEffects) {
      continue;
    }

    // effect record member functions (e.g., specialized ctl handlers like throw_ctl_unit)
    // are already generated in generateAllFunctions. Skip to avoid redefinition.
    if (functionValue.isEffectRecordMember) {
      continue;
    }

    // If this function has evidence parameters, the main loop already generated
    // its body with evidence passing (fn ptr params). Skip to avoid redefinition.
    const evidenceParams = getEvidenceParameters(
      functionValue.specializedType ?? functionValue.type
    );
    if (evidenceParams.length > 0) {
      continue;
    }

    // Generate the specialized function body
    generateFunction(functionValue, cFunctionName, context);
  }
}

/**
 * Emit borrow-flag primitives for the Law of Exclusivity runtime backstop.
 * These are needed regardless of the GC path (lightweight or full).
 */
function generateBorrowRuntimePrimitives(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;
  emitter.emitLine(`
// Law of Exclusivity (Swift-style runtime backstop). An interior 'ref'
// into a container's storage (e.g. xs(i)) increments the container's
// borrow_count for the borrow's lifetime; a container operation that
// could reallocate/free that storage asserts borrow_count == 0. This
// turns the one statically-unprovable interior-ref residual (a container
// reached through a global and grown while borrowed) into a deterministic
// panic instead of a use-after-free. Cost: a same-cache-line load + a
// predicted-not-taken branch (measured ~0% even on a tight push loop).
static inline void __yo_borrow_acquire(void* ptr) {
  if (ptr == NULL) return;
  ((__yo_ref_header_t*)ptr)->borrow_count++;
}
static inline void __yo_borrow_release(void* ptr) {
  if (ptr == NULL) return;
  ((__yo_ref_header_t*)ptr)->borrow_count--;
}
static inline void __yo_borrow_assert_unborrowed(void* ptr) {
  if (ptr == NULL) return;
  if (((__yo_ref_header_t*)ptr)->borrow_count != 0) {
    fprintf(stderr, "panic: container operation while an interior reference (a 'ref' into an element/field) borrows from it\\n");
    abort();
  }
}`);
}

/**
 * Generate non-atomic reference counting runtime functions.
 * Generate thread-local garbage collection with QuickJS-style trial deletion for cycle collection.
 * See CYCLE_COLLECTION.md for design details.
 */
function generateAtomicGCRuntimeFunctions(
  context: FunctionGenerationContext
): void {
  // Borrow-flag primitives (Law of Exclusivity runtime backstop).
  // Emitted unconditionally — needed regardless of GC path.
  generateBorrowRuntimePrimitives(context);

  if (context.needsCycleGC) {
    generateFullGCRuntimeFunctions(context);
  } else {
    generateLightweightRCFunctions(context);
  }
}

/**
 * Emit lightweight RC functions when no type can form reference cycles.
 * __yo_decr_rc has no GC checks, and GC functions are no-ops.
 */
function generateLightweightRCFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Forward-declare the dispose dispatch function (defined after all dispose functions)
  emitter.emitDeclarationLine(
    `static void __yo_dispose_dispatch(void* ptr); // Type-tag based dispose dispatch`
  );

  emitter.emitLine(`// Lightweight reference counting — no cycle detection needed
// Uses type_id dispatch instead of function pointer for dispose
// (WASM: br_table ~2 cycles vs call_indirect ~20+ cycles)
static inline void __yo_decr_rc(void* ptr) {
  if (ptr == NULL) return;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
  if (header->ref_count == 1) {
    if (header->type_id) {
      __yo_dispose_dispatch(ptr);
    }
    __yo_free(ptr);
  } else {
    header->ref_count--;
  }
}

static inline void* __yo_incr_rc(void* ptr) {
  if (ptr == NULL) return NULL;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
  header->ref_count++;
  return ptr;
}`);

  // Atomic reference counting functions for Iso types (still needed regardless of GC)
  emitter.emitLine(`
// Atomic reference counting functions for Iso types (thread-safe)
// Memory ordering follows the standard Arc pattern (Rust, Swift, C++ shared_ptr):
//   - Increment: relaxed (no ordering needed for new reference creation)
//   - Decrement: acq_rel (acquire on last drop to see all prior writes; release to publish our writes)
//   - rc() check: acquire (see all prior writes before acting on uniqueness)
static void* __yo_incr_rc_atomic(void* ptr) {
  if (ptr == NULL) return NULL;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
  atomic_fetch_add_explicit((_Atomic size_t*)&header->ref_count, 1, memory_order_relaxed);
  return ptr;
}

static void __yo_decr_rc_atomic(void* ptr) {
  if (ptr == NULL) return;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
  size_t old_count = atomic_fetch_sub_explicit((_Atomic size_t*)&header->ref_count, 1, memory_order_acq_rel);
  if (old_count == 1) {
    if (header->type_id) {
      __yo_dispose_dispatch(ptr);
    }
    __yo_free(ptr);
  }
}`);

  // Effect unwind flag and value buffer (always needed)
  emitter.emitDeclarationLine(
    `static _Thread_local int __yo_effect_escaped = 0;  // Thread-local flag for effect record unwind detection`
  );
  emitUnwindValueBuffer(context);

  // No-op GC functions so references elsewhere compile
  emitter.emitLine(`// No-op GC stubs — no types form reference cycles
static void __yo_gc_register(void* ptr) { (void)ptr; }
static void __yo_gc_unregister(void* ptr) { (void)ptr; }
static void __yo_gc_collect() {}
static size_t __yo_gc_tracked_count() { return 0; }
static void __yo_gc_init_thread() {}
static void __yo_cleanup_thread_gc() {}
static void __yo_init_process_cleanup(void) {}`);
}

/**
 * Emit full GC-aware RC functions when at least one type can form reference cycles.
 * This is the original implementation with cycle detection support.
 */
function generateFullGCRuntimeFunctions(
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Generate simple non-atomic __yo_decr_rc and __yo_incr_rc functions
  emitter.emitLine(`// Non-atomic reference counting functions (thread-local)
// Flag to prevent double RC decrements during GC collection.
// When set, __yo_decr_rc skips all tracked objects because the GC
// already accounts for their references via trial deletion.
static _Thread_local int __yo_gc_collecting = 0;

static inline void __yo_decr_rc(void* ptr) {
  if (ptr == NULL) return;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
  
  // During GC collection, skip all tracked objects.
  // The GC handles their lifecycle via trial deletion — decrementing here
  // would double-count the reference removal. Non-tracked RC children are
  // still decremented normally (they weren't trial-deleted).
  if (__yo_gc_collecting && (header->gc_flags & __YO_GC_TRACKED)) {
    GC_DEBUG("Decr: Skipping ptr=%p (GC collecting, tracked)\\n", ptr);
    return;
  }
  
  // Also skip objects marked as garbage by the GC (legacy guard for safety).
  if ((header->gc_flags & __YO_GC_TRACKED) && header->gc_mark == __YO_GC_GARBAGE) {
    GC_DEBUG("Decr: Skipping ptr=%p (marked as GC garbage)\\n", ptr);
    return;
  }
  
  GC_DEBUG("Decr: ptr=%p RC=%zu->%zu\\n", ptr, header->ref_count, header->ref_count - 1);
  
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

static inline void* __yo_incr_rc(void* ptr) {
  if (ptr == NULL) return NULL;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
  header->ref_count++;
  GC_DEBUG("Incr: ptr=%p RC=%zu\\n", ptr, header->ref_count);
  return ptr;
}`);

  // Atomic reference counting functions for Iso types (thread-safe)
  emitter.emitLine(`
// Atomic reference counting functions for Iso types (thread-safe)
// Memory ordering follows the standard Arc pattern (Rust, Swift, C++ shared_ptr):
//   - Increment: relaxed (no ordering needed for new reference creation)
//   - Decrement: acq_rel (acquire on last drop to see all prior writes; release to publish our writes)
//   - rc() check: acquire (see all prior writes before acting on uniqueness)
static void* __yo_incr_rc_atomic(void* ptr) {
  if (ptr == NULL) return NULL;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
  atomic_fetch_add_explicit((_Atomic size_t*)&header->ref_count, 1, memory_order_relaxed);
  return ptr;
}

static void __yo_decr_rc_atomic(void* ptr) {
  if (ptr == NULL) return;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
  size_t old_count = atomic_fetch_sub_explicit((_Atomic size_t*)&header->ref_count, 1, memory_order_acq_rel);
  
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
  // Effect unwind flag and value buffer are emitted in declaration section
  // (via emitDeclarationLine) so they're available to sync_fut_t resume functions.
  emitter.emitDeclarationLine(
    `static _Thread_local int __yo_effect_escaped = 0;  // Thread-local flag for effect record unwind detection`
  );
  emitUnwindValueBuffer(context);
  emitter.emitLine(`// Per-thread GC tracking state for cycle collection
static _Thread_local __yo_thread_gc_state_t* __yo_current_thread_gc = NULL;  // Current thread's GC state
static __yo_thread_gc_state_t* __yo_all_thread_gcs = NULL;  // Global list of all thread GC states (for cleanup)
${isTargetWindows(context.targetInfo) ? `static __YO_THREAD_SYNC_TYPE __yo_thread_list_mutex;` : `static __YO_THREAD_SYNC_TYPE __yo_thread_list_mutex = __YO_THREAD_SYNC_INIT;`}
static size_t __yo_gc_min_threshold = 256;       // Minimum threshold for adaptive scaling
static size_t __yo_gc_collect_threshold = 256;   // Adaptive: starts at min, grows to 2x live objects after each GC

// Thread cleanup infrastructure
${
  isTargetWindows(context.targetInfo)
    ? `// Windows: Use native TLS API instead of C11 tss_t (better compiler support)
static DWORD __yo_thread_cleanup_key = TLS_OUT_OF_INDEXES;
static volatile LONG __yo_thread_cleanup_init_started = 0;
static volatile LONG __yo_thread_cleanup_init_done = 0;

static void __yo_init_thread_cleanup_key(void) {
  // Simple once-only initialization using interlocked operations
  if (InterlockedCompareExchange(&__yo_thread_cleanup_init_started, 1, 0) == 0) {
    __yo_thread_cleanup_key = TlsAlloc();
    InterlockedExchange(&__yo_thread_cleanup_init_done, 1);
  } else {
    // Wait for initialization to complete
    while (InterlockedCompareExchange(&__yo_thread_cleanup_init_done, 1, 1) == 0) {
      Sleep(0);
    }
  }
}`
    : `static pthread_key_t __yo_thread_cleanup_key = (pthread_key_t)(-1);
static pthread_once_t __yo_thread_cleanup_once = PTHREAD_ONCE_INIT;

static void __yo_pthread_cleanup(void* value) {
  if (value != NULL) {
    __yo_cleanup_thread_gc();
  }
}

static void __yo_init_thread_cleanup_key(void) {
  pthread_key_create(&__yo_thread_cleanup_key, __yo_pthread_cleanup);
}`
}

// Initialize thread-local GC state
static void __yo_init_thread_gc() {
  if (__yo_current_thread_gc != NULL) return;

${
  isTargetWindows(context.targetInfo)
    ? `  __yo_init_thread_cleanup_key();
  if (__yo_thread_cleanup_key != TLS_OUT_OF_INDEXES) {
    TlsSetValue(__yo_thread_cleanup_key, (void*)1);
  }`
    : `  pthread_once(&__yo_thread_cleanup_once, __yo_init_thread_cleanup_key);
  if (__yo_thread_cleanup_key != (pthread_key_t)(-1)) {
    pthread_setspecific(__yo_thread_cleanup_key, (void*)1);
  }`
}
  
  __yo_init_process_cleanup();

  __yo_current_thread_gc = (__yo_thread_gc_state_t*)__yo_malloc(sizeof(__yo_thread_gc_state_t));
  __yo_current_thread_gc->tracked_objects = NULL;
  __yo_current_thread_gc->tracked_count = 0;
  __yo_current_thread_gc->thread_id = __yo_thread_self();
  __yo_current_thread_gc->alloc_count = 0;

  // Add to global thread list (for cleanup coordination)
  __yo_mutex_lock(&__yo_thread_list_mutex);
  __yo_current_thread_gc->next = __yo_all_thread_gcs;
  __yo_current_thread_gc->prev = NULL;
  if (__yo_all_thread_gcs != NULL) {
    __yo_all_thread_gcs->prev = __yo_current_thread_gc;
  }
  __yo_all_thread_gcs = __yo_current_thread_gc;
  __yo_mutex_unlock(&__yo_thread_list_mutex);
}

// Public function to initialize thread-local GC (for worker threads)
static void __yo_gc_init_thread() {
  __yo_init_thread_gc();
}`);

  // Generate __yo_gc_register and __yo_gc_unregister functions
  emitter.emitLine(`static void __yo_gc_register(void* ptr) {
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
  
  if (__yo_current_thread_gc == NULL) {
    __yo_init_thread_gc();
  }
  
  GC_DEBUG("GC Register: ptr=%p\\n", ptr);
  
  // Check if already tracked
  if (header->gc_flags & __YO_GC_TRACKED) {
    return;
  }
  
  header->gc_flags |= __YO_GC_TRACKED;
  header->gc_mark = __YO_GC_UNMARKED;
  
  // Add to thread-local tracking list
  header->gc_next = __yo_current_thread_gc->tracked_objects;
  header->gc_prev = NULL;
  if (__yo_current_thread_gc->tracked_objects != NULL) {
    __yo_current_thread_gc->tracked_objects->gc_prev = header;
  }
  __yo_current_thread_gc->tracked_objects = header;
  __yo_current_thread_gc->tracked_count++;
  
  // Check if we should trigger GC (skip during active collection to prevent re-entrance)
  if (!__yo_gc_collecting && __yo_current_thread_gc->tracked_count >= __yo_gc_collect_threshold) {
    __yo_gc_collect();
  }
}

static void __yo_gc_unregister(void* ptr) {
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
  
  if (__yo_current_thread_gc == NULL) {
    return;
  }
  
  if (!(header->gc_flags & __YO_GC_TRACKED)) {
    return;
  }
  
  // Remove from tracking list (O(1) with doubly-linked list)
  if (header->gc_prev != NULL) {
    header->gc_prev->gc_next = header->gc_next;
  } else {
    __yo_current_thread_gc->tracked_objects = header->gc_next;
  }
  
  if (header->gc_next != NULL) {
    header->gc_next->gc_prev = header->gc_prev;
  }

  __yo_current_thread_gc->tracked_count--;
  header->gc_flags &= ~__YO_GC_TRACKED;
}`);

  // Generate QuickJS-style trial deletion cycle collection
  emitter.emitLine(`// QuickJS-style trial deletion for cycle collection
// Phase 1: Trial deletion - decrement ref counts for internal references
static void __yo_gc_trial_delete_visitor(void* ptr) {
  if (ptr == NULL) return;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
  
  // Only process tracked objects
  if (!(header->gc_flags & __YO_GC_TRACKED)) return;
  
  // Trial decrement
  if (header->ref_count > 0) {
    header->ref_count--;
    GC_DEBUG("TrialDelete: ptr=%p, ref_count->%zu\\n", ptr, header->ref_count);
  }
}

// Phase 3: Recursive scan/restore visitor.
// Restores trial-deleted ref counts and propagates liveness from live roots
// to all reachable objects. Objects promoted from GARBAGE to live (UNMARKED)
// have their children recursively scanned.
static void __yo_gc_scan_restore_visitor(void* ptr) {
  if (ptr == NULL) return;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
  
  // Skip non-tracked objects (their RC was never trial-deleted)
  if (!(header->gc_flags & __YO_GC_TRACKED)) return;
  
  // Restore the trial-deleted reference
  header->ref_count++;
  GC_DEBUG("ScanRestore: ptr=%p, ref_count->%zu, mark=%d\\n", ptr, header->ref_count, header->gc_mark);
  
  if (header->gc_mark == __YO_GC_GARBAGE) {
    // This object was tentatively marked garbage but is reachable from a live root.
    // Promote to live (mark UNMARKED = "scanned") and recursively scan children.
    header->gc_mark = __YO_GC_UNMARKED;
    if (header->traverse_fn) {
      header->traverse_fn(ptr, __yo_gc_scan_restore_visitor);
    }
  }
  // If already LIVE or UNMARKED (already scanned), just restore RC — don't recurse again.
}

static void __yo_gc_collect() {
  if (__yo_current_thread_gc == NULL) return;
  
  __yo_ref_header_t* head = __yo_current_thread_gc->tracked_objects;
  if (head == NULL) return;
  
  GC_DEBUG("GC: Starting collection, tracked_count=%zu\\n", __yo_current_thread_gc->tracked_count);
  
  __yo_gc_collecting = 1;
  size_t collected = 0;
  
  // Phase 1: Mark all as candidates and trial-delete
  __yo_ref_header_t* obj = head;
  while (obj != NULL) {
    obj->gc_mark = __YO_GC_CANDIDATE;
    obj = obj->gc_next;
  }
  
  // Trial deletion: decrement RC for all internal (tracked→tracked) references
  obj = head;
  while (obj != NULL) {
    if (obj->traverse_fn) {
      obj->traverse_fn(obj, __yo_gc_trial_delete_visitor);
    }
    obj = obj->gc_next;
  }
  
  // Phase 2: Classify objects — RC > 0 means external references exist (live root),
  // RC == 0 means only internal references (tentative garbage)
  obj = head;
  while (obj != NULL) {
    if (obj->ref_count == 0) {
      obj->gc_mark = __YO_GC_GARBAGE;
      GC_DEBUG("GC: Marked as garbage: ptr=%p\\n", obj);
    } else {
      obj->gc_mark = __YO_GC_LIVE;
      GC_DEBUG("GC: Marked as live root: ptr=%p (ref_count=%zu)\\n", obj, obj->ref_count);
    }
    obj = obj->gc_next;
  }
  
  // Phase 3: Scan from live roots — restore ref counts and propagate liveness.
  // Live roots (__YO_GC_LIVE) are scanned; their reachable GARBAGE children are
  // promoted to UNMARKED (live+scanned). After this phase, only truly unreachable
  // objects remain marked __YO_GC_GARBAGE.
  obj = head;
  while (obj != NULL) {
    if (obj->gc_mark == __YO_GC_LIVE) {
      // Mark this root as scanned so the loop doesn't re-process it
      // if the list order changes (defensive) and to distinguish from promoted objects
      obj->gc_mark = __YO_GC_UNMARKED;
      if (obj->traverse_fn) {
        obj->traverse_fn(obj, __yo_gc_scan_restore_visitor);
      }
    }
    obj = obj->gc_next;
  }
  
  // Phase 4a: Call dispose functions on all garbage objects (while memory is still valid).
  // __yo_gc_collecting flag ensures __yo_decr_rc skips tracked objects, preventing
  // double RC decrements (trial deletion already accounted for those references).
  // Non-tracked RC children are still properly released by dispose.
  obj = head;
  while (obj != NULL) {
    if (obj->gc_mark == __YO_GC_GARBAGE && obj->dispose_fn) {
      GC_DEBUG("GC: Disposing garbage: ptr=%p\\n", obj);
      obj->dispose_fn(obj);
    }
    obj = obj->gc_next;
  }
  
  // Phase 4b: Free all garbage objects and remove from tracking list
  __yo_ref_header_t* current = head;
  __yo_ref_header_t* prev = NULL;
  
  while (current != NULL) {
    __yo_ref_header_t* next = current->gc_next;
    
    if (current->gc_mark == __YO_GC_GARBAGE) {
      GC_DEBUG("GC: Freeing garbage: ptr=%p\\n", current);
      
      // Remove from tracking list
      if (prev == NULL) {
        __yo_current_thread_gc->tracked_objects = next;
      } else {
        prev->gc_next = next;
      }
      if (next != NULL) {
        next->gc_prev = prev;
      }
      
      __yo_current_thread_gc->tracked_count--;
      collected++;
      
      // Free the object (dispose was already called in Phase 4a)
      __yo_free(current);
      
      current = next;
    } else {
      // Reset mark for next collection
      current->gc_mark = __YO_GC_UNMARKED;
      prev = current;
      current = next;
    }
  }
  
  __yo_gc_collecting = 0;
  
  // Adaptive threshold: set to max(min_threshold, 2 * remaining_objects)
  size_t new_threshold = __yo_current_thread_gc->tracked_count * 2;
  if (new_threshold < __yo_gc_min_threshold) {
    new_threshold = __yo_gc_min_threshold;
  }
  __yo_gc_collect_threshold = new_threshold;
  
  GC_DEBUG("GC: Collection complete, collected=%zu, remaining=%zu, next_threshold=%zu\\n", collected, __yo_current_thread_gc->tracked_count, __yo_gc_collect_threshold);
}

static size_t __yo_gc_tracked_count() {
  if (__yo_current_thread_gc == NULL) return 0;
  return __yo_current_thread_gc->tracked_count;
}`);

  // Generate thread cleanup function
  emitter.emitLine(`// Clean up thread-local GC state
static void __yo_cleanup_thread_gc() {
  __yo_mutex_lock(&__yo_thread_list_mutex);
  
  __yo_thread_gc_state_t* my_gc_state = __yo_current_thread_gc;
  
  if (my_gc_state == NULL) {
    __yo_mutex_unlock(&__yo_thread_list_mutex);
    return;
  }
  
  GC_DEBUG("CleanupThread: tracked_count=%zu\\n", my_gc_state->tracked_count);
  
  // Force dispose all remaining tracked objects
  __yo_ref_header_t* current = my_gc_state->tracked_objects;
  while (current != NULL) {
    __yo_ref_header_t* next = current->gc_next;
    
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
    __yo_all_thread_gcs = my_gc_state->next;
  }
  
  if (my_gc_state->next != NULL) {
    my_gc_state->next->prev = my_gc_state->prev;
  }
  
  __yo_mutex_unlock(&__yo_thread_list_mutex);
  
  __yo_free(my_gc_state);
  __yo_current_thread_gc = NULL;
}

// Process cleanup
static void __yo_process_cleanup(void) {
  GC_DEBUG("ProcessCleanup: Called\\n");
  
  if (__yo_current_thread_gc != NULL) {
    __yo_gc_collect();
    __yo_cleanup_thread_gc();
  }
  
${
  isTargetWindows(context.targetInfo)
    ? `  if (__yo_thread_cleanup_key != TLS_OUT_OF_INDEXES) {
    TlsFree(__yo_thread_cleanup_key);
    __yo_thread_cleanup_key = TLS_OUT_OF_INDEXES;
  }`
    : `  if (__yo_thread_cleanup_key != (pthread_key_t)(-1)) {
    pthread_key_delete(__yo_thread_cleanup_key);
  }`
}
}

${
  isTargetWindows(context.targetInfo)
    ? `static INIT_ONCE __yo_process_cleanup_once = INIT_ONCE_STATIC_INIT;
static BOOL CALLBACK __yo_process_cleanup_init_callback(PINIT_ONCE InitOnce, PVOID Parameter, PVOID *Context) {
  (void)InitOnce; (void)Parameter; (void)Context;
  InitializeCriticalSection(&__yo_thread_list_mutex);
  atexit(__yo_process_cleanup);
  return TRUE;
}

static void __yo_init_process_cleanup(void) {
  InitOnceExecuteOnce(&__yo_process_cleanup_once, __yo_process_cleanup_init_callback, NULL, NULL);
}`
    : `static void __yo_init_process_cleanup(void) {
  static bool cleanup_initialized = false;
  if (cleanup_initialized) return;
  cleanup_initialized = true;
  atexit(__yo_process_cleanup);
}`
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
      // Atomic objects don't participate in cycle GC — no traversal needed
      if (type.isAtomicRc) {
        continue;
      }

      // Skip generic structs that contain SomeType parameters
      const runtimeFields = getRuntimeStructFields(type);
      const hasGenericTypes = runtimeFields.some((field) =>
        typeContainsSomeType(field.type)
      );

      if (hasGenericTypes) {
        continue; // Skip generic structs
      }

      // Generate traversal function for this struct type
      const traversalFunctionName = `__yo_traverse_${cName}`;
      emitter.emitLine(
        `static void ${traversalFunctionName}(void* ptr, void (*visit)(void*)) {`
      );
      emitter.emitLine(`  ${cName}* obj = (${cName}*)ptr;`);

      // Visit each reference field in the struct
      for (const field of runtimeFields) {
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
          } else if (canOptimizeAsSimpleEnum(enumType)) {
            // Simple enums have no variant data, so no references to traverse
          } else {
            // Generate switch statement to handle enum variants
            emitter.emitLine(`  switch (obj->${fieldName}.tag) {`);

            for (const variant of enumType.variants || []) {
              // Check if any of the variant's fields contain references
              if (variant.fields && variant.fields.length > 0) {
                const rcFields = variant.fields.filter(
                  (f) => isStructType(f.type) && f.type.isReferenceSemantics
                );

                if (rcFields.length > 0) {
                  const enumConstantName = getEnumVariantCName(
                    enumType,
                    variant.name,
                    context
                  );
                  emitter.emitLine(`  case ${enumConstantName}:`);

                  // Visit ALL reference-counted fields in this variant
                  for (const variantField of rcFields) {
                    emitter.emitLine(
                      `    if (obj->${fieldName}.data.${variant.name}.${sanitizeForCIdentifier(variantField.label)}) {`
                    );
                    emitter.emitLine(
                      `      visit(obj->${fieldName}.data.${variant.name}.${sanitizeForCIdentifier(variantField.label)});`
                    );
                    emitter.emitLine(`    }`);
                  }

                  emitter.emitLine(`    break;`);
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

  // Only generate traversal functions when cycle GC is needed
  if (context.needsCycleGC) {
    generateRefStructTraversalFunctions(context);
  }

  // Generate constructor implementations for each object
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (isStructType(type) && type.isReferenceSemantics) {
      // Skip generic structs that contain SomeType parameters
      const runtimeFields = getRuntimeStructFields(type);
      const hasGenericTypes = runtimeFields.some((field) =>
        typeContainsSomeType(field.type)
      );

      if (hasGenericTypes) {
        continue; // Skip generic structs - only generate constructors for concrete types
      }

      // Generate constructor function implementation
      const constructorName = `__yo_new_${cName}`;
      const paramTypes = runtimeFields
        .map((field) => {
          const fieldType = getTypeString(field.type, context);
          const fieldName = sanitizeForCIdentifier(field.label);
          return `${fieldType} ${fieldName}`;
        })
        .join(", ");

      emitter.emitLine(`static ${cName}* ${constructorName}(${paramTypes}) {`);
      emitter.emitLine(
        `  ${cName}* obj = (${cName}*)__yo_malloc(sizeof(${cName}));`
      );
      // Initialize RC header
      emitter.emitLine(
        `  obj->header.ref_count = 1;  // Start with one reference`
      );
      emitter.emitLine(
        `  obj->header.borrow_count = 0;  // Law-of-Exclusivity: no live interior borrows yet`
      );
      if (context.needsCycleGC && !type.isAtomicRc) {
        emitter.emitLine(`  obj->header.gc_flags = 0;`);
        emitter.emitLine(`  obj->header.gc_mark = __YO_GC_UNMARKED;`);
        emitter.emitLine(`  obj->header.gc_next = NULL;`);
        emitter.emitLine(`  obj->header.gc_prev = NULL;`);
      }
      // Set dispose function pointer to ___dispose, which handles both user cleanup and field dropping.
      // ___dispose will call user's dispose() if it exists, then drop all GC-containing fields.
      const disposeInternalFunctionElement = type.trait.fields.find(
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

        if (context.needsCycleGC) {
          emitter.emitLine(
            `  obj->header.dispose_fn = (void(*)(void*))${disposeFunctionCName};`
          );
        } else {
          // Type-tag dispatch: assign a unique ID for this dispose function
          if (!context.disposeTypeIds) {
            context.disposeTypeIds = new Map();
            context.nextDisposeTypeId = 1;
          }
          let disposeId = context.disposeTypeIds.get(disposeFunctionCName);
          if (disposeId === undefined) {
            disposeId = context.nextDisposeTypeId!;
            context.nextDisposeTypeId = disposeId + 1;
            context.disposeTypeIds.set(disposeFunctionCName, disposeId);
          }
          emitter.emitLine(`  obj->header.type_id = ${disposeId};`);
        }
      } else {
        if (context.needsCycleGC) {
          // Fallback to NULL if no ___dispose function found
          emitter.emitLine(`  obj->header.dispose_fn = NULL;`);
        } else {
          // Type ID 0 = no dispose needed
          emitter.emitLine(`  obj->header.type_id = 0;`);
        }
      }

      // Set traversal function pointer for GC (only when cycle detection is needed)
      // Atomic objects never participate in cycle GC
      if (context.needsCycleGC && !type.isAtomicRc) {
        const traversalFunctionName = `__yo_traverse_${cName}`;
        emitter.emitLine(
          `  obj->header.traverse_fn = ${traversalFunctionName};`
        );
      }

      // Initialize fields
      runtimeFields.forEach((field) => {
        const fieldName = sanitizeForCIdentifier(field.label);
        emitter.emitLine(`  obj->${fieldName} = ${fieldName};`);
      });

      // Register with GC if this type might participate in cycles
      // Atomic objects never participate in cycle GC
      if (
        context.needsCycleGC &&
        !type.isAtomicRc &&
        canTypeFormRcCycle(type, new Set(), type.env)
      ) {
        emitter.emitLine(`  __yo_gc_register(obj);`);
      }

      emitter.emitLine(`  return obj;`);
      emitter.emitLine(`}`);
      emitter.emitLine(``);
    }
  }
}

/**
 * Generate constructor function implementations for closures and their Rc functions
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
      `static void ${disposeFunctionName}(void* closure_ptr);`
    );
  }

  // Then generate function implementations
  for (const [
    closureInstanceId,
    { closureCName, captureType, captureCName },
  ] of context.closureCaptureMap) {
    const disposeFunctionName = `__yo_dispose_closure_${closureInstanceId}`;

    // Get the drop function for the capture type
    const dropFunction = captureType.trait.fields.find(
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
      `static void ${disposeFunctionName}(void* closure_ptr) { // Dispose for ${closureCName} with ${captureCName} (Impl closure - value type)`
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
