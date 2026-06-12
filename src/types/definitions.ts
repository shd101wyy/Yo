import type { Environment, Frame } from "../env";
import type { Expr } from "../expr";
import type { FunctionValue } from "../function-value";
import type { Value } from "../value";
import { TypeTag } from "./tags";

export type TypeId = string;

export type ExternLanguage = "yo" | "c";

export interface Type {
  /**
   * The tag to identify the type of type.
   */
  tag: TypeTag;

  /**
   * The unique id of the type.
   */
  id: TypeId;

  /**
   * The size of the type in bits, not bytes.
   * For example, a 32-bit integer has a size of 4 bytes.
   * A 64-bit integer has a size of 8 bytes.
   * If not specified, the size is unknown.
   */
  // size?: number;

  /**
   * The name of the struct.
   * eg:
   *   Point :: struct(i32, i32);
   * Point is the name of the struct.
   *
   * eg:
   *   (comptime(LinearI32) : Linear) = i32;
   * LinearI32 is the name of the type.
   */
  typeName?: string;

  /**
   * Whether the type is from the extern.
   * If undefined, then it's not an extern type.
   */
  isExtern?: ExternLanguage;

  /**
   * The name of the type in the extern language.
   * eg:
   *
   *   extern "Yo",
   *     say :: (fn() -> unit)
   *   ;
   *
   * "say" is the extern name of the function "say".
   */
  externName?: string;

  /**
   * C header file to include when using this type.
   * Only applicable for extern "c" types.
   */
  cInclude?: string;

  /**
   * The trait of the type, which contains
   * the compile-time methods, properties, etc.
   */
  trait?: TraitType;

  /**
   * The module path where this type was defined.
   * Used for orphan rule checks to ensure coherence.
   */
  definedInModulePath?: string;

  /**
   * Marks this type as an Io module builtin function.
   * Set on Io effect record field types so that io.async and io.await
   * can be detected even when aliased (e.g., `my_async :: io.async`).
   */
  ioBuiltin?:
    | "io_async"
    | "io_await"
    | "io_state"
    | "io_spawn"
    | "join_handle_await";
}

/*
// NOTE: This is not actually used now.
export interface LiteralType extends Type {
  tag: TypeTag.Literal;
  //
  // The value of the singleton type.
  // This is also used to represent the value of a variable.
  //
  value: unknown;
  //
  // The type of the value.
  //
  type: Type;
}
*/

export interface ExprType extends Type {
  tag: TypeTag.Expr;
  id: TypeTag.Expr;
  trait: TraitType;
}

export interface ComptimeListType extends Type {
  tag: TypeTag.ComptimeList;
  childType: Type;
  trait: TraitType;
}

export interface TypeHierarchyType extends Type {
  tag: TypeTag.Type;

  /**
   * Level of the type in the hierarchy.
   * For example, Free/Linear/Type types are at level 0.
   * Type of Type    = Type(1) is at level 1.
   * Type of Type(1) = Type(2) is at level 2.
   */
  level: number;

  // The base type of this hierarchy type.
  baseType?: Type;

  trait: TraitType;
}

/**
 * SomeType is a type that is not known.
 *
 * MyType: (Type <: Display)
 * - type: (Type <: Display)
 * - value: SomeType(Type <: Display)
 *
 * The value here is the SomeType itself.
 */
export interface SomeType extends Type {
  tag: TypeTag.SomeType;

  /**
   * The name of the SomeType.
   * eg: T: Type
   * T is the name of the SomeType.
   */
  name: string;

  /**
   * The frame level where this SomeType was defined.
   * Used to resolve bindings without leaking across shadowed scopes.
   */
  definitionFrameLevel?: number;

  /**
   * The parent type of the SomeType.
   */
  parentType: TypeHierarchyType;
  /**
   * size is unknown for SomeType
   */
  size: undefined;

  /**
   * The function application expression that created this SomeType.
   * This is useful for error reporting and debugging.
   */
  functionApplication?: Expr;

