export function openWebfetchLink(
  url: string,
  openExternalLink?: (url: string) => void | Promise<void>,
) {
  if (!url) return
  if (openExternalLink) {
    void openExternalLink(url)
    return
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer")
  }
}
