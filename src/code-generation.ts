import llvm, { LLVMContext } from "llvm-bindings";
import {
  AstType,
  Expr,
  FunctionExpr,
  FunctionPrototype,
  OperatorType,
  exprToString,
} from "./ast";
import { ValueType } from "./env";
import { tokenize } from "./lexer";
import {
  LlvmEnvironment,
  LlvmValue,
  addLlvmEnvironmentNamedValue,
  copyLlvmEnvironment,
  getLlvmEnvironmentNamedValuesByName,
  getLlvmFunctionByNameAndTypeArgumentsAndArguments,
  getLlvmFunctionTemplateByName,
} from "./llvm-env";
import Parser from "./parser";
import { Token } from "./token";
import {
  TFunction,
  Type,
  applyTypeArgumentsToFunctionExpr,
  typeToString,
} from "./type-checker";

export class CodeGenerator {
  private inputString: string;
  private tokens: Token[];
  private ast: Expr[];

  private context: LLVMContext;
  private module: llvm.Module;
  private builder: llvm.IRBuilder;
  private dataLayout: llvm.DataLayout;

  private unit: llvm.Value;

  constructor(inputString: string, targetTriple?: string) {
    this.inputString = inputString;
    this.tokens = tokenize(this.inputString);
    console.log(`= tokens: `, this.tokens);

    const parser = new Parser(inputString);
    this.ast = parser.parse(this.tokens);

    console.log("\n= ast: ");
    this.ast.map((expr) => console.log(exprToString(expr)));
    console.log("\n= ast end\n");

    this.context = new llvm.LLVMContext();
    this.module = new llvm.Module("main", this.context);
    this.builder = new llvm.IRBuilder(this.context);

    // Set the target triple
    targetTriple = targetTriple ?? llvm.config.LLVM_DEFAULT_TARGET_TRIPLE;
    this.module.setTargetTriple(targetTriple);
    this.dataLayout = this.module.getDataLayout();
    /*
    const target = llvm.TargetRegistry.lookupTarget(targetTriple);
    if (!target) {
      throw new Error(`Target not found`);
    }
    const targetMachine = target.createTargetMachine(targetTriple, "generic");
    this.dataLayout = targetMachine.createDataLayout();
    */

    // Create unique unit "()" value in the context.
    this.unit = llvm.ConstantStruct.get(
      llvm.StructType.get(this.context, []),
      []
    );
  }

  private getLlvmType(typeExpr: Type): llvm.Type {
    switch (typeExpr.type) {
      case "i1": {
        return this.builder.getInt1Ty();
      }
      case "i8": {
        return this.builder.getInt8Ty();
      }
      case "i16": {
        return this.builder.getInt16Ty();
      }
      case "i32": {
        return this.builder.getInt32Ty();
      }
      case "i64": {
        return this.builder.getInt64Ty();
      }
      case "i128": {
        return this.builder.getInt128Ty();
      }
      case "f32": {
        return this.builder.getFloatTy();
      }
      case "f64": {
        return this.builder.getDoubleTy();
      }
      case "boolean": {
        return this.builder.getInt1Ty();
      }
      case "char": {
        return this.builder.getInt8Ty();
      }
      case "symbol": {
        // global string
        return llvm.PointerType.get(llvm.IntegerType.get(this.context, 8), 0);
      }

      // case "string": {
      /**
       * Allocate memory for string struct
       * struct String {
       *   char* data;
       *   int length;
       *   int size;
       * }
       */
      /*
        const propertyTypes = [
          llvm.PointerType.get(llvm.IntegerType.get(this.context, 8), 0), // char*
          llvm.IntegerType.get(this.context, 32), // int
          llvm.IntegerType.get(this.context, 32), // int
        ];
        const stringType = llvm.StructType.get(
          this.context,
          propertyTypes
          // false // isPacked
        );
        // Return pointer to string struct
        return llvm.PointerType.get(stringType, 0);
      }
      */
      case "slice": {
        const size = typeExpr.size;
        if (size === undefined) {
          throw new Error(`Slice size not found`);
        }
        const elementType = this.getLlvmType(typeExpr.elementType);

        // Create array of `elementType` with array size of `size`
        const arrayType = llvm.ArrayType.get(elementType, size);

        return llvm.PointerType.get(arrayType, 0);
      }
      case "Record": {
        const properties = typeExpr.properties ?? [];
        const propertyTypes = properties.map((property) => {
          const type = this.getLlvmType(property.type);
          return type;
        });
        const recordType = llvm.StructType.get(this.context, propertyTypes);

        // Return pointer to record struct
        return llvm.PointerType.get(recordType, 0);
      }
      case "Function": {
        // Create a closure type for the function
        const closureType = this.getClosureType(typeExpr);
        // Return pointer to record struct
        return llvm.PointerType.get(closureType, 0);
      }
      case "()": {
        return this.unit.getType();
      }
      default:
        throw new Error(`Unknown type: ${JSON.stringify(typeExpr)}`);
    }
  }

  private getBinOpType(left: llvm.Value, right: llvm.Value): "long" | "double" {
    // TODO: check more types
    const leftType = left.getType();
    const rightType = right.getType();
    try {
      if (
        leftType.isFloatTy() ||
        leftType.isDoubleTy() ||
        rightType.isFloatTy() ||
        rightType.isDoubleTy()
      ) {
        return "double";
      } else {
        return "long";
      }
    } catch (error) {
      return "long";
    }
  }

