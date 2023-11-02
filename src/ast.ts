import { Token, TokenType } from "./token";
import {
  TFunction,
  Type,
  TypeValues,
  VariableTypes,
  checkType,
  typeToString,
} from "./type-checker";

export enum AstType {
  // values
  Value = "value",
  Record = "record",

  // variable
  Variable = "variable",

  // operators
  BinaryOperator = "binop",
  UnaryOperator = "unop",

  // assignment
  ConstantAssigment = "const=",
  LetAssignment = "let=",
  Assignment = "=",
  TypeAlias = "type=",

  // parameters
  TypeParameter = "type-parameter",
  FunctionParameter = "function-parameter",

  // function
  FunctionPrototype = "function-prototype",
  Function = "function",
  CallFunction = "call-function",

  // extern
  Extern = "extern",

  // control flow
  If = "if",
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

export type Expr =
  | Expr[]
  | FunctionExpr
  | ExternExpr
  | AssignmentExpr
  | TypeAliasExpr
  | UnaryOperatorExpr
  | BinaryOperatorExpr
  | VariableExpr
  | ValueExpr
  | CallFunctionExpr
  | IfExpr;

export type TopLevelExpr = Expr | FunctionExpr;

export type ValueExpr = {
  type: AstType.Value;
  typeValue: Type;
  value: string;
  properties?: { name: string; value: Expr }[];
};

export type VariableExpr = {
  type: AstType.Variable;
  name: string;
};

export type BinaryOperatorExpr = {
  type: AstType.BinaryOperator;
  operator: OperatorType;
  left: Expr;
  right: Expr;
};

export type UnaryOperatorExpr = {
  type: AstType.UnaryOperator;
  operator: TokenType.LogicalNot;
  expr: Expr;
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
  right: Expr;
};

export type TypeAliasExpr = {
  type: AstType.TypeAlias;
  typeName: string;
  typeType: Type;
};

export type TypeParameterExpr = {
  typeName: string;
  typeType: Type;
  type: AstType.TypeParameter;
};

export type FunctionPrototype = {
  type: AstType.FunctionPrototype;
  functionName?: string; // If not set, it's an anonymous function
  functionParameters: Expr[]; // IdentifierExpr[] | TODO: For future pattern matching
  typeValue: TFunction;
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

export type IfExpr = {
  type: AstType.If;
  condition: Expr;
  then: Expr[];
  else: Expr[];
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

export function synthesizeExprType(
  expr: Expr,
  variableTypes: VariableTypes
): Type {
  if (expr instanceof Array) {
    throw new Error("Cannot synthesize type of array");
  }
  if (expr.type === AstType.Value) {
    return expr.typeValue;
  } else if (expr.type === AstType.BinaryOperator) {
    const leftType = synthesizeExprType(expr.left, variableTypes);
    const rightType = synthesizeExprType(expr.right, variableTypes);
    if (
      [
        OperatorType.LessThan,
        OperatorType.LessThanOrEqual,
        OperatorType.Equal,
        OperatorType.NotEqual,
      ].includes(expr.operator)
    ) {
      return TypeValues.boolean;
    } else if (leftType.type === rightType.type) {
      return leftType;
    } else {
      throw new Error(
        `Cannot synthesize type of binary operator ${JSON.stringify(expr)}`
      );
    }
  } else if (expr.type === AstType.CallFunction) {
    const functionName = expr.functionName;
    if (!(functionName in variableTypes)) {
      throw new Error(`Cannot find function ${functionName}`);
    } else {
      const namedType = variableTypes[functionName];
      if (namedType.type !== "Function") {
        throw new Error(`Cannot call non-function ${functionName}`);
      } else {
        return namedType.returnType;
      }
    }
  } else if (expr.type === AstType.If) {
    const lastThenExpr = expr.then[expr.then.length - 1];
    const lastElseExpr = expr.else[expr.else.length - 1];
    if (!lastThenExpr || !lastElseExpr) {
      throw new Error(`Missing then or else expression`);
    }
    const thenType = synthesizeExprType(lastThenExpr, variableTypes);
    const elseType = synthesizeExprType(lastElseExpr, variableTypes);
    // else and then should have the same type
    if (checkType(elseType, thenType)) {
      return thenType;
    } else {
      throw new Error(
        `Mismatched types between \`then\` and \`else\`.
then: ${typeToString(thenType)}
else: ${typeToString(synthesizeExprType(lastElseExpr, variableTypes))}  
`
      );
    }
  } else if (expr.type === AstType.Function) {
    return expr.prototype.typeValue;
  } else if (expr.type === AstType.Variable) {
    const variableName = expr.name;
    if (!(variableName in variableTypes)) {
      throw new Error(`Unbound variable ${variableName}`);
    } else {
      return variableTypes[variableName];
    }
  } else {
    throw new Error(
      `Cannot synthesize AST type of ${JSON.stringify(expr.type)}`
    );
  }
}

export function synthesizeRecordType(
  properties: {
    name: string;
    value: Expr;
  }[],
  variableTypes
): Type {
  return {
    type: "Record",
    properties: properties.map(({ name, value }) => {
      return {
        name,
        type: synthesizeExprType(value, variableTypes),
      };
    }),
  };
}
