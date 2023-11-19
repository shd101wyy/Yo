; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

define i32 @main() {
entry:
  %0 = call float @copy(float 0x400B333340000000)
  %1 = call i32 @copy.1(i32 3)
  %2 = call i32 @copy.1(i32 66)
  ret i32 %2
}

define float @copy(float %x) {
entry:
  ret float %x
}

define i32 @copy.1(i32 %x) {
entry:
  ret i32 %x
}