  /**
   * The resolved concrete type for this SomeType.
   *
   * For example, when we have `Impl(Fn(y: i32) -> i32)` with a closure body
   * that captures variable `x`, the resolvedConcreteType would be an anonymous
   * struct type like `struct(x: i32)` that contains the captured variables.
   *
   * This allows us to:
   * 1. Use SomeType as an abstraction (like a trait object)
   * 2. Know the actual concrete type at compile time for static dispatch
   *
   * For `Impl(...)`, this is set when evaluating the implementation body.
   * For `Dyn(...)`, this remains undefined since the concrete type is only
   * known at runtime.
   */
  resolvedConcreteType?: Type;

  /**
   * The required traits that this SomeType must implement.
   * Each constraint includes the frameLevel at which it was added.
   * For example, `Impl(Fn(x: i32) -> i32, Copy)` has requiredTraits with the corresponding traits.
   * NOTE: where-clause constraints are scoped in env frames, not stored here.
   */
  requiredTraits: { traitType: TraitType; frameLevel: number }[];

  /**
   * The negative traits that this SomeType must NOT implement.
   * Each constraint includes the frameLevel at which it was added.
   * For example, `Impl(!(Copy))` adds entries here.
   * NOTE: where-clause constraints are scoped in env frames, not stored here.
   */
  negativeTraits: { traitType: TraitType; frameLevel: number }[];

  /**
   * The trait that contains where constraints attached to this SomeType.
   * This is separate from requiredTraits which are the explicit traits in Impl(...).
   */
  trait: TraitType;

  /**
   * For recursive type references created by `recur` during compile-time evaluation,
   * stores the function and arguments needed to resolve the actual type later.
   * When this SomeType is used as a constructor, we look up the actual type from
   * the function's cache using these values.
   */
  recursiveTypeRef?: {
    functionValue: FunctionValue;
    argValues: Value[];
  };

  /**
   * When present, this SomeType represents a higher-kinded type variable with a function-type kind.
   * For example, `forall(F : (fn(comptime(T) : Type) -> comptime(Type)))` creates a SomeType
   * with kindFunctionType set to the `fn(comptime(T) : Type) -> comptime(Type)` function type.
   * This enables HKT support — F can be passed `Option`, `ArrayList`, etc. as concrete constructors.
   */
  kindFunctionType?: FunctionType;
}

/**
 * TypeApplicationType represents the symbolic application of an abstract type constructor
 * to type arguments. Created when `F(A)` is evaluated and `F` is an abstract SomeType
 * with a function-type kind (e.g., `forall(F : (fn(comptime(T) : Type) -> comptime(Type)))`).
 *
 * TypeApplication must NEVER reach codegen — it must be fully resolved during type evaluation
 * when the abstract constructor becomes concrete.
 *
 * Example: `F(A)` where F is abstract → TypeApplicationType { constructor: F, args: [A] }
 *          When F is bound to `Option`, resolves to `Option(A)`.
 */
export interface TypeApplicationType extends Type {
  tag: TypeTag.TypeApplication;

  /**
   * The abstract type constructor (a SomeType with kindFunctionType).
   * This is the `F` in `F(A)`.
   */
  constructor: SomeType;

  /**
   * The type arguments applied to the constructor.
   * For example, `F(A, B)` has args [A, B].
   */
  args: Type[];

  /**
   * The result kind of the application, inferred from the constructor's
   * return type. Usually Type (level 0).
   */
  resultKind: Type;

  /**
   * The trait associated with this type application.
   */
  trait: TraitType;
}

// Extended Type interface for compound types
export interface ArrayType extends Type {
  tag: TypeTag.Array;
  childType: Type;
  length: Value; // Compile-time known usize compatible value.
  trait: TraitType;
}

/// `str` — builtin immutable fat-pointer view of STATIC string bytes.
/// C lowering: `typedef struct { const uint8_t* ptr; size_t len; } __yo_str;`
export interface StrType extends Type {
  tag: TypeTag.Str;
  trait: TraitType;
}

