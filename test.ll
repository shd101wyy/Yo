; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

define i32 @add(i32 %x, i32 %y, i32 %z) {
entry:
  %0 = add i32 %x, %y
  %1 = add i32 %0, %z
  ret i32 %1
}

define i32 @main() {
entry:
  %0 = call i32 @add(i32 1, i32 3, i32 5)
  ret i32 %0
}
