import { Environment, Frame } from "../env";
import { Expr } from "../expr";
import { FunctionValue } from "../function-value";
import { Value } from "../value";
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
   *   (compt(LinearI32) : Linear) = i32;
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
   * The module of the struct, which contains
   * the compile-time methods, properties, etc.
   */
  module?: ModuleType;
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
  module: ModuleType;
}

export interface ComptListType extends Type {
  tag: TypeTag.ComptList;
  childType: Type;
  module: ModuleType;
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

  module: ModuleType;
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
   * The required modules that this SomeType must implement.
   * For example, `Impl(Fn(x: i32) -> i32, Copy)` has requiredModules = [FnModule, CopyModule]
   */
  requiredModules: ModuleType[];

  /**
   * The negative modules that this SomeType must NOT implement.
   * For example, `Impl(!(Copy))` has negativeModules = [CopyModule]
   */
  negativeModules?: ModuleType[];

  /**
   * The module that contains where constraints attached to this SomeType.
   * This is separate from requiredModules which are the explicit modules in Impl(...).
   */
  module: ModuleType;
}

// Extended Type interface for compound types
export interface ArrayType extends Type {
  tag: TypeTag.Array;
  childType: Type;
  length: Value; // Compile-time known usize compatible value.
  module: ModuleType;
}

export interface SliceType extends Type {
  tag: TypeTag.Slice;
  childType: Type;
  module: ModuleType;
}

export interface VoidType extends Type {
  tag: TypeTag.Void;
  module: ModuleType;
}

export type ElementExprs = {
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
   *   x = 20
   *
   * assignedValueExpr is:
   *  20
   */
  assignedValueExpr?: Expr;
};

export interface TypeField {
  type: Type;
  label: string;
  isCompileTimeOnly: boolean;

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

  exprs: ElementExprs;
}

export interface TupleType extends Type {
  tag: TypeTag.Tuple;
  fields: TypeField[];
  module: ModuleType;
}

/**
 * NOTE: For anonymous function, it might not have labelExpr, typeExpr, and defaultValueExpr.
 */
export type FunctionParameterExprs = {
  expr: Expr;
  labelExpr?: Expr;
  typeExpr?: Expr;
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
  isOwningTheRefValue: boolean;
  /**
   * The expression information of the parameter.
   */
  exprs: FunctionParameterExprs;
  /**
   * The assigned value for := syntax (e.g., T := Impl(Id))
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
   * The module of the struct, which contains
   * the compile-time methods, properties, etc.
   */
  module: ModuleType;

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
   * Whether this element is compile-time only.
   * In theory, all module elements are compile-time only.
   */
  isCompileTimeOnly: true;

  /**
   * The module path that added this field via `impl`.
   * Used to clean up impls when re-evaluating a module.
   * Only set for fields with empty label (impl'd modules).
   */
  sourceModulePath?: string;

  // The default value and assigned value are compile-time known.
  defaultValue?: Value;
  assignedValue?: Value;

  exprs: ElementExprs;
}

/**
 * ModuleType is a structural type that represents a module. It's not a nominal type like Struct/Enum/Union.
 */
export interface ModuleType extends Type {
  tag: TypeTag.Module;

  /**
   * The function that returns the module.
   * eg:
   *   Container :
   *     fn(compt(T): Type)-> compt(Type)
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
   * ModuleType doesn't have a module field because it IS the module itself.
   * This is different from StructType/EnumType/UnionType which have a separate module.
   */
  module: undefined;

  /**
   * The env when the module type is created.
   * The env is also useful to show the frame level at which the module is defined.
   */
  env: Environment;

  /**
   * The type that is the receiverType of this module.
   * eg:
   *
   *   T <: Id
   *
   */
  receiverType?: Type;

  /**
   * If true, this module constraint is negated (the receiver must NOT implement this module).
   * This is used for where clauses like: where(Self <: !(Copy))
   */
  isNegatedConstraint?: boolean;

  /**
   * The constraints on Self from where clauses.
   * These are ModuleTypes that Self must implement.
   * eg:
   *
   *   Id :: module(
   *     where(Self <: Copy),
   *     id : (fn(x : Self) -> Self)
   *   );
   *
   * selfConstraints would contain [CopyModuleType]
   */
  selfConstraints?: ModuleType[];

