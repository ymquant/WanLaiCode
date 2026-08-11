type Input = {
  prevScrollWidth: number
  scrollWidth: number
  clientWidth: number
  prevContextOpen: boolean
  contextOpen: boolean
}

export const nextTabListScrollLeft = (input: Input) => {
  if (input.scrollWidth <= input.prevScrollWidth) return
  if (!input.prevContextOpen && input.contextOpen) return 0
  if (input.scrollWidth <= input.clientWidth) return
  return input.scrollWidth - input.clientWidth
}

const TAB_LIST_THUMB_MIN = 24
const TAB_LIST_THUMB_MIN_TRAVEL = 4

export const tabListThumbMetrics = (scrollWidth: number, clientWidth: number, scrollLeft: number) => {
  if (scrollWidth <= clientWidth) return undefined

  const track = clientWidth
  const proportional = Math.round((clientWidth / scrollWidth) * track)
  const thumbMax = Math.max(track - TAB_LIST_THUMB_MIN_TRAVEL, 1)
  const thumb = Math.min(Math.max(TAB_LIST_THUMB_MIN, proportional), thumbMax)
  const maxLeft = Math.max(track - thumb, 0)
  const overflow = scrollWidth - clientWidth
  const left = maxLeft <= 0 ? 0 : (scrollLeft / overflow) * maxLeft

  return { track, thumb, maxLeft, left, overflow }
}

export const tabListScrollLeftFromThumbLeft = (left: number, maxLeft: number, overflow: number) => {
  if (maxLeft <= 0) return 0
  return (left / maxLeft) * overflow
}

export const tabListThumbLeftFromPointer = (pointerX: number, trackLeft: number, trackWidth: number, thumb: number) => {
  const maxLeft = Math.max(trackWidth - thumb, 0)
  const center = pointerX - trackLeft - thumb / 2
  return Math.max(0, Math.min(center, maxLeft))
}

export const createFileTabListSync = (input: { el: HTMLDivElement; contextOpen: () => boolean }) => {
  let frame: number | undefined
  let prevScrollWidth = input.el.scrollWidth
  let prevContextOpen = input.contextOpen()

  const update = () => {
    const scrollWidth = input.el.scrollWidth
    const clientWidth = input.el.clientWidth
    const contextOpen = input.contextOpen()
    const left = nextTabListScrollLeft({
      prevScrollWidth,
      scrollWidth,
      clientWidth,
      prevContextOpen,
      contextOpen,
    })

    if (left !== undefined) {
      input.el.scrollTo({
        left,
        behavior: "smooth",
      })
    }

    prevScrollWidth = scrollWidth
    prevContextOpen = contextOpen
  }

  const schedule = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = undefined
      update()
    })
  }

  const onWheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    input.el.scrollLeft += e.deltaY > 0 ? 50 : -50
    e.preventDefault()
  }

  input.el.addEventListener("wheel", onWheel, { passive: false })
  const observer = new MutationObserver(schedule)
  observer.observe(input.el, { childList: true })

  return () => {
    input.el.removeEventListener("wheel", onWheel)
    observer.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
  }
}
