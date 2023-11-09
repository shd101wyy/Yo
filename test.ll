; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

define i32 @test({ i32 (i32, i8*)*, i8* }* %f) {
entry:
  %callfn_freeVariablesPtr = getelementptr { i32 (i32, i8*)*, i8* }, { i32 (i32, i8*)*, i8* }* %f, i32 0, i32 1
  %callfn_freeVariablesPtr1 = load i8*, i8** %callfn_freeVariablesPtr, align 8
  %functionPtr = getelementptr { i32 (i32, i8*)*, i8* }, { i32 (i32, i8*)*, i8* }* %f, i32 0, i32 0
  %functionPtr2 = load i32 (i32, i8*)*, i32 (i32, i8*)** %functionPtr, align 8
  %0 = call i32 %functionPtr2(i32 3, i8* %callfn_freeVariablesPtr1)
  ret i32 %0
}

define i32 @main() {
entry:
  %malloc = call i8* @malloc(i32 16)
  %malloc1 = bitcast i8* %malloc to { i32 (i32, i8*)*, i8* }*
  %functionPtr = getelementptr { i32 (i32, i8*)*, i8* }, { i32 (i32, i8*)*, i8* }* %malloc1, i32 0, i32 0
  store i32 (i32, i8*)* @lambda_1, i32 (i32, i8*)** %functionPtr, align 8
  %malloc2 = call i8* @malloc(i32 4)
  %malloc3 = bitcast i8* %malloc2 to { i32 }*
  %a = getelementptr { i32 }, { i32 }* %malloc3, i32 0, i32 0
  store i32 12, i32* %a, align 4
  %fn_freeVariablesPtr = getelementptr { i32 (i32, i8*)*, i8* }, { i32 (i32, i8*)*, i8* }* %malloc1, i32 0, i32 1
  %fn_casted_freeVariablesPtr = bitcast { i32 }* %malloc3 to i8*
  store i8* %fn_casted_freeVariablesPtr, i8** %fn_freeVariablesPtr, align 8
  %0 = call i32 @test({ i32 (i32, i8*)*, i8* }* %malloc1)
  ret i32 %0
}

define i32 @lambda_1(i32 %x, i8* %FREE_VARIABLES) {
entry:
  %fn_FREE_VARIABLES = bitcast i8* %FREE_VARIABLES to { i32 }*
  %a = getelementptr { i32 }, { i32 }* %fn_FREE_VARIABLES, i32 0, i32 0
  %a1 = load i32, i32* %a, align 4
  %0 = add i32 %x, %a1
  ret i32 %0
}