  private getLlvmFunctionType(type: TFunction): llvm.FunctionType {
    const returnType = this.getLlvmType(type.returnType);
    const paramTypes = type.parameterTypes.map((param) => {
      return this.getLlvmType(param.type);
    });

    if (type.freeVariables) {
      // Add free variables as the last parameter
      // and cast it as void*
      paramTypes.push(
        llvm.PointerType.get(
          llvm.Type.getInt8Ty(this.context),
          0
        ) /*this.getFreeVariablesRecordType(type.freeVariables)*/
      );
    }

    const functionType = llvm.FunctionType.get(
      returnType,
      paramTypes,
      false // isVarArg
    );
    return functionType;
  }

  private getFreeVariablesRecordType(
    freeVariables: ValueType[] | undefined
  ): llvm.StructType {
    freeVariables = freeVariables ?? [];
    const propertyTypes = freeVariables.map((freeVariable) => {
      const type = this.getLlvmType(freeVariable.type);
      return type;
    });
    const recordType = llvm.StructType.get(this.context, propertyTypes);
    return recordType;
  }

  /**
   * Find the llvm function with `functionName` `typeArguments`, and `functionArguments` from the `env`.
   * If not found:
   *  - check if there is `functionExpr` with `functionName` in the env,
   *     - If yes, then generate the llvm function and return it.
   *     - If not, return null
   * Found:
   * - return the llvm function
   * @param functionName
   * @param typeArguments
   * @param env
   * @returns
   */
  private getLlvmFunctionByName(
    functionName: string,
    typeArguments: Type[],
    functionArguments: Expr[],
    env: LlvmEnvironment
  ): (LlvmValue & { env: LlvmEnvironment }) | null {
    const matchedFunction = getLlvmFunctionByNameAndTypeArgumentsAndArguments(
      env,
      functionName,
      typeArguments,
      functionArguments
    );
    if (matchedFunction) {
      return { ...matchedFunction.value, env };
    }

    // Not found, check if the function is defined:
    const definedFunction = getLlvmFunctionTemplateByName(
      env,
      functionName,
      typeArguments,
      functionArguments
    );
    if (!definedFunction || !definedFunction.value.functionExpr) {
      return null;
    } else {
      // Generate the llvm function
      const functionExpr = definedFunction.value.functionExpr;
      const newFunctionExpr = applyTypeArgumentsToFunctionExpr(
        functionExpr,
        typeArguments
      );
      // console.log("- newFunctionExpr: ", exprToString(newFunctionExpr));
      const retVal = this.codegenFunction(newFunctionExpr, env, typeArguments);
      return retVal;
    }
  }

  /**
   * The closure is a record of
   * {
   *    function pointer: void*
   *    free variables: void*
   * }
   * @param type
   * @returns
   */
  private getClosureType(type: TFunction): llvm.StructType {
    const functionPointer = llvm.PointerType.get(
      this.getLlvmFunctionType(type),
      0
    );

    // We set it as void*
    const freeVariablesPointer = llvm.PointerType.get(
      llvm.Type.getInt8Ty(this.context),
      0
    );

    return llvm.StructType.get(this.context, [
      // function pointer
      functionPointer,
      // free variables pointer
      freeVariablesPointer,
    ]);
  }

  private codegenPrototype(prototype: FunctionPrototype): llvm.Function | null {
    const functionName = prototype.typeValue.functionName;
    const functionType = this.getLlvmFunctionType(prototype.typeValue);
    const func = llvm.Function.Create(
      functionType,
      llvm.Function.LinkageTypes.ExternalLinkage,
      functionName,
      this.module
    );
    for (let i = 0; i < func.arg_size(); i++) {
      const arg = func.getArg(i);
      if (
        i >= prototype.typeValue.parameterTypes.length &&
        prototype.typeValue.freeVariables
      ) {
        // Free variables
        arg.setName("FREE_VARIABLES");
      } else {
        // Function parameters
        const parameterType = prototype.typeValue.parameterTypes[i];
        const parameterName = parameterType.name;
        arg.setName(parameterName);
      }
    }
    return func;
  }

