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
   * Marks this type as an IO module builtin function.
   * Set on IO module field types so that io.async and io.await
   * can be detected even when aliased (e.g., `my_async :: io.async`).
   */
  ioBuiltin?: "io_async" | "io_await";
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
   * If true, this SomeType represents an effect row variable (declared via `...(E)` in forall).
   * When bound, its value will be an EffectsRowType containing the concrete implicit parameters.
   */
  isEffectsRow?: boolean;
}

/**
 * EffectsRowType holds the concrete list of implicit parameters that an effect row variable
 * (declared via `...(E)` in forall) was bound to.
 * For example, after `run(might_fail)` with might_fail : fn(using(raise : Raise)) -> i32,
 * E is bound to EffectsRowType { implicitParameters: [{ label: "raise", type: RaiseType }] }.
 */
export interface EffectsRowType extends Type {
  tag: TypeTag.EffectsRow;
  implicitParameters: FunctionImplicitParameter[];
  trait: TraitType;
}

// Extended Type interface for compound types
export interface ArrayType extends Type {
  tag: TypeTag.Array;
  childType: Type;
  length: Value; // Compile-time known usize compatible value.
  trait: TraitType;
}

export interface SliceType extends Type {
  tag: TypeTag.Slice;
  childType: Type;
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
   * Whether this parameter is an implicit parameter (from `using(...)`).
   * Implicit parameters are resolved from `given` variables in scope at the call site.
   */
  isImplicit: boolean;
  /**
   * If true, this entry in implicitParameters is an effect row spread marker.
   * - Named spread `...(E)`: label = "E", type = SomeType_E (isEffectsRow: true)
   * - Anonymous spread `...`:  label = "...", type = unit (placeholder)
   * At call sites, spread entries are expanded to the concrete implicit params
   * bound to the effect row variable.
   */
  isEffectRowSpread?: boolean;

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

export type FunctionImplicitParameter = FunctionParameter & {
  isCompileTimeOnly: true;
  isImplicit: true;
};

export interface StructType extends Type {
  tag: TypeTag.Struct;

  /**
   * Whether this struct uses reference semantics.
   * true for "object(...)", false for "struct(...)"
   */
  isReferenceSemantics: boolean;

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

export interface ModuleField {
  type: Type;
  label: string;

  /**
   * The module path that added this field via `impl`.
   * Used to clean up impls when re-evaluating a module.
   * Only set for fields with empty label (impl'd modules).
   */
  sourceModulePath?: string;

  // The default value and assigned value are compile-time known.
  defaultValue?: Value;
  assignedValue?: Value;

  exprs: FieldExprs;
}

/**
 * TraitField extends ModuleField with additional support for associated types.
 * When a trait field is declared as `Error : Type` (a type field without assigned value),
 * we create a SomeType placeholder that represents the associated type.
 */
export interface TraitField extends ModuleField {
  /**
   * For associated types (fields declared as `X : Type` without an assigned value),
   * this holds a SomeType placeholder that represents the associated type.
   * When the trait is implemented, this SomeType will be replaced with the actual type.
   */
  unassignedSomeType?: SomeType;
}

/**
 * ModuleType is a ~~nominal~~structural type that represents a module.
 * Modules are compared by their unique id, not by their structure.
 * FnTraitType and FutureTraitType are exceptions that use structural comparison.
 */
export interface ModuleType extends Type {
  tag: TypeTag.Module;

  /**
   * The function that returns the module.
   * eg:
   *   Container :
   *     fn(comptime(T): Type)-> comptime(Type)
   *       module(x: T, y: T)
   * ;
   * "Container" is the function that returns the module.
   */
  functionValue?: FunctionValue;

  /**
   * The fields of the module.
   */
  fields: ModuleField[];

  /**
   * ModuleType doesn't have a trait field because modules are not traits.
   * This is different from StructType/EnumType/UnionType which have a separate trait.
   */
  trait: undefined;

  /**
   * The env when the module type is created.
   * The env is also useful to show the frame level at which the module is defined.
   */
  env: Environment;
}

/**
 * TraitType is a nominal type that represents a trait.
 * Trait are compared by their unique id, not by their structure.
 * FnTraitType and FutureTraitType are exceptions that use structural comparison.
 */
export interface TraitType extends Type {
  tag: TypeTag.Trait;
  /**
   * The function that returns the module.
   * eg:
   *   Container :
   *     fn(comptime(T): Type)-> comptime(Type)
   *       trait(x: T, y: T)
   * ;
   * "Container" is the function that returns the trait.
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
   * eg:
   *
   *   Id :: module(
   *     where(Self <: Copy),
   *     id : (fn(x : Self) -> Self)
   *   );
   *
   * selfConstraints would contain [Copy]
   */
  selfConstraints?: TraitType[];

  /**
   * The negative constraints on Self from where clauses.
   * These are TraitTypes that Self must NOT implement.
   * eg:
   *
   *   Gc :: module(
   *     where(Self <: !(Copy)),
   *     ...
   *   );
   *
   * negativeSelfConstraints would contain [Copy]
   */
  negativeSelfConstraints?: TraitType[];

  /**
   * If this trait represents a Fn trait (callable type), this contains the function signature.
   * Set for traits created via `Fn(params) -> ReturnType` syntax.
   * The FunctionType contains the parameters and return type of the callable.
   */
  isFn?: { callType: FunctionType };

  /**
   * If this trait represents a Future type, this contains the child type.
   * Set for traits created via `Future(T)` syntax.
   */
  isFuture?: { outputType: Type };

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
 * FutureTraitType represents an async/await future for stackless coroutines.
 * This replaces the old FutureType - now futures are just TraitTypes with isFuture set.
 *
 * Examples:
 * - Future(i32): A future that will eventually yield an i32 value
 * - Impl(Future(i32)) for static dispatch with futures
 * - Dyn(Future(i32)) for dynamic dispatch
 */
export type FutureTraitType = TraitType & { isFuture: { outputType: Type } };

/**
 * ConcreteModuleType is a marker module that specifies the concrete type for Impl.
 * Used with extern types to explicitly set resolvedConcreteType.
 *
 * Examples:
 * - Concrete(yo_io_future): marker that the concrete type is yo_io_future
 * - Impl(Concrete(yo_io_future), Future(i32)): Future with explicit C type
 */
export type ConcreteModuleType = TraitType & {
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
  // TODO: return type? For GADT
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
   * The implicit parameters, defined in using(...):
   * eg:
   *   (fn(x: i32, using(add_fn : (fn(a : i32, b : i32) -> i32))) -> i32)
   */
  implicitParameters: FunctionImplicitParameter[];

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
   * The trait that contains this function's methods (like ___drop, ___dup for closures).
   */
  trait: TraitType;

  /**
   * Whether this function type represents a closure.
   * Closures capture variables from the defining environment.
   * It's usually defined from Fn module types, like:
   *
   *   Impl(Fn(x : i32) -> i32)
   *   Dyn(Fn(x : i32) -> i32)
   *
   */
  isClosure?: boolean;
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