export interface VoidType extends Type {
  tag: TypeTag.Void;
  trait: TraitType;
}

export type FieldExprs = {
  /**
   * The expression of the element.
   */
  expr: Expr;
  /**
   * For example:
   *   x in (x: i32)
   */
  labelExpr?: Expr;
  /**
   * For example:
   *   i32 in (x: i32)
   *
   * We have to make `?: Expr` for anonymous struct value.
   */
  typeExpr?: Expr;
  /**
   * For example:
   *   x ?= 10
   *
   * defaultValueExpr is:
   *   10
   */
  defaultValueExpr?: Expr;
  /**
   * For example:
   *   x := 20
   *
   * assignedValueExpr is:
   *  20
   */
  assignedValueExpr?: Expr;
};

export interface TypeField {
  type: Type;
  label: string;

  /**
   * Whether this field is compile-time only and has no runtime layout.
   * Set by `comptime(name) : Type` and `name :: value` field syntax.
   */
  isCompileTimeOnly?: boolean;

  // The default value and assigned value are compile-time known.
  // eg:
  //   Point(x ?= 10, y = 20)
  // Here,
  //   `x ?= 10` has a default value of 10.
  //   `y = 20` has an assigned value of 20.
  //     So the struct will be
  //   Point(x: i32 ?= 10, y: i32 = 20)
  //     which is Point(y: i32)
  defaultValue?: Value;
  assignedValue?: Value;

  exprs: FieldExprs;

  // True for capture struct fields that hold effect handler function pointers.
  // These fields are zero-initialized at io.async time and populated at
  // io.spawn/io.await time with the concrete handler from using(...).
  isEffectParam?: boolean;

  // The module path that added this field via `impl`.
  // Used to clean up impls when re-evaluating a module.
  // Only set for fields with empty label (impl'd modules).
  sourceModulePath?: string;

  // Doc comment extracted from `///` comments preceding this field definition.
  docComment?: string;
}

export interface TupleType extends Type {
  tag: TypeTag.Tuple;
  fields: TypeField[];
  trait: TraitType;
}

export type FunctionParameterExprs = {
  expr: Expr;
  labelExpr?: Expr;
  /**
   * Always required to be set
   */
  typeExpr: Expr;
  defaultValueExpr?: Expr;
  assignedValueExpr?: Expr;
};

export interface FunctionParameter {
  /**
   * The label of the parameter.
   */
  label: string;
  /**
   * The type of the parameter.
   */
  type: Type;
  /**
   * Whether this parameter is compile-time only.
   */
  isCompileTimeOnly: boolean;

  /**
   * Whether this parameter is a quote parameter for constructing macro.
   */
  isQuote: boolean;
  /**
   * Whether this parameter takes ownership of ARC values.
   * When true, the caller must dup the value before passing.
   * The parameter becomes the owner and will be dropped at function exit.
   */
  isOwningTheRcValue: boolean;

  /**
   * Whether this parameter is declared with the `inout(name) : T`
   * modifier — second-class reference semantics. The caller's
   * variable is bound to the param by reference; assignments inside
   * the callee write through to the caller. The param identifier
   * cannot escape the callee (no return, no store in let/var/struct
   * field, no closure capture).
   *
   * At codegen, inout(name) : T lowers to a T* in C; reads become
   * (*name), writes become (*name) = v. Callers pass &(caller_var).
   *
   * See plans/MEMORY_SAFETY.md Phase B.
   */
  isRef?: boolean;

  /**
   * The expression information of the parameter.
   */
  exprs: FunctionParameterExprs;
  /**
   * The assigned value for "=" syntax (e.g., (T : Type) = Impl(Id))
   * This is the constraint/value bound to the type parameter.
   * Only used for forall parameters.
   */
  assignedValue?: Value;
}

export type FunctionForallParameter = FunctionParameter & {
  isCompileTimeOnly: true;
};

export interface StructType extends Type {
  tag: TypeTag.Struct;

