; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

declare i32 @printlnd(i32)

define i32 @add(i32 %self, i32 %y, i32 %z) {
entry:
  %0 = add i32 %self, %y
  %1 = add i32 %0, %z
  ret i32 %1
}

define {} @main() {
entry:
  %0 = call i32 @add(i32 7, i32 4, i32 7)
  %1 = call i32 @printlnd(i32 %0)
  %2 = call i32 @add(i32 3, i32 4, i32 7)
  %3 = call i32 @printlnd(i32 %2)
  ret {} zeroinitializer
}
