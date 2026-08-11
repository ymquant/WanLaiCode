import { isPublicHttpUrl } from "./safe-http-url"

/** Opens http(s) URLs in the system browser; ignores invalid or unsafe schemes. */
export function openHttpUrl(url: string, open: (url: string) => void) {
  if (!isPublicHttpUrl(url)) return
  open(url)
}
