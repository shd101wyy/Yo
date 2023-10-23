; ModuleID = 'demo'
source_filename = "demo"

@0 = private unnamed_addr constant [4 x i8] c"%d\0A\00", align 1

define i32 @add(i32 %0, i32 %1) {
entry:
  %2 = add i32 %0, %1
  %3 = call i32 (i8*, ...) @printf(i8* getelementptr inbounds ([4 x i8], [4 x i8]* @0, i32 0, i32 0), i32 %2)
  ret i32 %2
}

declare i32 @printf(i8*, ...)

define i32 @main() {
entry:
  %0 = call i32 @add(i32 1, i32 2)
  ret i32 %0
}