  /**
   * Whether this struct uses reference semantics.
   * true for "object(...)", false for "struct(...)"
   */
  isReferenceSemantics: boolean;

  /**
   * Whether this object uses atomic reference counting.
   * true for "atomic object(...)", false otherwise.
   * Atomic objects use thread-safe atomic RC operations and do NOT
   * participate in cycle collection. They auto-derive Send when
   * all fields implement Send.
   */
  isAtomicRc?: boolean;

  /**
   * Whether this struct is a newtype.
   * A newtype is a struct with a single element.
   * eg:
   *   NewInt :: newtype(value: i32);
   *
   * NewInt is a newtype.
   */
  isNewtype: boolean;

  /**
   * Whether this struct is the namespace value for an imported source file.
   * Source namespaces are compile-time values with import-only metadata.
   */
  isSourceNamespace?: true;

  /**
   * The function that returns the struct.
   * eg:
   *   Point :: struct(x: i32, y: i32)
   *
   * The struct Point is the function that returns the struct.
   */
  functionValue?: FunctionValue;

  /**
   * The fields of the struct.
   */
  fields: TypeField[];

  /**
   * The trait of the union, which contains
   * the compile-time methods, properties, etc.
   */
  trait: TraitType;

  /**
   * The env when the struct type is created.
   * The env is also useful to show the frame level at which the struct is defined.
   */
  env: Environment;
}

/**
 * TraitField extends TypeField with additional support for associated types.
 * When a trait field is declared as `Error : Type` (a type field without assigned value),
 * we create a SomeType placeholder that represents the associated type.
 */
export interface TraitField extends TypeField {
  /**
   * For associated types (fields declared as `X : Type` without an assigned value),
   * this holds a SomeType placeholder that represents the associated type.
   * When the trait is implemented, this SomeType will be replaced with the actual type.
   */
  unassignedSomeType?: SomeType;
}

/**
 * SourceNamespaceType is an alias for StructType with isSourceNamespace: true.
 * Imported source files use this marker for namespace-only behavior while
 * remaining ordinary StructType values.
 */
export type SourceNamespaceType = StructType & { isSourceNamespace: true };

/**
 * TraitType is a nominal type that represents a trait.
 * Trait are compared by their unique id, not by their structure.
 * FnTraitType and FutureTraitType are exceptions that use structural comparison.
 */
export interface TraitType extends Type {
  tag: TypeTag.Trait;
  /**
   * The function that returns the trait.
   */
  functionValue?: FunctionValue;

  /**
   * The fields of the trait.
   */
  fields: TraitField[];

  /**
   * TraitType doesn't have a trait field because traits are not traits.
   */
  trait: undefined;

  /**
   * The env when the trait type is created.
   * The env is also useful to show the frame level at which the trait is defined.
   */
  env: Environment;

  /**
   * The type that is the receiverType of this trait.
   * eg:
   *
   *   T <: Id
   */
  receiverType?: Type;

  /**
   * If true, this trait constraint is negated (the receiver must NOT implement this trait).
   * This is used for where clauses like: where(Self <: !(Copy))
   */
  isNegatedConstraint?: boolean;

  /**
   * The constraints on Self from where clauses.
   * These are TraitTypes that Self must implement.
   * A trait with `where(Self <: Copy)` records Copy here.
   */
  selfConstraints?: TraitType[];

  /**
   * The negative constraints on Self from where clauses.
   * These are TraitTypes that Self must NOT implement.
   * A trait with `where(Self <: !(Copy))` records Copy here.
   */
  negativeSelfConstraints?: TraitType[];

  /**
   * If this trait represents a Fn trait (callable type), this contains the function signature.
   * Set for traits created via `Fn(params) -> ReturnType` syntax.
   * The FunctionType contains the parameters and return type of the callable.
   */
  isFn?: { callType: FunctionType };

