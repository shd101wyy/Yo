; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

@string = private unnamed_addr constant [4 x i8] c"Red\00", align 1
@string.1 = private unnamed_addr constant [6 x i8] c"Green\00", align 1

declare i8* @malloc(i32)

declare i32 @printlnd(i1)

define i32 @main() {
entry:
  %0 = call i32 @printlnd(i1 true)
  ret i32 0
}
