import { Token, TokenType } from "./token";

export enum AstType {
  // values
  Integer = "integer",
  Float = "float",
  Boolean = "boolean",
  String = "string",
  Char = "char",
  TypeValue = "type-value",

  // variable
  Variable = "variable",

  // operators
  BinaryOperator = "binop",
  UnaryOperator = "unop",

  // assignment
  ConstantAssigment = "const=",
  LetAssignment = "let=",
  Assignment = "=",

  // parameters
  TypeParameter = "type-parameter",
  FunctionParameter = "function-parameter",

  // function
  FunctionPrototype = "function-prototype",
  Function = "function",
  CallFunction = "call-function",

  // extern
  Extern = "extern",
}

export type Expr =
  | Expr[]
  | FunctionExpr
  | ExternExpr
  | AssignmentExpr
  | UnaryOperatorExpr
  | BinaryOperatorExpr
  | VariableExpr
  | ValueExpr
  | CallFunctionExpr;

export type TopLevelExpr = Expr | FunctionExpr;

export type ValueExpr =
  | {
      type: AstType.Integer;
      value: string;
    }
  | {
      type: AstType.Float;
      value: string;
    }
  | {
      type: AstType.Boolean;
      value: boolean;
    }
  | {
      type: AstType.String;
      value: string;
    }
  | {
      type: AstType.Char;
      value: string;
    };

export type VariableExpr = {
  type: AstType.Variable;
  name: string;
};

export type BinaryOperatorExpr = {
  type: AstType.BinaryOperator;
  operator:
    | TokenType.Add
    | TokenType.Subtract
    | TokenType.Multiply
    | TokenType.Divide
    | TokenType.Modulo
    | TokenType.Equal
    | TokenType.NotEqual
    | TokenType.LessThan
    | TokenType.LessThanOrEqual
    | TokenType.GreaterThan
    | TokenType.GreaterThanOrEqual;
  left: Expr;
  right: Expr;
};

export type UnaryOperatorExpr = {
  type: AstType.UnaryOperator;
  operator: TokenType.Negate;
  expr: Expr;
};

export type TypeValueExpr = {
  type: AstType.TypeValue;
  value: string;
};

export type AssignmentExpr = {
  type: AstType.ConstantAssigment | AstType.LetAssignment; // | AstType.Assignment;
  variableName: AstType.Variable;
  variableType: TypeValueExpr;
  right: Expr;
};

export type TypeParameterExpr = {
  typeName: string;
  typeType: TypeValueExpr;
  type: AstType.TypeParameter;
};

export type FunctionParameterExpr = {
  parameterName: string;
  parameterType: TypeValueExpr;
  type: AstType.FunctionParameter;
};

export type FunctionPrototype = {
  type: AstType.FunctionPrototype;
  functionName: string;
  typeParameters: TypeParameterExpr[];
  functionParameters: FunctionParameterExpr[];
  returnType: TypeValueExpr;
};

export type FunctionExpr = {
  type: AstType.Function;
  prototype: FunctionPrototype;
  body: Expr[];
};

export type ExternExpr = {
  type: AstType.Extern;
  prototype: FunctionPrototype;
};

export type CallFunctionExpr = {
  type: AstType.CallFunction;
  functionName: string;
  functionArguments: Expr[];
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
