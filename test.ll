; ModuleID = 'main'
source_filename = "main"

define i32 @add(i32 %x, i32 %y) {
entry:
  %0 = add i32 %x, %y
  %1 = add i32 %0, 13
  %2 = add i32 %1, 3
  ret i32 %2
}