  /**
   * If this trait represents a Future type, this contains the output type
   * and (optionally) a single effect bundle.
   * Set for traits created via `Future(T)` or `Future(T, E)` syntax.
   *
   * `effect` carries the bundle's type and a display/capture-struct
   * field label derived from the type's name. Multiple effects are
   * packed into a single struct by the user before being passed here.
   */
  isFuture?: { outputType: Type; effect?: FutureEffect };

  /**
   * If this trait represents a Concrete type marker, this contains the concrete type.
   * Set for traits created via `Concrete(T)` syntax.
   * Used in Impl(Concrete(T), ...) to explicitly specify the resolvedConcreteType.
   */
  isConcrete?: { concreteType: Type };

  /**
   * The module path where this trait was defined.
   * Used for orphan rule checks to ensure coherence.
   * Inherited from Type.definedInModulePath.
   */
  definedInModulePath?: string;

  /**
   * For specialized traits, constraints on associated types.
   * Created when calling a trait type with `:=` arguments, e.g., `Iterator(Item := i32)`.
   * Used in where clauses to constrain associated types.
   */
  associatedTypeConstraints?: { label: string; constraintType: Type }[];

  /**
   * When set, this trait has a registered derive rule.
   * Used by `derive_rule(TraitConstructor, DeriveFn)` to store the user-defined
   * derive function on parameterless traits.
   * The derive rule function has signature:
   *   fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr)
   */
  deriveRule?: FunctionValue;
}

/**
 * FnTraitType represents a callable type (closure/function trait).
 * This replaces the old ClosureType - now closures are just TraitTypes with isFn set.
 *
 * Examples:
 * - Fn(x: i32) -> i32
 * - Impl(Fn(x: i32, y: i32) -> string)
 */
export type FnTraitType = TraitType & { isFn: { callType: FunctionType } };

/**
 * A single effect bundle entry on a Future trait.
 */
export interface FutureEffect {
  /** Display / capture-struct field name derived from the effect type. */
  label: string;
  /** The effect bundle type (typically a struct type or a forall-bound SomeType). */
  type: Type;
}

/**
 * FutureTraitType represents an async/await future for stackless coroutines.
 * This replaces the old FutureType - now futures are just TraitTypes with isFuture set.
 *
 * Examples:
 * - Future(i32): A future that will eventually yield an i32 value
 * - Impl(Future(i32)) for static dispatch with futures
 * - Dyn(Future(i32)) for dynamic dispatch
 */
export type FutureTraitType = TraitType & {
  isFuture: { outputType: Type; effect?: FutureEffect };
};

/**
 * ConcreteTraitType is a marker trait that specifies the concrete type for Impl.
 * Used with extern types to explicitly set resolvedConcreteType.
 *
 * Examples:
 * - Concrete(yo_io_future): marker that the concrete type is yo_io_future
 * - Impl(Concrete(yo_io_future), Future(i32)): Future with explicit C type
 */
export type ConcreteTraitType = TraitType & {
  isConcrete: { concreteType: Type };
};

export interface EnumVariant {
  /**
   * Without `.` prefix
   */
  name: string;
  fields?: TypeField[]; // Changed from TypeField[] to TupleType for consistency
  /**
   * Custom discriminant value for this variant.
   * If not specified, the discriminant will be automatically assigned
   * based on the previous variant's discriminant + 1.
   */
  discriminant?: bigint;
  /**
   * GADT return type arguments for this variant.
   * When a variant uses `-> recur(Type1, Type2, ...)`, these are the
   * type arguments [Type1, Type2, ...] that specify the concrete
   * instantiation of the enum this constructor produces.
   * Absent means unconstrained (same as regular enum behavior).
   */
  gadtReturnTypeArgs?: Type[];
}

export interface EnumType extends Type {
  tag: TypeTag.Enum;

  /**
   * The function that returns the enum.
   */
  functionValue?: FunctionValue;

  /**
   * The variants of the enum.
   */
  variants: EnumVariant[];

  /**
   * The trait of the enum, which contains
   * the compile-time methods, properties, etc.
   */
  trait: TraitType;