  private codegenFunction(
    expr: FunctionExpr,
    env: LlvmEnvironment,
    typeArguments?: Type[]
  ): LlvmValue & { env: LlvmEnvironment } {
    const theFunction = this.codegenPrototype(expr.prototype);
    if (!theFunction) {
      throw new Error(
        `(1) Function "${expr.prototype.functionName}" not found`
      );
    }

    const currentBasicBlock = this.builder.GetInsertBlock();
    const entryBB = llvm.BasicBlock.Create(this.context, "entry", theFunction);
    this.builder.SetInsertPoint(entryBB);

    // Record the function parameters in the namedValues map
    let newEnv: LlvmEnvironment = copyLlvmEnvironment(env);
    for (let i = 0; i < theFunction.arg_size(); i++) {
      const arg = theFunction.getArg(i);
      if (
        i >= expr.prototype.typeValue.parameterTypes.length &&
        expr.prototype.typeValue.freeVariables
      ) {
        // Free variables
        // Load free variables
        const freeVariablesType = this.getFreeVariablesRecordType(
          expr.prototype.typeValue.freeVariables
        );
        // Cast void* to real struct
        const freeVariablesPtr = this.builder.CreateBitCast(
          arg,
          llvm.PointerType.get(freeVariablesType, 0),
          "fn_FREE_VARIABLES"
        );

        const freeVariables = expr.prototype.typeValue.freeVariables;
        for (let i = 0; i < freeVariables.length; i++) {
          const freeVariable = freeVariables[i];
          const freeVariableName = freeVariable.variableName;

          // Get the pointer to the free variable
          const freeVariablePtr = this.builder.CreateGEP(
            freeVariablesType,
            freeVariablesPtr,
            [
              llvm.ConstantInt.get(llvm.IntegerType.get(this.context, 32), 0),
              llvm.ConstantInt.get(llvm.IntegerType.get(this.context, 32), i),
            ],
            freeVariableName
          );
          // Load the value from the free variable
          const freeVariableValue = this.builder.CreateLoad(
            this.getLlvmType(freeVariable.type),
            freeVariablePtr,
            freeVariableName
          );
          newEnv = addLlvmEnvironmentNamedValue(newEnv, {
            name: freeVariable.variableName,
            value: {
              type: freeVariable.type,
              value: freeVariableValue,
            },
          });
        }
      } else {
        const parameterType = expr.prototype.typeValue.parameterTypes[i];
        const parameterName = parameterType.name;
        newEnv = addLlvmEnvironmentNamedValue(newEnv, {
          // id: parameterType.id, // FIXME:
          name: parameterName,
          value: { type: parameterType.type, value: arg },
        });
      }
    }

    // Save the function itself to the namedValues map
    if (expr.prototype.functionName) {
      const closure: LlvmValue = {
        type: expr.typeValue,
        value: this.unit,
        functionExpr: expr,
        function: {
          typeArguments: typeArguments ?? [],
          value: theFunction,
        },
      };
      env = addLlvmEnvironmentNamedValue(env, {
        name: expr.prototype.functionName,
        value: closure,
      });
      newEnv = addLlvmEnvironmentNamedValue(newEnv, {
        name: expr.prototype.functionName,
        value: closure,
      });
    }

    // Codegen the body
    const returnVal = this.codegenExprs(expr.body, newEnv);
    // Move back to the entry block
    this.builder.CreateRet(returnVal.value);

    if (currentBasicBlock) {
      this.builder.SetInsertPoint(currentBasicBlock);
    }

    // verify the function
    if (llvm.verifyFunction(theFunction)) {
      throw new Error(
        `Function "${expr.prototype.functionName}" verification failed`
      );
    } else {
      console.log(`- Function verified for "${expr.prototype.functionName}"`);
    }

    // Return the function pointer + free variables record
    const freeVariables = expr.prototype.typeValue.freeVariables;
    if (!freeVariables) {
      // NOTE: This is not a closure
      // in theory, this return is not used anywhere
      const closure: LlvmValue = {
        type: expr.typeValue,
        value: this.unit,
        functionExpr: expr,
        function: {
          typeArguments: typeArguments ?? [],
          value: theFunction,
        },
      };
      return { ...closure, env };
    }

    const closureType = this.getClosureType(expr.prototype.typeValue);
    const closurePtrType = llvm.PointerType.get(closureType, 0);
    const closurePtr = this.allocateMemoryOnHeap(
      closurePtrType,
      this.dataLayout.getTypeAllocSize(closureType)
    );
    // NOTE: allocate on stack here will cause problem.
    // const freeVariablesRecord = this.builder.CreateAlloca(recordType);

    // Save the function pointer
    const functionPtr = this.builder.CreateGEP(
      closureType,
      closurePtr,
      [
        llvm.ConstantInt.get(llvm.IntegerType.get(this.context, 32), 0),
        llvm.ConstantInt.get(llvm.IntegerType.get(this.context, 32), 0),
      ],
      "functionPtr"
    );
    this.builder.CreateStore(theFunction, functionPtr);

    // Save the free variables
    const freeVariablesType = this.getFreeVariablesRecordType(freeVariables);
    const freeVariablesPtrType = llvm.PointerType.get(freeVariablesType, 0);
    const freeVariablesPtr = this.allocateMemoryOnHeap(
      freeVariablesPtrType,
      this.dataLayout.getTypeAllocSize(freeVariablesType)
    );
    for (let i = 0; i < freeVariables.length; i++) {
      const freeVariable = freeVariables[i];
      const freeVariableName = freeVariable.variableName;
      const freeVariableValues = getLlvmEnvironmentNamedValuesByName(
        env,
        freeVariableName
      );
      if (freeVariableValues.length === 0) {
        throw new Error(
          `Free variable ${freeVariableName} not found in namedValues`
        );
      }
      const freeVariableValue =
        freeVariableValues[freeVariableValues.length - 1];

      // Get the pointer to the free variable
      const freeVariablePtr = this.builder.CreateGEP(
        freeVariablesType,
        freeVariablesPtr,
        [
          llvm.ConstantInt.get(llvm.IntegerType.get(this.context, 32), 0),
          llvm.ConstantInt.get(llvm.IntegerType.get(this.context, 32), i),
        ],
        freeVariableName
      );
      // Store the value in the free variable
      this.builder.CreateStore(freeVariableValue.value.value, freeVariablePtr);
    }
    const freeVariablesRecordPtr = this.builder.CreateGEP(
      closureType,
      closurePtr,
      [
        llvm.ConstantInt.get(llvm.IntegerType.get(this.context, 32), 0),
        llvm.ConstantInt.get(llvm.IntegerType.get(this.context, 32), 1),
      ],
      "fn_freeVariablesPtr"
    );

    // cast freeVariablesPtr to void*
    const freeVariablesPtrCast = this.builder.CreateBitCast(
      freeVariablesPtr,
      llvm.PointerType.get(llvm.Type.getInt8Ty(this.context), 0),
      "fn_casted_freeVariablesPtr"
    );
    this.builder.CreateStore(freeVariablesPtrCast, freeVariablesRecordPtr);

    return {
      type: expr.typeValue,
      value: closurePtr,
      functionExpr: expr,
      function: {
        typeArguments: typeArguments ?? [],
        value: theFunction,
      },
      env,
    };
  }

