import llvm, { LLVMContext } from "llvm-bindings";
import { AstType, Expr, FunctionPrototype, OperatorType } from "./ast";
import { ValueType } from "./env";
import { tokenize } from "./lexer";
import Parser from "./parser";
import { Token } from "./token";
import { TFunction, Type, typeToString } from "./type-checker";

type NamedValue = {
  value: llvm.Value;
  type: Type;
};
type NamedValues = { [key: string]: NamedValue };

export class CodeGenerator {
  private inputString: string;
  private tokens: Token[];
  private ast: Expr;

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

    console.log("\n= ast: ", JSON.stringify(this.ast, null, 2));

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
    const functionId = prototype.typeValue.id;
    const functionType = this.getLlvmFunctionType(prototype.typeValue);
    const func = llvm.Function.Create(
      functionType,
      llvm.Function.LinkageTypes.ExternalLinkage,
      functionId,
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
    exprValue: llvm.Value,
    typeValue: Type,
    accessors: string[]
  ): NamedValue {
    if (accessors.length === 0) {
      return { value: exprValue, type: typeValue };
    }

    switch (typeValue.type) {
      case "Record": {
        const accessor = accessors[0];
        const propertyTypes = typeValue.properties ?? [];
        const propertyTypeIndex = propertyTypes.findIndex(
          (property) => property.name === accessor
        );
        if (propertyTypeIndex === -1) {
          throw new Error(
            `Property ${accessor} not found in ${JSON.stringify(typeValue)}`
          );
        }
        const propertyType = propertyTypes[propertyTypeIndex].type;
        const exprType = this.getLlvmType(typeValue);
        const exprPtrType = exprType.getPointerElementType();
        const propertyPtr = this.builder.CreateGEP(
          exprPtrType,
          exprValue,
          [
            llvm.ConstantInt.get(llvm.IntegerType.get(this.context, 32), 0),
            llvm.ConstantInt.get(
              llvm.IntegerType.get(this.context, 32),
              propertyTypeIndex
            ),
          ],
          accessor
        );
        const value: llvm.Value = this.builder.CreateLoad(
          this.getLlvmType(propertyType),
          propertyPtr,
          accessor
        );
        return this.codegenForPropertyAccess(
          value,
          propertyType,
          accessors.slice(1)
        );
      }
      default:
        throw new Error(
          `Accessors not implemented for ${typeToString(typeValue)}`
        );
    }
  }

