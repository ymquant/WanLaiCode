export function appSnapshotThumbnailSize(display: {
  size: { width: number; height: number }
  scaleFactor: number
}) {
  return {
    width: Math.max(1, Math.round(display.size.width * display.scaleFactor)),
    height: Math.max(1, Math.round(display.size.height * display.scaleFactor)),
  }
}

export function matchAppSnapshotSource<T extends { display_id: string }>(displayID: number, sources: T[]) {
  return sources.find((source) => source.display_id === String(displayID)) ?? (sources.length === 1 ? sources[0] : undefined)
}
