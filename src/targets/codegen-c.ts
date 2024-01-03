import { AstType, BlockExpr, Expr, FunctionExpr, IfExpr } from "../ast";
import { Emitter } from "../emitter";
import { generateModuleId } from "../env";
import {
  TFunction,
  TModule,
  TPrimitive,
  TPrimitiveWithValue,
  Type,
  typeToString,
} from "../type-checker";

export class CodeGeneratorC {
  private module: TModule;
  private emitter: Emitter;
  constructor(module: TModule) {
    this.module = module;
    this.emitter = new Emitter();
    this.emitter.emitHeaderLine("#include <stdbool.h>");
    this.emitter.emitHeaderLine("#include <stdint.h>");
    this.emitter.emitHeaderLine("#include <stddef.h>");

    // Define the Unit type as a struct with no fields
    // Initialize a global variable for the Unit type
    this.emitter.emitHeaderLine("struct Unit {};");
    this.emitter.emitHeaderLine("struct Unit unit = {};");

    this.emitter.emitDeclarationLine(`\n// Module ${module.modulePath}`);
    this.emitter.emitDeclarationLine(
      `// Module ID: ${generateModuleId(module.modulePath)}`
    );

    this.emitter.emit(this.codegenExprs({ exprs: this.module.ast }));
  }

  print() {
    return this.emitter.print();
  }

  getTypeInC(type: Type): string {
    switch (type.type) {
      case "i8": {
        return "int8_t";
      }
      case "i16": {
        return "int16_t";
      }
      case "i32": {
        return "int32_t";
      }
      case "i64": {
        return "int64_t";
      }
      // FIXME: i128
      case "u8": {
        return "uint8_t";
      }
      case "u16": {
        return "uint16_t";
      }
      case "u32": {
        return "uint32_t";
      }
      case "u64": {
        return "uint64_t";
      }
      // FIXME: u128
      case "f32": {
        return "float";
      }
      case "f64": {
        return "double";
      }
      case "boolean": {
        return "bool";
      }
      case "char": {
        return "char";
      }
      case "symbol": {
        return "char*";
      }
      case "()": {
        return "struct Unit";
      }
      default: {
        throw new Error(`Unimplemented type ${typeToString(type)}`);
      }
    }
  }

  codegenExprs({ exprs }: { exprs: Expr[] }): string {
    return exprs
      .map((expr) => this.codegenExpr({ expr, indentation: "" }))
      .join("\n");
  }

  codegenPrimitiveValue({
    value,
    typeValue,
  }: {
    value: string;
    typeValue: TPrimitive | TPrimitiveWithValue;
  }): string {
    switch (typeValue.type) {
      case "boolean": {
        return `${value === "true" ? "true" : "false"}`;
      }
      case "char": {
        return `'${value}'`;
      }
      case "u8": {
        // cast to uint8_t
        return `((uint8_t)${value})`;
      }
      case "u16": {
        // cast to uint16_t
        return `((uint16_t)${value})`;
      }
      case "u32": {
        // cast to uint32_t
        return `((uint32_t)${value})`;
      }
      case "u64": {
        // cast to uint64_t
        return `((uint64_t)${value})`;
      }
      // FIXME: support u128
      case "usize": {
        // cast to size_t
        return `((size_t)${value})`;
      }
      case "i8": {
        // cast to int8_t
        return `((int8_t)${value})`;
      }
      case "i16": {
        // cast to int16_t
        return `((int16_t)${value})`;
      }
      case "i32": {
        // cast to int32_t
        return `((int32_t)${value})`;
      }
      case "i64": {
        // cast to int64_t
        return `((int64_t)${value})`;
      }
      // FIXME: support i128
      // FIXME: support isize
      case "f32": {
        // cast to float
        return `((float)${value})`;
      }
      case "f64": {
        // cast to double
        return `((double)${value})`;
      }
      case "symbol": {
        // Generate global string
        return `"${value}"`;
      }
      case "()": {
        // Generate global unit value
        return `unit`;
      }
      default: {
        throw new Error(`Unimplemented primitive type ${typeValue.type}`);
      }
    }
  }

  codegenPrototype(functionType: TFunction): string {
    return `${this.getTypeInC(functionType.returnType)} ${
      functionType.functionId
    }(${functionType.parameterTypes
      .map(
        (parameter) => `${this.getTypeInC(parameter.type)} ${parameter.name}`
      )
      .join(", ")})`;
  }

  // TODO: Distinguish between top-level function and closure.
  codegenFunction({
    expr,
    indentation,
  }: {
    expr: FunctionExpr;
    indentation: string;
  }): string {
    let code: string = "";
    const prototype = this.codegenPrototype(expr.typeValue);
    this.emitter.emitDeclarationLine(prototype + ";");

    code += prototype + " {\n";
    // Parse the body
    code += this.codegenBlockExpression({
      blockExpr: expr.body,
      isFunctionBody: true,
      indentation: indentation + "  ",
    });
    code += "}\n";
    return code;
  }

