import { ValueType } from "./env";
import { Token, TokenType } from "./token";
import { TFunction, TInterface, TPrimitive, TUnit, Type } from "./type-checker";

export enum AstType {
  // values
  Value = "value",
  Record = "record",

  // variable
  Variable = "variable",
  PropertyAccess = "property-access",
  IndexAccess = "index-access",

  // operators
  BinaryOperator = "binop",
  UnaryOperator = "unop",

  // assignment
  ConstantAssigment = "const=",
  LetAssignment = "let=",
  Assignment = "=",
  TypeAlias = "type=",
  Interface = "interface",

  // parameters
  TypeParameter = "type-parameter",
  FunctionParameter = "function-parameter",

  // function
  FunctionPrototype = "function-prototype",
  Function = "function",
  CallFunction = "call-function",

  // enum
  Enum = "enum",

  // extern
  Extern = "extern",

  // control flow
  If = "if",

  // ignore
  Ignore = "ignore",
}

export enum OperatorType {
  LessThan = "<",
  LessThanOrEqual = "<=",
  Equal = "==",
  NotEqual = "!=",
  Add = "+",
  Subtract = "-",
  Multiply = "*",
  Divide = "/",
  Modulo = "%",
}

/**
 * All Expr should have `typeValue` attribute.
 */
export type Expr = (
  | FunctionExpr
  | ExternExpr
  | AssignmentExpr
  | TypeAliasExpr
  | InterfaceExpr
  | UnaryOperatorExpr
  | BinaryOperatorExpr
  | VariableExpr
  | PropertyAccessExpr
  | IndexAccessExpr
  | ValueExpr
  | CallFunctionExpr
  | IfExpr
  | IgnoreExpr
) & { typeValue: Type };

export type TopLevelExpr = Expr | FunctionExpr;

export type IgnoreExpr = {
  type: AstType.Ignore;
  typeValue: TUnit;
};

export type RecordValueExpr = {
  type: AstType.Value;
  tag: "record";
  typeValue: Type;
  properties: { name: string; value: Expr }[];
};

export type SliceValueExpr = {
  type: AstType.Value;
  tag: "slice";
  typeValue: Type;
  values: Expr[];
};

export type PrimitiveValueExpr = {
  type: AstType.Value;
  tag: "primitive";
  typeValue: TPrimitive;
};

export type ValueExpr = PrimitiveValueExpr | RecordValueExpr | SliceValueExpr;

export type VariableExpr = {
  type: AstType.Variable;
  name: string;
  typeValue: Type;
  frameLevel: number;
  // isFreeVariable: boolean;
};

export type PropertyAccessExpr = {
  type: AstType.PropertyAccess;
  propertyName: string;
  expr: Expr;
  typeValue: Type;
};

export type IndexAccessExpr = {
  type: AstType.IndexAccess;
  indexes: Expr[];
  expr: Expr;
  typeValue: Type;
};

export type BinaryOperatorExpr = {
  type: AstType.BinaryOperator;
  operator: OperatorType;
  left: Expr;
  right: Expr;
  typeValue: Type;
};

export type UnaryOperatorExpr = {
  type: AstType.UnaryOperator;
  operator: TokenType.LogicalNot;
  expr: Expr;
  typeValue: Type;
};

/*
export type TypeValueExpr = {
  type: AstType.TypeValue;
  value: string;
};
*/

export type AssignmentExpr = {
  type: AstType.ConstantAssigment; // | AstType.LetAssignment; // | AstType.Assignment;
  variableName: string;
  variableType: Type;
  frameLevel: number;
  right: Expr;
  typeValue: TUnit;
};

export type TypeAliasExpr = {
  type: AstType.TypeAlias;
  typeName: string;
  typeValue: Type;
};

export type InterfaceExpr = {
  type: AstType.Interface;
  interfaceName: string;
  typeValue: TInterface;
};

export type FunctionPrototype = {
  type: AstType.FunctionPrototype;
  functionName?: string; // If not set, it's an anonymous function
  typeValue: TFunction;
};

export type FunctionExpr = {
  type: AstType.Function;
  prototype: FunctionPrototype;
  /**
   * frameLevel at which the function is defined.
   */
  frameLevel: number;
  freeVariables: ValueType[];
  typeValue: TFunction;
  body: Expr[];
};

export type ExternExpr = {
  type: AstType.Extern;
  prototype: FunctionPrototype;
  typeValue: TFunction;
};

export type CallFunctionExpr = {
  type: AstType.CallFunction;
  callee: Expr;
  functionArguments: Expr[];
  typeValue: Type;
};

export type IfExpr = {
  type: AstType.If;
  condition: Expr;
  then: Expr[];
  else: Expr[];
  typeValue: Type;
};

/**
 * 1 is the lowest precedence
 */
const BinopPrecedence: { [key: string]: number } = {
  [TokenType.Equal]: 10,
  [TokenType.NotEqual]: 10,
  [TokenType.LessThan]: 20,
  [TokenType.LessThanOrEqual]: 20,
  [TokenType.GreaterThan]: 20,
  [TokenType.GreaterThanOrEqual]: 20,
  [TokenType.Add]: 30,
  [TokenType.Subtract]: 30,
  [TokenType.Multiply]: 40,
  [TokenType.Divide]: 40,
  [TokenType.Modulo]: 40,
};

export function getTokenPrecedence(token: Token | undefined): number {
  if (!token) {
    return -1;
  }
  if (token.type in BinopPrecedence) {
    return BinopPrecedence[token.type];
  } else {
    return -1;
  }
}

export function synthesizeRecordType(
  properties: {
    name: string;
    value: Expr;
  }[]
): Type {
  return {
    type: "Record",
    properties: properties.map(({ name, value }) => {
      return {
        name,
        type: value.typeValue,
      };
    }),
  };
}
