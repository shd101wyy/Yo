; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

declare i32 @printlnd(i32)

define i32 @main() {
entry:
  br i1 false, label %then, label %else

then:                                             ; preds = %entry
  br label %ifcont

else:                                             ; preds = %entry
  br label %ifcont

ifcont:                                           ; preds = %else, %then
  %iftmp = phi i32 [ 12, %then ], [ 22, %else ]
  %0 = call i32 @printlnd(i32 %iftmp)
  ret i32 %0
}
