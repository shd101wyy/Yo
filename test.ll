; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

declare i32 @printlnd(i32)

define i32 @main() {
entry:
  %0 = alloca [2 x { i32, i32 }*], align 8
  %malloc = call i8* @malloc(i32 8)
  %malloc1 = bitcast i8* %malloc to { i32, i32 }*
  %x = getelementptr { i32, i32 }, { i32, i32 }* %malloc1, i32 0, i32 0
  store i32 1234, i32* %x, align 4
  %y = getelementptr { i32, i32 }, { i32, i32 }* %malloc1, i32 0, i32 1
  store i32 2, i32* %y, align 4
  %index = getelementptr [2 x { i32, i32 }*], [2 x { i32, i32 }*]* %0, i32 0, i32 0
  store { i32, i32 }* %malloc1, { i32, i32 }** %index, align 8
  %malloc2 = call i8* @malloc(i32 8)
  %malloc3 = bitcast i8* %malloc2 to { i32, i32 }*
  %x4 = getelementptr { i32, i32 }, { i32, i32 }* %malloc3, i32 0, i32 0
  store i32 5, i32* %x4, align 4
  %y5 = getelementptr { i32, i32 }, { i32, i32 }* %malloc3, i32 0, i32 1
  store i32 3, i32* %y5, align 4
  %index6 = getelementptr [2 x { i32, i32 }*], [2 x { i32, i32 }*]* %0, i32 0, i32 1
  store { i32, i32 }* %malloc3, { i32, i32 }** %index6, align 8
  %index7 = getelementptr [2 x { i32, i32 }*], [2 x { i32, i32 }*]* %0, i32 0, i32 0
  %valueAtIndex = load { i32, i32 }*, { i32, i32 }** %index7, align 8
  %x8 = getelementptr { i32, i32 }, { i32, i32 }* %valueAtIndex, i32 0, i32 0
  %x9 = load i32, i32* %x8, align 4
  %index10 = getelementptr [2 x { i32, i32 }*], [2 x { i32, i32 }*]* %0, i32 0, i32 1
  %valueAtIndex11 = load { i32, i32 }*, { i32, i32 }** %index10, align 8
  %y12 = getelementptr { i32, i32 }, { i32, i32 }* %valueAtIndex11, i32 0, i32 1
  %y13 = load i32, i32* %y12, align 4
  %1 = add i32 %x9, %y13
  %2 = call i32 @printlnd(i32 %1)
  ret i32 0
}
