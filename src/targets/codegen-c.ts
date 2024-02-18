import { createHash } from "crypto";
import {
  AssignmentExpr,
  AstType,
  BlockExpr,
  CallEnumExpr,
  CallFunctionExpr,
  CallTypeConstructorExpr,
  Expr,
  FunctionExpr,
  IfExpr,
  ImplicitDereferenceExpr,
  IndexAccessExpr,
  MatchExpr,
  PropertyAccessExpr,
  ReadWriteExpr,
  RecordValueExpr,
  SliceValueExpr,
  exprToString,
} from "../ast";
import { Emitter } from "../emitter";
import { generateModuleId } from "../env";
import * as logger from "../logger";
import {
  Region,
  TEnum,
  TFunction,
  TModule,
  TParameterType,
  TPrimitive,
  TPrimitiveWithValue,
  TTypeConstructor,
  Type,
  applyTypeArgumentsToFunctionExpr,
  typeContainsTypeParameterThatDoesntHaveAppliedType,
  typeParametersToString,
  typeToString,
} from "../type-checker";

export class CodeGeneratorC {
  private emitter: Emitter;
  private functionIdToExprMap: Map<string, FunctionExpr> = new Map();

  /**
   * key is functionId + typeParametersToString
   */
  private generatedFunctionKeySet: Set<string> = new Set();

  /**
   * key is enumId + typeParametersToString
   */
  private generatedEnumKeySet: Set<string> = new Set();

  /**
   * key is typeConstructorId + typeParametersToString
   */
  private generatedTypeConstructorKeySet: Set<string> = new Set();

  /**
   * key is functionKey, value is the @codegenInline template
   */
  private functionKeyToCodegenInlineMap: Map<string, string> = new Map();

  constructor() {
    this.emitter = new Emitter();
    this.emitter.emitHeaderLine("#include <stdbool.h>");
    this.emitter.emitHeaderLine("#include <stdint.h>");
    this.emitter.emitHeaderLine("#include <stddef.h>");

    // Define the Unit type as a struct with no fields
    // Initialize a global variable for the Unit type
    this.emitter.emitHeaderLine("struct Unit {};");
    this.emitter.emitHeaderLine("struct Unit unit = {};");
  }

  public compileModule(module: TModule) {
    this.emitter.emitDeclarationLine(`\n// Module ${module.modulePath}`);
    this.emitter.emitDeclarationLine(
      `// Module ID: ${generateModuleId(module.modulePath)}`
    );

    this.emitter.emit(this.codegenExprs({ exprs: module.ast }));
  }

  print() {
    return this.emitter.print();
  }

