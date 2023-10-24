import llvm, { LLVMContext } from "llvm-bindings";
import { AstType, Expr, TypeValueExpr } from "./ast";
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
      case "i32": {
        return this.builder.getInt32Ty();
      }
      default:
        throw new Error(`Unknown type: ${JSON.stringify(typeExpr)}`);
    }
  }

  private codegenExpr(
    expr: Expr,
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
          const functionName = expr.functionName;
          const returnType = this.getTypeValue(expr.returnType);
          const paramTypes = expr.functionParameters.map((param) => {
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
          // Record the function parameters in the namedValues map
          const newNamedValues: { [key: string]: llvm.Value } = {
            ...namedValues,
          };
          for (let i = 0; i < func.arg_size(); i++) {
            const arg = func.getArg(i);
            const paramName = expr.functionParameters[i].parameterName;
            arg.setName(paramName);
            newNamedValues[paramName] = arg;
          }

          const entryBB = llvm.BasicBlock.Create(this.context, "entry", func);
          this.builder.SetInsertPoint(entryBB);

          const returnVal = this.codegenExpr(expr.body, newNamedValues);
          this.builder.CreateRet(returnVal);

          // verify the function
          if (llvm.verifyFunction(func)) {
            throw new Error(`Function ${functionName} verification failed`);
          }

          return func;
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