  /**
   * The env when the enum type is created.
   * The env is also useful to show the frame level at which the enum is defined.
   */
  env: Environment;

  /**
   * The size of the tag in bits.
   */
  // tagSize: number;

  /**
   * The name of the selected variant.
   */
  selectedVariantName?: string;

  /**
   * The required variant of the enum type.
   * For example:
   *
   *   Shape :: enum
   *     Circle(radius: i32),
   *     Square(side: i32)
   *   ;
   *
   *   circle : Shape(.Circle required) = Shape.Circle(10);
   *
   * Here, the type of circle is Shape(.Circle required).
   */
  requiredVariantNames?: string[];

  /**
   * GADT: The type arguments this enum was instantiated with.
   * For `Expr(i32)`, this is `[i32Type]`.
   * For `Expr(T)` where T is a SomeType, this is `[SomeType(T)]`.
   * Only set for generic enums created by type constructor functions.
   */
  typeConstructorArgs?: Type[];

  /**
   * Whether this enum is a GADT (has at least one variant with gadtReturnTypeArgs).
   */
  isGadt?: boolean;
}

export interface UnionType extends Type {
  tag: TypeTag.Union;

  /**
   * The function that returns the union.
   */
  functionValue?: FunctionValue;

  /**
   * The fields of the union.
   */
  fields: TypeField[];

  /**
   * The trait of the union, which contains
   * the compile-time methods, properties, etc.
   */
  trait: TraitType;

  /**
   * The env when the union type is created.
   * The env is also useful to show the frame level at which the union is defined.
   */
  env: Environment;
}

export interface FunctionReturn {
  type: Type;

  /**
   * Always set to the return type expression.
   * For anonymous function implementations, reuse the expected return type expression.
   */
  typeExpr: Expr;

  isCompileTimeOnly: boolean;
  isUnquote: boolean;
  label: string;
  /**
   * True when the function's return slot is declared `-> ref(T)`.
   * The function yields a second-class reference (lowered to `T*` at
   * the C ABI) into storage rooted in one of its `ref`-typed
   * parameters. The "flowability" rule on the return expression
   * ensures the borrow is sound. See `plans/ITERATOR_REDESIGN.md`.
   */
  isRef?: boolean;
}

export interface FunctionType extends Type {
  tag: TypeTag.Function;

  /**
   * The normal parameters of the function.
   */
  parameters: FunctionParameter[];

  /**
   * The type parameters, usually defined in forall(...):
   * eg:
   *   (forall(T: Type), x: T)-> T;
   */
  forallParameters: FunctionForallParameter[];

  /**
   * Variadic parameters are parameters that can take a variable number of arguments.
   * They are usually defined with a `...` syntax.
   * eg:
   *
   *  (x: i32, y: i32, ...) -> i32; // c style
   *
   *  (quote(e): Expr, ...(quote(rest))) -> unquote(Expr); // macro, rest has type ComptimeList(Expr)
   *  (x: i32, y: i32, ...(rest)) -> i32;     // Yo style. rest has type ArgList
   *  (comptime(x) : i32, comptime(y) : i32, ...(comptime(rest))); // Yo style. rest has type ArgList
   *
   */
  variadicParameter?: FunctionParameter;

  /**
   * Where-clause constraint expressions attached to this function type.
   * These are re-applied when evaluating the function body.
   */
  whereClauseExprs?: Expr[];

  /**
   * `requires(...)` precondition expressions extracted from the
   * function signature. Phase 0 of plans/FORMAL_VERIFICATION.md: each
   * predicate becomes a runtime `assert(predicate, "...")` at function
   * entry in default mode. Later phases lift these to SMT verification
   * conditions.
   *
   * Each entry is a single predicate expression (not the wrapping
   * `requires(...)` call). The single-call rule (one `requires(...)`
   * clause per signature, with multiple comma-separated predicates) is
   * enforced when the FunctionType is built.
   */
  requiresExprs?: Expr[];

