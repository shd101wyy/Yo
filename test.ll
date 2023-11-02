; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

@0 = private unnamed_addr constant [13 x i8] c"Hello, world\00", align 1

declare i8* @malloc(i32)

declare i32 @println({ i8*, i32, i32 }*)

define i32 @main() {
entry:
  %malloc = call i8* @malloc(i32 16)
  %malloc1 = bitcast i8* %malloc to { i8*, i32, i32 }*
  %data = getelementptr { i8*, i32, i32 }, { i8*, i32, i32 }* %malloc1, i32 0, i32 0
  %length = getelementptr { i8*, i32, i32 }, { i8*, i32, i32 }* %malloc1, i32 0, i32 1
  %size = getelementptr { i8*, i32, i32 }, { i8*, i32, i32 }* %malloc1, i32 0, i32 2
  store i8* getelementptr inbounds ([13 x i8], [13 x i8]* @0, i32 0, i32 0), i8** %data, align 8
  store i32 12, i32* %length, align 4
  store i32 12, i32* %size, align 4
  %malloc2 = call i8* @malloc(i32 16)
  %malloc3 = bitcast i8* %malloc2 to { i32, i32, { i8*, i32, i32 }* }*
  %a = getelementptr { i32, i32, { i8*, i32, i32 }* }, { i32, i32, { i8*, i32, i32 }* }* %malloc3, i32 0, i32 0
  store i32 1, i32* %a, align 4
  %b = getelementptr { i32, i32, { i8*, i32, i32 }* }, { i32, i32, { i8*, i32, i32 }* }* %malloc3, i32 0, i32 1
  store i32 2, i32* %b, align 4
  %c = getelementptr { i32, i32, { i8*, i32, i32 }* }, { i32, i32, { i8*, i32, i32 }* }* %malloc3, i32 0, i32 2
  store { i8*, i32, i32 }* %malloc1, { i8*, i32, i32 }** %c, align 8
  %0 = call i32 @println({ i8*, i32, i32 }* %malloc1)
  ret i32 0
}
