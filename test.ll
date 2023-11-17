; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

define i32 @add(i32 %x) {
entry:
  ret i32 %x
}

define i32 @main() {
entry:
  %0 = call i32 @add(i32 3)
  ret i32 %0
}
