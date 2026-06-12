import type { Environment, Variable } from "../env";
import { YoError } from "../error";
import type { Expr, FnCallExpr, PathCollection, ComptimeRef } from "../expr";
import type { FunctionValue } from "../function-value";
import type { Token } from "../token";
import type { FunctionType, TraitType, Type } from "../types/definitions";
import type { StructValue, TraitValue, Value } from "../value";

export interface FunctionEvaluationContext {
  kind: "function-body";
  type: FunctionType;
  value?: FunctionValue;
  /**
   * The environment at the time the function body is being evaluated.
   * This is used to determine the frame level for closure variable capture.
   * The evaluationEnv should contain the frame of parameters/arguments
   */
  evaluationEnv: Environment;
}

export type LoadModuleFn = (modulePath: string) => {
  moduleValue: StructValue;
  moduleError: Error | undefined;
};

export type EvaluateExpressionFn = ({
  expr,
  env,
  context,
}: {
  expr: Expr;
  env: Environment;
  context: EvaluatorContext;
}) => Expr;

export interface AsyncBlockEvaluationContext {
  kind: "async-block";
  evaluationEnv: Environment;
}

export interface TestBlockEvaluationContext {
  kind: "test-block";
  evaluationEnv: Environment;
}

export interface EvaluatorContext {
  /**
   * Whether we are currently executing code (true) or just analyzing/type-checking it (false).
   * This flag prevents side effects like comptime_print from executing during function definition.
   */
  isExecuting?: boolean;

  /**
   * Whether we are currently validating a function definition (type checking the function body).
   * This prevents certain side effects from occurring during function definition validation.
   */
  isValidatingFunctionDefinition?: boolean;

  /**
   *
   */
  expectedType?: {
    type: Type;
    env: Environment;
  };

  /**
   * Record the function that is currently being evaluated.
   * This is used for calling the `recur` function.
   *
   * Whether we are currently evaluating an async block.
   * This affects how we evaluate expressions within the async block.
   * For example, `await` expressions are only valid within async blocks.
   * Contains the environment at the time the async block started evaluation,
   * used to determine which variables are captured from outer scopes.
   *
   */
  isEvaluatingFunctionBodyOrAsyncBlock?:
    | FunctionEvaluationContext
    | AsyncBlockEvaluationContext
    | TestBlockEvaluationContext;

  /**
   * Whether we are currently evaluating an impl block body.
   * Used to prevent mutable runtime variables (:=) inside impl blocks.
   */
  isInsideImplBlock?: boolean;

  /**
   * For closures and async blocks, track variables captured from outer scopes.
   * Maps variable name to usage information (frame level, usage type, token).
   * This is populated during evaluation when isEvaluatingFunctionBodyOrAsyncBlock is set.
   */
  capturedVariables?: Map<string, CapturedVariableInfo>;

  /**
   * Captured variables that are actually consumed via own(self) parameter passing
   * inside the closure body. This is a subset of capturedVariables where usageType === "own".
   * Used by thread/worker spawn codegen to NULL these fields in the heap-copied capture
   * struct after the closure runs, preventing double-free.
   */
  ownConsumedCaptures?: Set<string>;

  /**
   * Whether we are currently evaluating a while/for loop.
   * This record the env that is used for the while/for loop body.
   */
  isEvaluatingLoopBody?: {
    kind: "while" | "for";
    env: Environment;
  };

  /**
   * The innermost struct, enum, or union that this function call is inside.
   * This can be useful for an anonymous struct that needs to refer to itself
   */
  SelfType?: Type;

  /**
   * The trait type currently being defined.
   * Used inside trait(...) definitions to allow self-referencing via `SelfTrait`.
   * For example: `source : (fn(self: *(Self)) -> Option(Dyn(SelfTrait)))`
   */
  SelfTraitType?: Type;

  /**
   * The receiverType for implementing the trait value.
   * Like:
   *
   * impl Point, Add(Point)(
   *   (+) : ((lhs, rhs) -> Point(lhs.x + rhs.x, lhs.y + rhs.y))
   * );
   *
   * here Point is the ReceiverType.
   */
  ReceiverType?: Type;

