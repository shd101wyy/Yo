import type { Environment } from "./env";
import type { CapturedVariableInfo } from "./evaluator/context";
import type { Expr } from "./expr";
import type { FnTraitType, FunctionType, Type } from "./types/definitions";
import type { Value } from "./value";
import { ValueTag } from "./value-tag";

export type FuncValueId = string;

export interface CalledComptimeFunctionCache {
  funcId: FuncValueId;
  /**
   * The function arguments that were used to call the comptime function.
   */
  argValues: Value[];
  /**
   * The environment after the function call.
   */
  env: Environment;
  /**
   * The return value of the comptime function call
   */
  value: Value;
  /**
   * Evaluated function body with the given argValues and env.
   */
  body: Expr;
}

export interface SpecializedFunctionCache {
  funcId: FuncValueId;
  /**
   * The environment after the function call.
   */
  env: Environment;
  /**
   * The compile-time arguments that were used to specialize the function.
   */
  compileTimeArgValues: Value[];
  /**
   * The runtime parameter types that were used to specialize the function.
   * This is used to differentiate specializations that have the same compile-time
   * arguments but different concrete runtime types (e.g., different closure capture structs).
   */
  runtimeParameterTypes: Type[];
  /**
   * The specialized function with evaluated body.
   */
  specializedFunction: FunctionValue;
  /**
   * Evaluated function body with the given argValues and env.
   */
  // body: Expr; // No need to save this. FunctionValue already has the body.
}

export type FunctionValue = {
  tag: ValueTag.Function;

  /**
   * The type of the function.
   */
  type: FunctionType;

  /**
   * The type of the function after removing all the compile-time parameters.
   * This is useful for code generation and other operations.
   */
  specializedType?: FunctionType;

  /**
   * The frame level of the env at which the function is defined.
   */
  frameLevel: number;

  /**
   * The function body expression.
   */
  body: Expr;

  /**
   * The CPS-transformed function body, if the function uses 'do' expressions.
   * This is kept separate from the original body for debugging and other purposes.
   */
  cpsTransformedBody?: Expr;

  /**
   * The function name, if available
   */
  funcName?: string;

  /**
   * The unique identifier of the function
   */
  funcId: FuncValueId;

  /**
   * This is used to cache the result of the call to the function that returns a comptime type value.
   * For example, a function returns a Type.
   * If the function is not a comptime function, this will be empty.
   */
  calledComptimeFunctionCaches: CalledComptimeFunctionCache[];

  /**
   * This is used to cache specialized versions of generic functions with compile-time parameters.
   * Each cache entry stores a specialized function for a specific set of compile-time arguments.
   */
  specializedFunctionCaches: SpecializedFunctionCache[];

  /**
   * Whether this function's body uses `escape` to return from the enclosing function.
   * Set after evaluating the function body. Used by effect analysis and codegen
   * to determine which functions are effect handlers that need state machine generation.
   */
  isControlFunction?: boolean;

  /**
   * The enclosing function type at the definition site of this function value.
   * Used to preserve `recur` resolution semantics for nested function parameter
   * type re-evaluation without storing parent links on FunctionType.
   */
  definitionSiteEnclosingFunctionType?: FunctionType;

  /**
   * Closure-specific information.
   * Only set for functions that are closure implementations.
   * Contains the FnTraitType and capture struct type for easy access during codegen.
   */
  closureInfo?: ClosureInfo;

  /**
   * When true, this function is used as an effect handler and must be compiled
   * as a concrete C function (even if its type has generic parameters), since it
   * will be stored as a void* function pointer for evidence passing.
   *
   * Set in two places:
   * - effect record members: fields of an effect record value used as an effect handler
   *   (set in codegen collection via collectEffectRecordMembers)
   * - Bare function-type effect handlers: function values assigned via `given`
   *   bindings (set in evaluator initialization-assignment)
   */
  isEffectRecordMember?: boolean;

  /**
   * When true, this closure's body is handled by an io.async state machine.
   * The codegen should NOT generate a separate C function for this closure.
   */
  isIoAsyncStateMachineClosure?: boolean;

  /**
   * When set, this function value has a registered derive rule.
   * Used by `derive_rule(TraitConstructor, DeriveFn)` to store the user-defined
   * derive function on the trait constructor's FunctionValue.
   * The derive rule function has signature:
   *   fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr)
   */
  deriveRule?: FunctionValue;
};

export interface FunctionCapturedVariableInfo extends CapturedVariableInfo {
  value: Value | undefined; // The actual captured value
  type: Type; // The type of the captured value
  isEffectParam?: boolean; // True for effect handler params from using(...)
}

/**
 * Information about a closure, stored on closure function values.
 * This allows codegen to easily access the closure type and capture struct type
 * without having to search through the type collection.
 */
export interface ClosureInfo {
  /**
   * The FnTraitType that represents this closure's callable interface
   */
  closureType: FnTraitType;

  /**
   * The capture struct type that holds captured variables
   */
  captureType: Type | undefined; // StructType | undefined

  /**
   * Effect param names in the capture struct (from using(...) params).
   * These fields are zero-initialized at io.async time and injected
   * at io.spawn/io.await time with concrete handler values.
   */
  effectParamNames?: string[];

  /**
   * Captured field names that are consumed inside the closure body
   * (passed to an own(self) parameter). Used by thread/worker spawn
   * codegen to NULL these fields in the heap-copied capture struct
   * after the closure runs, preventing double-free.
   */
  consumedCaptures?: string[];
}
