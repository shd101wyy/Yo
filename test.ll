; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

declare i32 @printlnd(i32)

define { i32 }* @test(i32 %x) {
entry:
  %malloc = call i8* @malloc(i32 4)
  %malloc1 = bitcast i8* %malloc to { i32 }*
  %x2 = getelementptr { i32 }, { i32 }* %malloc1, i32 0, i32 0
  store i32 %x, i32* %x2, align 4
  ret { i32 }* %malloc1
}

define i32 @lambda(i32 %x) {
entry:
  %0 = call i32 @printlnd(i32 %x)
  %1 = add i32 %x, 1
  ret i32 %1
}

define i32 @main() {
entry:
  %0 = call { i32 }* @test(i32 3)
  %x = getelementptr { i32 }, { i32 }* %0, i32 0, i32 0
  %x1 = load i32, i32* %x, align 4
  %1 = call i32 @lambda(i32 %x1)
  %2 = call i32 @printlnd(i32 %1)
  ret i32 0
}
