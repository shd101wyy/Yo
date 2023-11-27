; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

define i32 @main() {
entry:
  %0 = call i32 @id(i32 3)
  %1 = call i32 @id.1(i32 4)
  %2 = add i32 %0, %1
  ret i32 %2
}

define i32 @id(i32 %x) {
entry:
  ret i32 %x
}

define i32 @id.1(i32 %x) {
entry:
  ret i32 %x
}