  /**
   * Whether we are currently evaluating a function type definition.
   * When true, implicit parameters dependencies are deferred and assumed to be satisfied.
   * This allows clean type declarations like `M3 :: (fn(using(M2Instance : M2())) -> Type)`
   * without requiring all transitive dependencies to be resolved at type definition time.
   */
  isEvaluatingFunctionType?: boolean;

  /**
   * The function to load modules.
   * @param modulePath
   * @returns
   */
  loadModule?: (modulePath: string) => {
    moduleValue: StructValue;
    moduleError: Error | undefined;
  };

  /**
   * The path of the standard library modules.
   */
  stdPath: string;

  /**
   * The path of the module currently being evaluated.
   * Used to track which module added impl fields for cleanup on re-evaluation.
   */
  currentModulePath?: string;

  /**
   * Whether the function type being evaluated is marked as unsafe.
   */
  isUnsafeFunctionType?: boolean;

  /**
   * Whether we are currently inside an `unsafe(...)` expression body.
   * When true, pointer deref (`p.*`), pointer arithmetic (`&+`, `&-`,
   * `&/`), and `consume(p.* = v)` are permitted. Outside `unsafe(...)`,
   * those operations are compile errors.
   *
   * Pointer comparison operators (`&==`, `&!=`, `&<`, `&>`, `&<=`,
   * `&>=`) and pointer casts (`*(U)(p)`) stay safe — they don't
   * dereference, so they're not gated.
   *
   * This flag is NOT inherited across function-call boundaries — each
   * function body starts with `unsafeContext = false`. To allow an
   * unsafe op inside a function body, the body must wrap it in
   * `unsafe(...)` explicitly. This keeps the unsafe surface auditable
   * at the function-definition site.
   *
   * See plans/MEMORY_SAFETY.md for the full design.
   */
  unsafeContext?: boolean;

  /**
   * Whether the function type being evaluated was declared with `ctl(...)
   * -> ret` (the control-function constructor). Control functions may
   * contain `unwind` in their body and are frame-bound — see
   * plans/EXPLICIT_EFFECTS.md §4 for the type-system rules.
   */
  isControlFunctionType?: boolean;

  /**
   * The return type of the enclosing (parent) function.
   * This is set when evaluating a nested function body, enabling `escape expr`
   * to return from the enclosing function. `escape` is valid in any function
   * that has an enclosing function - the unwind value's type must match this type.
   */
  enclosingFunctionReturnType?: Type;

  /**
   * Whether the enclosing function being specialized has implicit params
   * bound to control function handlers (handlers whose body uses `escape`).
   * Set during specialization when handler values with isControlFunction are detected.
   */
  hasControlFunctionImplicitParams?: boolean;

  /**
   * Whether we are currently evaluating a where clause constraint.
   * When true, the LHS of `<:` must be a SomeType, and the constraint
   * will be added to the SomeType's trait constraints rather than creating a new trait type.
   */
  isInsideWhereClause?: boolean;

  /**
   * Whether we are currently evaluating the LHS of an assignment.
   * When true, accessing non-copyable fields is allowed because we're assigning into them,
   * not moving out of them.
   */
  isLhsOfAssignment?: boolean;

  /**
   * Track the concrete type of Impl(...) returns across all return statements in a function.
   * When a function returns Impl(...) (SomeType), all return statements must return
   * values of the SAME concrete type due to static dispatch.
   * This is a mutable container (array with 0 or 1 element) that can be shared across
   * context copies to preserve mutations.
   */
  functionReturnImplConcreteType?: Array<{
    concreteType: Type;
    env: Environment;
    token: Token;
  }>;

  /**
   * When true, forces all variable bindings (including `:=`) to be compile-time only.
   * This is used during CTFE (Compile-Time Function Evaluation) so that runtime-style
   * variable declarations inside a function body are still evaluated at compile time.
   *
   * For example, in `temp := x.*;`, normally `temp` would be a runtime variable.
   * But during CTFE with this flag set, `temp` becomes a compile-time variable.
   */
  forceCompileTimeBindings?: boolean;

  /**
   * When true, `evaluateBinding` skips its "Runtime variables with generic
   * function types are not allowed" check. The caller (typically
   * `evaluateAssignment`) takes responsibility for performing an
   * equivalent check after evaluating the RHS, where it has enough
   * information to relax the constraint for ctl handlers whose body
   * always unwinds (the C ABI never delivers the forall'd return value
   * in that case). See `allPathsUnwind` in `src/expr-traversal.ts`.
   */
  deferGenericFnTypeCheckToAssignment?: boolean;

