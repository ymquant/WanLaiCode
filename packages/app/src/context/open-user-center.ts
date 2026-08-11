import type { TabID } from "@/pages/users/types"

let openFn: ((tab?: TabID) => void) | null = null

export const setOpenUserCenterFn = (fn: (tab?: TabID) => void) => {
  openFn = fn
}

export const openUserCenterOverlay = (tab?: TabID) => {
  openFn?.(tab)
}