  getTypeInC(type: Type, setSliceAsPointer = true): string {
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
      // FIXME: f16
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
      /*
      case "char": {
        typeString = "char"; // FIXME: Shouldn't be char
        break;
      }
      */
      case "symbol": {
        typeString = "char*";
        break;
      }
      case "()": {
        typeString = "struct Unit";
        break;
      }
      case "slice": {
        if (setSliceAsPointer) {
          typeString += `${this.getTypeInC(type.elementType)}*`;
        } else {
          typeString += `${this.getTypeInC(type.elementType)}[${
            type.size === undefined ? "" : type.size
          }]`;
        }
        break;
      }
      case "Enum": {
        const enumKey = this.codegenEnumIfNecessary(type);
        typeString = enumKey;
        break;
      }
      case "TypeConstructor": {
        const typeConstructorKey = this.codegenTypeConstructorIfNecessary(type);
        typeString = typeConstructorKey;
        break;
      }
      case "TypeParameter": {
        if (type.appliedType) {
          typeString = this.getTypeInC(type.appliedType);
        } else {
          throw new Error(
            "Didn't find appliedType in TypeParameter: " + typeToString(type)
          );
        }
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

  codegenRecordValue({ expr }: { expr: RecordValueExpr }): string {
    return `{${expr.properties
      .map(({ name, value }) => {
        return `.${name} = ${this.codegenExpr({
          expr: value,
          indentation: "",
        })}`;
      })
      .join(", ")}}`;
  }

  codegenSliceValue({ expr }: { expr: SliceValueExpr }): string {
    return `(${this.getTypeInC(expr.typeValue, false)}) {${expr.values
      .map((element) => {
        return `${this.codegenExpr({
          expr: element,
          indentation: "",
        })}`;
      })
      .join(", ")}}`;
  }

  codegenFunctionIfNecessary(functionType: TFunction): string {
    const typeArguments = functionType.typeParameters.map((t) => t.appliedType);
    const regionArguments = functionType.regionParameters.map(
      (r) => r.appliedRegion
    );
    if (
      typeArguments.some((t) => t === undefined) ||
      regionArguments.some((r) => r === undefined) ||
      typeContainsTypeParameterThatDoesntHaveAppliedType(functionType)
    ) {
      return "";
    }

    // SHA1 of typeParametersToString
    const typeAndRegionString = typeParametersToString(
      functionType.typeParameters,
      functionType.regionParameters
    );
    const hash = createHash("sha1")
      .update(typeAndRegionString)
      .digest("hex")
      .slice(0, 8);

    const functionKey =
      functionType.functionId === "main"
        ? "main"
        : `${functionType.functionId}_${hash}`;
    if (this.generatedFunctionKeySet.has(functionKey)) {
      return functionKey;
    }
    const functionExpr = this.functionIdToExprMap.get(functionType.functionId);
    if (!functionExpr) {
      throw new Error(
        `Cannot find function expr of ${functionType.functionId}`
      );
    }

    const newFunctionExpr = applyTypeArgumentsToFunctionExpr({
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
            ...functionType.parameterTypes.map(
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

  codegenEnumIfNecessary(enumType: TEnum): string {
    const typeArguments = enumType.typeParameters.map((t) => t.appliedType);
    const regionArguments = enumType.regionParameters.map(
      (r) => r.appliedRegion
    );
    if (
      typeArguments.some((t) => t === undefined) ||
      regionArguments.some((r) => r === undefined) ||
      typeContainsTypeParameterThatDoesntHaveAppliedType(enumType)
    ) {
      return "";
    }

    // SHA1 of typeParametersToString
    const typeAndRegionString = typeParametersToString(
      enumType.typeParameters,
      enumType.regionParameters
    );
    const hash = createHash("sha1")
      .update(typeAndRegionString)
      .digest("hex")
      .slice(0, 8);

    const enumKey = `${enumType.enumId}_${hash}`;
    if (this.generatedEnumKeySet.has(enumKey)) {
      return enumKey;
    }
    this.generatedEnumKeySet.add(enumKey);

    const enumCode = this.codegenEnum({
      enumType: enumType,
      enumKey,
      indentation: "",
    });
    this.emitter.emit(enumCode);

    return enumKey;
  }

  codegenTypeConstructorIfNecessary(
    typeConstructorType: TTypeConstructor
  ): string {
    const typeArguments = typeConstructorType.typeParameters.map(
      (t) => t.appliedType
    );
    const regionArguments = typeConstructorType.regionParameters.map(
      (r) => r.appliedRegion
    );
    if (
      typeArguments.some((t) => t === undefined) ||
      regionArguments.some((r) => r === undefined) ||
      typeContainsTypeParameterThatDoesntHaveAppliedType(typeConstructorType)
    ) {
      return "";
    }

    // SHA1 of typeParametersToString
    const typeAndRegionString = typeParametersToString(
      typeConstructorType.typeParameters,
      typeConstructorType.regionParameters
    );
    const hash = createHash("sha1")
      .update(typeAndRegionString)
      .digest("hex")
      .slice(0, 8);

    const typeConstructorKey = `${typeConstructorType.typeConstructorId}_${hash}`;
    if (this.generatedTypeConstructorKeySet.has(typeConstructorKey)) {
      return typeConstructorKey;
    }
    this.generatedTypeConstructorKeySet.add(typeConstructorKey);

    const code = this.codegenTypeConstructor({
      typeConstructorType: typeConstructorType,
      typeConstructorKey,
      indentation: "",
    });
    this.emitter.emit(code);

    return typeConstructorKey;
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

  codegenEnum({
    enumType,
    enumKey,
    indentation,
  }: {
    enumType: TEnum;
    enumKey: string;
    indentation: string;
  }): string {
    let code: string = `${indentation}// enum ${typeToString(enumType, {
      extractTypeConstructor: false,
      hideTypeParameterKind: true,
    })}\n`;

    code += `${indentation}typedef struct {\n`;
    code += `${indentation}  int tag;\n`; // TODO: Minimum bits
    code += `${indentation}  union {\n`;

    // variants
    enumType.variants.forEach((variant) => {
      code += `${indentation}    struct {\n`;
      variant.parameterTypes.forEach((parameterType) => {
        code += `${indentation}      ${this.getTypeInC(parameterType.type)} ${
          parameterType.name
        };\n`;
      });
      code += `${indentation}    } ${variant.name};\n`;
    });

    code += `${indentation}  } variant;\n`;
    code += `${indentation}} ${enumKey};\n\n`;

    return code;
  }

  codegenTypeConstructor({
    typeConstructorKey,
    typeConstructorType,
    indentation,
  }: {
    typeConstructorType: TTypeConstructor;
    typeConstructorKey: string;
    indentation: string;
  }): string {
    let code: string = `${indentation}// type ${typeToString(
      typeConstructorType,
      { extractTypeConstructor: false, hideTypeParameterKind: true }
    )}\n`;

    code += `${indentation}typedef ${this.convertTypeConstructorToTypeInC({
      type: typeConstructorType.typeValue,
      indentation: indentation,
    }).trim()} ${typeConstructorKey};\n\n`;

    return code;
  }

  convertTypeConstructorToTypeInC({
    type,
    indentation,
  }: {
    type: Type;
    indentation: string;
  }): string {
    let typeString = "";
    switch (type.type) {
      case "Union": {
        typeString += `${indentation}union {
${type.types
  .map((type) => {
    return `${this.convertTypeConstructorToTypeInC({
      type,
      indentation: indentation + "  ",
    })};`;
  })
  .join("\n")}
${indentation}}\n`;
        break;
      }
      case "Intersection": {
        typeString += `${indentation}struct {
${type.types
  .map((type) => {
    return `${this.convertTypeConstructorToTypeInC({
      type,
      indentation: indentation + "  ",
    })};`;
  })
  .join("\n")}
${indentation}}\n`;
        break;
      }
      case "Record": {
        typeString += `${indentation}struct {
${type.properties
  .map((field) => {
    return `${this.convertTypeConstructorToTypeInC({
      type: field.type,
      indentation: indentation + "  ",
    })} ${field.name};`;
  })
  .join("\n")}
${indentation}}\n`;
        break;
      }
      default: {
        // FIXME: Support function
        typeString = indentation + this.getTypeInC(type);
      }
    }
    return typeString.trimEnd();
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
    let code = `${indentation}{ // block\n`;
    const originalIndentation = indentation;
    indentation = indentation + "  ";
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
          variableType: blockExpr.typeValue,
          rhs: exprs[i],
          indentation,
        });
      } else {
        const line = this.codegenExpr({
          expr: exprs[i],
          indentation: indentation,
        });
        code += `${indentation}${line}\n`;
      }
    }

    if (isFunctionBody) {
      code += `${indentation}return ${blockExpr.tempVariableName};\n`;
    }

    code += `${originalIndentation}} // end block\n`;
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

  codegenMatchExpression({
    expr,
    indentation,
  }: {
    expr: MatchExpr;
    indentation: string;
  }): string {
    let code = `\n${indentation}// match\n`;
    // Add temp variable;
    code += `${indentation}${this.getTypeInC(expr.typeValue)} ${
      expr.tempVariableName
    };\n`;
    code += `${indentation}switch ((${this.codegenExpr({
      expr: expr.matchedEnum,
      indentation: "",
    })}).tag) {
${expr.cases
  .map(({ case: _case, body, variantName }) => {
    let variantIndex = -1;
    if (variantName !== "*") {
      const enumType = expr.matchedEnum.typeValue as TEnum;
      variantIndex = enumType.variants.findIndex(
        (variant) => variant.name === variantName
      );
      if (variantIndex === -1) {
        throw new Error(
          `Cannot find variant "${variantName}" in enum ${typeToString(
            enumType
          )}`
        );
      }
    }

    return `${indentation}  ${
      _case ? `case ${variantIndex}` : "default"
    }: // ${variantName}
${indentation}    ${this.codegenBlockExpression({
      blockExpr: body,
      isFunctionBody: false,
      indentation: indentation + "    ",
      ignoreTempVariableDeclaration: true,
    })}
${indentation}    break;`;
  })
  .join("\n")}
${indentation}};\n\n`;
    return code;
  }

  codegenAssignmentByVariableId({
    variableId,
    variableType,
    rhs,
    indentation,
  }: {
    variableId: string;
    variableType: Type;
    rhs: Expr;
    indentation: string;
  }): string {
    let code = "";

    const needsDereference =
      variableType.permission === "own" &&
      (rhs.typeValue.permission === "read" ||
        rhs.typeValue.permission === "write");

    if (rhs.type === AstType.Block) {
      code += `${this.codegenBlockExpression({
        blockExpr: rhs,
        indentation,
        isFunctionBody: false,
      })}
${indentation}${variableId} = ${needsDereference ? "*" : ""}(${
        rhs.tempVariableName
      });\n`;
    } else if (
      rhs.type === AstType.Match ||
      rhs.type === AstType.If ||
      rhs.type === AstType.ReadWrite
    ) {
      code += `${this.codegenExpr({
        expr: rhs,
        indentation,
      })}
${indentation}${variableId} = ${needsDereference ? "*" : ""}(${
        rhs.tempVariableName
      });\n`;
    } else if (
      rhs.type === AstType.CallFunction ||
      rhs.type === AstType.CallEnum ||
      rhs.type === AstType.CallTypeConstructor
    ) {
      code += `${this.codegenExpr({
        expr: rhs,
        indentation,
      })}
${
  variableId === rhs.tempVariableName
    ? ""
    : `${indentation}${variableId} = ${needsDereference ? "*" : ""}(${
        rhs.tempVariableName
      });\n`
}`;
    } else {
      code += `${indentation}${variableId} = ${
        needsDereference ? "*" : ""
      }(${this.codegenExpr({
        expr: rhs,
        indentation,
      }).trim()});\n`;
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
        parameterTypes: functionType.parameterTypes,
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

  codegenCallEnum({
    expr,
    indentation,
  }: {
    expr: CallEnumExpr;
    indentation: string;
  }): string {
    let code = "";
    const enumType = expr.typeValue;
    const enumKey = this.codegenEnumIfNecessary(enumType);
    // Add temp variable:
    code += `${indentation}${this.getTypeInC(enumType)} ${
      expr.tempVariableName
    };\n`;
    const selectedVariantIndex = enumType.variants.findIndex(
      (variant) => variant.name === enumType.selectedVariantName
    );
    const selectedVariant = enumType.variants[selectedVariantIndex];
    if (!selectedVariant) {
      throw new Error(
        `Cannot find variant "${
          enumType.selectedVariantName
        }" in enum ${typeToString(enumType)}`
      );
    }

    // parse arguments
    const { functionArgumentStringList, code: nextCode } =
      this.getFunctionArgumentsStringList({
        functionArguments: expr.variantArguments,
        parameterTypes: selectedVariant.parameterTypes,
        code,
        indentation,
      });
    code = nextCode;

    {
      code += `${indentation}${expr.tempVariableName} = (${enumKey}){ 
${indentation}  .tag = ${selectedVariantIndex},
${indentation}  .variant = {
${indentation}    .${selectedVariant.name} = {
${functionArgumentStringList
  .map((argumentString, index) => {
    return `${indentation}      .${selectedVariant.parameterTypes[index].name} = ${argumentString}`;
  })
  .join(",\n")}
${indentation}    }
${indentation}  }
${indentation}};
`;
    }

    return code;
  }

  codegenCallTypeConstructor({
    expr,
    indentation,
  }: {
    expr: CallTypeConstructorExpr;
    indentation: string;
  }): string {
    let code = "";
    // Add temp variable:
    code += `${indentation}${this.getTypeInC(expr.typeValue)} ${
      expr.tempVariableName
    };\n`;
    const typeConstructorType = expr.typeValue;
    const typeConstructorKey =
      this.codegenTypeConstructorIfNecessary(typeConstructorType);

    code += `${indentation}${
      expr.tempVariableName
    } = ((${typeConstructorKey}) ${this.codegenExpr({
      expr: expr.expr,
      indentation: "",
    })});`;
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
    }).trim()});`;

    return code;
  }

  codegenImplicitDereference({
    expr,
    indentation,
  }: {
    expr: ImplicitDereferenceExpr;
    indentation: string;
  }): string {
    const code = `*(${this.codegenExpr({ expr: expr.expr, indentation })})`;
    return code;
  }

  getFunctionArgumentsStringList({
    functionArguments,
    parameterTypes,
    code,
    indentation,
  }: {
    functionArguments: Expr[];
    parameterTypes: TParameterType[];
    code: string;
    indentation: string;
  }): { functionArgumentStringList: string[]; code: string } {
    const functionArgumentStringList: string[] = [];
    for (let i = 0; i < functionArguments.length; i++) {
      const argument = functionArguments[i];
      const parameterType = parameterTypes[i];
      if ("tempVariableName" in argument) {
        code += this.codegenAssignmentByVariableId({
          variableId: argument.tempVariableName,
          variableType: parameterType.type,
          rhs: argument,
          indentation,
        });
        functionArgumentStringList.push(argument.tempVariableName);
      } else {
        const needsReference =
          (parameterType.type.permission === "read" ||
            parameterType.type.permission === "write") &&
          argument.typeValue.permission === "own";

        functionArgumentStringList.push(
          `(${needsReference ? "&" : ""}${this.codegenExpr({
            expr: argument,
            indentation,
          }).trim()})`
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
    let variableId = "";
    if (
      expr.left.typeValue.permission === "read" ||
      expr.left.typeValue.permission === "write"
    ) {
      variableId = "*";
    }
    code += this.codegenAssignmentByVariableId({
      variableId:
        variableId +
        this.codegenExpr({
          expr: expr.left,
          indentation: "",
        }),
      variableType: expr.left.typeValue,
      indentation,
      rhs: expr.right,
    });
    return code;
  }

  codegenPropertyAccess({
    expr,
    indentation,
  }: {
    expr: PropertyAccessExpr;
    indentation: string;
  }): string {
    const code = `${indentation}${this.codegenExpr({
      expr: expr.expr,
      indentation: "",
    })}${
      expr.expr.typeValue.permission === "read" ||
      expr.expr.typeValue.permission === "write"
        ? "->"
        : "."
    }${expr.propertyName}`;
    return code;
  }

  codegenIndexAccess({
    expr,
    indentation,
  }: {
    expr: IndexAccessExpr;
    indentation: string;
  }): string {
    const isReference =
      expr.expr.typeValue.permission === "read" ||
      expr.expr.typeValue.permission === "write";

    const code = `${indentation}${isReference ? "*(" : ""}${this.codegenExpr({
      expr: expr.expr,
      indentation: "",
    })}${isReference ? ")" : ""}${expr.indexes
      .map((index) => `[${this.codegenExpr({ expr: index, indentation: "" })}]`)
      .join("")}`;
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
          case "record": {
            return this.codegenRecordValue({
              expr: expr,
            });
          }
          case "slice": {
            return this.codegenSliceValue({
              expr: expr,
            });
          }
          default: {
            throw new Error(`Unimplemented value tag ${expr}`);
          }
        }
      }
      case AstType.Function: {
        this.functionIdToExprMap.set(expr.typeValue.functionId, expr);
        this.codegenFunctionIfNecessary(expr.typeValue);
        return "";
      }
      case AstType.Enum: {
        this.codegenEnumIfNecessary(expr.typeValue);
        return "";
      }
      case AstType.Interface: {
        // Check if there is pre-defined function
        for (let i = 0; i < expr.class.functions.length; i++) {
          const func = expr.class.functions[i];
          if (func.functionExpr) {
            this.functionIdToExprMap.set(
              func.func.functionId,
              func.functionExpr
            );
            this.codegenFunctionIfNecessary(func.functionExpr.typeValue);
          }
        }
        return ""; // TODO: To be implemented
      }
      case AstType.TypeAlias: {
        this.codegenTypeConstructorIfNecessary(expr.typeValue);
        return ""; // TODO: To be implemented
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
            variableType: expr.variableType,
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
      case AstType.Match: {
        return this.codegenMatchExpression({ expr, indentation });
      }
      case AstType.CallFunction: {
        return this.codegenCallFunction({ expr, indentation });
      }
      case AstType.CallEnum: {
        return this.codegenCallEnum({ expr, indentation });
      }
      case AstType.CallTypeConstructor: {
        return this.codegenCallTypeConstructor({ expr, indentation });
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
      case AstType.ImplicitDereference: {
        return this.codegenImplicitDereference({ expr, indentation });
      }
      case AstType.Import:
      case AstType.Infix: {
        return "";
      }
      case AstType.Export: {
        return this.codegenExpr({ expr: expr.expr, indentation });
      }
      case AstType.PropertyAccess: {
        return this.codegenPropertyAccess({ expr, indentation });
      }
      case AstType.IndexAccess: {
        return this.codegenIndexAccess({ expr, indentation });
      }
      default: {
        throw new Error(
          `Codegen: Unimplemented expr type "${expr.type}"\n${exprToString(
            expr
          )}`
        );
      }
    }
  }
}
