import llvm, { LLVMContext } from "llvm-bindings";
import { AstType, Expr, FunctionPrototype, TypeValueExpr } from "./ast";
import { tokenize } from "./lexer";
import { parse } from "./parser";
import { Token } from "./token";

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

    this.ast = parse(this.tokens);
    console.log("\nast: ", JSON.stringify(this.ast, null, 2));

    this.context = new llvm.LLVMContext();
    this.module = new llvm.Module("main", this.context);
    this.builder = new llvm.IRBuilder(this.context);

    this.codegenExpr(this.ast, {});
  }

  private getTypeValue(typeExpr: TypeValueExpr): llvm.Type {
    switch (typeExpr.value) {
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
      default:
        throw new Error(`Unknown type: ${JSON.stringify(typeExpr)}`);
    }
  }

  private codegenPrototype(prototype: FunctionPrototype): llvm.Function | null {
    const functionName = prototype.functionName;
    const returnType = this.getTypeValue(prototype.returnType);
    const paramTypes = prototype.functionParameters.map((param) => {
      return this.getTypeValue(param.parameterType);
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
      const paramName = prototype.functionParameters[i].parameterName;
      arg.setName(paramName);
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
        case AstType.Integer: {
          return llvm.ConstantInt.get(
            llvm.IntegerType.get(this.context, 32),
            parseInt(expr.value),
            true // isSigned
          );
        }
        case AstType.Float: {
          return llvm.ConstantFP.get(
            llvm.Type.getFloatTy(this.context),
            parseFloat(expr.value)
          );
        }
        case AstType.BinaryOperator: {
          const lhs = this.codegenExpr(expr.left, namedValues);
          const rhs = this.codegenExpr(expr.right, namedValues);
          switch (expr.operator) {
            case "+":
              return this.builder.CreateAdd(lhs, rhs);
            case "-":
              return this.builder.CreateSub(lhs, rhs);
            case "*":
              return this.builder.CreateMul(lhs, rhs);
            case "/":
              return this.builder.CreateSDiv(lhs, rhs);
            case "%":
              return this.builder.CreateSRem(lhs, rhs);
            case "==":
              return this.builder.CreateICmpEQ(lhs, rhs);
            case "!=":
              return this.builder.CreateICmpNE(lhs, rhs);
            case "<":
              return this.builder.CreateICmpSLT(lhs, rhs);
            case "<=":
              return this.builder.CreateICmpSLE(lhs, rhs);
            case ">":
              return this.builder.CreateICmpSGT(lhs, rhs);
            case ">=":
              return this.builder.CreateICmpSGE(lhs, rhs);
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
            newNamedValues[arg.getName()] = arg;
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
          console.log("Enter here", args.length);
          const call = this.builder.CreateCall(func, args);
          console.log("Enter here 2");
          return call;
        }
        default:
          throw new Error(`Unknown expression type: ${JSON.stringify(expr)}`);
      }
    }
  }

  getLlvmIr(): string {
    if (llvm.verifyModule(this.module)) {
      throw new Error("Verifying module failed");
    } else {
      return this.module.print();
    }
  }
}
