import { isComptimeStringType } from "../../types/guards";
import {
  findInnermostFrameWithGivenVariable,
  getVariablesFromEnv,
  getVariablesFromEnvByFilter,
} from "../../env";
import { isIoAsyncCall } from "../../evaluator/async/await-analysis";
import {
  extractFnTraitFromType,
  typeImplementsFn,
  typeImplementsFuture,
} from "../../evaluator/trait-checking";
import {
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  type AtomExpr,
  type Expr,
  type FnCallExpr,
} from "../../expr";
import type { FunctionValue } from "../../function-value";
import type { FunctionType, SomeType, Type } from "../../types/definitions";
import {
  isArrayType,
  isDynType,
  isEnumType,
  isFunctionType,
  isReferenceStructType,
  isPtrType,
  isSomeType,
  isStructType,
  isTupleType,
  isUnionType,
  isUnitType,
} from "../../types/guards";
import { typeContainsRcType, typeIsControlBound } from "../../types/utils";
import { TypeTag } from "../../types/tags";
import {
  isFunctionValue,
  isStructValue,
  isTypeValue,
  isUnknownValue,
} from "../../value";
import { BuiltinYoInlineFunctions } from "../constants";

import type { FunctionGenerationContext } from "../functions/context";
import {
  generateFunctionPrototype,
  getEvidenceParameters,
  type EvidenceParameter,
} from "../functions/declarations";
import {
  canOptimizeAsNullablePointer,
  canOptimizeAsSimpleEnum,
  getDeferredDupTargetAtomName,
  getEnumVariantCName,
  getRuntimeStructFields,
  getTypeString,
  getVariableNameForCodegen,
  getVariableTypeString,
  isFunctionValueWithOnlyBuiltinYoInlineFunctionCall,
  sanitizeForCIdentifier,
  type CodeGenContext,
} from "../utils";
import { emitAsyncFutureEscape } from "./async-completion";
import { checkVariableIsClosureCaptured } from "./closures";
import { generateComptimeValue } from "./comptime-value";
import {
  generateDeferredDropExpressions,
  generateDeferredDupExpressions,
  generateDropCodeForValue,
} from "./drop-dup";
import { generateExpr } from "./expr";
import { generateYoInlineFunctionCall } from "./inline-fns";
import {
  generateThreadSpawnCall,
  generateWorkerSpawnCall,
} from "./parallelism";
import {
  generatePendingDeferredDrops,
  generateConsumedVarDropsForEscape,
} from "./return";

let refSpillCounter = 0;

/**
 * True when the generated C expression is an addressable lvalue — i.e. `&(c)`
 * is valid AND points at the caller-visible storage (so a `ref` parameter's
 * writes land where the caller can see them). Conservative by construction:
 * anything unrecognized is treated as an rvalue and spilled to a temp.
 *
 * Accepted shapes (after stripping balanced outer parens):
 *   - a dereference `*expr` (then `&(*expr)` ≡ `expr`)
 *   - an identifier followed by member/index chains:
 *     `foo`, `foo.bar`, `foo->bar`, `sm->__capture.x`, `arr[idx]`, mixes.
 */
