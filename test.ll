; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

define i32 @main() {
entry:
  %malloc = call i8* @malloc(i32 8)
  %malloc1 = bitcast i8* %malloc to { i32, i32 }*
  %x = getelementptr { i32, i32 }, { i32, i32 }* %malloc1, i32 0, i32 0
  store i32 1, i32* %x, align 4
  %y = getelementptr { i32, i32 }, { i32, i32 }* %malloc1, i32 0, i32 1
  store i32 2, i32* %y, align 4
  %x2 = getelementptr { i32, i32 }, { i32, i32 }* %malloc1, i32 0, i32 0
  %x3 = load i32, i32* %x2, align 4
  %y4 = getelementptr { i32, i32 }, { i32, i32 }* %malloc1, i32 0, i32 1
  %y5 = load i32, i32* %y4, align 4
  %0 = add i32 %x3, %y5
  ret i32 %0
}
