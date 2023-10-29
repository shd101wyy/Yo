; ModuleID = 'main'
source_filename = "main"

define i32 @maxFloat(i32 %x, i32 %y) {
entry:
  %0 = icmp sgt i32 %x, %y
  br i1 %0, label %then, label %else

then:                                             ; preds = %entry
  %1 = add i32 %x, 1
  %2 = sub i32 %1, 1
  br label %ifcont

else:                                             ; preds = %entry
  %3 = add i32 %y, 1
  %4 = sub i32 %3, 1
  br label %ifcont

ifcont:                                           ; preds = %else, %then
  %iftmp = phi i32 [ %2, %then ], [ %4, %else ]
  ret i32 %iftmp
}

define i32 @main() {
entry:
  ret i32 0
}
