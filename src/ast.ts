import { Environment, ValueType } from "./env";
import { Token, TokenType } from "./token";
import {
  TBoolean,
  TEnum,
  TFunction,
  TPrimitive,
  TTrait,
  TUnit,
  Type,
  typeToString,
} from "./type-checker";

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
  IsOperator = "isop",

  // assignment
  ConstantAssignment = "const=",
  LetAssignment = "let=",
  Assignment = "=",
  TypeAlias = "type=",
  Trait = "trait",

  // parameters
  TypeParameter = "type-parameter",
  FunctionParameter = "function-parameter",

  // function
  FunctionPrototype = "function-prototype",
  Function = "function",
  CallFunction = "call-function",
  CallEnum = "call-enum",

  // enum
  Enum = "enum",

  // extern
  Extern = "extern",

  // control flow
  If = "if",
  Switch = "switch",

  // ignore
  Ignore = "ignore",

  // block expression
  Block = "block",
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
 * All Expr should have `typeValue` and `env` attribute.
 */
export type Expr =
  | FunctionExpr
  | ExternExpr
  | AssignmentExpr
  | TypeAliasExpr
  | EnumExpr
  | TraitExpr
  | UnaryOperatorExpr
  | BinaryOperatorExpr
  | IsOperatorExpr
  | VariableExpr
  | PropertyAccessExpr
  | IndexAccessExpr
  | ValueExpr
  | CallFunctionExpr
  | CallEnumExpr
  | IfExpr
  | IgnoreExpr
  | BlockExpr;

export type IgnoreExpr = {
  type: AstType.Ignore;
  typeValue: TUnit;
  env: Environment;
};

export type BlockExpr = {
  type: AstType.Block;
  exprs: Expr[];
  typeValue: Type;
  env: Environment;
};

export type RecordValueExpr = {
  type: AstType.Value;
  tag: "record";
  properties: { name: string; value: Expr }[];
  typeValue: Type;
  env: Environment;
};

export type SliceValueExpr = {
  type: AstType.Value;
  tag: "slice";
  values: Expr[];
  typeValue: Type;
  env: Environment;
};

export type PrimitiveValueExpr = {
  type: AstType.Value;
  tag: "primitive";
  typeValue: TPrimitive;
  env: Environment;
};

export type ValueExpr = PrimitiveValueExpr | RecordValueExpr | SliceValueExpr;

export type VariableExpr = {
  type: AstType.Variable;
  name: string;
  frameLevel: number;
  typeValue: Type;
  env: Environment;
  // isFreeVariable: boolean;
};

export type PropertyAccessExpr = {
  type: AstType.PropertyAccess;
  propertyName: string;
  expr: Expr;
  typeValue: Type;
  env: Environment;
};

export type IndexAccessExpr = {
  type: AstType.IndexAccess;
  indexes: Expr[];
  expr: Expr;
  typeValue: Type;
  env: Environment;
};

export type BinaryOperatorExpr = {
  type: AstType.BinaryOperator;
  operator: OperatorType;
  left: Expr;
  right: Expr;
  typeValue: Type;
  env: Environment;
};

export type IsOperatorExpr = {
  type: AstType.IsOperator;
  left: Expr;
  right: TEnum;
  typeValue: TBoolean;
  env: Environment;
};

export type UnaryOperatorExpr = {
  type: AstType.UnaryOperator;
  operator: TokenType.LogicalNot;
  expr: Expr;
  typeValue: Type;
  env: Environment;
};

/*
export type TypeValueExpr = {
  type: AstType.TypeValue;
  value: string;
};
*/

export type AssignmentExpr = {
  type: AstType.ConstantAssignment; // | AstType.LetAssignment; // | AstType.Assignment;
  variableName: string;
  variableType: Type;
  frameLevel: number;
  right: Expr;
  typeValue: TUnit;
  env: Environment;
};

export type TypeAliasExpr = {
  type: AstType.TypeAlias;
  typeName: string;
  typeValue: Type;
  env: Environment;
};

export type EnumExpr = {
  type: AstType.Enum;
  enumName: string;
  typeValue: TEnum;
  env: Environment;
};

export type TraitExpr = {
  type: AstType.Trait;
  traitName: string;
  typeValue: TTrait;
  /**
   * If typeArguments is undefined, then it's a trait definition.
   * If typeArguments is defined, then it's a trait implementation, aka instance.
   */
  typeArguments?: Type[];
  env: Environment;
  /**
   * If it's a trait definition or instance definition, then isDefinition is true.
   */
  isDefinition: boolean;
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
  body: Expr[];
  typeValue: TFunction;
  env: Environment;
};

export type ExternExpr = {
  type: AstType.Extern;
  prototype: FunctionPrototype;
  typeValue: TFunction;
  env: Environment;
};

export type CallFunctionExpr = {
  type: AstType.CallFunction;
  callee: Expr;
  typeArguments: Type[];
  functionArguments: Expr[];
  typeValue: Type;
  env: Environment;
};

export type CallEnumExpr = {
  type: AstType.CallEnum;
  variantArguments: Expr[];
  typeValue: TEnum;
  env: Environment;
};

export type IfExpr = {
  type: AstType.If;
  condition: Expr;
  then: Expr[];
  else: Expr[];
  typeValue: Type;
  env: Environment;
};

export type SwitchCase = {
  pattern: Expr;
  /**
   * If body is undefined, then it's a fallthrough case.
   */
  body?: Expr[];
  guard?: Expr;
};

