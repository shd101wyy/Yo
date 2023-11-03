import Environment from "./env";
import { Token, TokenType } from "./token";
import {
  TFunction,
  Type,
  TypeValues,
  checkType,
  typeToString,
} from "./type-checker";

export enum AstType {
  // values
  Value = "value",
  Record = "record",

  // variable
  Variable = "variable",
  Accessors = "accessors",

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
  | AccessorsExpr
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
  typeValue: Type;
};

export type AccessorsExpr = {
  type: AstType.Accessors;
  accessors: string[];
  expr: Expr;
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
  typeValue: Type;
};

export type FunctionPrototype = {
  type: AstType.FunctionPrototype;
  functionId: string; // This is used for function overloading
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
  functionId: string; // This is used for finding the function by id. Check `FunctionPrototype` above.
  functionName: string;
  functionArguments: Expr[];
  returnType: Type;
};

export type IfExpr = {
  type: AstType.If;
  condition: Expr;
  then: Expr[];
  else: Expr[];
  returnType: Type;
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

export function synthesizeExprType(expr: Expr, env: Environment): Type {
  if (expr instanceof Array) {
    throw new Error("Cannot synthesize type of array");
  }
  if (expr.type === AstType.Value) {
    return expr.typeValue;
  } else if (expr.type === AstType.BinaryOperator) {
    const leftType = synthesizeExprType(expr.left, env);
    const rightType = synthesizeExprType(expr.right, env);
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
  } else if (expr.type === AstType.CallFunction || expr.type === AstType.If) {
    return expr.returnType;
  } else if (expr.type === AstType.Function) {
    return expr.prototype.typeValue;
  } else if (expr.type === AstType.Variable) {
    return expr.typeValue;
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

export function getFunctionFromEnv(
  functionName: string,
  functionArguments: Expr[],
  env: Environment
) {
  const functionsInEnv = env.getValueTypesByVariableName(functionName);
  console.log("getFunctionFromEnv: ", JSON.stringify(env), functionName);
  if (functionsInEnv.length === 0) {
    throw new Error(`Cannot find function ${functionName}`);
  } else {
    // Find the function that matches the signature
    const matchedFunctions = functionsInEnv.filter((functionInEnv) => {
      if (functionInEnv.type.type !== "Function") {
        return false;
      }
      if (
        functionInEnv.type.parameterTypes.length !== functionArguments.length
      ) {
        return false;
      }
      for (let i = 0; i < functionInEnv.type.parameterTypes.length; i++) {
        const parameterType = functionInEnv.type.parameterTypes[i].type;
        const argumentType = synthesizeExprType(functionArguments[i], env);
        if (!checkType(parameterType, argumentType)) {
          return false;
        }
      }
      return true;
    });
    if (matchedFunctions.length > 1) {
      throw new Error(
        `Ambiguous function call ${functionName} with arguments ${JSON.stringify(
          functionArguments
        )}
Found possible functions:
- ${matchedFunctions
          .map((func) => `${func.variableName}: ${typeToString(func.type)}`)
          .join("\n- ")}
        `
      );
    }
    const matchedFunction = matchedFunctions[0];
    if (!matchedFunction || matchedFunction.type.type !== "Function") {
      throw new Error(`Function "${functionName}" not found`);
    } else {
      return matchedFunction;
    }
  }
}