  /**
   * `ensures(...)` postcondition expressions extracted from the
   * function signature. Phase 0: each predicate becomes a runtime
   * `assert(predicate, "...")` at function return in default mode.
   * Inside an ensures predicate, the magic identifier `result` refers
   * to the function's return value (scope handling is added when the
   * ensures clauses are lowered at codegen).
   */
  ensuresExprs?: Expr[];

  /**
   * The return information of the function.
   */
  return: FunctionReturn;
  /**
   * The env when the function type is created.
   * The env shouldn't contain the frame that have the parameters.
   * The env is also useful to show the frame level at which the function is defined.
   */
  env: Environment;

  /**
   * The frame that contains the parameters
   */
  parametersFrame: Frame;

  /**
   * Under which struct/enum/union this function is defined.
   */
  SelfType?: Type;

  /**
   * The trait type that this function was defined in (for SelfTrait resolution).
   * Set when a function type is created inside a trait(...) definition.
   */
  SelfTraitType?: Type;

  /**
   * The trait that contains this function's methods (like ___drop, ___dup for closures).
   */
  trait: TraitType;

  /**
   * Whether this function type represents a closure.
   * Closures capture variables from the defining environment.
   * It's usually defined from Fn trait types, like:
   *
   *   Impl(Fn(x : i32) -> i32)
   *   Dyn(Fn(x : i32) -> i32)
   *
   */
  isClosure?: boolean;

  /**
   * Whether this function type is a control function — declared with
   * `ctl(...) -> ret` rather than `fn(...) -> ret`. Control functions
   * may contain `unwind` in their body; their values are frame-bound
   * (cannot escape via return, module-level binding, heap allocation,
   * closure capture, or pointer indirection). See
   * plans/EXPLICIT_EFFECTS.md §4.
   */
  isControl?: boolean;
}

export interface PtrType extends Type {
  tag: TypeTag.Ptr;
  /**
   * The type of the pointer.
   */
  childType: Type;

  trait: TraitType;
}

/**
 * IsoType represents an isolated value with atomic reference counting.
 * Used for safe sharing of data across threads.
 *
 * Example:
 *   Iso(Box(i32))  // Type constructor
 *   Iso(Box(i32))(x)  // Value constructor (consumes x)
 *
 * Properties:
 * - Uses atomic reference counting (thread-safe)
 * - Can be freely copied and shared across threads
 * - Construction requires unique ownership (no aliases)
 * - extract() method returns Option(T) and can only succeed once
 */
export interface IsoType extends Type {
  tag: TypeTag.Iso;
  /**
   * The inner type that is isolated.
   */
  childType: Type;

  /**
   * The trait of the Iso type, which contains
   * the ARC methods (___dup_iso, ___drop_iso) using atomic operations.
   */
  trait: TraitType;

  /**
   * The env when the Iso type is created.
   */
  env: Environment;
}

/*
 *   eg:
 *   use_id :: (fn(value: Dyn(GiveInt)) -> unit) {
 *     return value.give_int();
 *   }
 */
export interface DynType extends Type {
  tag: TypeTag.Dyn;

  /**
   * The required traits that this dynamic dispatch type can dispatch to.
   * This is used to create vtable for dynamic dispatch.
   * Now uses reference semantics by default, so it's not a dynamic sized type.
   */
  requiredTraits: { traitType: TraitType; frameLevel: number }[];

  /**
   * The negative traits that this DynType must NOT implement.
   * For example, `Dyn(!(Copy))` has negativeTraits = [CopyTrait]
   */
  negativeTraits: { traitType: TraitType; frameLevel: number }[];

  /**
   * The trait of the dyn type, which contains
   * the ARC methods (___dup, ___drop) for the dyn wrapper itself.
   * These operate on the dyn object, not the wrapped object.
   */
  trait: TraitType;

  /**
   * The env when the dyn type is created.
   * The env is also useful to show the frame level at which the dyn is defined.
   */
  env: Environment;
}
