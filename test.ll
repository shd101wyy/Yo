; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

define { i32 }* @test() {
entry:
  %0 = alloca { i32 }, align 8
  %x = getelementptr { i32 }, { i32 }* %0, i32 0, i32 0
  store i32 12, i32* %x, align 4
  ret { i32 }* %0
}

define i32 @lambda(i32 %x) {
entry:
  ret i32 %x
}

define i32 @main() {
entry:
  %0 = call { i32 }* @test()
  %x = getelementptr { i32 }, { i32 }* %0, i32 0, i32 0
  %x1 = load i32, i32* %x, align 4
  %1 = call i32 @lambda(i32 %x1)
  ret i32 %1
}
