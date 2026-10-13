Unicode true
!define APP_NAME "@APP_NAME@"
!define APP_VERSION "@APP_VERSION@"
!define APP_DIR "@APP_DIR@"
!define APP_EXE "@APP_EXE@"
!define OUT_FILE "@OUT_FILE@"
Name "${APP_NAME}"
OutFile "${OUT_FILE}"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
SetCompressor lzma
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "${APP_NAME}"
VIAddVersionKey /LANG=1033 "FileDescription" "${APP_NAME} portable application"
VIAddVersionKey /LANG=1033 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "FileVersion" "${APP_VERSION}.0"
!include "FileFunc.nsh"
Var AppTempDir
Var ForwardArgs
Function .onInit
  System::Call 'Kernel32::GetCurrentProcessId() i .r0'
  StrCpy $AppTempDir "$TEMP\PAIRO-${APP_VERSION}-$0"
FunctionEnd
Section
  CreateDirectory "$AppTempDir"
  SetOutPath "$AppTempDir"
  File /r "${APP_DIR}\*.*"
  ${GetParameters} $ForwardArgs
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_FILE", "$EXEPATH").r0'
  ExecWait '"$AppTempDir\${APP_EXE}" $ForwardArgs' $0
  RMDir /r "$AppTempDir"
  SetErrorLevel $0
SectionEnd
