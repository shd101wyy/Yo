; ModuleID = 'main'
source_filename = "main"

define i32 @add(i32 %x, i32 %y) {
entry:
  %0 = add i32 %x, %y
  ret i32 %0
}

define i32 @main() {
entry:
  %0 = call i32 @add(i32 3, i32 4)
  ret i32 %0
}
