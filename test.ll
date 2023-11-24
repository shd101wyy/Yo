; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

define i32 @main() {
entry:
  %0 = call i32 @test(i32 15)
  ret i32 %0
}

define i32 @test(i32 %x) {
entry:
  %0 = call i32 @id(i32 %x)
  ret i32 %0
}

define i32 @id(i32 %x) {
entry:
  ret i32 %x
}
