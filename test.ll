; ModuleID = 'main'
source_filename = "main"

declare i32 @add(i32, i32)

define i32 @main() {
entry:
  %0 = call i32 @add(i32 3, i32 4)
  ret i32 %0
}
