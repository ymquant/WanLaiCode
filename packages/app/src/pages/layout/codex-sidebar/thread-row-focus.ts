export function shouldKeepActionFocus(pointerDown: boolean, focusTargetIsRow: boolean) {
  return !pointerDown || !focusTargetIsRow
}
