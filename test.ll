; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

define i32 @add(i32 %x, i32 %y) {
entry:
  %0 = add i32 %x, %y
  ret i32 %0
}

define i32 @addOne(i32 %x) {
entry:
  %0 = add i32 %x, 1
  ret i32 %0
}

define i32 @main() {
entry:
  %0 = call i32 @add(i32 3, i32 4)
  %1 = call i32 @addOne(i32 %0)
  ret i32 %1
}
