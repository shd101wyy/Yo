import { createHash } from "crypto";
import {
  AssignmentExpr,
  AstType,
  BlockExpr,
  CallFunctionExpr,
  Expr,
  FunctionExpr,
  IfExpr,
  ReadWriteExpr,
} from "../ast";
import { Emitter } from "../emitter";
import { generateModuleId } from "../env";
import * as logger from "../logger";
import {
  Region,
  TFunction,
  TModule,
  TPrimitive,
  TPrimitiveWithValue,
  Type,
  applyTypeAndRegionArgumentsToFunctionExpr,
  typeAndRegionParametersToString,
  typeToString,
} from "../type-checker";

export class CodeGeneratorC {
  private module: TModule;
  private emitter: Emitter;
  private functionIdToExprMap: Map<string, FunctionExpr> = new Map();
  /**
   * key is functionId + typeAndRegionParametersToString
   */
  private generatedFunctionKeySet: Set<string> = new Set();

  /**
   * key is functionKey, value is the @codegenInline template
   */
  private functionKeyToCodegenInlineMap: Map<string, string> = new Map();

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

    this.emitter.emitLine("\n// Code");

    this.emitter.emit(this.codegenExprs({ exprs: this.module.ast }));
  }

  print() {
    return this.emitter.print();
  }

  getTypeInC(type: Type): string {
    let typeString = "";
    switch (type.type) {
      case "i8": {
        typeString = "int8_t";
        break;
      }
      case "i16": {
        typeString = "int16_t";
        break;
      }
      case "i32": {
        typeString = "int32_t";
        break;
      }
      case "i64": {
        typeString = "int64_t";
        break;
      }
      // FIXME: i128
      case "u8": {
        typeString = "uint8_t";
        break;
      }
      case "u16": {
        typeString = "uint16_t";
        break;
      }
      case "u32": {
        typeString = "uint32_t";
        break;
      }
      case "u64": {
        typeString = "uint64_t";
        break;
      }
      // FIXME: u128
      case "f32": {
        typeString = "float";
        break;
      }
      case "f64": {
        typeString = "double";
        break;
      }
      case "boolean": {
        return "bool";
      }
      case "char": {
        typeString = "char";
        break;
      }
      case "symbol": {
        typeString = "char*";
        break;
      }
      case "()": {
        typeString = "struct Unit";
        break;
      }
      default: {
        throw new Error(`Unimplemented type ${typeToString(type)}`);
      }
    }

    if (type.permission === "read" || type.permission === "write") {
      typeString += "*";
    }

    return typeString;
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
      case "string": {
        return JSON.stringify(value);
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

  codegenFunctionIfNecessary(calleeType: TFunction): string {
    const typeArguments = calleeType.typeParameters.map((t) => t.appliedType);
    const regionArguments = calleeType.regionParameters.map(
      (r) => r.appliedRegion
    );
    if (
      typeArguments.some((t) => t === undefined) ||
      regionArguments.some((r) => r === undefined)
    ) {
      return "";
    }

    // SHA1 of typeAndRegionParametersToString
    const typeAndRegionString = typeAndRegionParametersToString(
      calleeType.typeParameters,
      calleeType.regionParameters
    );
    const hash = createHash("sha1")
      .update(typeAndRegionString)
      .digest("hex")
      .slice(0, 8);

    const functionKey =
      calleeType.functionId === "main"
        ? "main"
        : `${calleeType.functionId}_${hash}`;
    if (this.generatedFunctionKeySet.has(functionKey)) {
      return functionKey;
    }
    const functionExpr = this.functionIdToExprMap.get(calleeType.functionId);
    if (!functionExpr) {
      throw new Error(`Cannot find function expr of ${calleeType.functionId}`);
    }

    const newFunctionExpr = applyTypeAndRegionArgumentsToFunctionExpr({
      env: functionExpr.env,
      expr: functionExpr,
      typeArguments: typeArguments as Type[],
      regionArguments: regionArguments as Region[],
      typeParameterToTypeArgumentMap: {},
      regionParameterToRegionArgumentMap: {},
    });
    newFunctionExpr.typeValue.functionId = functionKey;
    this.generatedFunctionKeySet.add(functionKey);

    // Check if the first expr in the function body
    // is @codegenFunction or @codegenInline function call.
    const firstExpr = newFunctionExpr.body.exprs[0];
    if (
      firstExpr.type === AstType.CallFunction &&
      firstExpr.callee.typeValue.type === "Function"
    ) {
      const calleeFunctionType = firstExpr.callee.typeValue as TFunction;
      if (calleeFunctionType.functionId === "@codegenFunction") {
        // Get the first argument
        const firstArgument = firstExpr.functionArguments[0];
        if (
          firstArgument.type === AstType.Value &&
          firstArgument.tag === "primitive"
        ) {
          const codegenFunctionTemplate = firstArgument.value;
          const args: string[] = [
            functionKey,
            ...calleeType.parameterTypes.map(
              (parameter) => parameter.parameterId
            ),
          ];
          const functionCode = codegenFunctionTemplate.replace(
            /\$\d+/g,
            (match) => {
              const argIndex = parseInt(match.slice(1));
              if (isNaN(argIndex)) {
                throw new Error(`Invalid @codegenFunction template: ${match}`);
              }
              if (argIndex >= args.length) {
                throw new Error(
                  `Invalid @codegenFunction template: ${match} is out of range`
                );
              }
              return args[argIndex];
            }
          );
          logger.debug(`codegenFunctionTemplate: |${codegenFunctionTemplate}|`);
          logger.debug(`functionCode: |${functionCode}|`);
          this.emitter.emit(functionCode);
          return functionKey;
        }
      } else if (calleeFunctionType.functionId === "@codegenInline") {
        // Get the first argument
        const firstArgument = firstExpr.functionArguments[0];
        if (
          firstArgument.type === AstType.Value &&
          firstArgument.tag === "primitive"
        ) {
          const codegenInlineTemplate = firstArgument.value;
          this.functionKeyToCodegenInlineMap.set(
            functionKey,
            codegenInlineTemplate
          );
          return functionKey;
        }
      }
    }

    const functionCode = this.codegenFunction({
      expr: newFunctionExpr,
      indentation: "",
    });
    this.emitter.emit(functionCode);

    return functionKey;
  }

  codegenPrototype(functionType: TFunction): string {
    return `${this.getTypeInC(functionType.returnType)} ${
      functionType.functionId
    }(${functionType.parameterTypes
      .map(
        (parameter) =>
          `${this.getTypeInC(parameter.type)} ${parameter.parameterId}`
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
      if (i === exprs.length - 1) {
        code += this.codegenAssignmentByVariableId({
          variableId: blockExpr.tempVariableName,
          rhs: exprs[i],
          indentation,
        });
      } else {
        const line = this.codegenExpr({
          expr: exprs[i],
          indentation: indentation,
        });
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

  codegenAssignmentByVariableId({
    variableId,
    rhs,
    indentation,
  }: {
    variableId: string;
    rhs: Expr;
    indentation: string;
  }): string {
    let code = "";
    if (rhs.type === AstType.Block) {
      code += `${this.codegenBlockExpression({
        blockExpr: rhs,
        indentation,
        isFunctionBody: false,
      })}
${indentation}${variableId} = ${rhs.tempVariableName};\n`;
    } else if (rhs.type === AstType.If) {
      code += `${this.codegenIfExpression({
        expr: rhs,
        indentation,
      })}
${indentation}${variableId} = ${rhs.tempVariableName};\n`;
    } else if (rhs.type === AstType.CallFunction) {
      code += `${this.codegenCallFunction({
        expr: rhs,
        indentation,
      })}
${
  variableId === rhs.tempVariableName
    ? ""
    : `${indentation}${variableId} = ${rhs.tempVariableName};\n`
}`;
    } else if (rhs.type === AstType.ReadWrite) {
      code += `${this.codegenReadWrite({ expr: rhs, indentation })};\n`;
    } else {
      code += `${indentation}${variableId} = ${this.codegenExpr({
        expr: rhs,
        indentation,
      })};\n`;
    }
    return code;
  }

  codegenCallFunction({
    expr,
    indentation,
  }: {
    expr: CallFunctionExpr;
    indentation: string;
  }): string {
    let code = "";
    // Add temp variable;
    code += `${indentation}${this.getTypeInC(expr.typeValue)} ${
      expr.tempVariableName
    };\n`;
    const functionType = expr.callee.typeValue as TFunction;

    // parse arguments
    const { functionArgumentStringList, code: nextCode } =
      this.getFunctionArgumentsStringList({
        functionArguments: expr.functionArguments,
        code,
        indentation,
      });
    code = nextCode;

    const functionKey = this.codegenExpr({
      expr: expr.callee,
      indentation,
    });

    // Check if the function is from @codegenInline
    const codegenInlineTemplate =
      this.functionKeyToCodegenInlineMap.get(functionKey);
    if (codegenInlineTemplate) {
      const replaced = codegenInlineTemplate.replace(/\$\d+/g, (match) => {
        const argIndex = parseInt(match.slice(1));
        if (isNaN(argIndex)) {
          throw new Error(`Invalid @codegenInline template: ${match}`);
        }
        if (argIndex > functionArgumentStringList.length) {
          throw new Error(
            `Invalid @codegenInline template: ${match} is out of range`
          );
        }
        return functionArgumentStringList[argIndex - 1];
      });
      code += `${indentation}${expr.tempVariableName} = ${replaced};\n`;
    } else {
      code += `${indentation}${
        expr.tempVariableName
      } = ${functionKey}(${functionArgumentStringList
        .map((argumentString, index) => {
          return `${argumentString} /* ${functionType.parameterTypes[index].name} */`;
        })
        .join(", ")}); \n`;
    }
    return code;
  }

  codegenReadWrite({
    expr,
    indentation,
  }: {
    expr: ReadWriteExpr;
    indentation: string;
  }): string {
    let code = "";
    // Add temp variable;
    code += `${indentation}${this.getTypeInC(expr.typeValue)} ${
      expr.tempVariableName
    };\n`;

    code += `${indentation}${expr.tempVariableName} = &(${this.codegenExpr({
      expr: expr.expr,
      indentation,
    })})`;

    return code;
  }

  getFunctionArgumentsStringList({
    functionArguments,
    code,
    indentation,
  }: {
    functionArguments: Expr[];
    code: string;
    indentation: string;
  }): { functionArgumentStringList: string[]; code: string } {
    const functionArgumentStringList: string[] = [];
    for (let i = 0; i < functionArguments.length; i++) {
      const argument = functionArguments[i];
      if ("tempVariableName" in argument) {
        code += this.codegenAssignmentByVariableId({
          variableId: argument.tempVariableName,
          rhs: argument,
          indentation,
        });
        functionArgumentStringList.push(argument.tempVariableName);
      } else {
        functionArgumentStringList.push(
          this.codegenExpr({
            expr: argument,
            indentation,
          })
        );
      }
    }
    return {
      functionArgumentStringList,
      code,
    };
  }

  codegenAssignment({
    expr,
    indentation,
  }: {
    expr: AssignmentExpr;
    indentation: string;
  }): string {
    let code = `// assignment\n`;
    if (
      expr.left.typeValue.permission === "read" ||
      expr.left.typeValue.permission === "write"
    ) {
      code += `${indentation}*`;
    } else {
      code += `${indentation}`;
    }
    code += `${this.codegenExpr({ expr: expr.left, indentation: "" })} = `;
    if (
      expr.right.typeValue.permission === "read" ||
      expr.right.typeValue.permission === "write"
    ) {
      code += "*";
    }
    code += `${this.codegenExpr({ expr: expr.right, indentation: "" })};\n`;
    return code;
  }

  codegenExpr({
    expr,
    indentation,
  }: {
    expr: Expr;
    indentation: string;
  }): string {
    if (expr.typeValue.type === "Function" && expr.type !== AstType.Function) {
      return this.codegenFunctionIfNecessary(expr.typeValue);
    }

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
      case AstType.Function: {
        this.functionIdToExprMap.set(expr.typeValue.functionId, expr);
        this.codegenFunctionIfNecessary(expr.typeValue);
        return "";
      }
      case AstType.LetAssignment: {
        const rhs = expr.right;
        if (rhs.typeValue.type === "Function") {
          // ignore it
          if (rhs.type === AstType.Function) {
            return this.codegenExpr({
              expr: rhs,
              indentation,
            });
          } else {
            return "";
          }
        } else {
          let code = `${this.getTypeInC(rhs.typeValue)} ${
            expr.variableId
          }; // ${expr.variableName}\n`;
          code += this.codegenAssignmentByVariableId({
            variableId: expr.variableId,
            rhs,
            indentation,
          });
          return code;
        }
      }
      case AstType.Assignment: {
        return this.codegenAssignment({ expr, indentation });
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
      case AstType.If: {
        return this.codegenIfExpression({ expr, indentation });
      }
      case AstType.CallFunction: {
        return this.codegenCallFunction({ expr, indentation });
      }
      case AstType.Extern: {
        // TODO: Support "C"
        if (expr.language === "mo") {
          return "";
        }
        return "";
      }
      case AstType.ReadWrite: {
        return this.codegenReadWrite({ expr, indentation });
      }
      case AstType.Import:
      case AstType.Export:
      case AstType.Infix: {
        return "";
      }
      default: {
        throw new Error(`Codegen: Unimplemented expr type "${expr.type}"`);
      }
    }
  }
}
