import { AstType, Expr, FunctionExpr } from "../ast";
import { Emitter } from "../emitter";
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

    this.codegenExprs(this.module.ast);
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

  codegenExprs(exprs: Expr[]): string {
    return exprs.map((expr) => this.codegenExpr(expr)).join("\n");
  }

  codegenPrimitiveValue(
    value: string,
    typeValue: TPrimitive | TPrimitiveWithValue
  ): void {
    switch (typeValue.type) {
      case "boolean": {
        this.emitter.emit(`${value === "true" ? "true" : "false"}`);
        break;
      }
      case "char": {
        this.emitter.emit(`'${value}'`);
        break;
      }
      case "u8": {
        // cast to uint8_t
        this.emitter.emit(`((uint8_t)${value})`);
        break;
      }
      case "u16": {
        // cast to uint16_t
        this.emitter.emit(`((uint16_t)${value})`);
        break;
      }
      case "u32": {
        // cast to uint32_t
        this.emitter.emit(`((uint32_t)${value})`);
        break;
      }
      case "u64": {
        // cast to uint64_t
        this.emitter.emit(`((uint64_t)${value})`);
        break;
      }
      // FIXME: support u128
      case "usize": {
        // cast to size_t
        this.emitter.emit(`((size_t)${value})`);
        break;
      }
      case "i8": {
        // cast to int8_t
        this.emitter.emit(`((int8_t)${value})`);
        break;
      }
      case "i16": {
        // cast to int16_t
        this.emitter.emit(`((int16_t)${value})`);
        break;
      }
      case "i32": {
        // cast to int32_t
        this.emitter.emit(`((int32_t)${value})`);
        break;
      }
      case "i64": {
        // cast to int64_t
        this.emitter.emit(`((int64_t)${value})`);
        break;
      }
      // FIXME: support i128
      // FIXME: support isize
      case "f32": {
        // cast to float
        this.emitter.emit(`((float)${value})`);
        break;
      }
      case "f64": {
        // cast to double
        this.emitter.emit(`((double)${value})`);
        break;
      }
      case "symbol": {
        // Generate global string
        this.emitter.emit(`"${value}"`);
        break;
      }
      case "()": {
        // Generate global unit value
        this.emitter.emit(`unit`);
        break;
      }
      default: {
        throw new Error(`Unimplemented primitive type ${typeValue.type}`);
      }
    }
  }

  codegenPrototype(functionType: TFunction, functionId: string): void {
    this.emitter.emitDefinitionLine(
      `${
        functionType.returnType.type
      } ${functionId}(${functionType.parameterTypes
        .map((parameter) => `${parameter.type.type} ${parameter.name}`)
        .join(", ")})`
    );
  }

  codegenFunction(expr: FunctionExpr): void {
    // this.codegenPrototype(expr.typeValue);
  }

  codegenExpr(expr: Expr): void {
    switch (expr.type) {
      case AstType.Value: {
        switch (expr.tag) {
          case "primitive": {
            return this.codegenPrimitiveValue(expr.value, expr.typeValue);
          }
          default: {
            throw new Error(`Unimplemented value tag ${expr.tag}`);
          }
        }
      }
      default: {
        throw new Error(`Unimplemented expr type ${expr.type}`);
      }
    }
  }
}