  /**
   * Whether we are currently analyzing CTFE capability (with UnknownValue parameters).
   * This is different from forceCompileTimeBindings which is also used during actual CTFE execution.
   *
   * When true, `recur` calls should short-circuit and return an UnknownValue instead of
   * actually recursing, to avoid infinite loops during capability analysis.
   */
  isAnalyzingCtfeCapability?: boolean;

  /**
   * True while evaluating the RHS of a `ref(name) := …` borrow binding.
   * The borrow-invalidation call gate is suppressed for this subtree:
   * creating ANOTHER borrow from an already-borrowed source (e.g.
   * `ref(again) := list.project(0)` while `first` is live) is allowed —
   * the projection call hands out a reference, it doesn't invalidate the
   * existing ones. The new binding then records its own marks on the same
   * sources. (Residual: a ref-returning method that ALSO mutates would
   * slip through here — needs per-method effect annotations; tracked in
   * issues/flowability-growth-invalidation-method-calls.md.)
   */
  isEvaluatingRefBindingRhs?: boolean;

  /**
   * When true, we're in the "checking phase" of function call resolution where we
   * verify that arguments match parameter types. During this phase, we should NOT
   * execute CTFE functions - only verify types. This prevents exponential blowup
   * in recursive CTFE functions where each argument evaluation would otherwise
   * trigger full CTFE execution.
   */
  isInFunctionCallCheckingPhase?: boolean;

  /**
   * Whether we are evaluating the closure argument of an io.async call.
   * When true, the closure body should be evaluated as an async block
   * (kind: "async-block") so that `await` expressions are allowed inside.
   */
  isInsideIoAsyncCall?: boolean;

  /**
   * Whether we are currently re-evaluating type expressions during generic impl
   * specialization. When true, associated types (e.g., Output) are looked up
   * from the env before falling through to findAssociatedTypeFromGenericImpls,
   * which can be ambiguous when multiple impls of the same trait exist.
   */
  isEvaluatingGenericImplSpecialization?: boolean;

  /**
   * When inside createSpecializedFunctionInline body evaluation, this stores
   * the specialized funcId and return type so that recursive calls can create
   * a forward-reference to the specialized function being built.
   *
   * Top-of-stack — equals the innermost specialization in progress. Kept in
   * sync with `currentlySpecializingFunctionStack`.
   */
  currentlySpecializingFunction?: {
    originalFuncId: string;
    specializedFuncId: string;
    specializedReturnType: Type;
    originalFunction: FunctionValue;
  };

  /**
   * Full stack of in-progress specializations. Needed to detect *mutual*
   * recursion between sibling functions (e.g., two methods inside the same
   * `impl(...)` block calling each other). Without this, only direct
   * self-recursion is short-circuited and mutual recursion blows the stack
   * via infinite re-specialization.
   *
   * See `issues/mutual-recursion-impl-method-specialization-overflow.md`.
   */
  currentlySpecializingFunctionStack?: Array<{
    originalFuncId: string;
    specializedFuncId: string;
    specializedReturnType: Type;
    originalFunction: FunctionValue;
  }>;

  /**
   * Lookup map from declaration token location to doc comment content.
   * Built by extractDocComments() before evaluation starts.
   * Used by initialization-assignment to set Variable.docComment.
   */
  docCommentLookup?: Map<string, string>;
}

/**
 * Record the function call arguments and their values after function call.
 */
export interface ArgValues {
  forallArgs: { value: Value; parameterType: Type; argType: Type }[];
  args: { value: Value | undefined; parameterType: Type; argType: Type }[];
  implicitArgs?: { value: Value; parameterType: Type; argType: Type }[];
  variadicArgs: {
    value: Value | undefined;
    argType: Type;
  }[];
}

export interface FunctionCallResult {
  calleeEnv: Environment;
  callerEnv: Environment;
  pathCollection: PathCollection;
  returnType: Type;
  returnValue: Value | undefined;
  argValues: ArgValues;
  runtimeArgExprsInOrder: Expr[];
  /**
   * If the function has compile-time parameters and was specialized,
   * this contains the specialized function value with the evaluated body.
   * Otherwise, this is undefined.
   */
  specializedFunctionValue?: FunctionValue;
  /**
   * Drop expressions that need to be executed to clean up temporary variables
   * created during the function call (e.g., for function arguments that own Rc values).
   */
  deferredDropExpressions?: Expr[];
}