  private codegenExpr(
    expr: Expr | FunctionPrototype,
    namedValues: NamedValues
  ): NamedValue {
    if (expr instanceof Array) {
      // Create undefined value
      let namedValue: NamedValue = {
        value: this.unit, //llvm.UndefValue.get(llvm.PointerType.getVoidTy(this.context)),
        type: { type: "()" },
      };
      const exprs = expr;
      for (let i = 0; i < exprs.length; i++) {
        const expr = exprs[i];
        if (expr instanceof Array) {
          namedValue = this.codegenExpr(expr, namedValues);
        } else {
          if (expr.type === AstType.TypeAlias) {
            continue;
          }

          namedValue = this.codegenExpr(expr, namedValues);
        }
      }
      return namedValue;
    } else {
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
                  };
                case "char":
                  return {
                    value: llvm.ConstantInt.get(
                      llvm.IntegerType.get(this.context, 8),
                      typeValue.value.charCodeAt(0),
                      false // isSigned
                    ),
                    type: typeValue,
                  };
                case "u1":
                  return {
                    value: llvm.ConstantInt.get(
                      llvm.IntegerType.get(this.context, 1),
                      parseInt(typeValue.value),
                      false // isSigned
                    ),
                    type: typeValue,
                  };
                case "i1":
                  return {
                    value: llvm.ConstantInt.get(
                      llvm.IntegerType.get(this.context, 1),
                      parseInt(typeValue.value),
                      true // isSigned
                    ),
                    type: typeValue,
                  };
                case "u8":
                  return {
                    value: llvm.ConstantInt.get(
                      llvm.IntegerType.get(this.context, 8),
                      parseInt(typeValue.value),
                      false // isSigned
                    ),
                    type: typeValue,
                  };
                case "i8":
                  return {
                    value: llvm.ConstantInt.get(
                      llvm.IntegerType.get(this.context, 8),
                      parseInt(typeValue.value),
                      true // isSigned
                    ),
                    type: typeValue,
                  };
                case "u16":
                  return {
                    value: llvm.ConstantInt.get(
                      llvm.IntegerType.get(this.context, 16),
                      parseInt(typeValue.value),
                      false // isSigned
                    ),
                    type: typeValue,
                  };
                case "i16":
                  return {
                    value: llvm.ConstantInt.get(
                      llvm.IntegerType.get(this.context, 16),
                      parseInt(typeValue.value),
                      true // isSigned
                    ),
                    type: typeValue,
                  };
                case "u32":
                  return {
                    value: llvm.ConstantInt.get(
                      llvm.IntegerType.get(this.context, 32),
                      parseInt(typeValue.value),
                      false // isSigned
                    ),
                    type: typeValue,
                  };
                case "i32":
                  return {
                    value: llvm.ConstantInt.get(
                      llvm.IntegerType.get(this.context, 32),
                      parseInt(typeValue.value),
                      true // isSigned
                    ),
                    type: typeValue,
                  };
                case "u64":
                  return {
                    value: llvm.ConstantInt.get(
                      llvm.IntegerType.get(this.context, 64),
                      parseInt(typeValue.value),
                      false // isSigned
                    ),
                    type: typeValue,
                  };
                case "i64":
                  return {
                    value: llvm.ConstantInt.get(
                      llvm.IntegerType.get(this.context, 64),
                      parseInt(typeValue.value),
                      true // isSigned
                    ),
                    type: typeValue,
                  };
                case "u128":
                  return {
                    value: llvm.ConstantInt.get(
                      llvm.IntegerType.get(this.context, 128),
                      parseInt(typeValue.value),
                      false // isSigned
                    ),
                    type: typeValue,
                  };
                case "i128":
                  return {
                    value: llvm.ConstantInt.get(
                      llvm.IntegerType.get(this.context, 128),
                      parseInt(typeValue.value),
                      true // isSigned
                    ),
                    type: typeValue,
                  };
                case "f16":
                case "f32": {
                  return {
                    value: llvm.ConstantFP.get(
                      llvm.Type.getFloatTy(this.context),
                      parseFloat(typeValue.value)
                    ),
                    type: typeValue,
                  };
                }
                case "f64": {
                  return {
                    value: llvm.ConstantFP.get(
                      llvm.Type.getDoubleTy(this.context),
                      parseFloat(typeValue.value)
                    ),
                    type: typeValue,
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
                  };
                }
                case "()":
                  return {
                    value: this.unit,
                    type: typeValue,
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
                const propertyValue = this.codegenExpr(
                  property.value,
                  namedValues
                );

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
                const value = this.codegenExpr(sliceValue, namedValues);

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
              return { value: slicePtr, type: typeValue };
            }
            default: {
              throw new Error(`Unknown value tag: ${expr}`);
            }
          }
        }
        case AstType.BinaryOperator: {
          const typeValue = expr.typeValue;
          const lhs = this.codegenExpr(expr.left, namedValues);
          const rhs = this.codegenExpr(expr.right, namedValues);

          // TODO: Better logic
          if (
            !Array.isArray(expr.left) &&
            !Array.isArray(expr.right) &&
            expr.left.typeValue.type === "symbol" &&
            expr.right.typeValue.type === "symbol"
          ) {
            if (expr.operator === OperatorType.Equal) {
              return {
                value: this.builder.CreateICmpEQ(lhs.value, rhs.value),
                type: { type: "boolean" },
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
                };
              } else {
                return {
                  value: this.builder.CreateAdd(lhs.value, rhs.value),
                  type: typeValue,
                };
              }
            case "-":
              if (binopType === "double") {
                return {
                  value: this.builder.CreateFSub(lhs.value, rhs.value),
                  type: typeValue,
                };
              } else {
                return {
                  value: this.builder.CreateSub(lhs.value, rhs.value),
                  type: typeValue,
                };
              }
            case "*":
              if (binopType === "double") {
                return {
                  value: this.builder.CreateFMul(lhs.value, rhs.value),
                  type: typeValue,
                };
              } else {
                return {
                  value: this.builder.CreateMul(lhs.value, rhs.value),
                  type: typeValue,
                };
              }
            case "/":
              if (binopType === "double") {
                return {
                  value: this.builder.CreateFDiv(lhs.value, rhs.value),
                  type: typeValue,
                };
              } else {
                return {
                  value: this.builder.CreateSDiv(lhs.value, rhs.value),
                  type: typeValue,
                };
              }
            case "%":
              if (binopType === "double") {
                return {
                  value: this.builder.CreateFRem(lhs.value, rhs.value),
                  type: typeValue,
                };
              } else {
                return {
                  value: this.builder.CreateSRem(lhs.value, rhs.value),
                  type: typeValue,
                };
              }
            case "==":
              if (binopType === "double") {
                return {
                  value: this.builder.CreateFCmpOEQ(lhs.value, rhs.value),
                  type: typeValue,
                };
              } else {
                return {
                  value: this.builder.CreateICmpEQ(lhs.value, rhs.value),
                  type: typeValue,
                };
              }
            case "!=":
              if (binopType === "double") {
                return {
                  value: this.builder.CreateFCmpONE(lhs.value, rhs.value),
                  type: typeValue,
                };
              } else {
                return {
                  value: this.builder.CreateICmpNE(lhs.value, rhs.value),
                  type: typeValue,
                };
              }
            case "<":
              if (binopType === "double") {
                return {
                  value: this.builder.CreateFCmpOLT(lhs.value, rhs.value),
                  type: typeValue,
                };
              } else {
                return {
                  value: this.builder.CreateICmpSLT(lhs.value, rhs.value),
                  type: typeValue,
                };
              }
            case "<=":
              if (binopType === "double") {
                return {
                  value: this.builder.CreateFCmpOLE(lhs.value, rhs.value),
                  type: typeValue,
                };
              } else {
                return {
                  value: this.builder.CreateICmpSLE(lhs.value, rhs.value),
                  type: typeValue,
                };
              }
            default:
              throw new Error(`Unknown binary operator: ${expr.operator}`);
          }
        }
        case AstType.Function: {
          let theFunction = this.module.getFunction(
            expr.prototype.typeValue.id
          );
          if (!theFunction) {
            theFunction = this.codegenPrototype(expr.prototype);
          }
          if (!theFunction) {
            throw new Error(
              `Function ${expr.prototype.functionName} with id "${expr.prototype.typeValue.id}" not found`
            );
          }

          const currentBasicBlock = this.builder.GetInsertBlock();
          const entryBB = llvm.BasicBlock.Create(
            this.context,
            "entry",
            theFunction
          );
          this.builder.SetInsertPoint(entryBB);

          // Record the function parameters in the namedValues map
          const newNamedValues: NamedValues = {
            ...namedValues,
          };
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
                    llvm.ConstantInt.get(
                      llvm.IntegerType.get(this.context, 32),
                      0
                    ),
                    llvm.ConstantInt.get(
                      llvm.IntegerType.get(this.context, 32),
                      i
                    ),
                  ],
                  freeVariableName
                );
                // Load the value from the free variable
                const freeVariableValue = this.builder.CreateLoad(
                  this.getLlvmType(freeVariable.type),
                  freeVariablePtr,
                  freeVariableName
                );
                newNamedValues[freeVariableName] = {
                  type: freeVariable.type,
                  value: freeVariableValue,
                };
              }
            } else {
              const parameterType = expr.prototype.typeValue.parameterTypes[i];
              const parameterName = parameterType.name;
              newNamedValues[parameterName] = {
                type: parameterType.type,
                value: arg,
              };
            }
          }

          // Save the function itself to the namedValues map
          if (expr.prototype.functionName) {
            const closure: NamedValue = {
              value: this.unit,
              type: expr.typeValue,
            };
            namedValues[expr.prototype.functionName] = closure;
            newNamedValues[expr.prototype.functionName] = closure;
          }

          // Codegen the body
          const returnVal = this.codegenExpr(expr.body, newNamedValues);
          // Move back to the entry block
          this.builder.CreateRet(returnVal.value);

          if (currentBasicBlock) {
            this.builder.SetInsertPoint(currentBasicBlock);
          }

          // verify the function
          if (llvm.verifyFunction(theFunction)) {
            throw new Error(
              `Function ${expr.prototype.functionName} verification failed`
            );
          } else {
            console.log(
              `- Function verified for "${expr.prototype.functionName}" with id "${expr.prototype.typeValue.id}"`
            );
          }

          // Return the function pointer + free variables record
          const freeVariables = expr.prototype.typeValue.freeVariables;
          if (!freeVariables) {
            // NOTE: This is not a closure
            // in theory, this return is not used anywhere
            const closure: NamedValue = {
              value: this.unit,
              type: expr.typeValue,
            };
            return closure;
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
          const freeVariablesType =
            this.getFreeVariablesRecordType(freeVariables);
          const freeVariablesPtrType = llvm.PointerType.get(
            freeVariablesType,
            0
          );
          const freeVariablesPtr = this.allocateMemoryOnHeap(
            freeVariablesPtrType,
            this.dataLayout.getTypeAllocSize(freeVariablesType)
          );
          for (let i = 0; i < freeVariables.length; i++) {
            const freeVariable = freeVariables[i];
            const freeVariableName = freeVariable.variableName;
            const freeVariableValue = namedValues[freeVariableName];
            if (!freeVariableValue) {
              throw new Error(
                `Free variable ${freeVariableName} not found in namedValues`
              );
            }

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
            this.builder.CreateStore(freeVariableValue.value, freeVariablePtr);
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
          this.builder.CreateStore(
            freeVariablesPtrCast,
            freeVariablesRecordPtr
          );

          return { value: closurePtr, type: expr.typeValue };
        }
        case AstType.Extern: {
          const theFunction = this.codegenPrototype(expr.prototype);
          if (!theFunction || !expr.prototype.functionName) {
            throw new Error(
              `Function ${expr.prototype.functionName} not found`
            );
          }
          const closure: NamedValue = {
            value: this.unit,
            type: expr.typeValue,
          };
          namedValues[expr.prototype.functionName] = closure;
          return closure;
          // return theFunction;
        }
        case AstType.Variable: {
          // TODO: Check if it's a function
          const namedValue = namedValues[expr.name];
          if (!namedValue) {
            throw new Error(`Variable ${expr.name} not found`);
          }
          return namedValue;
        }
        case AstType.CallFunction: {
          const callee = expr.callee;

          // NOTE: Function argument types check is done in the parser.ts stage.
          const args: llvm.Value[] = expr.functionArguments.map((arg) => {
            return this.codegenExpr(arg, namedValues).value;
          });

          const namedValue = this.codegenExpr(callee, namedValues);
          const functionType = namedValue?.type;
          if (functionType.type !== "Function") {
            throw new Error(
              `Function ${JSON.stringify(callee)} not found in namedValues`
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

          let func: llvm.Function | llvm.FunctionCallee | null = null;
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
            };
          } else {
            func = this.module.getFunction(functionType.id);
            if (!func) {
              throw new Error(
                `Function with id "${functionType.id}" not found`
              );
            }
            return {
              value: this.builder.CreateCall(func, args),
              type: expr.typeValue,
            };
          }
        }
        case AstType.If: {
          const conditionValue = this.codegenExpr(expr.condition, namedValues);

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
          const thenValue = this.codegenExpr(expr.then, namedValues);
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

            const elseValue = this.codegenExpr(expr.else, namedValues);
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
              return { value: phiNode, type: expr.typeValue };
            }
          }
        }
        case AstType.ConstantAssigment: {
          if (Array.isArray(expr.right)) {
            throw new Error(`Cannot assign array of expressions`);
          }
          const value = this.codegenExpr(expr.right, namedValues);
          namedValues[expr.variableName] = value;
          return value;
        }
        case AstType.PropertyAccess: {
          const value = this.codegenExpr(expr.expr, namedValues);
          if (Array.isArray(expr.expr)) {
            throw new Error(`Cannot access array of expressions`);
          } else {
            return this.codegenForPropertyAccess(
              value.value,
              expr.expr.typeValue,
              expr.properties
            );
          }
        }
        case AstType.IndexAccess: {
          if (Array.isArray(expr.expr)) {
            throw new Error(`Cannot access array of expressions`);
          }
          if (expr.expr.typeValue.type !== "slice") {
            throw new Error(`Index access not implemented for ${expr.expr}`);
          }

          const indexes = expr.indexes;
          if (indexes.length === 0) {
            throw new Error(`Index not found`);
          }
          const indexValues = indexes.map((index) => {
            return this.codegenExpr(index, namedValues).value;
          });

          let sliceType: Type = expr.expr.typeValue;
          let { value: sliceValue } = this.codegenExpr(expr.expr, namedValues);

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
          };
        }
        default:
          throw new Error(`Unknown expression type: ${JSON.stringify(expr)}`);
      }
    }
  }

  getLlvmIr(): string {
    this.externMalloc();
    this.codegenExpr(this.ast, {});

    if (llvm.verifyModule(this.module)) {
      throw new Error("Verifying module failed");
    } else {
      return this.module.print();
    }
  }
}