  private allocateMemoryOnHeap(ptrType: llvm.Type, bytes: number): llvm.Value {
    const structType = ptrType.getPointerElementType() as llvm.StructType;
    if (!structType.isStructTy()) {
      throw new Error(`Only support allocating memory on heap for struct type`);
    }
    console.log("= allocateMemoryOnHeap: ", bytes);

    // Allocate memory on heap
    const malloc = this.module.getFunction("malloc");
    if (!malloc) {
      throw new Error(`malloc function not found`);
    }
    const structSize = llvm.ConstantInt.get(
      llvm.IntegerType.get(this.context, 32),
      bytes
    );
    const structPtr = this.builder.CreateCall(malloc, [structSize], "malloc");
    const structPtrCast = this.builder.CreateBitCast(
      structPtr,
      ptrType,
      "malloc"
    );

    return structPtrCast;
  }

  private externMalloc() {
    // extern malloc(size: i32): void*
    const mallocType = llvm.FunctionType.get(
      llvm.PointerType.get(llvm.Type.getInt8Ty(this.context), 0),
      [llvm.Type.getInt32Ty(this.context)],
      false // isVarArg
    );
    llvm.Function.Create(
      mallocType,
      llvm.Function.LinkageTypes.ExternalLinkage,
      "malloc",
      this.module
    );
  }

  private codegenForPropertyAccess(
    expr: Expr,
    env: LlvmEnvironment,
    propertyName: string
    // env: LlvmEnvironment
  ): LlvmValue {
    const typeValue = expr.typeValue;
    const exprValue = this.codegenExpr(expr, env);
    switch (typeValue.type) {
      case "Record": {
        const propertyTypes = typeValue.properties ?? [];
        const propertyTypeIndex = propertyTypes.findIndex(
          (property) => property.name === propertyName
        );
        if (propertyTypeIndex === -1) {
          throw new Error(
            `Property ${propertyName} not found in ${JSON.stringify(typeValue)}`
          );
        }
        const propertyType = propertyTypes[propertyTypeIndex].type;
        const exprType = this.getLlvmType(typeValue);
        const exprPtrType = exprType.getPointerElementType();
        const propertyPtr = this.builder.CreateGEP(
          exprPtrType,
          exprValue.value,
          [
            llvm.ConstantInt.get(llvm.IntegerType.get(this.context, 32), 0),
            llvm.ConstantInt.get(
              llvm.IntegerType.get(this.context, 32),
              propertyTypeIndex
            ),
          ],
          propertyName
        );
        const value: llvm.Value = this.builder.CreateLoad(
          this.getLlvmType(propertyType),
          propertyPtr,
          propertyName
        );
        // FIXME: it might be "tag": "function"
        return {
          type: propertyType,
          value,
        };
      }
      case "Trait": {
        // Get the function from the trait
        if (!exprValue.trait) {
          throw new Error(`Not a trait:

${exprToString(expr)}
`);
        }
        const trait = exprValue.trait;
        const functions = trait.functions;
        const functionIndex = functions.findIndex(
          (func) => func.name === propertyName
        );
        if (functionIndex < 0) {
          throw new Error(
            `Function "${propertyName}" not found in trait:

${exprToString(expr)}
`
          );
        }
        const func = functions[functionIndex];
        return {
          type: func.type,
          value: this.unit,
          functionExpr: func.functionExpr,
          function: {
            typeArguments: [],
            value: func.value,
          },
        };
      }
      default:
        throw new Error(
          `Accessors not implemented for:

${typeToString(typeValue)}
`
        );
    }
  }

  private codegenExprs(expr: Expr[], env: LlvmEnvironment): LlvmValue {
    // Create undefined value
    let llvmValue: LlvmValue & { env: LlvmEnvironment } = {
      value: this.unit, //llvm.UndefValue.get(llvm.PointerType.getVoidTy(this.context)),
      type: { type: "()" },
      env,
    };
    const exprs = expr;
    for (let i = 0; i < exprs.length; i++) {
      const expr = exprs[i];
      if (expr.type === AstType.TypeAlias) {
        continue;
      }
      llvmValue = this.codegenExpr(expr, env);
      env = llvmValue.env;
    }
    return llvmValue;
  }