export interface TypeCallResult {
  values: (Value | undefined)[];
  pathCollection: PathCollection;
  runtimeArgExprsInOrder: Expr[];
  callerEnv: Environment;
}

export interface RecordTypeCallResult {
  moduleValue: StructValue;
  callerEnv: Environment;
}

export interface TraitTypeCallResult {
  traitValue: TraitValue;
  callerEnv: Environment;
}

export interface TraitSpecializationResult {
  specializedTraitType: TraitType;
  callerEnv: Environment;
}

export interface MacroFunctionCallResult {
  calleeEnv: Environment;
  callerEnv: Environment;
  returnExpr: Expr;
}

export interface NumericTypeCallResult {
  expr: Expr;
  env: Environment;
}

export interface PointerTypeCallResult {
  expr: Expr;
  env: Environment;
}

export interface IndexCallResult {
  /**
   * The auto-dereferenced value (Output type, not *(Output)).
   */
  value: Value | undefined;

  /**
   * The auto-dereferenced type (Output).
   */
  type: Type;

  /**
   * The pointer type returned by index() before auto-deref: *(Output).
   * Used for &(value(i)) to skip the auto-deref.
   */
  ptrType: Type;

  /**
   * The specialized function type of the index method.
   * May be undefined for comptime array/slice element access.
   */
  indexMethodType: FunctionType | undefined;

  /**
   * The specialized function value of the index method (may be undefined for runtime dispatch).
   */
  indexMethodValue: Value | undefined;

  /**
   * The caller environment after evaluating the argument.
   */
  callerEnv: Environment;

  /**
   * The compile-time index, if known. Used for building pathCollection
   * to support array element assignment (arr(0) = val).
   */
  index?: number;

  /**
   * Unified compile-time element/field reference for mutation and pointer creation.
   */
  comptimeRef?: ComptimeRef;
}

export interface FunctionToCall {
  type: Type;
  /**
   * This is the original arg expressions.
   * Not the one we called with cloneExpr(...)
   */
  args?: Expr[];
  value?: Value;
  result:
    | {
        /**
         * This is the result from calling:
         *
         *   tryToCallFunctionWithArguments
         */
        kind: "function";
        result: FunctionCallResult;
      }
    | {
        /**
         * This is the result from calling:
         *
         *   tryToCallTypeWithArguments
         */
        kind: "type";
        result: TypeCallResult;
      }
    | {
        /**
         * This is the result from calling:
         *
         *   tryToImplementFunctionByFunctionType
         */
        kind: "function-type";
      }
    | {
        /**
         * This is the result from calling:
         *
         *   tryToImplementArrayByArrayType
         */
        kind: "array-type";
      }
    | {
        /**
         * This is the result from calling:
         *
         *   tryToImplementClosureByClosureType
         */
        kind: "closure-type";
      }
    | {
        /**
         * This is the result from calling:
         *
         *   tryToImplementRecordWithArguments
         */
        kind: "record-type";
        result: RecordTypeCallResult;
      }
    | {
        /**
         * This is the result from calling:
         *
         *   tryToImplementTraitWithArguments
         */
        kind: "trait-type";
        result: TraitTypeCallResult;
      }
    | {
        /**
         * This is the result from specializing a trait type with `:=` arguments.
         * e.g., Iterator(Item := i32) produces a specialized TraitType.
         */
        kind: "trait-specialization";
        result: TraitSpecializationResult;
      }
    | {
        /**
         * This is the result from calling:
         *
         *   tryToConvertToNumericType
         */
        kind: "numeric-type";
        result: NumericTypeCallResult;
      }
    | {
        /**
         * This is the result from calling:
         *
         *   tryToConvertToPointerType
         */
        kind: "pointer-type";
        result: PointerTypeCallResult;
      }
    | {
        /**
         * This is the result from calling:
         *
         *   evaluateIsoValueCall
         */
        kind: "iso-value";
        result: FnCallExpr;
      }
    | {
        /**
         * This is the result from calling:
         *
         *   tryToCallWithIndexTrait
         *
         * Dispatches value(arg) via the Index trait.
         */
        kind: "index";
        result: IndexCallResult;
      }
    | {
        kind: "error";
        error: Error | YoError;
      };
}

