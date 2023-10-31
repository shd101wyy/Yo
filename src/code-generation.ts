import llvm, { LLVMContext } from "llvm-bindings";
import { AstType, Expr, FunctionPrototype } from "./ast";
import { tokenize } from "./lexer";
import Parser from "./parser";
import { Token } from "./token";
import { Type } from "./type-checker";

export class CodeGenerator {
  private inputString: string;
  private tokens: Token[];
  private ast: Expr;

  private context: LLVMContext;
  private module: llvm.Module;
  private builder: llvm.IRBuilder;

  constructor(inputString: string) {
    this.inputString = inputString;
    this.tokens = tokenize(this.inputString);
    console.log(`tokens: `, this.tokens);

    const parser = new Parser(inputString);
    this.ast = parser.parse(this.tokens);

    console.log("\nast: ", JSON.stringify(this.ast, null, 2));

    this.context = new llvm.LLVMContext();
    this.module = new llvm.Module("main", this.context);
    this.builder = new llvm.IRBuilder(this.context);
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
      case "Record": {
        const properties = typeExpr.properties ?? [];
        const propertyTypes = properties.map((property) => {
          return this.getLlvmType(property.type);
        });
        return llvm.StructType.get(this.context, propertyTypes);
      }
      default:
        throw new Error(`Unknown type: ${JSON.stringify(typeExpr)}`);
    }
  }

  private getBinOpType(left: llvm.Value, right: llvm.Value): "long" | "double" {
    // TODO: check more types
    if (
      left.getType() instanceof llvm.APFloat ||
      right.getType() instanceof llvm.APFloat
    ) {
      return "double";
    } else {
      return "long";
    }
  }

  private codegenPrototype(prototype: FunctionPrototype): llvm.Function | null {
    const functionName = prototype.functionName;
    if (prototype.typeValue.type !== "function") {
      throw new Error(
        `Function prototype type is not a function: ${JSON.stringify(
          prototype.typeValue
        )}`
      );
    }

    const returnType = this.getLlvmType(prototype.typeValue.returnType);
    const paramTypes = prototype.typeValue.parameters.map((param) => {
      return this.getLlvmType(param);
    });
    const functionType = llvm.FunctionType.get(
      returnType,
      paramTypes,
      false // isVarArg
    );
    const func = llvm.Function.Create(
      functionType,
      llvm.Function.LinkageTypes.ExternalLinkage,
      functionName,
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
            case "string":
              return llvm.ConstantDataArray.getString(this.context, expr.value);
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
            case "f32":
            case "f64":
              return llvm.ConstantFP.get(
                llvm.Type.getFloatTy(this.context),
                parseFloat(expr.value)
              );
            case "Record": {
              // Allocate memory for the record
              const recordType = this.getLlvmType(typeValue);
              const recordPtr = this.builder.CreateAlloca(recordType);
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
          let theFunction = this.module.getFunction(
            expr.prototype.functionName
          );
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
          const func = this.module.getFunction(functionName);
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
        default:
          throw new Error(`Unknown expression type: ${JSON.stringify(expr)}`);
      }
    }
  }

  getLlvmIr(): string {
    this.codegenExpr(this.ast, {});

    if (llvm.verifyModule(this.module)) {
      throw new Error("Verifying module failed");
    } else {
      return this.module.print();
    }
  }
}
