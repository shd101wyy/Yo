; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

define i32 @main() {
entry:
  %0 = call float @id(float 0x40099999A0000000)
  %1 = call i32 @id.1(i32 3)
  %2 = call i32 @id.1(i32 4)
  %3 = add i32 %1, %2
  ret i32 %3
}

define float @id(float %x) {
entry:
  ret float %x
}

define i32 @id.1(i32 %x) {
entry:
  ret i32 %x
}