export function getFunctionCallResult(
  functionToCall: FunctionToCall
): FunctionCallResult {
  if (functionToCall.result.kind !== "function") {
    throw new Error("Expected function call result");
  }
  return functionToCall.result.result;
}

export function getTypeCallResult(
  functionToCall: FunctionToCall
): TypeCallResult {
  if (functionToCall.result.kind !== "type") {
    throw new Error("Expected type call result");
  }
  return functionToCall.result.result;
}

export function getRecordTypeCallResult(
  functionToCall: FunctionToCall
): RecordTypeCallResult {
  if (functionToCall.result.kind !== "record-type") {
    throw new Error("Expected record type call result");
  }
  return functionToCall.result.result;
}

export function getTraitTypeCallResult(
  functionToCall: FunctionToCall
): TraitTypeCallResult {
  if (functionToCall.result.kind !== "trait-type") {
    throw new Error("Expected trait type call result");
  }
  return functionToCall.result.result;
}

export function getIndexCallResult(
  functionToCall: FunctionToCall
): IndexCallResult {
  if (functionToCall.result.kind !== "index") {
    throw new Error("Expected index call result");
  }
  return functionToCall.result.result;
}

export function getPointerTypeCallResult(
  functionToCall: FunctionToCall
): PointerTypeCallResult {
  if (functionToCall.result.kind !== "pointer-type") {
    throw new Error("Expected pointer type call result");
  }
  return functionToCall.result.result;
}

export type EvaluateExpression = ({
  expr,
  env,
  context,
}: {
  expr: Expr;
  env: Environment;
  context: EvaluatorContext;
}) => Expr;

/**
 * Track usage of variables in closure contexts.
 * This enforces the borrowing rules for different closure types.
 */
export function trackVariableUsage(
  variableName: string,
  frameLevel: number,
  usageType: "read" | "write" | "own",
  token: Token,
  context: EvaluatorContext
): void {
  // Only track for closures or async blocks
  if (!context.isEvaluatingFunctionBodyOrAsyncBlock) {
    return;
  }

  // Determine the evaluation environment
  // Note: Check async block first since we can be inside both a function and an async block
  let evaluationEnv: Environment | undefined;
  if (context.isEvaluatingFunctionBodyOrAsyncBlock) {
    evaluationEnv = context.isEvaluatingFunctionBodyOrAsyncBlock.evaluationEnv;
  }

  // Only track variables from outer scopes (not local variables)
  if (!evaluationEnv || frameLevel >= evaluationEnv.frames.length) {
    return;
  }

  // Get the variable from the evaluation environment by searching all frames
  // The frameLevel parameter is relative to the original environment, but we need to
  // find the variable in evaluationEnv which may have different frame indices
  let variable: Variable | undefined = undefined;
  let actualFrameLevel = -1;

  for (let i = 0; i < evaluationEnv.frames.length; i++) {
    const found = evaluationEnv.frames[i]?.variables.find(
      (v) => v.name === variableName
    );
    if (found) {
      variable = found;
      actualFrameLevel = i;
      break;
    }
  }

  if (!variable || actualFrameLevel < 0) {
    return;
  }

  if (variable.isCompileTimeOnly) {
    // Don't track compile-time only variables
    return;
  }

  // Track the variable usage
  if (!context.capturedVariables) {
    context.capturedVariables = new Map();
  }

  const existing = context.capturedVariables.get(variableName);

  // Update with the highest privilege usage type (own > write > read)
  const newUsageType =
    existing &&
    (existing.usageType === "own" ||
      (existing.usageType === "write" && usageType === "read"))
      ? existing.usageType
      : usageType;

  context.capturedVariables.set(variableName, {
    frameLevel: actualFrameLevel, // Use the actual frame level in evaluationEnv
    usageType: newUsageType,
    token,
  });
}

export interface CapturedVariableInfo {
  frameLevel: number;
  usageType: "read" | "write" | "own"; // How the variable is used
  token: Token; // Token where the usage occurs
}
