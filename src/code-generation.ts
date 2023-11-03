import llvm, { LLVMContext } from "llvm-bindings";
import { AstType, Expr, FunctionPrototype } from "./ast";
import { tokenize } from "./lexer";
import Parser from "./parser";
import { Token } from "./token";
import { Type, typeToString } from "./type-checker";

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
      case "string": {
        /**
         * Allocate memory for string struct
         * struct String {
         *   char* data;
         *   int length;
         *   int size;
         * }
         */
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

  private codegenPrototype(prototype: FunctionPrototype): llvm.Function | null {
    const functionId = prototype.functionId;
    if (prototype.typeValue.type !== "Function") {
      throw new Error(
        `Function prototype type is not a function: ${JSON.stringify(
          prototype.typeValue
        )}`
      );
    }

    const returnType = this.getLlvmType(prototype.typeValue.returnType);
    const paramTypes = prototype.typeValue.parameterTypes.map((param) => {
      return this.getLlvmType(param.type);
    });
    const functionType = llvm.FunctionType.get(
      returnType,
      paramTypes,
      false // isVarArg
    );
    const func = llvm.Function.Create(
      functionType,
      llvm.Function.LinkageTypes.ExternalLinkage,
      functionId,
      this.module
    );
    for (let i = 0; i < func.arg_size(); i++) {
      const arg = func.getArg(i);
      const parameterNameExpr = prototype.functionParameters[i];
      if (Array.isArray(parameterNameExpr)) {
        throw new Error(`Parameter name is not a string`);
      }
      if (parameterNameExpr.type !== AstType.Variable) {
        throw new Error(`Parameter name is not a variable`);
      }
      const parameterName = parameterNameExpr.name;
      arg.setName(parameterName);
    }
    return func;
  }

  private allocateMemoryOnHeap(ptrType: llvm.Type, bytes: number): llvm.Value {
    const structType = ptrType.getPointerElementType() as llvm.StructType;
    if (!structType.isStructTy()) {
      throw new Error(`Only support allocating memory on heap for struct type`);
    }
    console.log("allocateMemoryOnHeap: ", bytes);

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

  private codegenForAccessor(
    exprValue: llvm.Value,
    typeValue: Type,
    accessors: string[]
  ): llvm.Value {
    if (accessors.length === 0) {
      return exprValue;
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
        return this.codegenForAccessor(value, propertyType, accessors.slice(1));
      }
      default:
        throw new Error(
          `Accessors not implemented for ${typeToString(typeValue)}`
        );
    }
  }

  private codegenExpr(
    expr: Expr | FunctionPrototype,
    namedValues: { [key: string]: llvm.Value }
  ): llvm.Value {
    if (expr instanceof Array) {
      // Create undefined value
      let llvmValue: llvm.Value = llvm.UndefValue.get(
        llvm.PointerType.getVoidTy(this.context)
      );
      for (let i = 0; i < expr.length; i++) {
        llvmValue = this.codegenExpr(expr[i], namedValues);
      }
      return llvmValue;
    } else {
      switch (expr.type) {
        case AstType.Value: {
          const typeValue = expr.typeValue;
          switch (typeValue.type) {
            case "boolean":
              return llvm.ConstantInt.get(
                llvm.IntegerType.get(this.context, 1),
                expr.value === "true" ? 1 : 0,
                false // isSigned
              );
            case "char":
              return llvm.ConstantInt.get(
                llvm.IntegerType.get(this.context, 8),
                expr.value.charCodeAt(0),
                false // isSigned
              );
            case "u1":
              return llvm.ConstantInt.get(
                llvm.IntegerType.get(this.context, 1),
                parseInt(expr.value),
                false // isSigned
              );
            case "i1":
              return llvm.ConstantInt.get(
                llvm.IntegerType.get(this.context, 1),
                parseInt(expr.value),
                true // isSigned
              );
            case "u8":
              return llvm.ConstantInt.get(
                llvm.IntegerType.get(this.context, 8),
                parseInt(expr.value),
                false // isSigned
              );
            case "i8":
              return llvm.ConstantInt.get(
                llvm.IntegerType.get(this.context, 8),
                parseInt(expr.value),
                true // isSigned
              );
            case "u16":
              return llvm.ConstantInt.get(
                llvm.IntegerType.get(this.context, 16),
                parseInt(expr.value),
                false // isSigned
              );
            case "i16":
              return llvm.ConstantInt.get(
                llvm.IntegerType.get(this.context, 16),
                parseInt(expr.value),
                true // isSigned
              );
            case "u32":
              return llvm.ConstantInt.get(
                llvm.IntegerType.get(this.context, 32),
                parseInt(expr.value),
                false // isSigned
              );
            case "i32":
              return llvm.ConstantInt.get(
                llvm.IntegerType.get(this.context, 32),
                parseInt(expr.value),
                true // isSigned
              );
            case "u64":
              return llvm.ConstantInt.get(
                llvm.IntegerType.get(this.context, 64),
                parseInt(expr.value),
                false // isSigned
              );
            case "i64":
              return llvm.ConstantInt.get(
                llvm.IntegerType.get(this.context, 64),
                parseInt(expr.value),
                true // isSigned
              );
            case "u128":
              return llvm.ConstantInt.get(
                llvm.IntegerType.get(this.context, 128),
                parseInt(expr.value),
                false // isSigned
              );
            case "i128":
              return llvm.ConstantInt.get(
                llvm.IntegerType.get(this.context, 128),
                parseInt(expr.value),
                true // isSigned
              );
            case "f16":
            case "f32": {
              return llvm.ConstantFP.get(
                llvm.Type.getFloatTy(this.context),
                parseFloat(expr.value)
              );
            }
            case "f64": {
              return llvm.ConstantFP.get(
                llvm.Type.getDoubleTy(this.context),
                parseFloat(expr.value)
              );
            }
            case "string": {
              const stringPtrType = this.getLlvmType(typeValue);
              const stringType = stringPtrType.getPointerElementType();
              const stringLiteral = this.builder.CreateGlobalStringPtr(
                expr.value
              );
              const stringByteSize = new Blob([expr.value]).size;

              // Allocate memory on heap
              const stringPtr = this.allocateMemoryOnHeap(
                stringPtrType,
                this.dataLayout.getTypeAllocSize(stringType)
              );

              // Allocate memory on stack
              // const stringPtr = this.builder.CreateAlloca(stringType);

              const stringDataPtr = this.builder.CreateGEP(
                stringType,
                stringPtr,
                [
                  llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 32),
                    0
                  ),
                  llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 32),
                    0
                  ),
                ],
                "data"
              );
              const stringLengthPtr = this.builder.CreateGEP(
                stringType,
                stringPtr,
                [
                  llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 32),
                    0
                  ),
                  llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 32),
                    1
                  ),
                ],
                "length"
              );
              const stringSizePtr = this.builder.CreateGEP(
                stringType,
                stringPtr,
                [
                  llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 32),
                    0
                  ),
                  llvm.ConstantInt.get(
                    llvm.IntegerType.get(this.context, 32),
                    2
                  ),
                ],
                "size"
              );
              this.builder.CreateStore(stringLiteral, stringDataPtr);
              this.builder.CreateStore(
                llvm.ConstantInt.get(
                  llvm.IntegerType.get(this.context, 32),
                  expr.value.length
                ),
                stringLengthPtr
              );
              this.builder.CreateStore(
                llvm.ConstantInt.get(
                  llvm.IntegerType.get(this.context, 32),
                  stringByteSize
                ),
                stringSizePtr
              );
              return stringPtr;
            }
            case "Record": {
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
                this.builder.CreateStore(propertyValue, propertyPtr);
              }
              return recordPtr;
            }
            case "()":
              return this.unit;
            default:
              throw new Error(
                `Unknown value type: ${JSON.stringify(typeValue)}`
              );
          }
        }
        case AstType.BinaryOperator: {
          const lhs = this.codegenExpr(expr.left, namedValues);
          const rhs = this.codegenExpr(expr.right, namedValues);
          const binopType = this.getBinOpType(lhs, rhs);
          console.log("binopType: ", binopType, expr.left, expr.right);
          switch (expr.operator) {
            case "+":
              if (binopType === "double") {
                return this.builder.CreateFAdd(lhs, rhs);
              } else {
                return this.builder.CreateAdd(lhs, rhs);
              }
            case "-":
              if (binopType === "double") {
                return this.builder.CreateFSub(lhs, rhs);
              } else {
                return this.builder.CreateSub(lhs, rhs);
              }
            case "*":
              if (binopType === "double") {
                return this.builder.CreateFMul(lhs, rhs);
              } else {
                return this.builder.CreateMul(lhs, rhs);
              }
            case "/":
              if (binopType === "double") {
                return this.builder.CreateFDiv(lhs, rhs);
              } else {
                return this.builder.CreateSDiv(lhs, rhs);
              }
            case "%":
              if (binopType === "double") {
                return this.builder.CreateFRem(lhs, rhs);
              } else {
                return this.builder.CreateSRem(lhs, rhs);
              }
            case "==":
              if (binopType === "double") {
                return this.builder.CreateFCmpOEQ(lhs, rhs);
              } else {
                return this.builder.CreateICmpEQ(lhs, rhs);
              }
            case "!=":
              if (binopType === "double") {
                return this.builder.CreateFCmpONE(lhs, rhs);
              } else {
                return this.builder.CreateICmpNE(lhs, rhs);
              }
            case "<":
              if (binopType === "double") {
                return this.builder.CreateFCmpOLT(lhs, rhs);
              } else {
                return this.builder.CreateICmpSLT(lhs, rhs);
              }
            case "<=":
              if (binopType === "double") {
                return this.builder.CreateFCmpOLE(lhs, rhs);
              } else {
                return this.builder.CreateICmpSLE(lhs, rhs);
              }
            default:
              throw new Error(`Unknown binary operator: ${expr.operator}`);
          }
        }
        case AstType.Function: {
          const functionName = expr.prototype.functionName;
          if (!functionName) {
            throw new Error(`Function name not found`);
          }

          let theFunction = this.module.getFunction(expr.prototype.functionId);
          if (!theFunction) {
            theFunction = this.codegenPrototype(expr.prototype);
          }
          if (!theFunction) {
            throw new Error(
              `Function ${expr.prototype.functionName} not found`
            );
          }

          const entryBB = llvm.BasicBlock.Create(
            this.context,
            "entry",
            theFunction
          );
          this.builder.SetInsertPoint(entryBB);

          // Record the function parameters in the namedValues map
          const newNamedValues: { [key: string]: llvm.Value } = {
            ...namedValues,
          };
          for (let i = 0; i < theFunction.arg_size(); i++) {
            const arg = theFunction.getArg(i);
            const parameterNameExpr = expr.prototype.functionParameters[i];
            if (Array.isArray(parameterNameExpr)) {
              throw new Error(`Parameter name is not a string`);
            }
            if (parameterNameExpr.type !== AstType.Variable) {
              throw new Error(`Parameter name is not a variable`);
            }
            const parameterName = parameterNameExpr.name;
            newNamedValues[parameterName] = arg;
          }

          const returnVal = this.codegenExpr(expr.body, newNamedValues);
          this.builder.CreateRet(returnVal);

          // verify the function
          if (llvm.verifyFunction(theFunction)) {
            throw new Error(
              `Function ${expr.prototype.functionName} verification failed`
            );
          }

          return theFunction;
        }
        case AstType.Extern: {
          const theFunction = this.codegenPrototype(expr.prototype);
          if (!theFunction) {
            throw new Error(
              `Function ${expr.prototype.functionName} not found`
            );
          }
          return theFunction;
        }
        case AstType.Variable: {
          const value = namedValues[expr.name];
          if (!value) {
            throw new Error(`Variable ${expr.name} not found`);
          }
          return value;
        }
        case AstType.CallFunction: {
          const functionName = expr.functionName;
          const func = this.module.getFunction(expr.functionId);
          if (!func) {
            throw new Error(`Function ${functionName} not found`);
          }

          // Check if argument mismatch
          // TODO: Verify argument types
          if (func.arg_size() !== expr.functionArguments.length) {
            throw new Error(
              `Function ${functionName} argument mismatch: expected ${func.arg_size()}, got ${
                expr.functionArguments.length
              }`
            );
          }
          const args = expr.functionArguments.map((arg) => {
            return this.codegenExpr(arg, namedValues);
          });
          const call = this.builder.CreateCall(func, args);
          return call;
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

          this.builder.CreateCondBr(conditionValue, thenBB, elseBB);

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
              phiNode.addIncoming(thenValue, thenBB);
              phiNode.addIncoming(elseValue, elseBB);
              return phiNode;
            }
          }
        }
        case AstType.ConstantAssigment: {
          const value = this.codegenExpr(expr.right, namedValues);
          namedValues[expr.variableName] = value;
          return value;
        }
        case AstType.Accessors: {
          const value = this.codegenExpr(expr.expr, namedValues);
          if (Array.isArray(expr.expr)) {
            throw new Error(`Cannot access array of expressions`);
          } else {
            switch (expr.expr.type) {
              /*
              case AstType.Variable: {
                const value = namedValues[expr.expr.name];
                if (!value) {
                  throw new Error(`Variable ${expr.expr.name} not found`);
                } else {
                  return this.codegenForAccessor(
                    value,
                    expr.expr.,
                    expr.accessors
                  );
                }
              }
              */
              case AstType.Value: {
                return this.codegenForAccessor(
                  value,
                  expr.expr.typeValue,
                  expr.accessors
                );
              }
              default: {
                throw new Error(
                  `Accessors not implemented for ${expr.expr.type}`
                );
              }
            }
          }
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
