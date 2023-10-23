import llvm from "llvm-bindings";

function main() {
  const context = new llvm.LLVMContext();
  const module = new llvm.Module("demo", context);
  const builder = new llvm.IRBuilder(context);

  const returnType = builder.getInt32Ty();
  const paramTypes = [builder.getInt32Ty(), builder.getInt32Ty()];
  const functionType = llvm.FunctionType.get(returnType, paramTypes, false);
  const func = llvm.Function.Create(
    functionType,
    llvm.Function.LinkageTypes.ExternalLinkage,
    "add",
    module,
  );

  const entryBB = llvm.BasicBlock.Create(context, "entry", func);
  builder.SetInsertPoint(entryBB);
  const a = func.getArg(0);
  const b = func.getArg(1);
  const result = builder.CreateAdd(a, b);

  // Print the result
  const printfType = llvm.FunctionType.get(
    builder.getInt32Ty(),
    [builder.getInt8PtrTy()],
    true,
  );
  const printfFunc = llvm.Function.Create(
    printfType,
    llvm.Function.LinkageTypes.ExternalLinkage,
    "printf",
    module,
  );
  const formatStr = builder.CreateGlobalStringPtr("%d\n");
  builder.CreateCall(printfFunc, [formatStr, result]);

  builder.CreateRet(result);

  // Call the function add(1, 2)
  const mainFuncType = llvm.FunctionType.get(builder.getInt32Ty(), [], false);
  const mainFunc = llvm.Function.Create(
    mainFuncType,
    llvm.Function.LinkageTypes.ExternalLinkage,
    "main",
    module,
  );
  const mainEntryBB = llvm.BasicBlock.Create(context, "entry", mainFunc);
  builder.SetInsertPoint(mainEntryBB);
  // Below don't work
  // const one = llvm.ConstantInt.get(context, 1);
  // const two = llvm.ConstantInt.get(context, 2);
  const one = llvm.ConstantInt.get(llvm.IntegerType.get(context, 32), 1, false);
  const two = llvm.ConstantInt.get(llvm.IntegerType.get(context, 32), 2, false);
  const args = [one, two];
  const call = builder.CreateCall(func, args);
  builder.CreateRet(call);

  if (llvm.verifyFunction(func)) {
    console.error("Verifying function failed");
    return;
  }
  if (llvm.verifyModule(module)) {
    console.error("Verifying module failed");
    return;
  }
  console.log(module.print());
}

main();
