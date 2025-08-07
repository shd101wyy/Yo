import { Environment, Frame } from "../env";
import { Expr } from "../expr";
import { FunctionValue } from "../function-value";
import { Value } from "../value";
import { TypeTag } from "./tags";

export type TypeId = string;

export type ExternLanguage = "yo" | "c";

/**
 * The kind of closure behavior.
 * - "Fn": Immutable borrow closure (can be called multiple times, read-only access to captures)
 * - "FnMut": Mutable borrow closure (can be called multiple times, can mutate captures)
 * - "FnMove": Move closure (can only be called once, moves/consumes captured values)
 */
export type ClosureKind = "Fn" | "FnMut" | "FnMove";

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
   * Force this type to be treated as a linear type.
   */
  forceLinear?: boolean;

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
  tag: TypeTag.Free | TypeTag.Linear | TypeTag.Type;

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

  /**
   * Whether the parameter is mutable or not.
   * This affects:
   * - Variable reassignment: x = new_value
   * - Creating mutable references: &!(x), *!(x)
   *
   * Examples:
   * - x : i32        -> isMutable: false
   * - mut(x) : i32   -> isMutable: true
   */
  isMutable: boolean;

  isCompileTimeOnly: boolean;
  isQuote: boolean;
  exprs: FunctionParameterExprs;
}

export interface StructType extends Type {
  tag: TypeTag.Struct;

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
  expr: Expr;
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
   * Under which interface/struct/enum/union this function is defined.
   */
  SelfType?: Type;

  /**
   * Under which module this function is defined.
   */
  ModuleType?: ModuleType;

  /**
   * The kind of closure this function type represents.
   * - undefined: Regular function (uses -> syntax, doesn't capture)
   * - "Fn": Immutable borrow closure (can be called multiple times)
   * - "FnMut": Mutable borrow closure (can be called multiple times, can mutate)
   * - "FnMove": Move closure (can only be called once, moves captured values)
   */
  closureKind?: ClosureKind;

  /**
   * Whether this function type is an effectful function defined using `ctl` keyword.
   */
  isEffect: boolean;

  /**
   * Whether this function type is an effect handler function.
   * This is used to record the effect function type that this handler is implementing for.
   */
  isHandlerForEffectFunction?: FunctionType & { isEffect: true };
}

export interface MutPtrType extends Type {
  tag: TypeTag.MutPtr;
  id: TypeTag.MutPtr;
  /**
   * The type of the pointer.
   */
  type: Type;
}

export interface PtrType extends Type {
  tag: TypeTag.Ptr;
  id: TypeTag.Ptr;
  /**
   * The type of the pointer.
   */
  type: Type;
}

export interface MutRefType extends Type {
  tag: TypeTag.MutRef;
  id: TypeTag.MutRef;
  /**
   * The type of the reference.
   */
  type: Type;
}

export interface RefType extends Type {
  tag: TypeTag.Ref;
  id: TypeTag.Ref;
  /**
   * The type of the reference.
   */
  type: Type;
}

/**
 * ClosureType represents a closure as a combination of:
 * 1. A call function with the appropriate closure kind (Fn/FnMut/FnMove)
 * 2. A capture struct containing the captured variables
 *
 * Examples:
 * - Closure(FnMut(elem: i32) -> i32, _)
 * - Closure(Fn(elem: i32) -> i32, MyCapture)
 * - Closure(FnMove(elem: i32) -> i32, MyCapture)
 */
export interface ClosureType extends Type {
  tag: TypeTag.Closure;

  /**
   * The function type that defines the call signature and closure behavior.
   * This must have a closureKind set to "Fn", "FnMut", or "FnMove".
   *
   * The function signature should NOT include a self parameter - that's
   * handled internally based on the closure kind and capture type.
   */
  callType: FunctionType & { closureKind: ClosureKind };

  /**
   * The type that contains the captured variables.
   * This defines what variables the closure captures and how they are captured.
   *
   * For example:
   *   struct(counter: &!(i32), base: &(i32))
   *
   * - SomeType: When the capture type should be inferred (e.g., using "_")
   * - StructType: When the capture type is known and contains the captured variables
   */
  captureType: SomeType | StructType;

  /**
   * The env when the closure type is created.
   */
  env: Environment;
}

/**
 * EffType represents an effectful computation that produces a value of type A.
 *
 * Conceptually similar to IO monad in Haskell or Effect in PureScript.
 * An Eff(A) represents a suspended computation that, when executed,
 * will produce a value of type A (possibly with side effects).
 *
 * Examples:
 * - Eff(i32): An effectful computation that produces an i32
 * - Eff(string): An effectful computation that produces a string
 * - Eff(unit): An effectful computation that produces unit (side effects only)
 *
 * Implementation details:
 * - Built-in type with special runtime support
 * - Similar to a closure but with effect system integration
 * - Can capture context and suspend/resume execution
 * - Supports monadic composition via bind/flatMap
 */
export interface EffType extends Type {
  tag: TypeTag.Eff;

  /**
   * The type of value this effect computation will produce when executed.
   */
  resultType: Type;

  /**
   * The continuation function type that represents the suspended computation.
   * This is conceptually similar to: (context: Context) -> A
   *
   * The continuation captures:
   * 1. The computation to be performed
   * 2. Any captured variables from the surrounding scope
   * 3. The runtime context needed for effect execution
   */
  /*
    // NOTE: Let's not record it for now.
    continuationType: FunctionType;
  */

  /**
   * The type that contains captured variables and context.
   * This is similar to closure capture but for effects.
   *
   * Contains:
   * - Captured variables from lexical scope
   * - Effect context (e.g., IO state, error handlers, etc.)
   * - Continuation chain for composed effects
   */
  contextType: StructType;

  /**
   * The environment when this effect type was created.
   * Used for proper scoping and capture analysis.
   */
  env: Environment;
}