export type SwitchExpr = {
  type: AstType.Switch;
  condition: Expr;
  cases: SwitchCase[];
  typeValue: Type;
  env: Environment;
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

export function exprToString(expr: Expr | FunctionPrototype) {
  switch (expr.type) {
    case AstType.Value:
      switch (expr.tag) {
        case "primitive":
          return expr.typeValue.value;
        case "record":
          return `{${expr.properties
            .map(({ name, value }) => `${name}: ${exprToString(value)}`)
            .join(", ")}}`;
        case "slice":
          return `[${expr.values
            .map((expr) => exprToString(expr))
            .join(", ")}]`;
        default:
          throw new Error(`Unknown value tag ${expr}`);
      }
    case AstType.Variable:
      if ("id" in expr.typeValue) {
        return `@${expr.typeValue.id}`;
      }
      return expr.name;
    case AstType.PropertyAccess:
      return `${exprToString(expr.expr)}.${expr.propertyName}`;
    case AstType.IndexAccess:
      return `${exprToString(expr.expr)}[${expr.indexes
        .map((expr) => exprToString(expr))
        .join(", ")}]`;
    case AstType.BinaryOperator:
      return `${exprToString(expr.left)} ${expr.operator} ${exprToString(
        expr.right
      )}`;
    case AstType.UnaryOperator:
      return `${expr.operator}${exprToString(expr.expr)}`;
    case AstType.IsOperator:
      return `${exprToString(expr.left)} is ${typeToString(expr.right)}`;
    case AstType.ConstantAssignment:
      return `const ${expr.variableName}: ${typeToString(
        expr.variableType
      )} = ${exprToString(expr.right)}`;
    case AstType.TypeAlias:
      return `type ${expr.typeName} = ${typeToString(expr.typeValue)}`;
    case AstType.Trait:
      if (!expr.isDefinition) {
        return `${expr.traitName}${
          expr.typeArguments && expr.typeArguments.length > 0
            ? `<${expr.typeArguments.map(typeToString).join(", ")}>`
            : ""
        }`;
      }

      return `${expr.typeArguments ? "instance" : "trait"} ${expr.traitName}${
        expr.typeArguments && expr.typeArguments.length > 0
          ? `<${expr.typeArguments.map(typeToString).join(", ")}>`
          : ""
      }${typeToString(expr.typeValue).replace(/^(trait|instance)/, "")}`;
    case AstType.Enum:
      return `enum ${expr.enumName}${typeToString(expr.typeValue).replace(
        /^enum/,
        ""
      )}`;
    case AstType.Function:
      return `${
        expr.prototype.functionName
          ? `function ${expr.prototype.functionName}`
          : ``
      }${
        expr.prototype.typeValue.typeParameters.length > 0
          ? `<${expr.prototype.typeValue.typeParameters.map(typeToString)}>`
          : ""
      }(${expr.prototype.typeValue.parameterTypes
        .map((p) => `${p.name}: ${typeToString(p.type)}`)
        .join(", ")}):${typeToString(expr.prototype.typeValue.returnType)} ${
        expr.prototype.functionName ? "" : " => "
      } {\n${expr.body
        .map((expr) =>
          exprToString(expr)
            .split("\n")
            .map((l) => "  " + l)
            .join("\n")
        )
        .join(";\n")}\n}`;
    case AstType.CallFunction:
      return `${exprToString(expr.callee)}${
        expr.typeArguments.length > 0
          ? `<${expr.typeArguments.map(typeToString)}>`
          : ""
      }(${expr.functionArguments
        .map((expr) => exprToString(expr))
        .join(", ")})`;
    case AstType.CallEnum:
      return `${typeToString(expr.typeValue)}${
        expr.variantArguments.length > 0
          ? `(${expr.variantArguments
              .map((expr) => exprToString(expr))
              .join(", ")})`
          : ""
      }`;
    case AstType.If:
      return `if (${exprToString(expr.condition)}) {\n${expr.then
        .map((expr) => "  " + exprToString(expr))
        .join(";\n")} } else {\n${expr.else
        .map((expr) => "  " + exprToString(expr))
        .join(";\n")} }`;
    case AstType.Ignore:
      return ``;
    case AstType.Block: {
      return `{\n${expr.exprs
        .map((expr) =>
          exprToString(expr)
            .split("\n")
            .map((l) => "  " + l)
            .join("\n")
        )
        .join(";\n")}
  }`;
    }
    case AstType.FunctionPrototype: {
      return `${expr.functionName ?? ``}${
        expr.typeValue.typeParameters.length > 0
          ? `<${expr.typeValue.typeParameters.map(typeToString)}>`
          : ""
      }(${expr.typeValue.parameterTypes
        .map((p) => `${p.name}: ${typeToString(p.type)}`)
        .join(", ")}):${typeToString(expr.typeValue.returnType)}`;
    }
    case AstType.Extern: {
      return `extern ${expr.prototype.functionName ?? ``}${
        expr.prototype.typeValue.typeParameters.length > 0
          ? `<${expr.prototype.typeValue.typeParameters.map(typeToString)}>`
          : ""
      }(${expr.prototype.typeValue.parameterTypes
        .map((p) => `${p.name}: ${typeToString(p.type)}`)
        .join(", ")}):${typeToString(expr.prototype.typeValue.returnType)}`;
    }
    default:
      throw new Error(`Unknown expr type ${expr}`);
  }
}