function isAddressableCExpr(code: string): boolean {
  let s = code.trim();
  // Strip balanced fully-enclosing parens: `((*self)._inner)` →
  // `(*self)._inner`, `(*self)` → `*self`.
  for (;;) {
    if (!(s.startsWith("(") && s.endsWith(")"))) break;
    let depth = 0;
    let enclosing = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") {
        depth--;
        if (depth === 0 && i < s.length - 1) {
          enclosing = false;
          break;
        }
      }
    }
    if (!enclosing) break;
    s = s.slice(1, -1).trim();
  }
  // A deref of anything is an lvalue (`&(*p)` is just `p`, and writes
  // through it land in the pointed-to storage).
  if (s.startsWith("*")) return true;
  // Chain scanner: HEAD (identifier or parenthesized deref `(*…)`) followed
  // by member/index tails `.f` / `->f` / `[…]`. Covers the shapes codegen
  // emits for receivers: `self`, `(*self)._inner`, `sm->__capture.x`,
  // `arr[i]`. Anything else (binary exprs, calls, casts, literals) is an
  // rvalue → caller spills.
  let i = 0;
  if (s[0] === "(") {
    // Parenthesized head must be a deref `(*…)` with balanced parens.
    let depth = 0;
    let close = -1;
    for (let k = 0; k < s.length; k++) {
      if (s[k] === "(") depth++;
      else if (s[k] === ")") {
        depth--;
        if (depth === 0) {
          close = k;
          break;
        }
      }
    }
    if (close < 0) return false;
    if (!s.slice(1, close).trim().startsWith("*")) return false;
    i = close + 1;
  } else {
    const m = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(s);
    if (!m) return false;
    i = m[0].length;
  }
  while (i < s.length) {
    if (s[i] === " ") {
      i++;
    } else if (s[i] === "." || s.startsWith("->", i)) {
      i += s[i] === "." ? 1 : 2;
      const m = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(s.slice(i));
      if (!m) return false;
      i += m[0].length;
    } else if (s[i] === "[") {
      let depth = 0;
      let close = -1;
      for (let k = i; k < s.length; k++) {
        if (s[k] === "[") depth++;
        else if (s[k] === "]") {
          depth--;
          if (depth === 0) {
            close = k;
            break;
          }
        }
      }
      if (close < 0) return false;
      i = close + 1;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Resolves a variable name to its state machine field reference if inside an
 * async or effect state machine context. Returns `sm->__capture.X` for outer
 * variables or `sm->var_X` for locals; otherwise returns the name unchanged.
 */
function resolveVarNameInContext(
  varName: string,
  context: CodeGenContext
): string {
  const functionContext = context as FunctionGenerationContext;
  if (
    !(
      functionContext.inAsyncStateMachine ||
      functionContext.inEffectStateMachine
    ) ||
    !functionContext.stateMachineVariables
  ) {
    return varName;
  }
  for (const [varId, capturedVar] of functionContext.stateMachineVariables) {
    if (capturedVar.name === varName) {
      const fieldName =
        capturedVar.kind === "outer"
          ? `__capture.${capturedVar.name}`
          : `var_${varId}`;
      return `sm->${fieldName}`;
    }
  }
  return varName;
}

/**
 * In async state machine context, stores a local temp variable to its
 * corresponding sm->var_xxx field. This ensures deferred drops in the final
 * state can access a valid value instead of the zero-initialized struct field.
 */
export function storeTempVarToStateMachineIfNeeded(
  tempVar: string,
  indent: string,
  context: CodeGenContext
): void {
  const functionContext = context as FunctionGenerationContext;
  if (
    !(
      functionContext.inAsyncStateMachine ||
      functionContext.inEffectStateMachine
    ) ||
    !functionContext.stateMachineVariables
  ) {
    return;
  }

  let capturedVar = functionContext.stateMachineVariables.get(tempVar);
  if (!capturedVar) {
    for (const [, cv] of functionContext.stateMachineVariables) {
      if (cv.name === tempVar) {
        capturedVar = cv;
        break;
      }
    }
  }
  if (capturedVar && capturedVar.kind !== "outer") {
    // Skip Future-typed temps — their lifecycle is managed by the await logic
    // (await_future_X fields), and the deferred drops already have NULL checks.
    // Storing them here would cause double-free.
    if (capturedVar.type && typeImplementsFuture(capturedVar.type)) {
      return;
    }
    const smFieldName = `var_${capturedVar.id}`;
    const sanitizedTempVar = sanitizeForCIdentifier(tempVar);
    context.emitter.emitLine(
      `${indent}sm->${smFieldName} = ${sanitizedTempVar};`
    );
  }
}

/**
 * Split a comma-separated C arg list at top-level commas, respecting
 * (), [], {} nesting. Used to apply per-argument type casts.
 */
function splitTopLevelArgsList(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  // Track whether we're inside a C string/char literal so that bracket and
  // comma characters within a literal (e.g. the `)` in the str initializer
  // `(__yo_str){ .ptr=(const uint8_t*)")", .len=1 }`) don't corrupt the depth
  // count and cause a split inside the literal.
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr !== null) {
      cur += ch;
      if (ch === "\\") {
        // Escape sequence: consume the next char verbatim.
        i++;
        if (i < s.length) cur += s[i];
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      cur += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0) out.push(cur.trim());
  return out;
}

/**
 * For a `ref` argument that is an interior borrow (Index-trait expression),
 * extract the C code string for the container pointer that needs acquire/release.
 * Returns undefined when the argument is not an interior borrow.
 */
function getInteriorRefContainerCode(
  argExpr: Expr,
  param: { isRef?: boolean } | undefined,
  indent: string,
  context: CodeGenContext
): string | undefined {
  if (!param?.isRef) return undefined;
  if (!argExpr.$?.indexTraitPtrType) return undefined;
  if (!exprIsFunctionCall(argExpr)) return undefined;

  const containerExpr = (argExpr as FnCallExpr).func;

  // Simple atom (e.g., xs in xs(i)): generateExpr returns the C variable name
  if (exprIsAtom(containerExpr)) {
    return generateExpr(containerExpr, indent, context);
  }

  // Property chain (e.g., self->_inner in self->_inner(i)):
  // generateExpr returns C field-access expression (arrow notation for objects)
  if (exprIsFunctionCallOf(containerExpr, ".", 2)) {
    return generateExpr(containerExpr, indent, context);
  }

  // Complex expression (function call result, etc.): skip borrow tracking.
  // The static rule covers the obvious violations; the runtime backstop
  // conservatively skips cases where we can't statically identify the container.
  return undefined;
}

/**
 * Emit borrow acquire/release bracketing for interior-ref arguments at a call site.
 * Returns the list of container C codes that were acquired (caller must emit releases).
 */
function emitBorrowAcquires(
  runtimeArgExprs: Expr[],
  runtimeParams: { isRef?: boolean }[],
  indent: string,
  context: CodeGenContext
): string[] {
  const containers: string[] = [];
  for (
    let ai = 0;
    ai < runtimeArgExprs.length && ai < runtimeParams.length;
    ai++
  ) {
    const containerCode = getInteriorRefContainerCode(
      runtimeArgExprs[ai]!,
      runtimeParams[ai],
      indent,
      context
    );
    if (containerCode) {
      containers.push(containerCode);
      context.emitter.emitLine(
        `${indent}__yo_borrow_acquire((void*)(${containerCode}));`
      );
    }
  }
  return containers;
}

/**
 * Emit borrow releases (LIFO order) for containers acquired by emitBorrowAcquires.
 */
function emitBorrowReleases(
  containers: string[],
  indent: string,
  context: CodeGenContext
): void {
  for (let ai = containers.length - 1; ai >= 0; ai--) {
    context.emitter.emitLine(
      `${indent}__yo_borrow_release((void*)(${containers[ai]!}));`
    );
  }
}

/**
 * Check whether the current function being generated is a method of an
 * RC-managed object type (i.e., has a `self` parameter whose type is an
 * object with a borrow_count in its RC header).
 */
function isInsideObjectMethod(context: CodeGenContext): boolean {
  const funcCtx = context as FunctionGenerationContext;
  const fnType = funcCtx.currentFunctionType;
  if (!fnType || !fnType.parameters[0]) return false;
  const selfParam = fnType.parameters[0];
  if (selfParam.label !== "self") return false;
  return isReferenceStructType(selfParam.type);
}

/**
 * Auto-emit __yo_borrow_assert_unborrowed before a realloc/free call inside
 * an RC-managed object method. This turns the interior-ref-into-reallocated-
 * buffer residual into a deterministic panic without requiring manual
 * annotations in container code.
 *
 * Conservative: asserts on EVERY realloc/free inside an object method, not
 * just those operating on self's buffer. False positives are negligible in
 * practice — an object method that frees/reallocs a buffer NOT owned by self
 * while self is simultaneously borrowed is a pathologically contrived shape.
 */
function maybeEmitAutoBorrowAssert(
  externFuncName: string,
  _expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): void {
  // Only intercept realloc and free — the two operations that invalidate
  // existing buffers (realloc moves, free releases).
  if (externFuncName !== "__yo_realloc" && externFuncName !== "__yo_free")
    return;
  if (!isInsideObjectMethod(context)) return;

  // Emit the assertion on self before the realloc/free call.
  context.emitter.emitLine(
    `${indent}__yo_borrow_assert_unborrowed((void*)self);`
  );
}

/**
 * Other function call
 */
export function generateOtherFunctionCall(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string | undefined {
  // If the expression has a compile-time value (not UnknownValue), generate it directly.
  // This handles CTFE functions, compile-time evaluated calls like `assert(true)`, etc.
  if (expr.$?.value !== undefined && !isUnknownValue(expr.$.value)) {
    // Handle deferred drop expressions if they exist
    if (expr.$?.deferredDropExpressions) {
      generateDeferredDropExpressions(expr, indent, context);
    }
    // For unit type, no code needed
    if (isUnitType(expr.$.type)) {
      return "";
    }
    // For non-unit types, generate the compile-time value
    return generateComptimeValue(expr.$.value, context, expr);
  }

  // Mutual-recursion bridge: when a `comptime(name) : (fn ...)` variable's
  // body was evaluated before the matching `name = ...` assignment, the
  // body's call to `name(...)` captured an UnknownValue. The assignment
  // later back-patches that UnknownValue with the funcId; resolve it
  // here so codegen emits a direct call instead of routing through the
  // fn-pointer-cast fallback (which would print a raw `name` identifier
  // with no C declaration). See UnknownValue.resolvedFuncValueId.
  let functionValue = expr.func.$?.value;
  const rawFnValue = Array.isArray(functionValue)
    ? functionValue[0]
    : functionValue;
  if (
    rawFnValue &&
    isUnknownValue(rawFnValue) &&
    rawFnValue.resolvedFuncValueId
  ) {
    const resolved = context.functions[rawFnValue.resolvedFuncValueId]?.value;
    if (resolved && isFunctionValue(resolved)) {
      functionValue = resolved;
    }
  }
  const functionType =
    expr.func.$?.type ??
    (isFunctionValue(functionValue)
      ? (functionValue.specializedType ?? functionValue.type)
      : undefined);

  if (isFunctionType(functionType)) {
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;

    if (runtimeArgExprs) {
      // Check if this is a method call on a dyn object
      let isDynMethodCall = false;
      if (
        exprIsFunctionCall(expr.func) &&
        exprIsFunctionCallOf(expr.func, ".", 2)
      ) {
        const objectExpr = expr.func.args[0];
        const objectType = objectExpr?.$?.type;
        if (objectType && isDynType(objectType)) {
          isDynMethodCall = true;
        }
      }

      // Pre-compute which runtime parameter positions are `ref`-bound so
      // the arg-materializer below can skip the temp-var copy for them.
      // Materializing `(*self).field` into a local temp and then taking
      // `&(temp)` breaks mutation propagation through the field — the
      // local temp's mutations don't reach the original field. This was
      // the iterator-combinator chain bug: `IterMap.next`'s body called
      // `self._inner.next()`, but the codegen copied `(*self)._inner`
      // into a local, called next on `&(local)`, and discarded the
      // local — leaving the inner iterator's index unchanged across
      // calls and causing the chain to infinite-loop yielding the same
      // first element.
      const _runtimeParamsForRefCheck = functionType.parameters.filter(
        (p) => !p.isCompileTimeOnly && !p.isQuote
      );
      // Generate arg list with special handling for dyn method calls
      const args = runtimeArgExprs.map((arg, index) => {
        const paramIsRef = _runtimeParamsForRefCheck[index]?.isRef === true;
        // First, check if this argument needs a temporary variable
        if (arg.$?.variableName && arg.$?.type) {
          const functionContext = context as FunctionGenerationContext;

          // Check if this variable is captured by a closure
          const isClosureCapturedVariable =
            functionContext.currentClosureCaptures &&
            functionContext.currentClosureCaptures.includes(
              arg.$.variableName
            ) &&
            exprIsAtom(arg) &&
            arg.$.env &&
            functionContext.currentClosureCaptureFrameLevel !== undefined &&
            checkVariableIsClosureCaptured(
              arg.token.value,
              arg.$.env,
              functionContext.currentClosureCaptureFrameLevel
            );

          // Generate the argument expression and declare it as a temp variable
          let argCode = generateExpr(arg, indent, context);

          // If the arg is a function-typed variable, look up its FunctionValue
          // in the call site env and use the function C name.
          const callSiteEnv = expr.$?.env ?? expr.func.$?.env ?? arg.$?.env;
          if (exprIsAtom(arg) && arg.$.variableName && callSiteEnv) {
            const varName = arg.$.variableName;
            const argVars = getVariablesFromEnv(callSiteEnv, varName);
            if (argVars.length === 0 && arg.$?.env) {
              // Fallback: try the arg's own env
              const fallbackVars = getVariablesFromEnv(arg.$.env, varName);
              argVars.push(...fallbackVars);
            }
            const argVar = argVars[argVars.length - 1];
            const argVal = argVar?.value?.[0];
            if (
              argVal &&
              isFunctionValue(argVal) &&
              context.functions[argVal.funcId]?.cName
            ) {
              argCode = context.functions[argVal.funcId]!.cName!;
            }
          }

          // Check if this is a compile-time-only constant (e.g., AF_INET :: i32(2)).
          // In that case, generateExpr already inlined the value (e.g., "2"),
          // so we must NOT create a temp variable with the original name because
          // it could conflict with C preprocessor macros (e.g., AF_INET from <sys/socket.h>).
          let isComptimeOnlyArg = false;
          // Check if this is an ref parameter (e.g., `inout(self) : T`).
          // For inout, atom.ts already emitted `(*name)` — creating a temp
          // local with the same name would shadow the pointer parameter
          // (`T name = (*name);` is a C redefinition error). See
          // plans/MEMORY_SAFETY.md and issues/inout-multi-stmt-body-shadow.md.
          let isRefArg = false;
          if (exprIsAtom(arg) && arg.$.env && arg.$.variableName) {
            const variables = getVariablesFromEnv(
              arg.$.env,
              arg.$.variableName
            );
            if (
              variables.length > 0 &&
              variables[variables.length - 1]!.isCompileTimeOnly
            ) {
              isComptimeOnlyArg = true;
            }
            if (
              variables.length > 0 &&
              variables[variables.length - 1]!.isRef
            ) {
              isRefArg = true;
            }
          }

          // Check if this variable is captured by a state machine
          const isStateMachineCapturedVariable =
            (functionContext.inAsyncStateMachine ||
              functionContext.inEffectStateMachine) &&
            argCode.startsWith("sm->");

          // Track whether we emitted a temp variable declaration
          let emittedTempVarDeclaration = false;

          // A deferred `___dup` that targets THIS argument's own eval temp
          // forces the temp declaration even for closure/state-machine
          // captured accesses: the dup names the temp
          // (`___dup(<temp>)`), so skipping the declaration emits an
          // undeclared C identifier and loses the raw read (aliasing
          // Stage 0 projection dups on `self._buf` inside an async loop
          // surfaced the SM case). The capture exclusions below exist to
          // avoid REDUNDANT copies of already-addressable storage — a
          // dup-carrying arg needs the materialization regardless.
          let argDupForcesTempDeclaration = false;
          if (
            arg.$?.variableName &&
            arg.$?.deferredDupExpressions &&
            arg.$.deferredDupExpressions.length > 0
          ) {
            const argTempCName = getVariableNameForCodegen(
              arg.$.variableName,
              arg.$.env
            );
            argDupForcesTempDeclaration = arg.$.deferredDupExpressions.some(
              (e) => {
                const target = getDeferredDupTargetAtomName(e);
                return (
                  !!target &&
                  getVariableNameForCodegen(target, e.$?.env) === argTempCName
                );
              }
            );
          }

          if (
            argCode &&
            argCode !== arg.$.variableName &&
            ((!isClosureCapturedVariable && !isStateMachineCapturedVariable) ||
              argDupForcesTempDeclaration) &&
            !isComptimeOnlyArg &&
            !isRefArg &&
            !paramIsRef
          ) {
            // Only emit declaration if:
            // 1. The expression doesn't already handle it
            // 2. It's not a closure-captured variable (those are accessed inline from closure_context->data)
            // 3. It's not a state machine variable (those are accessed via sm->var_xxx)
            // 4. It's not a redundant self-assignment (e.g., int32_t errno_ = errno_)
            const sanitizedVarName = getVariableNameForCodegen(
              arg.$.variableName,
              arg.$.env
            );
            if (argCode !== sanitizedVarName) {
              // Use convertedRuntimeType if available (e.g., comptime_str -> str)
              const effectiveType = arg.$.convertedRuntimeType || arg.$.type;
              const varTypeAndName = getVariableTypeString(
                effectiveType,
                arg.$.variableName,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${argCode};`
              );
              emittedTempVarDeclaration = true;
              storeTempVarToStateMachineIfNeeded(
                arg.$.variableName,
                indent,
                context
              );
            }
          }

          // Handle deferred dup expressions for function arguments
          // After generating the argument temp variable, check if we need to dup it
          // Start with argCode (which may be aliased) instead of arg.$.variableName
          let finalArgVarName = emittedTempVarDeclaration
            ? arg.$.variableName
            : argCode;
          if (
            arg.$?.deferredDupExpressions &&
            arg.$.deferredDupExpressions.length > 0
          ) {
            // Only treat deferred dup as a replacement for the argument value
            // when it actually targets this argument. For example, closure
            // construction may carry deferred dups for captured variables; those
            // must be applied during capture initialization, not substituted as
            // the call argument.
            const argTargets = new Set<string>();
            if (arg.$?.variableName) {
              argTargets.add(
                getVariableNameForCodegen(arg.$.variableName, arg.$.env)
              );
            }
            if (argCode) {
              argTargets.add(argCode);
            }
            if (exprIsAtom(arg)) {
              argTargets.add(
                getVariableNameForCodegen(arg.token.value, arg.$.env)
              );
            }

            const matchingDupExpr = arg.$.deferredDupExpressions.find((e) => {
              const target = getDeferredDupTargetAtomName(e);
              if (!target) return false;
              return argTargets.has(
                getVariableNameForCodegen(target, e.$?.env)
              );
            });

            if (matchingDupExpr) {
              generateDeferredDupExpressions(arg, indent, functionContext);
              if (
                exprIsFunctionCall(matchingDupExpr) &&
                matchingDupExpr.$?.variableName
              ) {
                finalArgVarName = getVariableNameForCodegen(
                  matchingDupExpr.$.variableName,
                  matchingDupExpr.$.env
                );
              }
            }
          }

          // For dyn method calls, transform the first argument (self) from dyn object to data pointer
          // EXCEPT for dyn object's own methods (which are in the dyn type's .trait)
          if (isDynMethodCall && index === 0) {
            // Check if this method exists in the dyn type's own trait
            if (
              exprIsFunctionCall(expr.func) &&
              exprIsFunctionCallOf(expr.func, ".", 2)
            ) {
              const objectExpr = expr.func.args[0];
              const dynType = objectExpr?.$?.type;
              const methodExpr = expr.func.args[1];

              if (exprIsAtom(methodExpr) && isDynType(dynType)) {
                const methodName = methodExpr.token.value;
                // Check if this method exists in the dyn type's trait
                const dynMethod = dynType.trait.fields.find(
                  (field) => field.label === methodName
                );

                if (dynMethod) {
                  // This is a dyn object's own method, pass the dyn object directly
                  return isStateMachineCapturedVariable
                    ? argCode
                    : sanitizeForCIdentifier(
                        finalArgVarName,
                        arg.$.type.isExtern === "c"
                      );
                }
              }
            }

            // For all other methods (wrapped object methods), pass the wrapped object data
            // Dyn is a value type, but callers may pass a borrow (pointer) depending on the method signature.
            const argType = arg.$?.type;
            if (argType && isPtrType(argType)) {
              return isStateMachineCapturedVariable
                ? `${argCode}->data`
                : `${sanitizeForCIdentifier(finalArgVarName, arg.$.type.isExtern === "c")}->data`;
            }
            return isStateMachineCapturedVariable
              ? `(${argCode}).data`
              : `(${sanitizeForCIdentifier(finalArgVarName, arg.$.type.isExtern === "c")}).data`;
          } else {
            // If this is a closure-captured variable, use the generated code (inline access)
            // If this is a state machine variable, use the generated code (sm->var_xxx access)
            // If this is a compile-time-only constant, use the generated code (inlined literal)
            // If this is an ref parameter, use the generated code — it's
            // already `(*name)` and we skipped the temp-var materialization
            // above (the shadow would have been a C redefinition error).
            // If the target param is `ref` (paramIsRef), we also skipped
            // the temp materialization above — return the place expression
            // (e.g. `(*self)._inner`) directly so the isRef-wrapper at line
            // ~518 can take its address without copying. See the iterator
            // combinator chain fix.
            // Otherwise use the sanitized variable name (potentially duped)
            return isClosureCapturedVariable ||
              isStateMachineCapturedVariable ||
              isComptimeOnlyArg ||
              isRefArg ||
              paramIsRef
              ? argCode
              : sanitizeForCIdentifier(
                  finalArgVarName,
                  arg.$.type.isExtern === "c"
                );
          }
        } else {
          // For dyn method calls, transform the first argument (self) from dyn object to data pointer
          // EXCEPT for dyn object's own methods (which are in the dyn type's .trait)
          if (isDynMethodCall && index === 0) {
            const dynObjectCode = generateExpr(arg, indent, context);

            // Check if this method exists in the dyn type's own trait
            if (
              exprIsFunctionCall(expr.func) &&
              exprIsFunctionCallOf(expr.func, ".", 2)
            ) {
              const objectExpr = expr.func.args[0];
              const dynType = objectExpr?.$?.type;
              const methodExpr = expr.func.args[1];

              if (exprIsAtom(methodExpr) && isDynType(dynType)) {
                const methodName = methodExpr.token.value;
                // Check if this method exists in the dyn type's trait
                const dynMethod = dynType.trait.fields.find(
                  (field) => field.label === methodName
                );

                if (dynMethod) {
                  // This is a dyn object's own method, pass the dyn object directly
                  return dynObjectCode;
                }
              }
            }

            // For all other methods (wrapped object methods), pass the wrapped object data
            const argType = arg.$?.type;
            if (argType && isPtrType(argType)) {
              return `(${dynObjectCode})->data`;
            }
            return `(${dynObjectCode}).data`;
          } else {
            return generateExpr(arg, indent, context);
          }
        }
      });

      // inout(name) : T parameter — caller passes &(arg) automatically.
      // Match each runtime arg index to the runtime parameter at the
      // same index (filter out comptime params first). See
      // plans/MEMORY_SAFETY.md Phase B.
      //
      // Skip the auto-`&` for the receiver slot of a Dyn method call:
      // the dyn-method branch above already transformed the receiver
      // from the Dyn value to its `.data` pointer (the box address),
      // which IS the pointer that the vtable wrapper expects as a bare
      // `void*` self_ptr. Wrapping `(err).data` in `(&(...))` would
      // pass `&err.data` (address of the Dyn's data field) instead of
      // `err.data` (the box pointer value), so the vtable wrapper would
      // dereference a slot offset inside the Dyn struct instead of the
      // heap-boxed value — a stack-buffer-overflow at runtime.
      {
        const runtimeParams = functionType.parameters.filter(
          (p) => !p.isCompileTimeOnly && !p.isQuote
        );
        for (let i = 0; i < args.length; i++) {
          const param = runtimeParams[i];
          if (param?.isRef && !(isDynMethodCall && i === 0)) {
            const c = args[i]!;
            // If c is already an l-value-looking expression like
            // `(*expr)`, fold to just `expr` rather than `&(*expr)`.
            const inoutLvalue = c.match(/^\(\*(.+)\)$/);
            if (inoutLvalue) {
              args[i] = inoutLvalue[1]!;
              continue;
            }
            // If the generated arg code is a literal / rvalue (e.g.
            // `123.to_string()` where the receiver is `123`, or
            // `(1 + 2).to_string()` where the evaluator constant-folded
            // the receiver to `3`), then `&(3)` is invalid C — you
            // can't take the address of an rvalue. Wrap the literal in
            // a C99 compound literal of the arg's runtime type so the
            // address-of operates on the unnamed compound-literal
            // object instead.
            //
            // We inspect the GENERATED code string `c` because the
            // evaluator may have produced a temp `variableName` (which
            // would normally let us use the variable as an lvalue), but
            // the codegen ultimately emits the constant value rather
            // than declaring the temp — so the c-string is just a bare
            // literal in those cases.
            // Prefer the converted runtime type when present: a
            // comptime_str literal coerced to `str` records its real C
            // type (__yo_str) there, while `$.type` still says
            // comptime_str (whose default C mapping is uint8_t*).
            const argRuntimeType =
              runtimeArgExprs[i]!.$?.convertedRuntimeType ??
              runtimeArgExprs[i]!.$?.type;
            const cIsBareLiteral =
              // signed/unsigned integer literal, possibly with L/LL/U
              // suffixes, possibly negated
              /^-?[0-9]+(?:[uU]?[lL]{0,2}[uU]?)?$/.test(c) ||
              // floating-point literal with f/F suffix
              /^-?[0-9]+\.[0-9]+(?:[fFlL]?)$/.test(c) ||
              c === "true" ||
              c === "false";
            if (argRuntimeType && cIsBareLiteral) {
              const cType = getTypeString(argRuntimeType, context);
              args[i] = `(&((${cType}){${c}}))`;
              continue;
            }
            // Spill genuine RVALUES (binary exprs, calls) to a temp so `&()`
            // operates on an lvalue. ADDRESSABLE expressions must NOT be
            // spilled: a `ref` parameter mutates through the pointer, and
            // `&__yo_ref_spill_N` would hand the callee a COPY — the caller's
            // storage never changes. That regression made every
            // `it.next(ref(self))`-style call advance a copy: iterator
            // combinators hung (the real iterator never advanced) or aborted
            // (tests/iterator_combinators.test.yo, found by bisect). C
            // lvalues here: bare identifiers, derefs `(*p)`, member chains
            // `a.b` / `a->b`, and subscripts `a[i]` — `&` is valid on all.
            if (isAddressableCExpr(c)) {
              args[i] = `(&(${c}))`;
            } else {
              // comptime_str args materialize as __yo_str (mirrors the
              // comptime-value fallback) — the spill var must match.
              const spillType = argRuntimeType
                ? isComptimeStringType(argRuntimeType)
                  ? "__yo_str"
                  : getTypeString(argRuntimeType, context)
                : "size_t";
              const spillName = `__yo_ref_spill_${refSpillCounter++}`;
              context.emitter.emitLine(
                `${indent}${spillType} ${spillName} = ${c};`
              );
              args[i] = `(&(${spillName}))`;
            }
          }
        }
      }

      const argsList = args.join(", ");

      // Check if this is an extern "yo" function - handle these first before regular function values
      if (functionType.isExtern === "yo" && functionType.externName) {
        const externFuncName = functionType.externName;

        // Auto-assert borrow before realloc/free on a buffer derived from self
        // inside an RC-managed object method. Turns the interior-ref-into-
        // reallocated-buffer residual into a deterministic panic without
        // requiring manual annotation in container code.
        maybeEmitAutoBorrowAssert(
          externFuncName,
          expr,
          indent,
          context as FunctionGenerationContext
        );

        if (BuiltinYoInlineFunctions.includes(externFuncName)) {
          return generateYoInlineFunctionCall(
            externFuncName,
            args,
            expr,
            context,
            indent
          );
        } else if (externFuncName === "__yo_thread_spawn") {
          // Special handling for __yo_thread_spawn(cb : Impl(Fn() -> unit, Send))
          // We need to:
          // 1. Find the closure function from implClosureCallMap
          // 2. Heap-allocate the closure data (since thread needs it after function returns)
          // 3. Call __yo_thread_spawn(closure_fn, heap_closure_data)
          return generateThreadSpawnCall(expr, indent, context);
        } else if (externFuncName === "__yo_worker_spawn") {
          // Special handling for __yo_worker_spawn(cb : Impl(Fn() -> unit, Send))
          // Similar to __yo_thread_spawn but spawns on the worker pool
          return generateWorkerSpawnCall(expr, indent, context);
        } else if (isUnitType(functionType.return.type)) {
          // If the function returns unit, just call it without assignment
          context.emitter.emitLine(`${indent}${externFuncName}(${argsList});`);

          // Handle deferred drop expressions if they exist
          if (expr.$?.deferredDropExpressions) {
            generateDeferredDropExpressions(expr, indent, context);
          }

          return ""; // No return value
        } else {
          return `${externFuncName}(${argsList})`;
        }
      }

      // Bare fn evidence passing: if we're inside a function with evidence params
      // and this call targets an atom that matches an evidence parameter name,
      // call through the evidence fn ptr. This must be checked BEFORE
      // isFunctionValue because inside the function body, the implicit param's
      // value is UnknownValue (body evaluated at definition time).
      {
        const functionContext = context as FunctionGenerationContext;
        if (functionContext.currentEvidenceParams?.size) {
          let atomName = expr.func.token?.value;
          let dotLeftLabel: string | undefined;
          // For dot expressions like fx.errors.raise(msg), extract the field name
          // and the left-side label to verify the call actually targets an evidence module.
          if (
            atomName === "." &&
            exprIsFunctionCall(expr.func) &&
            exprIsFunctionCallOf(expr.func, ".", 2)
          ) {
            const fieldExpr = expr.func.args[1];
            if (fieldExpr && exprIsAtom(fieldExpr)) {
              atomName = fieldExpr.token.value;
            }
            // Extract the left-side atom name (e.g., "fx" from fx.raise, "process" from process.spawn)
            const leftExpr = expr.func.args[0];
            if (leftExpr && exprIsAtom(leftExpr)) {
              dotLeftLabel = leftExpr.token.value;
            } else if (
              leftExpr &&
              exprIsFunctionCall(leftExpr) &&
              exprIsFunctionCallOf(leftExpr, ".", 2)
            ) {
              // Nested dot: fx.errors.raise → left is fx.errors, extract "fx"
              const nestedLeft = leftExpr.args[0];
              if (nestedLeft && exprIsAtom(nestedLeft)) {
                dotLeftLabel = nestedLeft.token.value;
              }
            }
          }
          if (atomName && atomName !== ".") {
            for (const ep of functionContext.currentEvidenceParams.values()) {
              if (
                ep.fieldLabel === atomName ||
                ep.implicitLabel === atomName ||
                ep.fieldPath[ep.fieldPath.length - 1] === atomName
              ) {
                // For dot expressions, verify the left side matches the evidence
                // parameter's implicit label. This prevents false matches where
                // a regular module member (e.g., process.spawn) collides with
                // an effect module member name (e.g., io.spawn).
                if (dotLeftLabel && dotLeftLabel !== ep.implicitLabel) {
                  continue;
                }
                return generateEvidenceFnPtrCall(
                  ep.cParamName,
                  functionType,
                  args,
                  runtimeArgExprs,
                  expr,
                  indent,
                  functionContext,
                  ep
                );
              }
            }
          }
        }
      }

      if (isFunctionValue(functionValue)) {
        // Check if it's function vaue whose body only contains Yo operator
        const operatorFunctionName =
          isFunctionValueWithOnlyBuiltinYoInlineFunctionCall(functionValue);
        if (operatorFunctionName) {
          return generateYoInlineFunctionCall(
            operatorFunctionName,
            args,
            expr,
            context,
            indent
          );
        }

        // Get new function type, which might be specialized.
        const functionValueType =
          functionValue.specializedType ?? functionValue.type;

        // Evidence passing: if we're inside a function with evidence params and
        // this call is toan effect record member, call through the evidence fn ptr
        // instead of inlining the handler body.
        const functionContext = context as FunctionGenerationContext;
        if (
          functionContext.currentEvidenceParams &&
          functionValue.isEffectRecordMember
        ) {
          // Find the matching evidence parameter for this function value by
          // navigating each evidence param's evidence field path in the given
          // binding environment and comparing funcIds.
          let matchedEp: EvidenceParameter | undefined;
          const callEnv = expr.func.$?.env ?? expr.$?.env;
          if (callEnv) {
            for (const ep of functionContext.currentEvidenceParams.values()) {
              const givenVars = getVariablesFromEnv(callEnv, ep.implicitLabel);
              const givenVar = givenVars[givenVars.length - 1];
              const recordVal = givenVar?.value?.[0];
              if (recordVal && isStructValue(recordVal)) {
                // Navigate fieldPath through potentially nested effect records
                let currentRecord = recordVal;
                let navigated = true;
                for (let i = 0; i < ep.fieldPath.length - 1; i++) {
                  const pathSegment = ep.fieldPath[i]!;
                  const idx = currentRecord.type.fields.findIndex(
                    (f) => f.label === pathSegment
                  );
                  if (idx >= 0 && currentRecord.fields[idx]) {
                    const nextVal = currentRecord.fields[idx]!;
                    if (isStructValue(nextVal)) {
                      currentRecord = nextVal;
                    } else {
                      navigated = false;
                      break;
                    }
                  } else {
                    navigated = false;
                    break;
                  }
                }
                if (navigated) {
                  const lastLabel = ep.fieldPath[ep.fieldPath.length - 1]!;
                  const fieldIdx = currentRecord.type.fields.findIndex(
                    (f) => f.label === lastLabel
                  );
                  if (fieldIdx >= 0) {
                    const fieldVal = currentRecord.fields[fieldIdx];
                    if (
                      fieldVal &&
                      isFunctionValue(fieldVal) &&
                      fieldVal.funcId === functionValue.funcId
                    ) {
                      matchedEp = ep;
                      break;
                    }
                  }
                }
              }
            }
          }
          if (matchedEp) {
            const funcCode = matchedEp.cParamName;
            return generateEvidenceFnPtrCall(
              funcCode,
              functionValueType,
              args,
              runtimeArgExprs,
              expr,
              indent,
              functionContext,
              matchedEp
            );
          }
          // No matching evidence parameter found — this function is in a module
          // but is NOT an effect handler member. Fall through to normal call path.
        }

        // Normal function call
        const cFuncName = context.functions[functionValue.funcId]?.cName;

        if (cFuncName) {
          // Cast each runtime arg to the named callee's declared parameter
          // type. Strict C compilers (wasm/clang) treat
          // -Wincompatible-pointer-types as an error; this happens for generic
          // specialized callees where the arg's struct C type id differs from
          // the parameter's struct C type id even though they refer to the
          // same logical Yo type. Native clang only warns. The cast is a safe
          // no-op when types already match.
          // Use the SAME FunctionValue that was used to emit the C declaration
          // (stored in context.functions[funcId].value). The call-site
          // `functionValue` may diverge from that — e.g., when duplicate
          // specialization produces a different FunctionValue object whose
          // nested generic types resolve to different C struct ids than the
          // declaration's. Pulling from the registered entry ensures the cast
          // types match the declaration.
          const registeredValue =
            context.functions[functionValue.funcId]?.value ?? functionValue;
          const registeredType =
            registeredValue.specializedType ?? registeredValue.type;
          const namedRuntimeParams = registeredType.parameters.filter(
            (p) => !p.isCompileTimeOnly
          );
          // Resolve param C type strings defensively. If any param's type is
          // not yet registered (e.g., an unspecialized generic enum referenced
          // by a fallback `functionValue.type`), skip the cast entirely
          // rather than crashing — the original argsList is already valid C.
          let namedParamTypeStrs: string[] | undefined;
          try {
            namedParamTypeStrs = namedRuntimeParams.map((p) => {
              const baseStr = getTypeString(p.type, context);
              // inout(name) : T lowers to T* in C. See
              // plans/MEMORY_SAFETY.md Phase B.
              return p.isRef ? `${baseStr}*` : baseStr;
            });
          } catch {
            namedParamTypeStrs = undefined;
          }
          let namedCastedArgsList = argsList;
          if (argsList && namedParamTypeStrs && namedParamTypeStrs.length > 0) {
            const parts = splitTopLevelArgsList(argsList);
            if (parts.length === namedParamTypeStrs.length) {
              namedCastedArgsList = parts
                .map((part, i) => `(${namedParamTypeStrs![i]})(${part})`)
                .join(", ");
            }
          }
          // Evidence passing call site: callee has effect-record implicit params
          // that compile to extra C function pointer parameters.
          // Use specializedType (which now includes resolved implicits) if available,
          // otherwise fall back to original type for generic evidence params (void* cast).
          const evidenceCheckType =
            functionValue.specializedType ?? functionValue.type;
          let calleeEvidenceParams = getEvidenceParameters(evidenceCheckType);
          if (
            calleeEvidenceParams.length === 0 &&
            functionValue.specializedType
          ) {
            const fallbackParams = getEvidenceParameters(functionValue.type);
            if (
              fallbackParams.length > 0 &&
              fallbackParams.some(
                (p) =>
                  p.fieldFunctionType.forallParameters &&
                  p.fieldFunctionType.forallParameters.length > 0
              )
            ) {
              calleeEvidenceParams = fallbackParams;
            }
          }
          if (calleeEvidenceParams.length > 0) {
            const { args: evidenceArgNames, isHandlerInstallation } =
              resolveEvidenceArgsForCallSite(
                calleeEvidenceParams,
                functionValue,
                expr,
                context as FunctionGenerationContext
              );
            if (evidenceArgNames.length > 0) {
              const fullArgs = argsList
                ? `${argsList}, ${evidenceArgNames.join(", ")}`
                : evidenceArgNames.join(", ");
              return generateEvidenceCallSite(
                cFuncName,
                fullArgs,
                functionValueType,
                expr,
                runtimeArgExprs,
                indent,
                context as FunctionGenerationContext,
                isHandlerInstallation
              );
            }
          }

          // Determine if this call might trigger an effect escape.
          // Control functions / effect record members set __yo_effect_escaped.
          // Specialized effectful functions transitively call handlers.
          // Functions whose body has effects may also trigger escape transitively.
          const paramHasCtlField =
            functionType &&
            functionType.parameters.some((p) => {
              if (isStructType(p.type)) {
                return p.type.fields.some(
                  (f) => isFunctionType(f.type) && f.type.isControl
                );
              }
              return false;
            });
          const callMayUnwind =
            (isFunctionValue(functionValue) &&
              functionValue.isControlFunction) ||
            (isFunctionValue(functionValue) &&
              functionValue.isEffectRecordMember) ||
            (isFunctionValue(functionValue) &&
              functionValue.body?.$?.effectAnalysis?.hasEffects) ||
            // Effect-record-field call shape: `exn.throw(...)` where the
            // callee is a property access on an effect-record value and the
            // resolved function type is a `ctl(...) -> R`. The handler is
            // free to call `unwind(...)` which sets __yo_effect_escaped, so
            // we must propagate after the call.
            (functionType &&
              isFunctionType(functionType) &&
              functionType.isControl) ||
            // Callee takes an effect-record parameter whose struct has at
            // least one `ctl(...)` field (e.g. `exn : Exception` whose
            // `throw` is `ctl(...) -> R`). The callee may call into that
            // handler and transitively unwind. Without this, code like
            // `fn(s : str, exn : Exception) -> T` calling exn.throw deep
            // inside its body wouldn't trigger an unwind check at the call
            // site — "should fail" assertions fire after the unwind handler
            // ran but before the caller observes __yo_effect_escaped.
            paramHasCtlField ||
            // Fallback: function has function-typed params that may be handlers
            (functionType &&
              functionType.parameters.some((p) => isFunctionType(p.type))) ||
            // Fallback: direct call to an atom whose type is a function type
            // (but functionValue may not be a FunctionValue after Phase 2)
            (functionType &&
              isFunctionType(functionType) &&
              exprIsAtom(expr.func));
          // For specialized effectful functions, check if this is the handler
          // installation point (where the unwind value should be extracted
          // rather than just propagated).
          let callIsHandlerInstallation = false;
          if (callMayUnwind) {
            if (
              isFunctionValue(functionValue) &&
              (functionValue.isControlFunction ||
                functionValue.isEffectRecordMember)
            ) {
              // Direct call to a control/handler function.
              // Check if the function was bound via `given` in a begin-block
              // frame within the current function's scope. This distinguishes
              // body-level given bindings (handler installation) from function
              // parameter bindings (using params, which are handler usage).
              const callEnv = expr.func?.$?.env ?? expr.$?.env;
              if (callEnv) {
                const frameIdx = findInnermostFrameWithGivenVariable(
                  callEnv,
                  (v) =>
                    isFunctionValue(v.value?.[0]) &&
                    v.value![0].funcId ===
                      (functionValue as FunctionValue).funcId
                );
                if (
                  frameIdx >= 0 &&
                  frameIdx > callEnv.functionDeclarationFrameLevel &&
                  callEnv.frames[frameIdx]?.isBeginBlockFrame
                ) {
                  callIsHandlerInstallation = true;
                }
              }
            } else if (
              isFunctionValue(functionValue) &&
              functionValue.specializedType
            ) {
              // For specialized effectful functions, check if any of the
              // callee's evidence parameters were provided by a local `given`
              // binding in a begin-block frame (handler installation) vs
              // forwarded from the caller's own `using` params (propagation).
              const origEvidenceParams = getEvidenceParameters(
                functionValue.type
              );
              if (origEvidenceParams.length > 0) {
                const callEnv = expr.func?.$?.env ?? expr.$?.env;
                if (callEnv) {
                  for (const ep of origEvidenceParams) {
                    const frameIdx = findInnermostFrameWithGivenVariable(
                      callEnv,
                      (v) =>
                        v.name === ep.implicitLabel || v.name === ep.fieldLabel
                    );
                    if (
                      frameIdx >= 0 &&
                      frameIdx > callEnv.functionDeclarationFrameLevel &&
                      callEnv.frames[frameIdx]?.isBeginBlockFrame
                    ) {
                      callIsHandlerInstallation = true;
                      break;
                    }
                  }
                }
              }
            }
            // Fallback for explicit params (Phase 2): if the callee has a
            // function-typed regular param OR a struct/effect-record param
            // whose type transitively carries a `ctl(...)` field (e.g.
            // `exn : Exception`), check whether the argument variable is
            // locally bound in a begin-block frame of the enclosing
            // function — that makes the call site the handler installation
            // point for any unwind raised inside the callee.
            //
            // We match against the call's *argument atoms* rather than the
            // param labels so a renamed binding like `local_exn` for an
            // `exn` param still resolves to the local frame.
            if (!callIsHandlerInstallation && functionType) {
              const callEnv2 = expr.func.$?.env ?? expr.$?.env;
              if (callEnv2) {
                for (let i = 0; i < functionType.parameters.length; i++) {
                  const param = functionType.parameters[i]!;
                  const paramIsFn = isFunctionType(param.type);
                  const paramHasCtl = typeIsControlBound(param.type);
                  if (!paramIsFn && !paramHasCtl) continue;
                  // Resolve the argument variable name passed for this param.
                  const argExpr = expr.args[i];
                  let argVarName: string | undefined;
                  if (argExpr && exprIsAtom(argExpr)) {
                    argVarName = argExpr.token.value;
                  } else if (param.label) {
                    // Named-arg desugar: arg labels match param labels.
                    argVarName = param.label;
                  }
                  if (!argVarName) continue;
                  const frameIdx = findInnermostFrameWithGivenVariable(
                    callEnv2,
                    (v) => v.name === argVarName
                  );
                  if (
                    frameIdx < 0 ||
                    frameIdx <= callEnv2.functionDeclarationFrameLevel ||
                    !callEnv2.frames[frameIdx]?.isBeginBlockFrame
                  ) {
                    continue;
                  }
                  callIsHandlerInstallation = true;
                  break;
                }
              }
            }
          }

          // Generate function call
          if (isUnitType(functionValueType.return.type)) {
            // Acquire borrow flags for interior-ref arguments before the call
            const borrowContainers = emitBorrowAcquires(
              runtimeArgExprs,
              _runtimeParamsForRefCheck as { isRef?: boolean }[],
              indent,
              context as FunctionGenerationContext
            );

            // If the function returns unit, just call it without assignment
            // Clear __yo_effect_escaped before the call so a stale flag from
            // a previous unwind (already handled by a higher-level handler)
            // doesn't leak into this call's escape check.
            if (callMayUnwind) {
              context.emitter.emitLine(`${indent}__yo_effect_escaped = 0;`);
            }
            context.emitter.emitLine(
              `${indent}${cFuncName}(${namedCastedArgsList});`
            );

            // Release borrow flags after the call (before deferred drops and unwind check,
            // so the release runs even if the callee set __yo_effect_escaped)
            emitBorrowReleases(
              borrowContainers,
              indent,
              context as FunctionGenerationContext
            );

            // Handle deferred drop expressions if they exist
            if (expr.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(expr, indent, context);
            }

            // unwind check: if callee may set __yo_effect_escaped, propagate
            if (callMayUnwind) {
              emitEffectUnwindCheck(
                indent,
                context as FunctionGenerationContext,
                callIsHandlerInstallation,
                expr
              );
            }

            return ""; // No return value
          } else {
            // If it returns a value, assign to a temp variable
            const tempVar = expr.$?.variableName;
            if (tempVar) {
              // For Impl(Future(...)), use the actual function return type to get the correct state machine type
              const returnType =
                functionValue.specializedType?.return.type ??
                functionValueType.return.type;
              const exprType = expr.$?.type;

              // Check if both types implement Future
              const exprIsFuture = exprType && typeImplementsFuture(exprType);
              const returnIsFuture =
                returnType && typeImplementsFuture(returnType);

              let cTypeString: string;
              if (exprIsFuture && returnIsFuture) {
                // For Future types, we need to get the correct state machine struct name
                // The function's body should have an async block with the correct struct name
                // The body might be wrapped in a begin() block, so we need to unwrap it
                let funcBody = functionValue.body;

                // If body is begin(async(...)), unwrap to get the async block
                if (funcBody && exprIsFunctionCallOf(funcBody, "begin")) {
                  const beginArgs = (funcBody as FnCallExpr).args;
                  if (beginArgs.length > 0) {
                    const lastArg = beginArgs[beginArgs.length - 1]!;
                    if (isIoAsyncCall(lastArg)) {
                      funcBody = lastArg;
                    }
                  }
                }

                if (
                  funcBody &&
                  isIoAsyncCall(funcBody) &&
                  funcBody.$?.asyncStateMachineStructName
                ) {
                  // Use the async block's registered struct name directly
                  const asyncStructName =
                    funcBody.$.asyncStateMachineStructName;
                  cTypeString = `${asyncStructName}*`;

                  // Store the mapping for variable binding later
                  if (!context.tempVarAsyncStructNames) {
                    context.tempVarAsyncStructNames = new Map();
                  }
                  context.tempVarAsyncStructNames.set(tempVar, asyncStructName);
                } else {
                  // Fallback: function delegates to another Future-returning function
                  // (e.g., File.open calls File.open_with). Use exprType if it has
                  // resolvedConcreteType, otherwise fall back to returnType.
                  if (
                    exprType &&
                    isSomeType(exprType) &&
                    exprType.resolvedConcreteType
                  ) {
                    cTypeString = getTypeString(exprType, context);
                  } else {
                    cTypeString = getTypeString(returnType, context);
                  }
                }
              } else {
                // Use returnType (from function signature) instead of exprType (from expression metadata)
                // because exprType might have unresolved type parameters from nested generic calls
                cTypeString = getTypeString(returnType ?? exprType, context);
              }

              // Phase B of plans/archive/ITERATOR_REDESIGN.md — for a function
              // whose return slot is `-> ref(T)`, the C signature returns
              // `T*`. The temp variable that holds the result must
              // therefore be declared `T*` too. The evaluator marks
              // such temp variables with `isRef: true` (in
              // `attachTempVariableToExpr`); the existing ref-aware
              // atom emitter handles `(*temp)` auto-deref on read.
              if (
                functionValueType.return.isRef &&
                !cTypeString.endsWith("*")
              ) {
                cTypeString = `${cTypeString}*`;
              }

              // Acquire borrow flags for interior-ref arguments before the call
              const borrowContainers = emitBorrowAcquires(
                runtimeArgExprs,
                _runtimeParamsForRefCheck as { isRef?: boolean }[],
                indent,
                context as FunctionGenerationContext
              );

              // Guard against duplicate temp variable declarations.
              // This can happen when the same sub-expression is traversed
              // multiple times (e.g., begin block dup handling).
              const funcCtx = context as FunctionGenerationContext;
              if (!funcCtx.declaredTempVars)
                funcCtx.declaredTempVars = new Set();
              if (!funcCtx.declaredTempVars.has(tempVar)) {
                funcCtx.declaredTempVars.add(tempVar);
                // Clear __yo_effect_escaped before the call so a stale flag from
                // a previous unwind (already handled by a higher-level handler)
                // doesn't leak into this call's escape check.
                if (callMayUnwind) {
                  context.emitter.emitLine(`${indent}__yo_effect_escaped = 0;`);
                }
                context.emitter.emitLine(
                  `${indent}${cTypeString} ${tempVar} = ${cFuncName}(${namedCastedArgsList});`
                );
              }
              storeTempVarToStateMachineIfNeeded(tempVar, indent, context);

              // Release borrow flags after the call
              emitBorrowReleases(
                borrowContainers,
                indent,
                context as FunctionGenerationContext
              );

              // Handle deferred drop expressions if they exist
              if (expr.$?.deferredDropExpressions) {
                generateDeferredDropExpressions(expr, indent, context);
              }

              // unwind check: if callee may set __yo_effect_escaped, propagate
              if (callMayUnwind) {
                emitEffectUnwindCheck(
                  indent,
                  context as FunctionGenerationContext,
                  callIsHandlerInstallation,
                  expr
                );
              }

              return tempVar; // Return the temp variable name
            } else {
              // Error: regular function call returns non-unit type but no temp variable assigned
              return `// Error: Regular function call returns ${getTypeString(functionValue.specializedType?.return.type ?? functionValueType.return.type, context)} but no temp variable assigned`;
            }
          }
        }
      } else {
        const externFunction = context.externFunctions[functionType.id];
        if (externFunction) {
          // Generate regular extern function call
          const cFuncName = externFunction.cName;

          // Handle deferred drop expressions if they exist
          if (expr.$?.deferredDropExpressions) {
            generateDeferredDropExpressions(expr, indent, context);
          }

          return `${cFuncName}(${argsList})`;
        } else {
          // Function parameter call (e.g., callback(x))
          // When calling through a void* (e.g., a captured function-typed variable),
          // we need to cast it to the proper function pointer type.
          const funcCode = generateExpr(expr.func, indent, context);

          // Check if the function value has evidence params (e.g., delegation wrappers
          // not in context.functions but compiled with evidence parameter prototypes)
          if (functionValue && isFunctionType(functionValue.type)) {
            const calleeEvidence = getEvidenceParameters(functionValue.type);
            if (calleeEvidence.length > 0) {
              const { args: evidenceArgs, isHandlerInstallation } =
                resolveEvidenceArgsForCallSite(
                  calleeEvidence,
                  functionValue as unknown as FunctionValue,
                  expr,
                  context as FunctionGenerationContext
                );
              if (evidenceArgs.length > 0) {
                const fullArgs = argsList
                  ? `${argsList}, ${evidenceArgs.join(", ")}`
                  : evidenceArgs.join(", ");
                return generateEvidenceCallSite(
                  funcCode,
                  fullArgs,
                  functionType,
                  expr,
                  runtimeArgExprs,
                  indent,
                  context as FunctionGenerationContext,
                  isHandlerInstallation
                );
              }
            }
          }

          // Use the call expression's resolved type when available (handles generic monomorphization)
          const resolvedReturnType = expr.$?.type ?? functionType.return.type;
          const returnTypeStr = getTypeString(resolvedReturnType, context);
          const runtimeParams = functionType.parameters.filter(
            (p) => !p.isCompileTimeOnly
          );
          const paramTypeStrs = runtimeParams.map((p) =>
            getTypeString(p.type, context)
          );
          // Function-pointer signatures must include any implicit (using-)
          // params at the C ABI level — they are passed as extra args after
          // the regular params (one `void*` per evidence field, matching
          // generateFunctionPrototype's emission for the same FunctionType).
          // Without this, a fn-ptr dispatch like
          // `evaluate_expression_raw`'s `.Some(f) => f(expr, env, ctx, using(exn))`
          // would silently drop `exn__throw` at the call site, leaving the
          // callee to read garbage off the stack on the deep throw path.
          //
          // The functionType reaching this branch can lose its
          // `implicitParameters` when the fn value is destructured from a
          // generic enum (e.g. Option(F) → `.Some(f) => f(...)`), so we
          // fall back to the explicit `using(...)` arg at the call site
          // when present — one void* per atom inside `using(...)`.
          const ptrEvidenceParams = getEvidenceParameters(functionType);
          const ptrEvidenceCount = ptrEvidenceParams.length;
          // using keyword removed — effects are explicit params
          const ptrParamTypeStrs = [
            ...paramTypeStrs,
            ...Array.from({ length: ptrEvidenceCount }, () => "void*"),
          ];
          // Resolve evidence args for the fn-ptr call site.
          //   * When functionType carries the implicits, use the normal
          //     resolution flow (caller's evidence params → handler value →
          //     given() binding → SM capture → null fallback).
          //   * When functionType has lost its implicits (Option(F) etc.)
          //     but the call site has an explicit `using(name, ...)` arg,
          //     resolve each `name` from the call env directly.
          //   * Otherwise pass nulls so cast and call shapes still match.
          let ptrEvidenceArgs: string[] = [];
          if (ptrEvidenceParams.length > 0) {
            if (functionValue && isFunctionValue(functionValue)) {
              const { args: resolved } = resolveEvidenceArgsForCallSite(
                ptrEvidenceParams,
                functionValue,
                expr,
                context as FunctionGenerationContext
              );
              if (resolved.length === ptrEvidenceParams.length) {
                ptrEvidenceArgs = resolved;
              }
            }
            if (ptrEvidenceArgs.length === 0) {
              ptrEvidenceArgs = ptrEvidenceParams.map(() => "((void*)0)");
            }
          }
          // Dead code removed: using() call-site evidence resolution
          // Effects are now explicit regular params
          // ABI: a `ctl` whose ResumeType is GENERIC (`Exception.throw`'s
          // `ctl(generic(ResumeType : Type), ...) -> ResumeType`) is emitted as a
          // SINGLE `void`-returning C function — one handler serves every
          // instantiation, so it cannot return a ResumeType it does not know, and
          // `generation.ts` deliberately keeps SomeType → void for effect record
          // members. But `expr.$.type` here is the INSTANTIATED type at this call
          // site, so the cast said e.g. `Big (*)(dyn)` while the callee really is
          // `void f(dyn)`.
          //
          // That is UB in C at any size, and on x86_64 SysV it CORRUPTS THE
          // CALLEE'S ARGUMENT when the instantiated type is >16 bytes (MEMORY
          // class): the caller passes a hidden sret pointer, which consumes RDI,
          // displacing `err` to RSI/RDX — so a handler that reads `err.vtable`
          // dispatches through the caller's stack slot. Demonstrated in
          // issues/repros/ctl-large-resume-type-sret{.yo,-abi-demo.c}: the
          // cross-compiled call site emits `leaq -40(%rbp), %rdi`.
          //
          // Cast to the callee's REAL return type and use the zero-init-temp
          // protocol below. That is exactly what the evidence-parameter call path
          // already does (`handlerReturnsVoid`, generateEvidenceCallSite) — the
          // two protocols disagreeing is the bug. Note assigning a void call's
          // "result" to a typed temp is itself UB and once crashed on WASM, hence
          // the declare-then-call shape rather than a cast at the assignment.
          // See issues/ctl-handler-void-signature-vs-sret-cast.md.
          const calleeEmittedVoid =
            isFunctionType(functionType) &&
            functionType.isControl &&
            isSomeType(functionType.return.type);
          const fnPtrCast = `((${calleeEmittedVoid ? "void" : returnTypeStr} (*)(${ptrParamTypeStrs.join(", ")}))${funcCode})`;

          // Cast each runtime arg to its corresponding parameter type. This
          // avoids -Wincompatible-pointer-types errors from strict C compilers
          // (e.g., wasm/clang) when the function pointer cast's parameter
          // types don't match the actual call-site argument types — common
          // for generic Clone impls where the declared param is SomeType
          // (typed as `void*`/`void**` in C) but the call site passes a
          // concrete struct pointer.
          let castedArgsList = argsList;
          if (argsList && paramTypeStrs.length > 0) {
            const parts = splitTopLevelArgsList(argsList);
            if (parts.length === paramTypeStrs.length) {
              castedArgsList = parts
                .map((part, i) => `(${paramTypeStrs[i]})(${part})`)
                .join(", ");
            }
          }
          // Append evidence args to the cast/call so they survive the
          // function-pointer dispatch.
          if (ptrEvidenceArgs.length > 0) {
            castedArgsList = castedArgsList
              ? `${castedArgsList}, ${ptrEvidenceArgs.join(", ")}`
              : ptrEvidenceArgs.join(", ");
          }

          // Detect effect record member calls in async SM context
          // (e.g., sm->__capture.throw(arg) — handler may escape)
          const functionContext = context as FunctionGenerationContext;
          const isEffectRecordCapture =
            funcCode.includes("__capture.") &&
            !!functionContext.inAsyncStateMachine;

          if (isEffectRecordCapture) {
            context.emitter.emitLine(`${indent}__yo_effect_escaped = 0;`);
          } else if (isFunctionType(functionType) && functionType.isControl) {
            // Clear before indirect ctl call (e.g. exn.throw(error))
            context.emitter.emitLine(`${indent}__yo_effect_escaped = 0;`);
          }

          if (
            isUnitType(functionType.return.type) ||
            isUnitType(resolvedReturnType)
          ) {
            // If the function returns unit, just call it without assignment
            context.emitter.emitLine(
              `${indent}${fnPtrCast}(${castedArgsList});`
            );

            // Handle deferred drop expressions if they exist
            if (expr.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(expr, indent, context);
            }

            // unwind check for direct handler calls (only when functionValue
            // is not available — indicating a local variable, not a module fn).
            // Install vs propagate: the call site is a handler installation
            // point only when the function value (atom) is bound in a local
            // begin-block frame within the current function; if the atom
            // refers to a function parameter, the unwind must propagate.
            if (
              isFunctionType(functionType) &&
              exprIsAtom(expr.func) &&
              !functionValue
            ) {
              emitEffectUnwindCheck(
                indent,
                context as FunctionGenerationContext,
                isHandlerAtomBoundLocally(expr.func, expr),
                expr
              );
            } else if (
              // Effect-record-field call shape: `exn.throw(...)` where the
              // callee is a property access on an effect-record value (and
              // the resolved function type is `ctl(...)`). The handler may
              // call `unwind(...)`, which sets __yo_effect_escaped — we
              // must propagate after the call.
              isFunctionType(functionType) &&
              functionType.isControl &&
              !exprIsAtom(expr.func)
            ) {
              emitEffectUnwindCheck(
                indent,
                context as FunctionGenerationContext,
                false, // propagation, not install
                expr
              );
            }

            if (isEffectRecordCapture) {
              context.emitter.emitLine(`${indent}if (__yo_effect_escaped) {`);
              // Drop RC-typed arguments that won't be dropped by the escaped handler
              if (runtimeArgExprs) {
                for (const arg of runtimeArgExprs) {
                  if (
                    arg.$?.variableName &&
                    arg.$?.type &&
                    typeContainsRcType(arg.$.type)
                  ) {
                    const argVarName = resolveVarNameInContext(
                      sanitizeForCIdentifier(arg.$.variableName),
                      context
                    );
                    const dropCode = generateDropCodeForValue(
                      argVarName,
                      arg.$.type,
                      context
                    );
                    if (dropCode) {
                      context.emitter.emitLine(`${indent}  ${dropCode};`);
                      // Zero SM field to prevent double-drop in dispose
                      context.emitter.emitLine(
                        `${indent}  memset(&${argVarName}, 0, sizeof(${argVarName}));`
                      );
                    }
                  }
                }
              }
              emitAsyncFutureEscape({
                emitter: context.emitter,
                indent: indent + "  ",
                resultCode: undefined,
                debugLabel: undefined,
              });
              context.emitter.emitLine(`${indent}}`);
            }

            return ""; // No return value
          } else {
            // If it returns a value, assign to a temp variable or return directly
            const tempVar = expr.$?.variableName;
            if (tempVar) {
              // For Impl(Future(...)), use the actual function return type to get the correct state machine type
              const returnType = functionType.return.type;
              const exprType = expr.$?.type;
              const typeToUse =
                exprType &&
                returnType &&
                typeImplementsFuture(exprType) &&
                typeImplementsFuture(returnType)
                  ? returnType // Use function's return type for correct state machine
                  : (exprType ?? returnType); // Otherwise use expr type or fallback to return type

              const funcCtx2 = context as FunctionGenerationContext;
              if (!funcCtx2.declaredTempVars)
                funcCtx2.declaredTempVars = new Set();
              if (!funcCtx2.declaredTempVars.has(tempVar)) {
                funcCtx2.declaredTempVars.add(tempVar);
                // Clear before indirect ctl call (e.g. exn.throw(error))
                if (
                  isFunctionType(functionType) &&
                  (functionType.isControl || exprIsAtom(expr.func))
                ) {
                  context.emitter.emitLine(`${indent}__yo_effect_escaped = 0;`);
                }
                if (calleeEmittedVoid) {
                  // Declare the temp BEFORE the call (escape-path drops may
                  // reference it) and call as void. A generic-ResumeType handler
                  // cannot resume with a value, so the zero-init IS the result.
                  const voidTempType = getTypeString(typeToUse, context);
                  context.emitter.emitLine(
                    `${indent}${voidTempType} ${tempVar} = (${voidTempType}){0};`
                  );
                  context.emitter.emitLine(
                    `${indent}${fnPtrCast}(${castedArgsList});`
                  );
                } else {
                  context.emitter.emitLine(
                    `${indent}${getTypeString(typeToUse, context)} ${tempVar} = ${fnPtrCast}(${castedArgsList});`
                  );
                }
                context.declaredCVarNames?.add(tempVar);
              }
              storeTempVarToStateMachineIfNeeded(tempVar, indent, context);

              // Handle deferred drop expressions if they exist
              if (expr.$?.deferredDropExpressions) {
                generateDeferredDropExpressions(expr, indent, context);
              }

              // unwind check for direct handler calls. Install vs propagate:
              // install only when the atom is bound in a local begin-block
              // frame within the current function; a function parameter is a
              // propagation point and must not extract __yo_unwind_value.
              if (isFunctionType(functionType) && exprIsAtom(expr.func)) {
                emitEffectUnwindCheck(
                  indent,
                  context as FunctionGenerationContext,
                  isHandlerAtomBoundLocally(expr.func, expr),
                  expr
                );
              } else if (
                // Effect-record-field call shape: `exn.throw(...)` —
                // see counterpart in the unit-return branch above.
                isFunctionType(functionType) &&
                functionType.isControl &&
                !exprIsAtom(expr.func)
              ) {
                emitEffectUnwindCheck(
                  indent,
                  context as FunctionGenerationContext,
                  false,
                  expr
                );
              }

              if (isEffectRecordCapture) {
                context.emitter.emitLine(`${indent}if (__yo_effect_escaped) {`);
                // Drop RC-typed arguments that won't be dropped by the escaped handler
                if (runtimeArgExprs) {
                  for (const arg of runtimeArgExprs) {
                    if (
                      arg.$?.variableName &&
                      arg.$?.type &&
                      typeContainsRcType(arg.$.type)
                    ) {
                      const argVarName = resolveVarNameInContext(
                        sanitizeForCIdentifier(arg.$.variableName),
                        context
                      );
                      const dropCode = generateDropCodeForValue(
                        argVarName,
                        arg.$.type,
                        context
                      );
                      if (dropCode) {
                        context.emitter.emitLine(`${indent}  ${dropCode};`);
                        // Zero SM field to prevent double-drop in dispose
                        context.emitter.emitLine(
                          `${indent}  memset(&${argVarName}, 0, sizeof(${argVarName}));`
                        );
                      }
                    }
                  }
                }
                emitAsyncFutureEscape({
                  emitter: context.emitter,
                  indent: indent + "  ",
                  resultCode: undefined,
                  debugLabel: undefined,
                });
                context.emitter.emitLine(`${indent}}`);
              }

              return tempVar; // Return the temp variable name
            } else {
              // Error: function parameter call returns non-unit type but no temp variable assigned
              return `// Error: Function parameter call returns ${getTypeString(functionType.return.type, context)} but no temp variable assigned`;
            }
          }
        }
      }
    }
  } else if (
    functionType &&
    (typeImplementsFn(functionType) ||
      extractFnTraitFromType(functionType, expr.func.$?.env))
  ) {
    const closureValueType = functionType;
    const fnTrait = extractFnTraitFromType(closureValueType, expr.func.$?.env)!;
    // Check if this is a Dyn closure (uses vtable) or Impl closure (static dispatch)
    const isDynClosure = isDynType(closureValueType);
    {
      const callSig = fnTrait.isFn.callType;
      // Handle closure calls with dynamic dispatch through vtable
      const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;

      if (runtimeArgExprs) {
        // First, handle arguments that need temporary variables
        const functionContext = context as FunctionGenerationContext;
        for (const arg of runtimeArgExprs) {
          if (arg.$?.variableName && arg.$?.type) {
            // Check if this variable is captured by a closure
            const isClosureCapturedVariable =
              functionContext.currentClosureCaptures &&
              functionContext.currentClosureCaptures.includes(
                arg.$.variableName
              ) &&
              exprIsAtom(arg) &&
              arg.$.env &&
              functionContext.currentClosureCaptureFrameLevel !== undefined &&
              checkVariableIsClosureCaptured(
                arg.token.value,
                arg.$.env,
                functionContext.currentClosureCaptureFrameLevel
              );

            // Generate the argument expression and declare it as a temp variable
            const argCode = generateExpr(arg, indent, context);

            // Check if this is a compile-time-only constant - skip temp variable creation
            let isComptimeOnlyArg = false;
            if (exprIsAtom(arg) && arg.$.env && arg.$.variableName) {
              const variables = getVariablesFromEnv(
                arg.$.env,
                arg.$.variableName
              );
              if (
                variables.length > 0 &&
                variables[variables.length - 1]!.isCompileTimeOnly
              ) {
                isComptimeOnlyArg = true;
              }
            }

            // Check if this variable is captured by a state machine
            const isStateMachineCapturedVariable =
              (functionContext.inAsyncStateMachine ||
                functionContext.inEffectStateMachine) &&
              argCode.startsWith("sm->");

            if (
              argCode &&
              argCode !== arg.$.variableName &&
              !isClosureCapturedVariable &&
              !isStateMachineCapturedVariable &&
              !isComptimeOnlyArg
            ) {
              // Only emit declaration if:
              // 1. The expression doesn't already handle it
              // 2. It's not a closure-captured variable (those are accessed inline from closure_context->data)
              // 3. It's not a state machine variable (those are accessed via sm->var_xxx)
              // Use convertedRuntimeType if available (e.g., comptime_str -> str)
              const effectiveType = arg.$.convertedRuntimeType || arg.$.type;
              const varTypeAndName = getVariableTypeString(
                effectiveType,
                arg.$.variableName,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${argCode};`
              );
              storeTempVarToStateMachineIfNeeded(
                arg.$.variableName,
                indent,
                context
              );
            }
          }
        }

        // Generate closure value and function arguments
        const closureCode = generateExpr(expr.func, indent, context);
        const args = runtimeArgExprs.map((arg) => {
          if (arg.$?.variableName && arg.$?.type) {
            // Check if this is a closure-captured variable - if so, use the full access expression
            const isClosureCapturedVariable =
              functionContext.currentClosureCaptures &&
              functionContext.currentClosureCaptures.includes(
                arg.$.variableName
              ) &&
              exprIsAtom(arg) &&
              arg.$.env &&
              functionContext.currentClosureCaptureFrameLevel !== undefined &&
              checkVariableIsClosureCaptured(
                arg.token.value,
                arg.$.env,
                functionContext.currentClosureCaptureFrameLevel
              );

            if (isClosureCapturedVariable) {
              // Return the inline access expression
              return generateExpr(arg, indent, context);
            } else {
              // The pre-processing loop above already called generateExpr to emit
              // temp variable declarations. Use the variable name directly to avoid
              // re-generating the same code.
              const argVarName = getVariableNameForCodegen(
                arg.$.variableName,
                arg.$.env
              );
              const isStateMachineCapturedVariable =
                (functionContext.inAsyncStateMachine ||
                  functionContext.inEffectStateMachine) &&
                argVarName.startsWith("sm->");

              // Handle deferred dup expressions for closure call arguments
              let finalArgVarName = argVarName;
              if (
                arg.$?.deferredDupExpressions &&
                arg.$.deferredDupExpressions.length > 0
              ) {
                generateDeferredDupExpressions(arg, indent, functionContext);
                // Use the dup result variable instead of the original
                const dupExpr = arg.$.deferredDupExpressions[0]!;
                if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                  finalArgVarName = getVariableNameForCodegen(
                    dupExpr.$.variableName,
                    dupExpr.$.env
                  );
                }
              }

              return isStateMachineCapturedVariable
                ? argVarName
                : finalArgVarName;
            }
          } else {
            return generateExpr(arg, indent, context);
          }
        });

        // Phase D (THREAD_SAFETY): Wrap ref(v):T arguments with &() to match
        // the callee's T* parameter declaration. This mirrors the regular call
        // path at lines 568-611.
        const callSigRuntimeParams = callSig.parameters.filter(
          (p) => !p.isCompileTimeOnly && !p.isQuote
        );
        for (let i = 0; i < callSigRuntimeParams.length; i++) {
          const param = callSigRuntimeParams[i];
          if (param && param.isRef && i < args.length) {
            const arg = args[i]!;
            // Only wrap if it's a clean variable name (not a complex expression)
            if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(arg)) {
              args[i] = `(&(${arg}))`;
            }
          }
        }

        // Dispatch:
        // - Dyn(Fn(...)) uses vtable: closure.vtable->call(closure.data, args...)
        // - Impl(Fn(...)) uses static dispatch: closure_impl(&closure, args...)
        // - Function pointer parameter: direct call f(args...)
        //   (when the parameter is a generic F constrained by where(F <: Fn(...)),
        //    specialization replaces F with a concrete FunctionType, and the C
        //    parameter is declared as a function pointer in declarations.ts.)
        let closureCall: string;
        let isFunctionPointerParam = false;
        let functionPointerReturnType: Type | undefined;
        // When the param type is SomeType that resolves to FunctionType, the C
        // declaration is void* (because getTypeString(SomeType) = void*). We
        // must cast void* to the concrete function pointer type before calling.
        let functionPointerResolvedFnType: FunctionType | undefined;
        if (
          exprIsAtom(expr.func) &&
          (context as FunctionGenerationContext).currentFunctionType
        ) {
          const funcVarName = expr.func.token.value;
          const curFnType = (context as FunctionGenerationContext)
            .currentFunctionType!;
          const matchedParam = curFnType.parameters.find(
            (p) => p.label === funcVarName
          );
          if (matchedParam) {
            if (isFunctionType(matchedParam.type)) {
              isFunctionPointerParam = true;
              functionPointerReturnType = (matchedParam.type as FunctionType)
                .return.type;
            } else if (isSomeType(matchedParam.type)) {
              // Walk the SomeType chain to find the concrete FunctionType.
              // This occurs when a generic parameter constrained by Impl(Fn(...))
              // is specialized with a concrete function type — the C param is
              // declared as void*, so we need an explicit cast.
              let cur: Type = matchedParam.type;
              while (cur.tag === TypeTag.SomeType) {
                const s = cur as SomeType;
                if (!s.resolvedConcreteType || s.resolvedConcreteType === s)
                  break;
                cur = s.resolvedConcreteType;
              }
              if (isFunctionType(cur)) {
                isFunctionPointerParam = true;
                functionPointerReturnType = (cur as FunctionType).return.type;
                functionPointerResolvedFnType = cur as FunctionType;
              }
            }
          }
        }
        if (isFunctionPointerParam) {
          if (functionPointerResolvedFnType) {
            // The C param is void* (SomeType resolved to FunctionType).
            // Cast to the concrete function pointer type before calling.
            const fnPtrProto = generateFunctionPrototype(
              functionPointerResolvedFnType,
              "(*)",
              context
            );
            closureCall = `((${fnPtrProto})(${closureCode}))(${args.join(", ")})`;
          } else {
            closureCall = `${closureCode}(${args.join(", ")})`;
          }
        } else if (isDynClosure) {
          const allArgs = [`(${closureCode}).data`, ...args];
          closureCall = `(${closureCode}).vtable->call(${allArgs.join(", ")})`;
        } else {
          // For Impl closures, the value is the concrete capture struct.
          // Find the corresponding generated implementation function.
          let concreteTypeId: string | undefined;
          if (isSomeType(closureValueType)) {
            const someType = closureValueType as SomeType;
            if (someType.resolvedConcreteType) {
              let cur: Type = someType;
              while (cur.tag === TypeTag.SomeType) {
                const s = cur as SomeType;
                if (!s.resolvedConcreteType) break;
                if (s.resolvedConcreteType === s) break;
                cur = s.resolvedConcreteType;
              }
              concreteTypeId = cur.id;
            }
          }

          const mapped = concreteTypeId
            ? context.implClosureCallMap.get(concreteTypeId)
            : undefined;

          if (!mapped) {
            // No registered Impl closure mapping. This means the value is a
            // plain function pointer (passed as void* via an Impl(Fn(...))
            // parameter) rather than a closure struct. Build a function pointer
            // cast from the Fn trait's call signature and call through it.
            const runtimeCallSigParams = callSig.parameters.filter(
              (p) => !p.isCompileTimeOnly
            );
            const returnTypeStr = getTypeString(callSig.return.type, context);
            const paramTypeStrs = runtimeCallSigParams.map((p) =>
              getTypeString(p.type, context)
            );
            const fnPtrCast = `((${returnTypeStr} (*)(${paramTypeStrs.join(", ")}))(${closureCode}))`;
            closureCall = `${fnPtrCast}(${args.join(", ")})`;
          } else {
            // Check if the closure function has evidence parameters
            const closureEvidenceParams = getEvidenceParameters(callSig);
            if (closureEvidenceParams.length > 0) {
              const { args: evidenceArgs, isHandlerInstallation } =
                resolveEvidenceArgsForCallSite(
                  closureEvidenceParams,
                  {} as FunctionValue,
                  expr,
                  functionContext
                );
              if (evidenceArgs.length > 0) {
                const allArgs = [`&(${closureCode})`, ...args, ...evidenceArgs];
                return generateEvidenceCallSite(
                  mapped.functionCName,
                  allArgs.join(", "),
                  callSig,
                  expr,
                  runtimeArgExprs,
                  indent,
                  functionContext,
                  isHandlerInstallation
                );
              }
            }
            const allArgs = [`&(${closureCode})`, ...args];
            closureCall = `${mapped.functionCName}(${allArgs.join(", ")})`;
          }
        }

        // Get return type from the closure's function signature
        // (or from the specialized function-pointer parameter when applicable)
        const returnType = functionPointerReturnType ?? callSig.return.type;

        // Compute borrow containers for interior-ref args in the closure call
        const borrowContainersClosure = emitBorrowAcquires(
          runtimeArgExprs,
          callSigRuntimeParams as { isRef?: boolean }[],
          indent,
          functionContext
        );

        if (isUnitType(returnType)) {
          // If the closure returns unit, just call it without assignment
          context.emitter.emitLine(`${indent}${closureCall};`);

          // Release borrow flags after the call
          emitBorrowReleases(borrowContainersClosure, indent, functionContext);

          // Handle deferred drop expressions if they exist
          if (expr.$?.deferredDropExpressions) {
            generateDeferredDropExpressions(expr, indent, context);
          }

          return ""; // No return value
        } else {
          // If it returns a value, assign to a temp variable or return directly
          const tempVar = expr.$?.variableName;
          if (tempVar) {
            context.emitter.emitLine(
              `${indent}${getTypeString(returnType, context)} ${tempVar} = ${closureCall};`
            );
            context.declaredCVarNames?.add(tempVar);
            storeTempVarToStateMachineIfNeeded(tempVar, indent, context);

            // Release borrow flags after the call
            emitBorrowReleases(
              borrowContainersClosure,
              indent,
              functionContext
            );

            // Handle deferred drop expressions if they exist
            if (expr.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(expr, indent, context);
            }

            return tempVar; // Return the temp variable name
          } else {
            // Error: closure returns non-unit type but no temp variable assigned
            return `// Error: Closure call returns ${getTypeString(returnType, context)} but no temp variable assigned`;
          }
        }
      } else {
        // Note: Closure construction is now handled in the isTypeValue(functionValue) branch below
        // by checking for expr.$?.closureFunctionValue
        return `// Error: No runtime args found for closure call`;
      }
    }
  } else if (isTypeValue(functionValue)) {
    // struct
    if (isStructType(functionValue.value)) {
      const structType = functionValue.value;
      const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
      const cName = context.types[structType.id]?.cName;
      const runtimeFieldEntries = runtimeArgExprs
        ? structType.fields
            .map((field, index) => ({
              field,
              arg: runtimeArgExprs[index],
            }))
            .filter(({ field }) =>
              getRuntimeStructFields(structType).some(
                (runtimeField) => runtimeField === field
              )
            )
        : undefined;
      const tempVar = expr.$?.variableName;

      if (
        runtimeArgExprs &&
        cName &&
        runtimeFieldEntries &&
        runtimeFieldEntries.every(({ arg }) => arg !== undefined)
      ) {
        // Handle newtype as zero-cost abstraction
        if (structType.isNewtype && structType.fields.length === 1) {
          // For newtype, just use the underlying value directly (with cast for type safety)
          const argExpr = runtimeArgExprs[0]!;
          const argCode = generateExpr(argExpr, indent, context);

          // Handle deferred dup expressions for newtype constructor arguments
          // This is important because newtype shares the same RC as its inner type,
          // so if the inner value is passed to the newtype, we need to dup it
          // to avoid double-free (both newtype and original will try to drop).
          let finalArgCode = argCode;
          if (
            argExpr.$?.deferredDupExpressions &&
            argExpr.$.deferredDupExpressions.length > 0
          ) {
            const functionContext = context as FunctionGenerationContext;

            // If the arg has a variable name but generateExpr didn't create a declaration,
            // we need to create it now so the dup call can reference it
            if (argExpr.$?.variableName && argExpr.$?.type) {
              const argVarName = getVariableNameForCodegen(
                argExpr.$.variableName,
                argExpr.$.env
              );
              // Only emit the declaration if argCode is different from the variable name
              if (argCode !== argVarName) {
                const argType = argExpr.$.type;
                const argTypeStr = getTypeString(argType, context);
                context.emitter.emitLine(
                  `${indent}${argTypeStr} ${argVarName} = ${argCode};`
                );
              }
            }

            generateDeferredDupExpressions(argExpr, indent, functionContext);
            // Use the dup result variable instead of the original
            const dupExpr = argExpr.$.deferredDupExpressions[0]!;
            if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
              finalArgCode = getVariableNameForCodegen(
                dupExpr.$.variableName,
                dupExpr.$.env
              );
            }
          }

          const newtypeValue = `((${cName})(${finalArgCode}))`;

          // If this newtype has a temporary variable name, declare it
          if (tempVar && expr.$?.type) {
            const varTypeAndName = getVariableTypeString(
              expr.$.type,
              tempVar,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${newtypeValue};`
            );
            storeTempVarToStateMachineIfNeeded(tempVar, indent, context);
            return tempVar;
          } else {
            return newtypeValue;
          }
        }

        if (structType.isReferenceSemantics) {
          // For object, call the constructor function
          const functionContext = context as FunctionGenerationContext;

          const argsList = runtimeFieldEntries
            .map(({ arg }) => {
              arg = arg!;
              const argCode = generateExpr(arg, indent, context);

              // Handle deferred dup expressions for constructor arguments
              if (
                arg.$?.deferredDupExpressions &&
                arg.$.deferredDupExpressions.length > 0
              ) {
                // If the arg has a variable name but generateExpr didn't create a declaration,
                // we need to create it now so the dup call can reference it
                if (arg.$?.variableName && arg.$?.type) {
                  const argVarName = getVariableNameForCodegen(
                    arg.$.variableName,
                    arg.$.env
                  );
                  // Only emit the declaration if argCode is different from the variable name
                  // to avoid generating code like: prev_opt = prev_opt;
                  if (argCode !== argVarName) {
                    const argType = arg.$.type;
                    const argTypeStr = getTypeString(argType, context);
                    // Emit the variable declaration and assignment
                    context.emitter.emitLine(
                      `${indent}${argTypeStr} ${argVarName} = ${argCode};`
                    );
                  }
                }

                generateDeferredDupExpressions(arg, indent, functionContext);
                // Use the dup result variable instead of the original
                const dupExpr = arg.$.deferredDupExpressions[0]!;
                if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                  return getVariableNameForCodegen(
                    dupExpr.$.variableName,
                    dupExpr.$.env
                  );
                }
              }

              return argCode;
            })
            .join(", ");

          const constructorName = `__yo_new_${cName}`;
          const structValue = `${constructorName}(${argsList})`;

          // If this struct has a temporary variable name, declare it
          if (tempVar && expr.$?.type) {
            const varTypeAndName = getVariableTypeString(
              expr.$.type,
              tempVar,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${structValue};`
            );
            storeTempVarToStateMachineIfNeeded(tempVar, indent, context);
            return tempVar;
          } else {
            return structValue;
          }
        } else {
          // For regular struct, generate struct initialization as before
          const functionContext = context as FunctionGenerationContext;

          const argsList = runtimeFieldEntries
            .map(({ field, arg }, index) => {
              arg = arg!;
              const argCode = generateExpr(arg, indent, context);
              // For tuples, always use numeric field names _0, _1, _2...
              // For regular structs, use the actual field labels
              const fieldName = isTupleType(structType)
                ? `_${index}`
                : sanitizeForCIdentifier(
                    field.label,
                    structType.isExtern === "c"
                  );

              // Handle deferred dup expressions for struct fields
              let finalArgValue = argCode;
              if (
                arg.$?.deferredDupExpressions &&
                arg.$.deferredDupExpressions.length > 0
              ) {
                // If the arg has a variable name but generateExpr didn't create a declaration,
                // we need to create it now so the dup call can reference it
                if (arg.$?.variableName && arg.$?.type) {
                  const argVarName = getVariableNameForCodegen(
                    arg.$.variableName,
                    arg.$.env
                  );
                  const argType = arg.$.type;
                  const argTypeStr = getTypeString(argType, context);
                  // Only emit the variable declaration if argCode is different from argVarName
                  // to prevent self-assignment like: var = var;
                  if (argCode !== argVarName) {
                    context.emitter.emitLine(
                      `${indent}${argTypeStr} ${argVarName} = ${argCode};`
                    );
                  }
                }

                generateDeferredDupExpressions(arg, indent, functionContext);
                // Use the dup result variable instead of the original
                const dupExpr = arg.$.deferredDupExpressions[0]!;
                if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                  finalArgValue = getVariableNameForCodegen(
                    dupExpr.$.variableName,
                    dupExpr.$.env
                  );
                }
              }

              return `.${fieldName} = ` + finalArgValue;
            })
            .join(", ");
          const structValue = `(${cName}){ ${argsList} }`;

          // If this struct has a temporary variable name, declare it
          if (tempVar && expr.$?.type) {
            const varTypeAndName = getVariableTypeString(
              expr.$.type,
              tempVar,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${structValue};`
            );
            storeTempVarToStateMachineIfNeeded(tempVar, indent, context);
            return tempVar;
          } else {
            return structValue;
          }
        }
      }
    }
    // closure type - closure construction
    // Note: This is now handled at the top of generateFuncCall by checking expr.$.closureFunctionValue
    else if (typeImplementsFn(functionValue.value)) {
      return `// Error: Closure construction should have been handled by closureFunctionValue check at top of generateFuncCall`;
    }
    // union
    // union is supposed to have only one member initialized
    else if (isUnionType(functionValue.value)) {
      const tempVar = expr.$?.variableName;
      const arg = expr.args[0]!;
      if (arg && exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, ":", 2)) {
        const labelExpr = arg.args[0]!;
        const fieldExpr = arg.args[1]!;
        const cName = context.types[functionValue.value.id]?.cName;
        if (cName && exprIsAtom(labelExpr) && fieldExpr) {
          const functionContext = context as FunctionGenerationContext;
          const label = labelExpr.token.value;
          const sanitizedLabel = getVariableNameForCodegen(
            label,
            labelExpr.$?.env
          );
          const fieldCode = generateExpr(fieldExpr, indent, context);

          // Handle deferred dup expressions for union field
          let finalFieldValue = fieldCode;
          if (
            fieldExpr.$?.deferredDupExpressions &&
            fieldExpr.$.deferredDupExpressions.length > 0
          ) {
            generateDeferredDupExpressions(fieldExpr, indent, functionContext);
            // Use the dup result variable instead of the original
            const dupExpr = fieldExpr.$.deferredDupExpressions[0]!;
            if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
              finalFieldValue = getVariableNameForCodegen(
                dupExpr.$.variableName,
                dupExpr.$.env
              );
            }
          }

          const unionValue = `(${cName}){ .${sanitizedLabel} = ${finalFieldValue} }`;

          // If this union has a temporary variable name, declare it
          if (tempVar && expr.$?.type) {
            const varTypeAndName = getVariableTypeString(
              expr.$.type,
              tempVar,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${unionValue};`
            );
            storeTempVarToStateMachineIfNeeded(tempVar, indent, context);
            return tempVar;
          } else {
            return unionValue;
          }
        }
      }
    }
    // enum
    else if (isEnumType(functionValue.value)) {
      const enumType = functionValue.value;
      const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
      const cName = context.types[enumType.id]?.cName;
      const tempVar = expr.$?.variableName;

      if (enumType.selectedVariantName && runtimeArgExprs && cName) {
        // Check if this enum can be optimized as a nullable pointer
        const nullablePointerType = canOptimizeAsNullablePointer(enumType);
        if (nullablePointerType) {
          const variantName = enumType.selectedVariantName;
          const variant = enumType.variants.find((v) => v.name === variantName);

          if (variant) {
            if (!variant.fields || variant.fields.length === 0) {
              // This is the "None" case - return NULL
              const enumValue = "NULL";
              if (tempVar && expr.$?.type) {
                const varTypeAndName = getVariableTypeString(
                  expr.$.type,
                  tempVar,
                  context
                );
                context.emitter.emitLine(
                  `${indent}${varTypeAndName} = ${enumValue};`
                );
                storeTempVarToStateMachineIfNeeded(tempVar, indent, context);
                return tempVar;
              } else {
                return enumValue;
              }
            } else if (variant.fields.length === 1) {
              // This is the "Some" case - return the pointer value directly
              const pointerValue = generateExpr(
                runtimeArgExprs[0]!,
                indent,
                context
              );
              if (tempVar && expr.$?.type) {
                const varTypeAndName = getVariableTypeString(
                  expr.$.type,
                  tempVar,
                  context
                );
                context.emitter.emitLine(
                  `${indent}${varTypeAndName} = ${pointerValue};`
                );
                storeTempVarToStateMachineIfNeeded(tempVar, indent, context);
                return tempVar;
              } else {
                return pointerValue;
              }
            }
          }
        }

        // Check if this enum can be optimized as a simple C enum
        const simpleEnumOptimizable = canOptimizeAsSimpleEnum(enumType);
        if (simpleEnumOptimizable) {
          const variantName = enumType.selectedVariantName;
          // For simple enums, just return the enum constant
          const enumValue = getEnumVariantCName(enumType, variantName, context);
          if (tempVar && expr.$?.type) {
            const varTypeAndName = getVariableTypeString(
              expr.$.type,
              tempVar,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${enumValue};`
            );
            storeTempVarToStateMachineIfNeeded(tempVar, indent, context);
            return tempVar;
          } else {
            return enumValue;
          }
        }

        // Generate enum initialization (fallback for non-optimized enums)
        const variantName = enumType.selectedVariantName;
        const variant = enumType.variants.find((v) => v.name === variantName);
        if (variant) {
          // Filter out unit type arguments - they don't need to be stored
          const nonUnitElements =
            variant.fields?.filter((field) => !isUnitType(field.type)) || [];

          const functionContext = context as FunctionGenerationContext;

          const argEntries = runtimeArgExprs
            .map((arg, index) => {
              if (variant.fields) {
                const field = variant.fields[index];
                if (field && !isUnitType(field.type)) {
                  const argCode = generateExpr(arg, indent, context);
                  const sanitizedLabel = getVariableNameForCodegen(
                    field.label,
                    arg.$?.env
                  );

                  // Declare temp variable for enum field arguments when needed
                  let finalArgValue = argCode;
                  if (arg.$?.variableName && arg.$?.type) {
                    const isClosureCapturedVariable =
                      functionContext.currentClosureCaptures &&
                      functionContext.currentClosureCaptures.includes(
                        arg.$.variableName
                      ) &&
                      exprIsAtom(arg) &&
                      arg.$.env &&
                      functionContext.currentClosureCaptureFrameLevel !==
                        undefined &&
                      checkVariableIsClosureCaptured(
                        arg.token.value,
                        arg.$.env,
                        functionContext.currentClosureCaptureFrameLevel
                      );

                    const isStateMachineCapturedVariable =
                      (functionContext.inAsyncStateMachine ||
                        functionContext.inEffectStateMachine) &&
                      argCode.startsWith("sm->");

                    let isComptimeOnlyArg = false;
                    if (exprIsAtom(arg) && arg.$.env && arg.$.variableName) {
                      const variables = getVariablesFromEnv(
                        arg.$.env,
                        arg.$.variableName
                      );
                      if (
                        variables.length > 0 &&
                        variables[variables.length - 1]!.isCompileTimeOnly
                      ) {
                        isComptimeOnlyArg = true;
                      }
                    }

                    let emittedTempVarDeclaration = false;

                    if (
                      argCode &&
                      argCode !== arg.$.variableName &&
                      !isClosureCapturedVariable &&
                      !isStateMachineCapturedVariable &&
                      !isComptimeOnlyArg
                    ) {
                      const sanitizedVarName = getVariableNameForCodegen(
                        arg.$.variableName,
                        arg.$.env
                      );
                      if (argCode !== sanitizedVarName) {
                        const varTypeAndName = getVariableTypeString(
                          arg.$.type,
                          arg.$.variableName,
                          context
                        );
                        context.emitter.emitLine(
                          `${indent}${varTypeAndName} = ${argCode};`
                        );
                        emittedTempVarDeclaration = true;
                        storeTempVarToStateMachineIfNeeded(
                          arg.$.variableName,
                          indent,
                          context
                        );
                      }
                    }

                    if (emittedTempVarDeclaration) {
                      finalArgValue = getVariableNameForCodegen(
                        arg.$.variableName,
                        arg.$.env
                      );
                    }
                  }

                  // Handle deferred dup expressions for enum variant fields
                  if (
                    arg.$?.deferredDupExpressions &&
                    arg.$.deferredDupExpressions.length > 0
                  ) {
                    generateDeferredDupExpressions(
                      arg,
                      indent,
                      functionContext
                    );
                    // Use the dup result variable instead of the original
                    const dupExpr = arg.$.deferredDupExpressions[0]!;
                    if (
                      exprIsFunctionCall(dupExpr) &&
                      dupExpr.$?.variableName
                    ) {
                      finalArgValue = getVariableNameForCodegen(
                        dupExpr.$.variableName,
                        dupExpr.$.env
                      );
                    }
                  }

                  return {
                    designated: `.${sanitizedLabel} = ` + finalArgValue,
                    positional: finalArgValue,
                  };
                }
                return null; // Skip if no field matches or if it's unit type
              } else {
                return null;
              }
            })
            .filter(
              (e): e is { designated: string; positional: string } => e !== null
            );
          const argsList = argEntries.map((e) => e.designated).join(", ");
          const positionalArgs = argEntries.map((e) => e.positional).join(", ");

          // Reference-semantics enums (`ref(enum(…))`) heap-allocate via a
          // per-variant constructor; value enums use a compound literal.
          // If there are no non-unit fields, we only need the tag.
          const enumValue = enumType.isReferenceSemantics
            ? `__yo_new_${cName}_${variantName}(${positionalArgs})`
            : nonUnitElements.length > 0
              ? `(${cName}){ .tag = ${getEnumVariantCName(enumType, variantName, context)}, .data = { .${variantName} = { ${argsList} } } }`
              : `(${cName}){ .tag = ${getEnumVariantCName(enumType, variantName, context)} }`;
          if (tempVar && expr.$?.type) {
            const varTypeAndName = getVariableTypeString(
              expr.$.type,
              tempVar,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${enumValue};`
            );
            storeTempVarToStateMachineIfNeeded(tempVar, indent, context);
            return tempVar;
          } else {
            return enumValue;
          }
        }
      }
    }
  } else if (isArrayType(functionType)) {
    const firstArg = expr.args[0];

    // Array access by index: arr[index] or arr(index)
    const arrayCode = generateExpr(expr.func!, indent, context);
    const indexCode = generateExpr(firstArg!, indent, context);
    // Generate array access with struct wrapper
    return `${arrayCode}.data[${indexCode}]`; // Access the element at the index
  }
}

/**
 * Determine whether a function-valued atom is a locally bound handler in the
 * enclosing function (handler installation point) rather than a parameter or
 * captured variable (propagation point).
 *
 * The decision is data-flow based: walk the atom's environment frames and
 * find where the variable is bound. If the innermost binding lives in a
 * begin-block frame above the function's parameter frame, the call site is
 * the install site for any unwind triggered by the handler. Otherwise the
 * call site must propagate the unwind to a transitive caller.
 */
function isHandlerAtomBoundLocally(
  funcExpr: AtomExpr,
  callExpr: FnCallExpr
): boolean {
  const varName = funcExpr.token.value;
  const callEnv = funcExpr.$?.env ?? callExpr.$?.env;
  if (!callEnv) return false;
  const frameIdx = findInnermostFrameWithGivenVariable(
    callEnv,
    (v) => v.name === varName
  );
  if (frameIdx < 0) return false;
  const frame = callEnv.frames[frameIdx];
  return !!frame?.isBeginBlockFrame;
}

/**
 * Emit an unwind check after calling a function that may set __yo_effect_escaped.
 * Used in the normal (non-evidence) call path for specialized effectful functions
 * and direct handler calls.
 *
 * At handler installation points (isHandlerInstallation=true): extracts the escape
 * value from __yo_unwind_value and returns it.
 * At transitive points: returns a dummy value to propagate the escape.
 */
function emitEffectUnwindCheck(
  indent: string,
  context: FunctionGenerationContext,
  isHandlerInstallation: boolean,
  expr: FnCallExpr
): void {
  const emitter = context.emitter;
  emitter.emitLine(`${indent}if (__yo_effect_escaped) {`);
  // This call's own result temp must never be dropped on the escape path: the
  // handler unwound instead of returning, so the temp was never assigned and
  // still holds whatever the ABI left in the return registers. On x86_64 that
  // is routinely a stack address (a `void` handler reached through a
  // value-returning function-pointer cast leaves RAX from the previous
  // sret-class call), so the drop dereferences it and jumps into the stack.
  // See issues/fixed/escape-path-drops-unwound-call-result-temp.md.
  const escapedCallResultCName = expr.$?.variableName;
  // In async SMs, local variable cleanup is handled by _state_dispose when
  // the SM is freed (state == -2). Dropping here would cause double-free.
  if (!context.inAsyncStateMachine) {
    // Drop in-scope RC-typed locals before early return to prevent leaks
    generatePendingDeferredDrops(
      indent + "  ",
      context,
      expr,
      false,
      true,
      false,
      undefined,
      escapedCallResultCName
    );
    // Also drop consumed variables (their drops were optimized away because
    // they'd be consumed by the return value, but escape discards the return)
    generateConsumedVarDropsForEscape(
      indent + "  ",
      context,
      expr,
      false,
      undefined,
      escapedCallResultCName
    );
  }
  if (context.inAsyncStateMachine) {
    // Drop RC-typed arg temporaries that are segment-local C locals.
    // Cross-boundary struct fields are cleaned up later by _state_dispose,
    // but segment-local C locals go out of scope and would leak without an
    // explicit drop here. Zero the variable afterwards to prevent double-drop
    // if the variable happens to also be a cross-boundary struct field.
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
    if (runtimeArgExprs) {
      const declaredTempVars = context.declaredTempVars;
      for (const arg of runtimeArgExprs) {
        if (
          arg.$?.variableName &&
          arg.$?.type &&
          typeContainsRcType(arg.$.type)
        ) {
          const argVarName = resolveVarNameInContext(
            sanitizeForCIdentifier(arg.$.variableName),
            context
          );
          // Only drop if we can confirm the variable exists:
          // - sm-> prefix → SM struct field, always exists
          // - declaredTempVars → was emitted as a C local declaration
          const isSMField = argVarName.startsWith("sm->");
          const isDeclared =
            isSMField || (declaredTempVars && declaredTempVars.has(argVarName));
          if (!isDeclared) continue;
          const dropCode = generateDropCodeForValue(
            argVarName,
            arg.$.type,
            context
          );
          if (dropCode) {
            emitter.emitLine(`${indent}  ${dropCode};`);
            emitter.emitLine(
              `${indent}  memset(&${argVarName}, 0, sizeof(${argVarName}));`
            );
          }
        }
      }
    }
    if (isHandlerInstallation) {
      emitter.emitLine(`${indent}  __yo_effect_escaped = 0;`);
    }
    emitAsyncFutureEscape({
      emitter,
      indent: indent + "  ",
      resultCode: undefined,
      debugLabel: undefined,
    });
  } else if (isHandlerInstallation) {
    emitter.emitLine(`${indent}  __yo_effect_escaped = 0;`);
    const callerReturnType = context.currentFunctionType?.return.type;
    if (callerReturnType && !isUnitType(callerReturnType)) {
      // Phase B of plans/archive/ITERATOR_REDESIGN.md — `-> ref(T)` lowers to
      // `T*` at the C ABI, so the unwind-fallback `(T){0}` would be
      // ill-typed. Wrap with `*` when the function declares a ref return.
      let callerCType = getTypeString(callerReturnType, context);
      if (
        context.currentFunctionType?.return.isRef &&
        callerCType !== "void" &&
        !callerCType.endsWith("*")
      ) {
        callerCType = `${callerCType}*`;
      }
      if (callerCType !== "void") {
        emitter.emitLine(`${indent}  ${callerCType} _unw_result;`);
        emitter.emitLine(
          `${indent}  memcpy(&_unw_result, __yo_unwind_value, sizeof(${callerCType}));`
        );
        emitter.emitLine(`${indent}  return _unw_result;`);
      } else {
        emitter.emitLine(`${indent}  return;`);
      }
    } else {
      emitter.emitLine(`${indent}  return;`);
    }
  } else {
    const callerReturnType = context.currentFunctionType?.return.type;
    if (callerReturnType && !isUnitType(callerReturnType)) {
      // Phase B of plans/archive/ITERATOR_REDESIGN.md — `-> ref(T)` lowers to
      // `T*` at the C ABI, so the unwind-fallback `(T){0}` would be
      // ill-typed. Wrap with `*` when the function declares a ref return.
      let callerCType = getTypeString(callerReturnType, context);
      if (
        context.currentFunctionType?.return.isRef &&
        callerCType !== "void" &&
        !callerCType.endsWith("*")
      ) {
        callerCType = `${callerCType}*`;
      }
      if (callerCType !== "void") {
        emitter.emitLine(`${indent}  return (${callerCType}){0};`);
      } else {
        emitter.emitLine(`${indent}  return;`);
      }
    } else {
      emitter.emitLine(`${indent}  return;`);
    }
  }
  emitter.emitLine(`${indent}}`);
}

/**
 * Generate a call through an evidence fn ptr parameter.
 * Used inside functions with evidence passing when calling effect record members.
 *
 * Generates:
 *   result = evidence_fn_ptr(args);
 *   if (__yo_effect_escaped) { return dummy; }
 *
 * For generic evidence (void* parameter), generates a cast:
 *   result = ((ReturnType (*)(ParamTypes...))evidence_fn_ptr)(args);
 */
function generateEvidenceFnPtrCall(
  funcCode: string,
  functionType: FunctionType,
  args: string[],
  runtimeArgExprs: import("../../expr").Expr[] | undefined,
  expr: FnCallExpr,
  indent: string,
  context: FunctionGenerationContext,
  evidenceParam?: EvidenceParameter
): string {
  const argsList = args.join(", ");
  const returnType = functionType.return.type;
  const emitter = context.emitter;

  // For generic evidence parameters (passed as void*), cast to the concrete
  // function pointer type at this call site. The generic type vars (SomeType)
  // resolve to void* in the function type, so we build the cast from the
  // concrete argument and return types at this call expression.
  let callExpr: string;
  // Track whether the handler has a generic/SomeType return type (compiled as void).
  // The cast must use void to match the handler's actual C return type.
  let handlerReturnsVoid = false;
  if (
    evidenceParam?.fieldFunctionType.forallParameters &&
    evidenceParam.fieldFunctionType.forallParameters.length > 0
  ) {
    // Build concrete fn ptr type from the FUNCTION TYPE's parameters, not the
    // argument expression types. This avoids mismatches like ComptimeString
    // (uint8_t*) vs str (Slice_uint8_t) when the arg gets coerced.
    // For SomeType (generic type vars), resolve from the call-site arg types.
    const fieldRetType = evidenceParam.fieldFunctionType.return.type;
    // When the handler's return type is SomeType (generic type variable), it's
    // compiled as void in C. The cast must use void to avoid ABI mismatch —
    // casting a void-returning function to return a struct is undefined behavior
    // and crashes on WASM.
    handlerReturnsVoid = isSomeType(fieldRetType);
    const concreteRetType = handlerReturnsVoid
      ? "void"
      : expr.$?.type
        ? getTypeString(expr.$.type, context)
        : getTypeString(returnType, context);
    const concreteParamTypes: string[] = [];
    const fnParamType = evidenceParam.fieldFunctionType;
    const runtimeParams = fnParamType.parameters.filter(
      (p) => !p.isCompileTimeOnly
    );
    for (let i = 0; i < runtimeParams.length; i++) {
      const paramType = runtimeParams[i]!.type;
      // For SomeType (generic type variable T), use the concrete type from
      // the call-site argument expression instead.
      const resolvedType =
        isSomeType(paramType) && runtimeArgExprs?.[i]?.$?.type
          ? runtimeArgExprs[i]!.$!.type
          : paramType;
      const typeStr = isFunctionType(resolvedType)
        ? generateFunctionPrototype(resolvedType, "(*)", context)
        : getTypeString(resolvedType, context);
      concreteParamTypes.push(typeStr);
    }
    const paramList = concreteParamTypes.join(", ");
    // Cast void* to typed fn ptr: ((ReturnType (*)(ParamTypes...))funcCode)
    callExpr = `((${concreteRetType} (*)(${paramList}))${funcCode})`;
  } else {
    callExpr = funcCode;
  }

  if (isUnitType(returnType)) {
    emitter.emitLine(`${indent}${callExpr}(${argsList});`);

    // Handle deferred drop expressions
    if (expr.$?.deferredDropExpressions) {
      generateDeferredDropExpressions(expr, indent, context);
    }

    // Check unwind flag — propagate early return if handler escaped
    emitter.emitLine(`${indent}if (__yo_effect_escaped) {`);
    // In async SMs, local variable cleanup is handled by _state_dispose
    if (!context.inAsyncStateMachine) {
      // Drop in-scope RC-typed locals before early return to prevent leaks
      generatePendingDeferredDrops(
        indent + "  ",
        context,
        expr,
        false,
        true,
        false
      );
      generateConsumedVarDropsForEscape(indent + "  ", context, expr);
    }
    if (context.inAsyncStateMachine) {
      emitAsyncFutureEscape({
        emitter,
        indent: indent + "  ",
        resultCode: undefined,
        debugLabel: undefined,
      });
    } else {
      const callerReturnType = context.currentFunctionType?.return.type;
      if (callerReturnType && !isUnitType(callerReturnType)) {
        // Phase B of plans/archive/ITERATOR_REDESIGN.md — `-> ref(T)` lowers to
        // `T*` at the C ABI, so the unwind-fallback `(T){0}` would be
        // ill-typed. Wrap with `*` when the function declares a ref return.
        let callerCType = getTypeString(callerReturnType, context);
        if (
          context.currentFunctionType?.return.isRef &&
          callerCType !== "void" &&
          !callerCType.endsWith("*")
        ) {
          callerCType = `${callerCType}*`;
        }
        if (callerCType !== "void") {
          emitter.emitLine(`${indent}  return (${callerCType}){0};`);
        } else {
          emitter.emitLine(`${indent}  return;`);
        }
      } else {
        emitter.emitLine(`${indent}  return;`);
      }
    }
    emitter.emitLine(`${indent}}`);
    return "";
  } else {
    const tempVar = expr.$?.variableName;
    if (tempVar) {
      // For generic evidence calls, use the concrete return type from the call expression
      // rather than the generic function type's return type (which may be SomeType/void*).
      const concreteReturnType =
        evidenceParam?.fieldFunctionType.forallParameters?.length &&
        expr.$?.type
          ? expr.$.type
          : returnType;
      const cTypeString = getTypeString(concreteReturnType, context);

      // When the concrete return type resolves to void (e.g., generic ResumeType resolved
      // to unit), we must not assign to a temp — treat like the unit case above.
      if (cTypeString === "void" || isUnitType(concreteReturnType)) {
        emitter.emitLine(`${indent}${callExpr}(${argsList});`);

        // Handle deferred drop expressions
        if (expr.$?.deferredDropExpressions) {
          generateDeferredDropExpressions(expr, indent, context);
        }

        // Check unwind flag — propagate early return if handler escaped
        emitter.emitLine(`${indent}if (__yo_effect_escaped) {`);
        // In async SMs, local variable cleanup is handled by _state_dispose
        if (!context.inAsyncStateMachine) {
          // Drop in-scope RC-typed locals before early return to prevent leaks
          generatePendingDeferredDrops(
            indent + "  ",
            context,
            expr,
            false,
            true,
            false
          );
          generateConsumedVarDropsForEscape(indent + "  ", context, expr);
        }
        if (context.inAsyncStateMachine) {
          emitAsyncFutureEscape({
            emitter,
            indent: indent + "  ",
            resultCode: undefined,
            debugLabel: undefined,
          });
        } else {
          const callerReturnType = context.currentFunctionType?.return.type;
          if (callerReturnType && !isUnitType(callerReturnType)) {
            // Phase B of plans/archive/ITERATOR_REDESIGN.md — `-> ref(T)` lowers to
            // `T*` at the C ABI, so the unwind-fallback `(T){0}` would be
            // ill-typed. Wrap with `*` when the function declares a ref return.
            let callerCType = getTypeString(callerReturnType, context);
            if (
              context.currentFunctionType?.return.isRef &&
              callerCType !== "void" &&
              !callerCType.endsWith("*")
            ) {
              callerCType = `${callerCType}*`;
            }
            if (callerCType !== "void") {
              emitter.emitLine(`${indent}  return (${callerCType}){0};`);
            } else {
              emitter.emitLine(`${indent}  return;`);
            }
          } else {
            emitter.emitLine(`${indent}  return;`);
          }
        }
        emitter.emitLine(`${indent}}`);
        return "";
      }

      // When the handler has a generic/SomeType return type, it's compiled as
      // void in C (isEffectRecordMember). We must NOT assign the handler's
      // (void) "return value" to a typed temp — that's undefined behavior and
      // crashes on WASM. Instead: declare the temp var zero-initialized before
      // the call (so escape-path drops reference a valid variable), call as void,
      // check escape, then leave the zero-init for the (unlikely) resume case.
      if (handlerReturnsVoid) {
        // Declare temp var before the call — the unwind path's consumed-var
        // drops may reference it, so it must exist in scope.
        emitter.emitLine(
          `${indent}${cTypeString} ${tempVar} = (${cTypeString}){0};`
        );
        emitter.emitLine(`${indent}${callExpr}(${argsList});`);

        if (expr.$?.deferredDropExpressions) {
          generateDeferredDropExpressions(expr, indent, context);
        }

        emitter.emitLine(`${indent}if (__yo_effect_escaped) {`);
        if (!context.inAsyncStateMachine) {
          generatePendingDeferredDrops(
            indent + "  ",
            context,
            expr,
            false,
            true,
            false
          );
          generateConsumedVarDropsForEscape(indent + "  ", context, expr);
        }
        if (context.inAsyncStateMachine) {
          emitAsyncFutureEscape({
            emitter,
            indent: indent + "  ",
            resultCode: undefined,
            debugLabel: undefined,
          });
        } else {
          const callerReturnType = context.currentFunctionType?.return.type;
          if (callerReturnType && !isUnitType(callerReturnType)) {
            // Phase B of plans/archive/ITERATOR_REDESIGN.md — `-> ref(T)` lowers to
            // `T*` at the C ABI, so the unwind-fallback `(T){0}` would be
            // ill-typed. Wrap with `*` when the function declares a ref return.
            let callerCType = getTypeString(callerReturnType, context);
            if (
              context.currentFunctionType?.return.isRef &&
              callerCType !== "void" &&
              !callerCType.endsWith("*")
            ) {
              callerCType = `${callerCType}*`;
            }
            if (callerCType !== "void") {
              emitter.emitLine(`${indent}  return (${callerCType}){0};`);
            } else {
              emitter.emitLine(`${indent}  return;`);
            }
          } else {
            emitter.emitLine(`${indent}  return;`);
          }
        }
        emitter.emitLine(`${indent}}`);
        storeTempVarToStateMachineIfNeeded(tempVar, indent, context);
        return tempVar;
      }

      emitter.emitLine(
        `${indent}${cTypeString} ${tempVar} = ${callExpr}(${argsList});`
      );

      // Handle deferred drop expressions
      if (expr.$?.deferredDropExpressions) {
        generateDeferredDropExpressions(expr, indent, context);
      }

      // Check unwind flag — propagate early return if handler escaped
      emitter.emitLine(`${indent}if (__yo_effect_escaped) {`);
      // In async SMs, local variable cleanup is handled by _state_dispose
      if (!context.inAsyncStateMachine) {
        // Drop in-scope RC-typed locals before early return to prevent leaks.
        // `tempVar` is excluded: the callee unwound, so it never assigned a
        // value and the temp still holds return-register garbage.
        generatePendingDeferredDrops(
          indent + "  ",
          context,
          expr,
          false,
          true,
          false,
          undefined,
          tempVar
        );
        generateConsumedVarDropsForEscape(
          indent + "  ",
          context,
          expr,
          false,
          undefined,
          tempVar
        );
      }
      if (context.inAsyncStateMachine) {
        emitAsyncFutureEscape({
          emitter,
          indent: indent + "  ",
          resultCode: undefined,
          debugLabel: undefined,
        });
      } else {
        // Return type for unwind propagation must match the CALLER's return type, not the callee's
        const callerReturnType = context.currentFunctionType?.return.type;
        if (callerReturnType && !isUnitType(callerReturnType)) {
          // Phase B of plans/archive/ITERATOR_REDESIGN.md — `-> ref(T)` lowers to
          // `T*` at the C ABI, so the unwind-fallback `(T){0}` would be
          // ill-typed. Wrap with `*` when the function declares a ref return.
          let callerCType = getTypeString(callerReturnType, context);
          if (
            context.currentFunctionType?.return.isRef &&
            callerCType !== "void" &&
            !callerCType.endsWith("*")
          ) {
            callerCType = `${callerCType}*`;
          }
          if (callerCType !== "void") {
            emitter.emitLine(`${indent}  return (${callerCType}){0};`);
          } else {
            emitter.emitLine(`${indent}  return;`);
          }
        } else {
          emitter.emitLine(`${indent}  return;`);
        }
      }
      emitter.emitLine(`${indent}}`);
      return tempVar;
    } else {
      return `${callExpr}(${argsList})`;
    }
  }
}

/**
 * Resolve evidence fn ptr arguments for a call site, using the callee's
 * evidence parameters (from its function type). This works for both
 * escape and resume handlers.
 *
 * Resolution order for each evidence param:
 * 1. Transitive: if caller has matching evidence params, forward them
 * 2. From effectAnalysis: look up handler function values (escape or resume)
 * 3. From given binding: look up the effect record value in the call environment
 */
function resolveEvidenceArgsForCallSite(
  calleeEvidenceParams: EvidenceParameter[],
  functionValue: FunctionValue,
  expr: FnCallExpr,
  context: FunctionGenerationContext
): { args: string[]; isHandlerInstallation: boolean } {
  const result: string[] = [];
  const effectAnalysis = functionValue.body?.$?.effectAnalysis;
  let isHandlerInstallation = false;

  for (const ep of calleeEvidenceParams) {
    const key = `${ep.implicitLabel}.${ep.fieldLabel}`;
    let resolved = false;

    // 1. Transitive: forward from caller's own evidence params
    if (context.currentEvidenceParams) {
      const callerEp = context.currentEvidenceParams.get(key);
      if (callerEp) {
        result.push(callerEp.cParamName);
        resolved = true;
      }
    }

    if (resolved) continue;

    // 2. From effectAnalysis handler values
    if (effectAnalysis) {
      // Check effectHandlerInfos first (multi-effect or single with handler infos)
      if (effectAnalysis.effectHandlerInfos) {
        for (const hi of effectAnalysis.effectHandlerInfos) {
          // Match handler to specific evidence param by name
          if (
            hi.effectParameterName !== ep.fieldLabel &&
            hi.effectParameterName !== ep.implicitLabel
          ) {
            continue;
          }
          const handlerValue = hi.handlerValue as FunctionValue | undefined;
          if (handlerValue && isFunctionValue(handlerValue)) {
            // For generic handlers, use the specialized version cast to void*
            if (handlerValue.specializedFunctionCaches?.length) {
              const specialized =
                handlerValue.specializedFunctionCaches[0]!.specializedFunction;
              const specializedCName =
                context.functions[specialized.funcId]?.cName;
              if (specializedCName) {
                result.push(`(void*)${specializedCName}`);
                resolved = true;
                isHandlerInstallation = true;
                break;
              }
            }
            const cName = context.functions[handlerValue.funcId]?.cName;
            if (cName) {
              result.push(cName);
              resolved = true;
              isHandlerInstallation = true;
              break;
            }
          }
        }
      }

      // Fall back to single handler value — only when there's exactly one evidence param.
      // When there are multiple evidence params, we can't use a single handlerValue
      // for all params. Fall through to step 3 (given binding lookup) instead.
      if (
        !resolved &&
        effectAnalysis.handlerValue &&
        calleeEvidenceParams.length === 1
      ) {
        const handlerValue = effectAnalysis.handlerValue as
          | FunctionValue
          | undefined;
        if (handlerValue && isFunctionValue(handlerValue)) {
          // For generic handlers, use the specialized version cast to void*
          if (handlerValue.specializedFunctionCaches?.length) {
            const specialized =
              handlerValue.specializedFunctionCaches[0]!.specializedFunction;
            const specializedCName =
              context.functions[specialized.funcId]?.cName;
            if (specializedCName) {
              result.push(`(void*)${specializedCName}`);
              resolved = true;
              isHandlerInstallation = true;
            }
          }
          if (!resolved) {
            const cName = context.functions[handlerValue.funcId]?.cName;
            if (cName) {
              result.push(cName);
              resolved = true;
              isHandlerInstallation = true;
            }
          }
        }
      }
    }

    // 3. From given binding in the call environment
    if (!resolved) {
      const callEnv = expr.func.$?.env ?? expr.$?.env;
      if (callEnv) {
        // Search for given bindings by both label name and type, preferring
        // whichever resolves in the innermost scope (handles given variable
        // shadowing where inner scope uses a different name).
        const labelVars = getVariablesFromEnv(callEnv, ep.implicitLabel);
        const typeVars = getVariablesFromEnvByFilter(
          callEnv,
          (v) =>
            /* removed isImplicit check — Phase 2 */
            isFunctionType(v.type) &&
            isFunctionType(ep.fieldFunctionType) &&
            v.type === ep.fieldFunctionType
        );
        // Pick the variable from the innermost scope (last in array)
        const labelVar = labelVars[labelVars.length - 1];
        const typeVar = typeVars[typeVars.length - 1];
        // Prefer typeVar if it exists and is different from labelVar (shadowing)
        const givenVar =
          typeVar && typeVar !== labelVar ? typeVar : (labelVar ?? typeVar);
        const givenValue = givenVar?.value?.[0];

        // Phase 4b: runtime struct given binding — emit a C field access
        // through the runtime variable (e.g. `c.next`). This applies when
        // the given variable holds a runtime struct value (no comptime
        // FunctionValue/StructValue available). Requires
        // isCompileTimeOnly===false to distinguish runtime given(struct)
        // bindings from compile-time using(struct) parameters that are
        // lowered to flat evidence params at the C level.
        if (
          !resolved &&
          givenVar &&
          givenVar.isCompileTimeOnly === false &&
          isStructType(givenVar.type) &&
          (!givenValue || !isStructValue(givenValue)) &&
          (!givenValue || !isFunctionValue(givenValue))
        ) {
          const callEnvForName = expr.func.$?.env ?? expr.$?.env;
          const cName = getVariableNameForCodegen(
            givenVar.name,
            callEnvForName
          );
          // ep.fieldPath starts with the implicit label; drop it because
          // the implicit label maps to the C variable name itself.
          const fieldPath = ep.fieldPath.slice(
            ep.fieldPath[0] === ep.implicitLabel ? 1 : 0
          );
          if (fieldPath.length > 0) {
            result.push(`${cName}.${fieldPath.join(".")}`);
          } else {
            result.push(cName);
          }
          resolved = true;
          isHandlerInstallation = true;
          continue;
        }

        if (givenValue && isStructValue(givenValue)) {
          // Navigate the field path through potentially nested struct records
          let currentModule = givenValue;
          let navigated = true;
          for (let i = 0; i < ep.fieldPath.length - 1; i++) {
            const pathSegment = ep.fieldPath[i]!;
            const idx = currentModule.type.fields.findIndex(
              (f) => f.label === pathSegment
            );
            const nextRecord = idx >= 0 ? currentModule.fields[idx] : undefined;
            if (nextRecord && isStructValue(nextRecord)) {
              currentModule = nextRecord;
            } else {
              navigated = false;
              break;
            }
          }
          if (navigated) {
            const lastLabel = ep.fieldPath[ep.fieldPath.length - 1]!;
            const fieldIndex = currentModule.type.fields.findIndex(
              (f) => f.label === lastLabel
            );
            if (fieldIndex >= 0) {
              const fieldValue = currentModule.fields[fieldIndex];
              if (fieldValue && isFunctionValue(fieldValue)) {
                // For generic functions that were specialized, the unspecialized C function
                // is not generated — only specialized versions exist. Use one of those
                // and cast to void* (the evidence param type for generic functions).
                if (fieldValue.specializedFunctionCaches?.length > 0) {
                  const specialized =
                    fieldValue.specializedFunctionCaches[0]!
                      .specializedFunction;
                  const specializedCName =
                    context.functions[specialized.funcId]?.cName;
                  if (specializedCName) {
                    result.push(`(void*)${specializedCName}`);
                    resolved = true;
                  }
                }
                if (!resolved) {
                  const cName = context.functions[fieldValue.funcId]?.cName;
                  if (cName) {
                    result.push(cName);
                    resolved = true;
                  }
                }
              }
            }
          }
        } else if (givenValue && isFunctionValue(givenValue)) {
          // Bare function evidence (non-module) — look up cName directly.
          // For generic handlers, use the specialized version (cast to void*)
          // since the unspecialized version has void* params that don't match.
          if (givenValue.specializedFunctionCaches?.length) {
            const specialized =
              givenValue.specializedFunctionCaches[0]!.specializedFunction;
            const specializedCName =
              context.functions[specialized.funcId]?.cName;
            if (specializedCName) {
              result.push(`(void*)${specializedCName}`);
              resolved = true;
            }
          }
          if (!resolved) {
            const cName = context.functions[givenValue.funcId]?.cName;
            if (cName) {
              result.push(cName);
              resolved = true;
            }
          }
        }
        // Fallback: if we found a variable by name but couldn't resolve the value
        // (runtime variables after Phase 2), look up function C name from context.
        if (!resolved && givenVar) {
          let cName: string | undefined;
          // Try to find the function C name from the variable's value
          const funcVal = givenVar.value?.find((v) => isFunctionValue(v));
          if (funcVal) {
            cName = context.functions[funcVal.funcId]?.cName;
          }
          if (!cName) {
            const callEnvForName = expr.func.$?.env ?? expr.$?.env;
            cName = getVariableNameForCodegen(givenVar.name, callEnvForName);
          }
          result.push(cName);
          resolved = true;
          isHandlerInstallation = true;
        }
        if (resolved) {
          isHandlerInstallation = true;
        }
      }
    }

    // 4. Inside async SM: resolve from state machine capture struct
    if (!resolved && context.stateMachineVariables) {
      const lastLabel = ep.fieldPath[ep.fieldPath.length - 1]!;
      for (const [, capturedVar] of context.stateMachineVariables) {
        if (capturedVar.name === lastLabel && capturedVar.kind === "outer") {
          result.push(`sm->__capture.${lastLabel}`);
          resolved = true;
          break;
        }
      }
    }

    if (!resolved) {
      break;
    }
  }

  return { args: result, isHandlerInstallation };
}

/**
 * Generate an evidence passing call site.
 * Emits: __yo_effect_escaped = 0; result = callee(args, evidence...); if (__yo_effect_escaped) { return; }
 */
function generateEvidenceCallSite(
  cFuncName: string,
  fullArgsList: string,
  functionType: FunctionType,
  expr: FnCallExpr,
  runtimeArgExprs: import("../../expr").Expr[] | undefined,
  indent: string,
  context: FunctionGenerationContext,
  isHandlerInstallation: boolean = false
): string {
  const emitter = context.emitter;
  const returnType = functionType.return.type;

  emitter.emitLine(`${indent}__yo_effect_escaped = 0;`);

  if (isUnitType(returnType)) {
    emitter.emitLine(`${indent}${cFuncName}(${fullArgsList});`);

    if (expr.$?.deferredDropExpressions) {
      generateDeferredDropExpressions(expr, indent, context);
    }

    emitter.emitLine(`${indent}if (__yo_effect_escaped) {`);
    // In async SMs, local variable cleanup is handled by _state_dispose
    if (!context.inAsyncStateMachine) {
      // Drop in-scope local variables before unwind propagation
      // (includes RC-typed args and other locals like closure captures)
      generatePendingDeferredDrops(
        indent + "  ",
        context,
        expr,
        false,
        true,
        false
      );
      generateConsumedVarDropsForEscape(indent + "  ", context, expr);
    }
    if (context.inAsyncStateMachine) {
      emitAsyncFutureEscape({
        emitter,
        indent: indent + "  ",
        resultCode: undefined,
        debugLabel: undefined,
      });
    } else {
      const callerReturnType = context.currentFunctionType?.return.type;
      if (isHandlerInstallation) {
        emitter.emitLine(`${indent}  __yo_effect_escaped = 0;`);
      }
      if (callerReturnType && !isUnitType(callerReturnType)) {
        if (isHandlerInstallation) {
          // Phase B of plans/archive/ITERATOR_REDESIGN.md — `-> ref(T)` lowers to
          // `T*` at the C ABI, so the unwind-fallback `(T){0}` would be
          // ill-typed. Wrap with `*` when the function declares a ref return.
          let callerCType = getTypeString(callerReturnType, context);
          if (
            context.currentFunctionType?.return.isRef &&
            callerCType !== "void" &&
            !callerCType.endsWith("*")
          ) {
            callerCType = `${callerCType}*`;
          }
          if (callerCType !== "void") {
            emitter.emitLine(`${indent}  ${callerCType} _unw_result;`);
            emitter.emitLine(
              `${indent}  memcpy(&_unw_result, __yo_unwind_value, sizeof(${callerCType}));`
            );
            emitter.emitLine(`${indent}  return _unw_result;`);
          } else {
            emitter.emitLine(`${indent}  return;`);
          }
        } else {
          // Phase B of plans/archive/ITERATOR_REDESIGN.md — `-> ref(T)` lowers to
          // `T*` at the C ABI, so the unwind-fallback `(T){0}` would be
          // ill-typed. Wrap with `*` when the function declares a ref return.
          let callerCType = getTypeString(callerReturnType, context);
          if (
            context.currentFunctionType?.return.isRef &&
            callerCType !== "void" &&
            !callerCType.endsWith("*")
          ) {
            callerCType = `${callerCType}*`;
          }
          if (callerCType !== "void") {
            emitter.emitLine(`${indent}  return (${callerCType}){0};`);
          } else {
            emitter.emitLine(`${indent}  return;`);
          }
        }
      } else {
        emitter.emitLine(`${indent}  return;`);
      }
    }
    emitter.emitLine(`${indent}}`);
    return "";
  } else {
    const tempVar = expr.$?.variableName;
    if (tempVar) {
      const cTypeString = getTypeString(returnType, context);
      emitter.emitLine(
        `${indent}${cTypeString} ${tempVar} = ${cFuncName}(${fullArgsList});`
      );
      storeTempVarToStateMachineIfNeeded(tempVar, indent, context);

      if (expr.$?.deferredDropExpressions) {
        generateDeferredDropExpressions(expr, indent, context);
      }

      emitter.emitLine(`${indent}if (__yo_effect_escaped) {`);
      // In async SMs, local variable cleanup is handled by _state_dispose
      if (!context.inAsyncStateMachine) {
        // Drop in-scope local variables before unwind propagation
        // (includes RC-typed args and other locals like closure captures)
        // `tempVar` is excluded: the callee unwound, so it never assigned a
        // value and the temp still holds return-register garbage.
        generatePendingDeferredDrops(
          indent + "  ",
          context,
          expr,
          false,
          true,
          false,
          undefined,
          tempVar
        );
        generateConsumedVarDropsForEscape(
          indent + "  ",
          context,
          expr,
          false,
          undefined,
          tempVar
        );
      }
      if (context.inAsyncStateMachine) {
        emitAsyncFutureEscape({
          emitter,
          indent: indent + "  ",
          resultCode: undefined,
          debugLabel: undefined,
        });
      } else {
        const callerReturnType = context.currentFunctionType?.return.type;
        if (
          isHandlerInstallation &&
          callerReturnType &&
          !isUnitType(callerReturnType)
        ) {
          // Phase B of plans/archive/ITERATOR_REDESIGN.md — `-> ref(T)` lowers to
          // `T*` at the C ABI, so the unwind-fallback `(T){0}` would be
          // ill-typed. Wrap with `*` when the function declares a ref return.
          let callerCType = getTypeString(callerReturnType, context);
          if (
            context.currentFunctionType?.return.isRef &&
            callerCType !== "void" &&
            !callerCType.endsWith("*")
          ) {
            callerCType = `${callerCType}*`;
          }
          emitter.emitLine(`${indent}  ${callerCType} _unw_result;`);
          emitter.emitLine(
            `${indent}  memcpy(&_unw_result, __yo_unwind_value, sizeof(${callerCType}));`
          );
          emitter.emitLine(`${indent}  __yo_effect_escaped = 0;`);
          emitter.emitLine(`${indent}  return _unw_result;`);
        } else if (callerReturnType && !isUnitType(callerReturnType)) {
          // Phase B of plans/archive/ITERATOR_REDESIGN.md — `-> ref(T)` lowers to
          // `T*` at the C ABI, so the unwind-fallback `(T){0}` would be
          // ill-typed. Wrap with `*` when the function declares a ref return.
          let callerCType = getTypeString(callerReturnType, context);
          if (
            context.currentFunctionType?.return.isRef &&
            callerCType !== "void" &&
            !callerCType.endsWith("*")
          ) {
            callerCType = `${callerCType}*`;
          }
          if (callerCType !== "void") {
            emitter.emitLine(`${indent}  return (${callerCType}){0};`);
          } else {
            emitter.emitLine(`${indent}  return;`);
          }
        } else {
          if (isHandlerInstallation) {
            emitter.emitLine(`${indent}  __yo_effect_escaped = 0;`);
          }
          emitter.emitLine(`${indent}  return;`);
        }
      }
      emitter.emitLine(`${indent}}`);
      return tempVar;
    } else {
      return `${cFuncName}(${fullArgsList})`;
    }
  }
}
