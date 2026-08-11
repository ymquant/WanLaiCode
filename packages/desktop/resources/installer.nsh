; Uninstall feedback gate.
;
; electron-builder auto-includes this file: the buildResources dir (resources/)
; is added via `!addincludedir`, and the macros defined here are expanded into
; the generated (un)installer. `customUnInit` runs inside the uninstaller's
; un.onInit, before any files are removed.
;
; Flow: on uninstall, launch the already-installed app in --uninstall-feedback
; mode to collect feedback, then decide whether to proceed based on its exit
; code. The contract mirrors the app side (packages/desktop/src/uninstall-feedback/
; shared.ts):
;   0  = submitted (incl. local fallback) -> continue uninstall
;   2  = user cancelled / closed window   -> abort uninstall
;   *  = crash / launch failure / anything else -> continue (never lock the user in)
;
; Only built-in NSIS instructions are used (IfSilent / ExecWait / StrCmp / Quit),
; so there is no dependency on LogicLib or FileFunc being included at this point.

!macro customUnInit
  ; Silent uninstall (e.g. auto-updater's `Uninstall.exe /S`) must skip the
  ; feedback window, otherwise it would block an unattended update.
  IfSilent uninstall_feedback_done

  ; The uninstaller has not deleted files yet, so the main exe is still present.
  ; ${APP_EXECUTABLE_FILENAME} resolves to the real exe name regardless of how the
  ; (Chinese) productName was sanitized. The app's --uninstall-feedback mode
  ; bypasses the single-instance lock, so it launches its own feedback window even
  ; if the app is already running. ExecWait blocks until that window exits.
  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-feedback' $0

  ; Abort only on the explicit "user cancelled" code (2). Any other value —
  ; including launch failures — falls through and lets the uninstall proceed.
  StrCmp $0 "2" 0 uninstall_feedback_done
  Quit

  uninstall_feedback_done:
!macroend

!macro customUnInstall
  ; electron-builder's deleteAppDataOnUninstall removes Electron's default
  ; app-data names. WanLaiCode overrides userData to $APPDATA\${APP_ID}, so
  ; remove that real data root as well when local data cleanup is requested.
  StrCpy $1 "0"

  ClearErrors
  ${GetParameters} $0
  ${GetOptions} $0 "--delete-app-data" $2
  IfErrors 0 wanlaicode_delete_app_data_enabled

  !ifdef DELETE_APP_DATA_ON_UNINSTALL
    ${ifNot} ${isUpdated}
      StrCpy $1 "1"
    ${endif}
  !endif
  Goto wanlaicode_delete_app_data_check

  wanlaicode_delete_app_data_enabled:
    StrCpy $1 "1"

  wanlaicode_delete_app_data_check:
    StrCmp $1 "1" 0 wanlaicode_delete_app_data_done

  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}
  ClearErrors
  RMDir /r "$APPDATA\${APP_ID}"
  ClearErrors
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}

  wanlaicode_delete_app_data_done:
!macroend
