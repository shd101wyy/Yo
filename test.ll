; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

define i32 @max(i32 %x, i32 %y) {
entry:
  %0 = icmp slt i32 %y, %x
  br i1 %0, label %then, label %else

then:                                             ; preds = %entry
  br label %ifcont

else:                                             ; preds = %entry
  br label %ifcont

ifcont:                                           ; preds = %else, %then
  %iftmp = phi i32 [ %x, %then ], [ %y, %else ]
  ret i32 %iftmp
}

define i32 @main() {
entry:
  %0 = call i32 @max(i32 3, i32 4)
  ret i32 %0
}
