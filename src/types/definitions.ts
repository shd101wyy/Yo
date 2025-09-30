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
   *  Whether this type is a dynamic sized type.
   *  Dynamic sized types are types whose size cannot be determined at compile time.
   *  For example:
   *  - Slice
   *  - dyn Module (dynamic dispatch object)
   *  - void
   *
   *  DST also doesn't have type universe. So it cannot be Free/Linear/Type.
   */
  isDynamicSized?: boolean;

  /**
   * Whether the type is from the extern.
   * If undefined, then it's not an extern type.
   */
  isExtern?: ExternLanguage;

  /**
   * C header file to include when using this type.
   * Only applicable for extern "c" types.
   */
  cInclude?: string;
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
}

// Extended Type interface for compound types
export interface ArrayType extends Type {
  tag: TypeTag.Array;
  elementType: Type;
  length: Value; // Compile-time known usize compatible value.
}

export interface SliceType extends Type {
  tag: TypeTag.Slice;
  isDynamicSized: true;
  elementType: Type;
}

export interface VoidType extends Type {
  tag: TypeTag.Void;
  isDynamicSized: true;
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

export interface ElementType {
  type: Type;
  label: string;
  isCompileTimeOnly: boolean;
  isImplicit: boolean;

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

export interface TupleElement extends ElementType {
  // Additional tuple-specific properties can be added here if needed
}

export interface TupleType extends Type {
  tag: TypeTag.Tuple;
  elements: TupleElement[];
}

/**
 * NOTE: For anonymous function, it might not have labelExpr, typeExpr, and defaultValueExpr.
 */
export type FunctionParameterExprs = {
  expr: Expr;
  labelExpr?: Expr;
  typeExpr?: Expr;
  defaultValueExpr?: Expr;
};

export interface FunctionParameter {
  label: string;
  type: Type;
  isCompileTimeOnly: boolean;
  isQuote: boolean;
  exprs: FunctionParameterExprs;
}

export interface StructType extends Type {
  tag: TypeTag.Struct;

  /**
   * Whether this struct uses reference semantics.
   * true for "object(...)", false for "struct(...)"
   */
  isReferenceSemantics: boolean;

  /**
   * The function that returns the struct.
   * eg:
   *   Point :: struct(x: i32, y: i32)
   *
   * The struct Point is the function that returns the struct.
   */
  functionValue?: FunctionValue;

  /**
   * The elements of the struct.
   */
  elements: TupleElement[];

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

export interface ModuleElement {
  type: Type;
  label: string;
  isCompileTimeOnly: true;
  isImplicit: boolean;

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
   * The elements of the module.
   */
  elements: ModuleElement[];

  /**
   * The env when the module type is created.
   * The env is also useful to show the frame level at which the module is defined.
   */
  env: Environment;

  /**
   * The type that is the subtype of this module.
   * eg:
   *
   *   T <: Id
   *
   */
  subtype?: Type;
}

export interface EnumVariant {
  /**
   * Without `.` prefix
   */
  name: string;
  elements?: TupleElement[]; // Changed from TupleElement[] to TupleType for consistency
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
   * The elements of the union.
   */
  elements: TupleElement[];

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
  forallParameters: FunctionParameter[];

  /**
   * The implicit parameters (aka contextual parameters), usually define in implicit(...):
   * eg:
   *   (compt(T): Type, p: Point(T), implicit(Show(T)))-> String
   */
  implicitParameters: FunctionParameter[];

  /**
   * Variadic parameters are parameters that can take a variable number of arguments.
   * They are usually defined with a `...` syntax.
   * eg:
   *
   *  (x: i32, y: i32, ...) -> i32; // c style
   *
   *  (quote(e): Expr, ...(quote(rest))) -> unquote(Expr); // macro, rest has type ExprList
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
   * Under which module this function is defined.
   */
  ModuleType?: ModuleType;

  /**
   * Whether this function is a closure (uses => syntax) or a regular function (uses -> syntax).
   *
   * - true: fn(x: i32) => i32  (closure that can capture variables)
   * - false: fn(x: i32) -> i32  (regular function, no captures)
   * - undefined: regular function (default behavior)
   */
  isClosure?: boolean;
}

export interface MutPtrType extends Type {
  tag: TypeTag.MutPtr;
  id: TypeTag.MutPtr;
  /**
   * The type of the pointer.
   */
  type: Type;
}

/**
 * ClosureType represents a closure with simplified syntax:
 *
 * Examples:
 * - fn(elem : i32) => i32
 * - fn(x: i32, y: i32) => string
 */
export interface ClosureType extends Type {
  tag: TypeTag.Closure;

  /**
   * The function type that defines the call signature.
   * This is a regular function type without closure kinds.
   */
  callType: FunctionType & { isClosure: true };

  /**
   * The type that contains the captured variables.
   * This defines what variables the closure captures and how they are captured.
   *
   * For example:
   *   struct(counter: &(i32), base: &(i32))
   *
   * - undefined: Base closure type that can accept any closure with the same call signature
   * - StructType: Specific closure type with known captured variables
   */
  captureType: StructType | undefined;

  /**
   * The module that contains the closure's ARC functions (___drop, ___dup).
   * Similar to DynType's module property.
   */
  module: ModuleType;

  /**
   * The env when the closure type is created.
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
   * The module types that this dynamic dispatch type can dispatch to.
   * This is used to create vtable for dynamic dispatch.
   * Now uses reference semantics by default, so it's not a dynamic sized type.
   */
  moduleTypes: ModuleType[];

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
 * ThreadType represents a spawned thread with a specific return type.
 *
 * Examples:
 * - Thread(unit): A thread that returns unit (no value)
 * - Thread(i32): A thread that returns an i32 value
 * - Thread(String): A thread that returns a String value
 *
 * Usage:
 * ```yo
 * t := spawn some_function(); // Returns Thread(ReturnTypeOfSomeFunction)
 * result := __yo_thread_wait(t); // Get the result when the thread completes
 * ```
 */
export interface ThreadType extends Type {
  tag: TypeTag.Thread;

  /**
   * The type of value that this thread will return when completed.
   * This corresponds to the return type of the function passed to spawn.
   */
  returnType: Type;

  /**
   * The module associated with this thread type.
   * Contains ARC functions (___dup, ___drop) and other thread-related functions.
   */
  module: ModuleType;

  /**
   * The env when the thread type is created.
   * The env is also useful to show the frame level at which the thread is defined.
   */
  env: Environment;
}

/**
 * ChanType represents a Go-like channel for communication between threads.
 * Following Go's design, the buffer size is not part of the type - it's a runtime property.
 *
 * Examples:
 * - Chan(i32): A channel that sends/receives i32 values (can be buffered or unbuffered)
 * - Chan(string): A channel that sends/receives string values
 * - Chan(MyStruct): A channel for custom structs
 *
 * Usage:
 * ```yo
 * unbuffered := chan(i32);           // Creates unbuffered Chan(i32)
 * buffered := chan(string, 10);      // Creates buffered Chan(string) with capacity 10
 * __yo_chan_send(ch, value);         // Send value to channel
 * result := __yo_chan_recv(ch);      // Receive value from channel
 * ```
 */
export interface ChanType extends Type {
  tag: TypeTag.Chan;

  /**
   * The type of values that can be sent/received through this channel.
   */
  elementType: Type;

  /**
   * The module associated with this channel type.
   * Contains ARC functions (___dup, ___drop) and channel-related functions.
   */
  module: ModuleType;

  /**
   * The env when the channel type is created.
   * The env is also useful to show the frame level at which the channel is defined.
   */
  env: Environment;
}
