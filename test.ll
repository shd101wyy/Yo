; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

declare i32 @printlnd(i32)

define {} @main() {
entry:
  %malloc = call i8* @malloc(i32 16)
  %malloc1 = bitcast i8* %malloc to { {} (i8*)*, i8* }*
  %functionPtr = getelementptr { {} (i8*)*, i8* }, { {} (i8*)*, i8* }* %malloc1, i32 0, i32 0
  store {} (i8*)* @lambda_3, {} (i8*)** %functionPtr, align 8
  %malloc2 = call i8* @malloc(i32 0)
  %malloc3 = bitcast i8* %malloc2 to {}*
  %fn_freeVariablesPtr = getelementptr { {} (i8*)*, i8* }, { {} (i8*)*, i8* }* %malloc1, i32 0, i32 1
  %fn_casted_freeVariablesPtr = bitcast {}* %malloc3 to i8*
  store i8* %fn_casted_freeVariablesPtr, i8** %fn_freeVariablesPtr, align 8
  %0 = call {} @twice.1({ {} (i8*)*, i8* }* %malloc1)
  ret {} %0
}

define {} @lambda_3(i8* %FREE_VARIABLES) {
entry:
  %fn_FREE_VARIABLES = bitcast i8* %FREE_VARIABLES to {}*
  %malloc = call i8* @malloc(i32 16)
  %malloc1 = bitcast i8* %malloc to { {} (i8*)*, i8* }*
  %functionPtr = getelementptr { {} (i8*)*, i8* }, { {} (i8*)*, i8* }* %malloc1, i32 0, i32 0
  store {} (i8*)* @lambda_4, {} (i8*)** %functionPtr, align 8
  %malloc2 = call i8* @malloc(i32 0)
  %malloc3 = bitcast i8* %malloc2 to {}*
  %fn_freeVariablesPtr = getelementptr { {} (i8*)*, i8* }, { {} (i8*)*, i8* }* %malloc1, i32 0, i32 1
  %fn_casted_freeVariablesPtr = bitcast {}* %malloc3 to i8*
  store i8* %fn_casted_freeVariablesPtr, i8** %fn_freeVariablesPtr, align 8
  %0 = call {} @twice({ {} (i8*)*, i8* }* %malloc1)
  ret {} %0
}

define {} @lambda_4(i8* %FREE_VARIABLES) {
entry:
  %fn_FREE_VARIABLES = bitcast i8* %FREE_VARIABLES to {}*
  %0 = call i32 @printlnd(i32 12)
  ret {} zeroinitializer
}

define {} @twice({ {} (i8*)*, i8* }* %fn) {
entry:
  %callfn_freeVariablesPtr = getelementptr { {} (i8*)*, i8* }, { {} (i8*)*, i8* }* %fn, i32 0, i32 1
  %callfn_freeVariablesPtr1 = load i8*, i8** %callfn_freeVariablesPtr, align 8
  %functionPtr = getelementptr { {} (i8*)*, i8* }, { {} (i8*)*, i8* }* %fn, i32 0, i32 0
  %functionPtr2 = load {} (i8*)*, {} (i8*)** %functionPtr, align 8
  %0 = call {} %functionPtr2(i8* %callfn_freeVariablesPtr1)
  %callfn_freeVariablesPtr3 = getelementptr { {} (i8*)*, i8* }, { {} (i8*)*, i8* }* %fn, i32 0, i32 1
  %callfn_freeVariablesPtr4 = load i8*, i8** %callfn_freeVariablesPtr3, align 8
  %functionPtr5 = getelementptr { {} (i8*)*, i8* }, { {} (i8*)*, i8* }* %fn, i32 0, i32 0
  %functionPtr6 = load {} (i8*)*, {} (i8*)** %functionPtr5, align 8
  %1 = call {} %functionPtr6(i8* %callfn_freeVariablesPtr4)
  ret {} %1
}

define {} @twice.1({ {} (i8*)*, i8* }* %fn) {
entry:
  %callfn_freeVariablesPtr = getelementptr { {} (i8*)*, i8* }, { {} (i8*)*, i8* }* %fn, i32 0, i32 1
  %callfn_freeVariablesPtr1 = load i8*, i8** %callfn_freeVariablesPtr, align 8
  %functionPtr = getelementptr { {} (i8*)*, i8* }, { {} (i8*)*, i8* }* %fn, i32 0, i32 0
  %functionPtr2 = load {} (i8*)*, {} (i8*)** %functionPtr, align 8
  %0 = call {} %functionPtr2(i8* %callfn_freeVariablesPtr1)
  %callfn_freeVariablesPtr3 = getelementptr { {} (i8*)*, i8* }, { {} (i8*)*, i8* }* %fn, i32 0, i32 1
  %callfn_freeVariablesPtr4 = load i8*, i8** %callfn_freeVariablesPtr3, align 8
  %functionPtr5 = getelementptr { {} (i8*)*, i8* }, { {} (i8*)*, i8* }* %fn, i32 0, i32 0
  %functionPtr6 = load {} (i8*)*, {} (i8*)** %functionPtr5, align 8
  %1 = call {} %functionPtr6(i8* %callfn_freeVariablesPtr4)
  ret {} %1
}
