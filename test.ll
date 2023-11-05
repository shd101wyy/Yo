; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

declare i32 @printlnd(i32)

define i32 @main() {
entry:
  %0 = alloca [10 x i32], align 4
  %index = getelementptr [10 x i32], [10 x i32]* %0, i32 0, i32 0
  store i32 1, i32* %index, align 4
  %index1 = getelementptr [10 x i32], [10 x i32]* %0, i32 0, i32 1
  store i32 2, i32* %index1, align 4
  %index2 = getelementptr [10 x i32], [10 x i32]* %0, i32 0, i32 0
  %valueAtIndex = load i32, i32* %index2, align 4
  ret i32 %valueAtIndex
}