  private codegenExpr(
    expr: Expr | FunctionPrototype,
    env: LlvmEnvironment
  ): LlvmValue & { env: LlvmEnvironment } {
    switch (expr.type) {
      case AstType.Value: {
        const typeValue = expr.typeValue;
        switch (expr.tag) {
          case "primitive": {
            const typeValue = expr.typeValue;
            switch (typeValue.type) {
              case "boolean":
                return {
                  value: llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 1),
                    typeValue.value === "true" ? 1 : 0,
                    false // isSigned
                  ),
                  type: typeValue,
                  env,
                };
              case "char":
                return {
                  value: llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 8),
                    typeValue.value.charCodeAt(0),
                    false // isSigned
                  ),
                  type: typeValue,
                  env,
                };
              case "u1":
                return {
                  value: llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 1),
                    parseInt(typeValue.value),
                    false // isSigned
                  ),
                  type: typeValue,
                  env,
                };
              case "i1":
                return {
                  value: llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 1),
                    parseInt(typeValue.value),
                    true // isSigned
                  ),
                  type: typeValue,
                  env,
                };
              case "u8":
                return {
                  value: llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 8),
                    parseInt(typeValue.value),
                    false // isSigned
                  ),
                  type: typeValue,
                  env,
                };
              case "i8":
                return {
                  value: llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 8),
                    parseInt(typeValue.value),
                    true // isSigned
                  ),
                  type: typeValue,
                  env,
                };
              case "u16":
                return {
                  value: llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 16),
                    parseInt(typeValue.value),
                    false // isSigned
                  ),
                  type: typeValue,
                  env,
                };
              case "i16":
                return {
                  value: llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 16),
                    parseInt(typeValue.value),
                    true // isSigned
                  ),
                  type: typeValue,
                  env,
                };
              case "u32":
                return {
                  value: llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 32),
                    parseInt(typeValue.value),
                    false // isSigned
                  ),
                  type: typeValue,
                  env,
                };
              case "i32":
                return {
                  value: llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 32),
                    parseInt(typeValue.value),
                    true // isSigned
                  ),
                  type: typeValue,
                  env,
                };
              case "u64":
                return {
                  value: llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 64),
                    parseInt(typeValue.value),
                    false // isSigned
                  ),
                  type: typeValue,
                  env,
                };
              case "i64":
                return {
                  value: llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 64),
                    parseInt(typeValue.value),
                    true // isSigned
                  ),
                  type: typeValue,
                  env,
                };
              case "u128":
                return {
                  value: llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 128),
                    parseInt(typeValue.value),
                    false // isSigned
                  ),
                  type: typeValue,
                  env,
                };
              case "i128":
                return {
                  value: llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 128),
                    parseInt(typeValue.value),
                    true // isSigned
                  ),
                  type: typeValue,
                  env,
                };
              case "f16":
              case "f32": {
                return {
                  value: llvm.ConstantFP.get(
                    llvm.Type.getFloatTy(this.context),
                    parseFloat(typeValue.value)
                  ),
                  type: typeValue,
                  env,
                };
              }
              case "f64": {
                return {
                  value: llvm.ConstantFP.get(
                    llvm.Type.getDoubleTy(this.context),
                    parseFloat(typeValue.value)
                  ),
                  type: typeValue,
                  env,
                };
              }
              case "symbol": {
                /*
                  // Generate global string
                  const stringConstant = llvm.ConstantDataArray.getString(
                    this.context,
                    typeValue.value
                  );
                  */
                // Create pointer to it
                const stringPtr = this.builder.CreateGlobalStringPtr(
                  typeValue.value,
                  "string"
                );
                return {
                  value: stringPtr,
                  type: typeValue,
                  env,
                };
              }
              case "()":
                return {
                  value: this.unit,
                  type: typeValue,
                  env,
                };
              default:
                throw new Error(
                  `Unknown value type: ${JSON.stringify(typeValue)}`
                );
            }
          }
          case "record": {
            // Allocate memory for the record
            const recordPtrType = this.getLlvmType(typeValue);
            const recordType = recordPtrType.getPointerElementType();

            // Allocate on heap
            const recordPtr = this.allocateMemoryOnHeap(
              recordPtrType,
              this.dataLayout.getTypeAllocSize(recordType)
            );

            // Allocate on stack
            // const recordPtr = this.builder.CreateAlloca(recordType);

            // Set the record fields
            const properties = expr.properties ?? [];
            for (let i = 0; i < properties.length; i++) {
              const property = properties[i];
              const propertyValue = this.codegenExpr(property.value, env);

              // Get the pointer to the property
              const propertyPtr = this.builder.CreateGEP(
                recordType,
                recordPtr,
                [
                  llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 32),
                    0
                  ),
                  llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 32),
                    i
                  ),
                ],
                property.name
              );

              // Store the value in the property
              this.builder.CreateStore(propertyValue.value, propertyPtr);
            }
            return {
              value: recordPtr,
              type: typeValue,
              env,
            };
          }
          case "slice": {
            // Allocate memory for the slice
            const slicePtrType = this.getLlvmType(typeValue);
            const sliceType = slicePtrType.getPointerElementType();

            // Allocate on heap
            /*
              const slicePtr = this.allocateMemoryOnHeap(
                slicePtrType,
                this.dataLayout.getTypeAllocSize(sliceType)
              );
              */

            // Allocate on stack
            const slicePtr = this.builder.CreateAlloca(sliceType);

            // Set the slice values
            const sliceValues = expr.values ?? [];
            for (let i = 0; i < sliceValues.length; i++) {
              const sliceValue = sliceValues[i];
              const value = this.codegenExpr(sliceValue, env);

              // Set value at index
              const indexPtr = this.builder.CreateGEP(
                sliceType,
                slicePtr,
                [
                  llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 32),
                    0
                  ),
                  llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 32),
                    i
                  ),
                ],
                "index"
              );

              this.builder.CreateStore(value.value, indexPtr);
            }
            return { value: slicePtr, type: typeValue, env };
          }
          default: {
            throw new Error(`Unknown value tag: ${expr}`);
          }
        }
      }
      case AstType.BinaryOperator: {
        const typeValue = expr.typeValue;
        const lhs = this.codegenExpr(expr.left, env);
        const rhs = this.codegenExpr(expr.right, lhs.env);
        env = rhs.env;

        // TODO: Better logic
        if (
          expr.left.typeValue.type === "symbol" &&
          expr.right.typeValue.type === "symbol"
        ) {
          if (expr.operator === OperatorType.Equal) {
            return {
              value: this.builder.CreateICmpEQ(lhs.value, rhs.value),
              type: { type: "boolean" },
              env,
            }; // 1 means equal
          }
        }

        const binopType = this.getBinOpType(lhs.value, rhs.value);
        switch (expr.operator) {
          // TODO: Support operator overloading
          case "+":
            if (binopType === "double") {
              return {
                value: this.builder.CreateFAdd(lhs.value, rhs.value),
                type: typeValue,
                env,
              };
            } else {
              return {
                value: this.builder.CreateAdd(lhs.value, rhs.value),
                type: typeValue,
                env,
              };
            }
          case "-":
            if (binopType === "double") {
              return {
                value: this.builder.CreateFSub(lhs.value, rhs.value),
                type: typeValue,
                env,
              };
            } else {
              return {
                value: this.builder.CreateSub(lhs.value, rhs.value),
                type: typeValue,
                env,
              };
            }
          case "*":
            if (binopType === "double") {
              return {
                value: this.builder.CreateFMul(lhs.value, rhs.value),
                type: typeValue,
                env,
              };
            } else {
              return {
                value: this.builder.CreateMul(lhs.value, rhs.value),
                type: typeValue,
                env,
              };
            }
          case "/":
            if (binopType === "double") {
              return {
                value: this.builder.CreateFDiv(lhs.value, rhs.value),
                type: typeValue,
                env,
              };
            } else {
              return {
                value: this.builder.CreateSDiv(lhs.value, rhs.value),
                type: typeValue,
                env,
              };
            }
          case "%":
            if (binopType === "double") {
              return {
                value: this.builder.CreateFRem(lhs.value, rhs.value),
                type: typeValue,
                env,
              };
            } else {
              return {
                value: this.builder.CreateSRem(lhs.value, rhs.value),
                type: typeValue,
                env,
              };
            }
          case "==":
            if (binopType === "double") {
              return {
                value: this.builder.CreateFCmpOEQ(lhs.value, rhs.value),
                type: typeValue,
                env,
              };
            } else {
              return {
                value: this.builder.CreateICmpEQ(lhs.value, rhs.value),
                type: typeValue,
                env,
              };
            }
          case "!=":
            if (binopType === "double") {
              return {
                value: this.builder.CreateFCmpONE(lhs.value, rhs.value),
                type: typeValue,
                env,
              };
            } else {
              return {
                value: this.builder.CreateICmpNE(lhs.value, rhs.value),
                type: typeValue,
                env,
              };
            }
          case "<":
            if (binopType === "double") {
              return {
                value: this.builder.CreateFCmpOLT(lhs.value, rhs.value),
                type: typeValue,
                env,
              };
            } else {
              return {
                value: this.builder.CreateICmpSLT(lhs.value, rhs.value),
                type: typeValue,
                env,
              };
            }
          case "<=":
            if (binopType === "double") {
              return {
                value: this.builder.CreateFCmpOLE(lhs.value, rhs.value),
                type: typeValue,
                env,
              };
            } else {
              return {
                value: this.builder.CreateICmpSLE(lhs.value, rhs.value),
                type: typeValue,
                env,
              };
            }
          default:
            throw new Error(`Unknown binary operator: ${expr.operator}`);
        }
      }
      case AstType.Function: {
        // Check if the function has type parameters
        if (
          expr.prototype.typeValue.parameterTypes.length > 0 &&
          expr.prototype.functionName
        ) {
          // Don't generate llvm function.
          env = addLlvmEnvironmentNamedValue(env, {
            name: expr.prototype.functionName,
            value: {
              value: this.unit,
              type: expr.typeValue,
              functionExpr: expr,
            },
          });
          return {
            value: this.unit,
            type: { type: "()" },
            env,
          };
        } else {
          return this.codegenFunction(expr, env);
        }
      }
      case AstType.Extern: {
        const theFunction = this.codegenPrototype(expr.prototype);
        if (!theFunction || !expr.prototype.functionName) {
          throw new Error(
            `"extern" function "${expr.prototype.functionName}" not found`
          );
        }
        const closure: LlvmValue = {
          value: this.unit,
          type: expr.typeValue,
          function: {
            typeArguments: [],
            value: theFunction,
          },
        };
        env = addLlvmEnvironmentNamedValue(env, {
          name: expr.prototype.functionName,
          value: closure,
        });
        return { ...closure, env };
        // return theFunction;
      }
      case AstType.Variable: {
        // TODO: Check if it's a function
        /* if (expr.typeValue.type === "Function") {
          const namedValue =
            getLlvmFunctionByNameAndTypeArgumentsAndFunctionType(
              env,
              expr.name,
              [],
              expr.typeValue
            );
          if (!namedValue) {
            throw new Error(`Function "${expr.name}" not found in env.`);
          } else {
            return { ...namedValue.value, env };
          }
        } else */ {
          const namedValues = getLlvmEnvironmentNamedValuesByName(
            env,
            expr.name
          );

          if (!namedValues.length) {
            throw new Error(`Variable "${expr.name}" not found`);
          }
          const namedValue = namedValues[namedValues.length - 1];
          return { ...namedValue.value, env };
        }
      }
      case AstType.CallFunction: {
        const callee = expr.callee;
        const calleeTypeValue = callee.typeValue;
        console.log("callee: ");
        console.log("  - expr: ", exprToString(callee));
        console.log("  - type: ", typeToString(callee.typeValue));
        console.log("expr: ", exprToString(expr));

        // NOTE: Function argument types check is done in the parser.ts stage.
        const args: llvm.Value[] = expr.functionArguments.map((arg) => {
          return this.codegenExpr(arg, env).value;
        });

        if (calleeTypeValue.type !== "Function") {
          throw new Error(`Callee is not a function:\n${exprToString(callee)}`);
        }

        let namedValue:
          | (LlvmValue & { env: LlvmEnvironment })
          | null
          | undefined;
        if (callee.type === AstType.Variable) {
          const function_ = this.getLlvmFunctionByName(
            callee.name,
            expr.typeArguments,
            expr.functionArguments,
            env
          );
          namedValue = function_;
        } else {
          namedValue = this.codegenExpr(callee, env);
          env = namedValue.env; // NOTE: This is necessary
        }

        const functionType = namedValue?.type;
        if (!namedValue || functionType?.type !== "Function") {
          throw new Error(
            `Function not found:
${exprToString(callee)}: ${typeToString(callee.typeValue)}`
          );
        }

        if (
          namedValue &&
          functionType &&
          functionType.type === "Function" &&
          functionType.freeVariables
        ) {
          const closurePtr = namedValue.value;
          const closureType = this.getClosureType(functionType);

          // Get the pointer to the free variables
          const freeVariablesRecordPtr = this.builder.CreateGEP(
            closureType,
            closurePtr,
            [
              llvm.ConstantInt.get(llvm.IntegerType.get(this.context, 32), 0),
              llvm.ConstantInt.get(llvm.IntegerType.get(this.context, 32), 1),
            ],
            "callfn_freeVariablesPtr"
          );

          // Load as void*
          const freeVariablesVoidPtr = this.builder.CreateLoad(
            llvm.PointerType.get(llvm.Type.getInt8Ty(this.context), 0),
            freeVariablesRecordPtr,
            "callfn_freeVariablesPtr"
          );

          args.push(freeVariablesVoidPtr);
        }

        // This is closure
        if (functionType.freeVariables) {
          // Get the function from the closure
          const closurePtr = namedValue.value;
          const llvmFunctionType = this.getLlvmFunctionType(functionType);
          const closureType = this.getClosureType(functionType);
          const functionPtr = this.builder.CreateGEP(
            closureType,
            closurePtr,
            [
              llvm.ConstantInt.get(llvm.IntegerType.get(this.context, 32), 0),
              llvm.ConstantInt.get(llvm.IntegerType.get(this.context, 32), 0),
            ],
            "functionPtr"
          );
          const functionValue = this.builder.CreateLoad(
            llvm.PointerType.get(llvmFunctionType, 0),
            functionPtr,
            "functionPtr"
          );

          return {
            value: this.builder.CreateCall(
              llvmFunctionType,
              functionValue,
              args
            ),
            type: expr.typeValue,
            env,
          };
        } else {
          const retVal = namedValue; // this.module.getFunction(functionType.id);
          if (!retVal || !retVal.function) {
            throw new Error(
              `(2) Function "${functionType.functionName}" not found`
            );
          }
          return {
            value: this.builder.CreateCall(retVal.function.value, args),
            type: expr.typeValue,
            env: retVal.env,
          };
        }
      }
      case AstType.If: {
        const conditionValue = this.codegenExpr(expr.condition, env);

        // Convert condition to a bool by comparing equal to 0.0
        /*
          conditionValue = this.builder.CreateFCmpONE(
            conditionValue,
            llvm.ConstantFP.get(this.context, new llvm.APFloat(0.0)),
            "ifcond"
          );
          */

        const theFunction = this.builder.GetInsertBlock()?.getParent();
        if (!theFunction) {
          throw new Error(`Function not found`);
        }

        // Create blocks for the `then` and `else` cases. Insert the `then` block at the end of the function
        const thenBB = llvm.BasicBlock.Create(
          this.context,
          "then",
          theFunction
        );
        const elseBB = llvm.BasicBlock.Create(this.context, "else");
        const mergeBB = llvm.BasicBlock.Create(this.context, "ifcont");

        this.builder.CreateCondBr(conditionValue.value, thenBB, elseBB);

        // Emit then value
        this.builder.SetInsertPoint(thenBB);
        const thenValue = this.codegenExprs(expr.then, env);
        if (!thenValue) {
          throw new Error(`Then value not found`);
        }

        this.builder.CreateBr(mergeBB);
        {
          // Codegen of 'Then' can change the current block, update ThenBB for the PHI.
          const thenBB = this.builder.GetInsertBlock();
          if (!thenBB) {
            throw new Error(`Then block not found`);
          }

          // Emit else block
          theFunction.insertAfter(thenBB, elseBB);
          this.builder.SetInsertPoint(elseBB);

          const elseValue = this.codegenExprs(expr.else, env);
          if (!elseValue) {
            throw new Error(`Else value not found`);
          }

          this.builder.CreateBr(mergeBB);
          // Codegen of 'Else' can change the current block, update ElseBB for the PHI.
          {
            const elseBB = this.builder.GetInsertBlock();
            if (!elseBB) {
              throw new Error(`Else block not found`);
            }

            // Emit merge block
            theFunction.insertAfter(elseBB, mergeBB);
            this.builder.SetInsertPoint(mergeBB);

            const phiNode = this.builder.CreatePHI(
              // llvm.Type.getVoidTy(this.context),
              llvm.Type.getInt32Ty(this.context), // TODO: This should be the type of the return value. This means both thenValue and elseValue should have the same type.
              2,
              "iftmp"
            );
            phiNode.addIncoming(thenValue.value, thenBB);
            phiNode.addIncoming(elseValue.value, elseBB);
            return { value: phiNode, type: expr.typeValue, env };
          }
        }
      }
      case AstType.ConstantAssigment: {
        const value = this.codegenExpr(expr.right, env);
        env = addLlvmEnvironmentNamedValue(value.env, {
          name: expr.variableName,
          value,
        });
        return { ...value, env };
      }
      case AstType.PropertyAccess: {
        return {
          ...this.codegenForPropertyAccess(expr.expr, env, expr.propertyName),
          env,
        };
      }
      case AstType.IndexAccess: {
        if (expr.expr.typeValue.type !== "slice") {
          throw new Error(`Index access not implemented for ${expr.expr}`);
        }

        const indexes = expr.indexes;
        if (indexes.length === 0) {
          throw new Error(`Index not found`);
        }
        const indexValues = indexes.map((index) => {
          return this.codegenExpr(index, env).value;
        });

        let sliceType: Type = expr.expr.typeValue;
        let { value: sliceValue } = this.codegenExpr(expr.expr, env);

        // Get the pointer to the index
        for (let i = 0; i < indexValues.length; i++) {
          if (sliceType.type !== "slice") {
            throw new Error(`Index access not implemented for ${expr.expr}`);
          }

          const slidePtrLlvmType = this.getLlvmType(sliceType);
          const sliceLlvmType = slidePtrLlvmType.getPointerElementType();

          sliceValue = this.builder.CreateGEP(
            sliceLlvmType,
            sliceValue,
            [
              llvm.ConstantInt.get(llvm.IntegerType.get(this.context, 32), 0),
              indexValues[i],
            ],
            "index"
          );

          const targetType = sliceType.elementType;
          sliceValue = this.builder.CreateLoad(
            this.getLlvmType(targetType),
            sliceValue,
            "valueAtIndex"
          );
          sliceType = targetType;
        }

        if (sliceValue === undefined) {
          throw new Error(`Slice value not found`);
        }

        // Load the value from the index
        return {
          value: sliceValue,
          type: expr.typeValue,
          env,
        };
      }
      case AstType.Block: {
        const returnValue = this.codegenExprs(expr.exprs, env);
        return { ...returnValue, env };
      }
      case AstType.Trait: {
        const traitTypeArguments = expr.typeArguments;
        if (traitTypeArguments === undefined) {
          // This is trait definition
          const value: LlvmValue = {
            type: expr.typeValue,
            value: this.unit,

            traitExpr: expr,
            trait: undefined,
          };
          env = addLlvmEnvironmentNamedValue(env, {
            name: expr.traitName,
            value,
          });
          return { ...value, env };
        } else {
          // Check if the trait instance with the same typeArguments already exists
          const traitInstance = env.find(
            ({ name, value }) =>
              name === expr.traitName &&
              value.type.type === "Trait" &&
              value.trait?.typeArguments &&
              value.trait.typeArguments.length === traitTypeArguments.length &&
              value.trait.typeArguments.every((typeArgument, i) => {
                return (
                  JSON.stringify(typeArgument.type) ===
                  JSON.stringify(traitTypeArguments[i].type)
                );
              })
          );
          console.log("- traitInstance: ", !!traitInstance);
          console.log("- env: ", env);
          if (traitInstance) {
            return { ...traitInstance.value, env };
          } else {
            // Check if the trait functions have default implementations
            // if yes, then we generate the function
            const functions: {
              name: string;
              type: TFunction;
              value: llvm.Function;
              functionExpr: FunctionExpr;
            }[] = [];
            for (let i = 0; i < expr.typeValue.functions.length; i++) {
              const { functionExpr } = expr.typeValue.functions[i];
              if (functionExpr) {
                const retVal = this.codegenFunction(functionExpr, env);
                const theFunction = retVal.function?.value;
                if (!retVal || !theFunction) {
                  throw new Error(`Function not found`);
                }
                functions.push({
                  name: functionExpr.prototype.functionName!,
                  type: functionExpr.typeValue,
                  value: theFunction,
                  functionExpr,
                });
              }
            }

            const value: LlvmValue = {
              type: expr.typeValue,
              value: this.unit,

              traitExpr: expr,
              trait: {
                typeArguments: traitTypeArguments,
                functions,
              },
            };
            env = addLlvmEnvironmentNamedValue(env, {
              name: expr.traitName,
              value,
            });
            console.log("- env2: ", env);
            return { ...value, env };
          }
        }
      }
      default:
        throw new Error(`Unknown expression type:\n
  ${exprToString(expr)}`);
    }
  }

  getLlvmIr(): string {
    this.externMalloc();
    this.codegenExprs(this.ast, []);

    if (llvm.verifyModule(this.module)) {
      throw new Error("Verifying module failed");
    } else {
      return this.module.print();
    }
  }
}
