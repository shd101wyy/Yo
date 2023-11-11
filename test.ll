; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

define i32 @test() {
entry:
  %malloc = call i8* @malloc(i32 4)
  %malloc1 = bitcast i8* %malloc to { i32 }*
  %v = getelementptr { i32 }, { i32 }* %malloc1, i32 0, i32 0
  store i32 1, i32* %v, align 4
  %v2 = getelementptr { i32 }, { i32 }* %malloc1, i32 0, i32 0
  %v3 = load i32, i32* %v2, align 4
  %0 = add i32 %v3, 2
  ret i32 %0
}

define i32 @main() {
entry:
  %0 = call i32 @test()
  ret i32 %0
}