  /**
   * The negative constraints on Self from where clauses.
   * These are ModuleTypes that Self must NOT implement.
   * eg:
   *
   *   Gc :: module(
   *     where(Self <: !(Copy)),
   *     ...
   *   );
   *
   * negativeSelfConstraints would contain [CopyModuleType]
   */
  negativeSelfConstraints?: ModuleType[];

  /**
   * If this module represents a Fn trait (callable type), this contains the function signature.
   * Set for modules created via `Fn(params) -> ReturnType` syntax.
   * The FunctionType contains the parameters and return type of the callable.
   */
  isFn?: FunctionType;
}

/**
 * FnModuleType represents a callable type (closure/function trait).
 * This replaces the old ClosureType - now closures are just ModuleTypes with isFn set.
 *
 * Examples:
 * - Fn(x: i32) -> i32
 * - Impl(Fn(x: i32, y: i32) -> string)
 */
export type FnModuleType = ModuleType & { isFn: FunctionType };

export interface EnumVariant {
  /**
   * Without `.` prefix
   */
  name: string;
  fields?: TypeField[]; // Changed from TypeField[] to TupleType for consistency
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
   * The module of the struct, which contains
   * the compile-time methods, properties, etc.
   */
  module: ModuleType;

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
   * The module of the union, which contains
   * the compile-time methods, properties, etc.
   */
  module: ModuleType;

  /**
   * The env when the union type is created.
   * The env is also useful to show the frame level at which the union is defined.
   */
  env: Environment;
}

export interface FunctionReturn {
  type: Type;
  /**
   * For anonymous function implementataion, let's set `expr` to undefined.
   */
  expr?: Expr;

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
   * Variadic parameters are parameters that can take a variable number of arguments.
   * They are usually defined with a `...` syntax.
   * eg:
   *
   *  (x: i32, y: i32, ...) -> i32; // c style
   *
   *  (quote(e): Expr, ...(quote(rest))) -> unquote(Expr); // macro, rest has type ComptList(Expr)
   *  (x: i32, y: i32, ...(rest)) -> i32;     // Yo style. rest has type ArgList
   *  (compt(x) : i32, compt(y) : i32, ...(compt(rest))); // Yo style. rest has type ArgList
   *
   */
  variadicParameter?: FunctionParameter;

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
   * The module that contains this function's methods (like ___drop, ___dup for closures).
   */
  module: ModuleType;

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

  module: ModuleType;
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
   * The required modules that this dynamic dispatch type can dispatch to.
   * This is used to create vtable for dynamic dispatch.
   * Now uses reference semantics by default, so it's not a dynamic sized type.
   */
  requiredModules: ModuleType[];

  /**
   * The negative modules that this DynType must NOT implement.
   * For example, `Dyn(!(Copy))` has negativeModules = [CopyModule]
   */
  negativeModules?: ModuleType[];

  /**
   * The module of the dyn type, which contains
   * the ARC methods (___dup, ___drop) for the dyn wrapper itself.
   * These operate on the dyn object, not the wrapped object.
   */
  module: ModuleType;

  /**
   * The env when the dyn type is created.
   * The env is also useful to show the frame level at which the dyn is defined.
   */
  env: Environment;
}

/**
 * FutureType represents an async/await future for stackless coroutines.
 * A Future(T) is a value that will be available in the future after an async operation completes.
 *
 * Examples:
 * - Future(i32): A future that will eventually yield an i32 value
 * - Future(string): A future that will eventually yield a string value
 * - Future(unit): A future that completes without returning a value
 *
 * Usage:
 * ```yo
 * read_async :: (fn(fd: i32) -> Future(String)) { ... }
 * future := read_async(fd);          // Returns Future(string)
 * result := await future;            // Waits for and extracts the string
 * ```
 */
export interface FutureType extends Type {
  tag: TypeTag.Future;

  /**
   * The type of value that this future will eventually yield.
   */
  childType: Type;

  /**
   * The module associated with this future type.
   * Contains ARC functions (___dup, ___drop) for reference counting.
   */
  module: ModuleType;

  /**
   * The env when the future type is created.
   * The env is also useful to show the frame level at which the future is defined.
   */
  env: Environment;
}
