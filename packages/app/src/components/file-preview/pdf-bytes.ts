export function decodePdfBase64(
  b64: string,
  nativeDecoder?: (input: string) => Uint8Array,
): Uint8Array {
  const native = nativeDecoder ?? (typeof Uint8Array.fromBase64 === "function" ? (input: string) => Uint8Array.fromBase64(input) : undefined)
  if (native) return native(b64)

  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
