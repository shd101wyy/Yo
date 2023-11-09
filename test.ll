; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

declare i32 @printlnd(i32)

define i32 @factorial(i32 %x, i32 %acc) {
entry:
  %0 = icmp eq i32 %x, 0
  br i1 %0, label %then, label %else

then:                                             ; preds = %entry
  br label %ifcont

else:                                             ; preds = %entry
  %1 = sub i32 %x, 1
  %2 = mul i32 %acc, %x
  %3 = call i32 @factorial(i32 %1, i32 %2)
  br label %ifcont

ifcont:                                           ; preds = %else, %then
  %iftmp = phi i32 [ %acc, %then ], [ %3, %else ]
  ret i32 %iftmp
}

define i32 @main() {
entry:
  %0 = call i32 @factorial(i32 15, i32 1)
  %1 = call i32 @printlnd(i32 %0)
  ret i32 %1
}
