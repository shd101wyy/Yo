; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

declare i32 @println({ i8*, i32, i32 }*)

define float @add(float %x, float %y) {
entry:
  %0 = fadd float %x, %y
  ret float %0
}

define i32 @add_1(i32 %x, i32 %y) {
entry:
  %0 = add i32 %x, %y
  ret i32 %0
}

define i32 @main() {
entry:
  %0 = call float @add(float 0x3FF19999A0000000, float 0x40019999A0000000)
  %1 = call i32 @add_1(i32 1, i32 3)
  ret i32 %1
}
