; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

declare i32 @printlnd(i32)

define { i32, i32 }* @Point(i32 %x, i32 %y) {
entry:
  %malloc = call i8* @malloc(i32 8)
  %malloc1 = bitcast i8* %malloc to { i32, i32 }*
  %x2 = getelementptr { i32, i32 }, { i32, i32 }* %malloc1, i32 0, i32 0
  store i32 %x, i32* %x2, align 4
  %y3 = getelementptr { i32, i32 }, { i32, i32 }* %malloc1, i32 0, i32 1
  store i32 %y, i32* %y3, align 4
  ret { i32, i32 }* %malloc1
}

define i32 @main() {
entry:
  %0 = call { i32, i32 }* @Point(i32 4, i32 8)
  %y = getelementptr { i32, i32 }, { i32, i32 }* %0, i32 0, i32 1
  %y1 = load i32, i32* %y, align 4
  %1 = call i32 @printlnd(i32 %y1)
  ret i32 %1
}
