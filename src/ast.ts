import { Token, TokenType } from "./token";
import { Type, TypeValues, isSubtype } from "./type-checker";

export type NamedTypes = { [key: string]: Type };

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
  operator: TokenType.Negate;
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

export type TypeParameterExpr = {
  typeName: string;
  typeType: Type;
  type: AstType.TypeParameter;
};

export type FunctionParameterExpr = {
  parameterName: string;
  parameterType: Type;
  type: AstType.FunctionParameter;
};

export type FunctionPrototype = {
  type: AstType.FunctionPrototype;
  functionName: string;
  functionParameters: Expr[]; // IdentifierExpr[] | TODO: For future pattern matching
  typeValue: Type;
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

export function synthesizeExprType(expr: Expr, namedTypes: NamedTypes): Type {
  if (expr instanceof Array) {
    throw new Error("Cannot synthesize type of array");
  }
  if (expr.type === AstType.Value) {
    return expr.typeValue;
  } else if (expr.type === AstType.BinaryOperator) {
    const leftType = synthesizeExprType(expr.left, namedTypes);
    const rightType = synthesizeExprType(expr.right, namedTypes);
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
    if (!(functionName in namedTypes)) {
      throw new Error(`Cannot find function ${functionName}`);
    } else {
      const namedType = namedTypes[functionName];
      if (namedType.type !== "function") {
        throw new Error(`Cannot call non-function ${functionName}`);
      } else {
        return namedType.returnType;
      }
    }
  } else {
    throw new Error(`Cannot synthesize type of ${JSON.stringify(expr.type)}`);
  }
}

export function synthesizeRecordType(
  properties: {
    name: string;
    value: Expr;
  }[],
  namedTypes
): Type {
  return {
    type: "Record",
    properties: properties.map(({ name, value }) => {
      return {
        name,
        type: synthesizeExprType(value, namedTypes),
      };
    }),
  };
}

export function checkType(
  expr: Expr,
  type: Type,
  namedTypes: NamedTypes
): boolean {
  if (expr instanceof Array) {
    throw new Error("Cannot check type of array");
  }
  const exprType = synthesizeExprType(expr, namedTypes);
  if (exprType.type === type.type) {
    if (exprType.type === "Record") {
      return checkRecordExactMatchType(expr, type, namedTypes);
    } else {
      return isSubtype(exprType, type);
    }
  } else {
    return false;
  }
}

function checkRecordExactMatchType(
  expr: Expr,
  type: Type,
  namedTypes: NamedTypes
): boolean {
  if (expr instanceof Array) {
    throw new Error("Cannot check type of array");
  }
  if (expr.type !== AstType.Value) {
    throw new Error("Cannot check type of non-value");
  }
  if (type.type !== "Record") {
    throw new Error("Cannot check type of non-record");
  }
  if (expr.typeValue.type !== "Record" || !expr.properties) {
    throw new Error("Cannot check type of non-record");
  }
  const exprProperties = expr.properties.sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const typeProperties = type.properties.sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  if (exprProperties.length !== typeProperties.length) {
    return false;
  }

  let result = true;
  for (let i = 0; i < exprProperties.length; i++) {
    const exprProperty = exprProperties[i];
    const typeProperty = typeProperties[i];
    if (exprProperty.name !== typeProperty.name) {
      result = false;
      break;
    }
    if (!checkType(exprProperty.value, typeProperty.type, namedTypes)) {
      result = false;
      break;
    }
  }
  return result;
}