  codegenBlockExpression({
    blockExpr,
    isFunctionBody,
    indentation,
    ignoreTempVariableDeclaration,
  }: {
    blockExpr: BlockExpr;
    isFunctionBody: boolean;
    indentation: string;
    ignoreTempVariableDeclaration?: boolean;
  }): string {
    let code = `${indentation}// block\n`;
    if (!ignoreTempVariableDeclaration) {
      // Add temp variable;
      code += `${indentation}${this.getTypeInC(blockExpr.typeValue)} ${
        blockExpr.tempVariableName
      };\n`;
    }

    const exprs = blockExpr.exprs;
    for (let i = 0; i < exprs.length; i++) {
      const line = this.codegenExpr({
        expr: exprs[i],
        indentation: indentation,
      });
      if (i === exprs.length - 1) {
        code += `${indentation}${blockExpr.tempVariableName} = ${line}${
          line.trim().endsWith(";") ? "" : ";"
        }\n`;
      } else {
        code += `${indentation}${line}${
          line.trim().endsWith(";") ? "" : ";"
        }\n`;
      }
    }

    if (isFunctionBody) {
      code += `${indentation}return ${blockExpr.tempVariableName};\n`;
    }

    code += `${indentation}// end block\n`;
    return code;
  }

  codegenIfExpression({
    expr,
    indentation,
  }: {
    expr: IfExpr;
    indentation: string;
  }): string {
    let code = `\n${indentation}// if\n`;
    // Add temp variable;
    code += `${indentation}${this.getTypeInC(expr.typeValue)} ${
      expr.tempVariableName
    };\n`;
    for (let i = 0; i < expr.cases.length; i++) {
      const case_ = expr.cases[i];
      if (case_.condition) {
        code += `${indentation}if (${this.codegenExpr({
          expr: case_.condition,
          indentation: "",
        })}) {\n`;

        code += this.codegenBlockExpression({
          blockExpr: case_.body,
          isFunctionBody: false,
          indentation: indentation + "  ",
          ignoreTempVariableDeclaration: true,
        });

        code += `${indentation}}`;
      } else {
        code +=
          "{\n" +
          this.codegenBlockExpression({
            blockExpr: case_.body,
            isFunctionBody: false,
            indentation: indentation + "  ",
            ignoreTempVariableDeclaration: true,
          }) +
          `${indentation}}`;
      }

      if (i !== expr.cases.length - 1) {
        code += " else ";
      }
    }

    code += `\n${indentation}// end if\n`;

    return code;
  }

  codegenExpr({
    expr,
    indentation,
  }: {
    expr: Expr;
    indentation: string;
  }): string {
    switch (expr.type) {
      case AstType.Value: {
        switch (expr.tag) {
          case "primitive": {
            return this.codegenPrimitiveValue({
              value: expr.value,
              typeValue: expr.typeValue,
            });
          }
          default: {
            throw new Error(`Unimplemented value tag ${expr.tag}`);
          }
        }
      }
      case AstType.LetAssignment: {
        const rhs = expr.right;
        if (rhs.typeValue.type === "Function") {
          // ignore it
          if (rhs.type === AstType.Function) {
            return this.codegenFunction({ expr: rhs, indentation });
          } else {
            return "";
          }
        } else {
          let code = `${this.getTypeInC(rhs.typeValue)} ${
            expr.variableId
          }; // ${expr.variableName}\n`;
          if (rhs.type === AstType.Block) {
            code += `${this.codegenBlockExpression({
              blockExpr: rhs,
              indentation,
              isFunctionBody: false,
            })}
${indentation}${expr.variableId} = ${rhs.tempVariableName};
`;
          } else if (rhs.type === AstType.If) {
            code += `${this.codegenIfExpression({
              expr: rhs,
              indentation,
            })}
${indentation}${expr.variableId} = ${rhs.tempVariableName};
`;
          } else {
            code += `${indentation}${expr.variableId} = ${this.codegenExpr({
              expr: rhs,
              indentation,
            })}`;
          }
          return code;
        }
      }
      case AstType.Block: {
        return (
          "\n" +
          this.codegenBlockExpression({
            blockExpr: expr,
            isFunctionBody: false,
            indentation,
          })
        );
      }
      case AstType.Variable: {
        return expr.variableId;
      }
      case AstType.BinaryOperator: {
        return `(${this.codegenExpr({
          expr: expr.left,
          indentation,
        })} ${expr.operator} ${this.codegenExpr({
          expr: expr.right,
          indentation,
        })})`;
      }
      case AstType.If: {
        return this.codegenIfExpression({ expr, indentation });
      }
      default: {
        throw new Error(`Unimplemented expr type "${expr.type}"`);
      }
    }
  }
}
