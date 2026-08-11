function parseDottedIpv4Octets(host: string) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return undefined
  const octets = host.split(".").map((part) => Number(part))
  if (octets.some((octet) => octet > 255)) return undefined
  return octets
}

function ipv4OctetsFromHost(host: string) {
  const dotted = parseDottedIpv4Octets(host)
  if (dotted) return dotted
  if (!/^\d{1,10}$/.test(host)) return undefined
  const value = Number(host)
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return undefined
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
}

function isPrivateOrLoopbackIpv4Octets(octets: readonly number[]) {
  const [a, b] = octets
  if (a === 127 || a === 0) return true
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

function ipv4OctetsFromIpv4MappedIpv6(host: string) {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase()
  const match = normalized.match(/(?:^|:)ffff:(.+)$/)
  if (!match) return undefined
  const tail = match[1]!

  const dotted = parseDottedIpv4Octets(tail)
  if (dotted) return dotted

  const parts = tail.split(":")
  if (parts.length === 2 && parts.every((part) => /^[0-9a-f]{1,4}$/i.test(part))) {
    const hi = parseInt(parts[0]!, 16)
    const lo = parseInt(parts[1]!, 16)
    if (Number.isNaN(hi) || Number.isNaN(lo)) return undefined
    const value = ((hi & 0xffff) << 16) | (lo & 0xffff)
    return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
  }

  return undefined
}

/** Blocks loopback, link-local, and RFC1918 hosts (incl. decimal IPv4 literals like 2130706433). */
export function isPrivateOrLoopbackHost(host: string) {
  const normalized = host.toLowerCase()
  if (!normalized) return true
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true
  if (normalized.endsWith(".local")) return true
  if (normalized === "::1" || normalized === "[::1]") return true

  const mapped = ipv4OctetsFromIpv4MappedIpv6(normalized)
  if (mapped) return isPrivateOrLoopbackIpv4Octets(mapped)

  const octets = ipv4OctetsFromHost(normalized)
  if (octets) return isPrivateOrLoopbackIpv4Octets(octets)

  if (normalized.startsWith("fe80:")) return true
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true
  return false
}

export function isPublicHttpUrl(url: string) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
    return !isPrivateOrLoopbackHost(parsed.hostname)
  } catch {
    return false
  }
}
