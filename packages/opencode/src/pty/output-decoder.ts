const utf8 = new TextDecoder("utf-8")
const cjkPattern = /[\u3400-\u9fff]/

function concatBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length === 0) return right
  if (right.length === 0) return left
  const out = new Uint8Array(left.length + right.length)
  out.set(left)
  out.set(right, left.length)
  return out
}

function isContinuation(byte: number) {
  return byte >= 0x80 && byte <= 0xbf
}

function utf8Prefix(input: Uint8Array) {
  for (let i = 0; i < input.length; ) {
    const byte = input[i]
    if (byte <= 0x7f) {
      i += 1
      continue
    }

    if (byte >= 0xc2 && byte <= 0xdf) {
      if (i + 1 >= input.length) return { valid: true, complete: i }
      if (!isContinuation(input[i + 1])) return { valid: false, complete: i }
      i += 2
      continue
    }

    if (byte === 0xe0) {
      if (i + 2 >= input.length) return { valid: true, complete: i }
      if (input[i + 1] < 0xa0 || input[i + 1] > 0xbf || !isContinuation(input[i + 2])) {
        return { valid: false, complete: i }
      }
      i += 3
      continue
    }

    if ((byte >= 0xe1 && byte <= 0xec) || (byte >= 0xee && byte <= 0xef)) {
      if (i + 2 >= input.length) return { valid: true, complete: i }
      if (!isContinuation(input[i + 1]) || !isContinuation(input[i + 2])) return { valid: false, complete: i }
      i += 3
      continue
    }

    if (byte === 0xed) {
      if (i + 2 >= input.length) return { valid: true, complete: i }
      if (input[i + 1] < 0x80 || input[i + 1] > 0x9f || !isContinuation(input[i + 2])) {
        return { valid: false, complete: i }
      }
      i += 3
      continue
    }

    if (byte === 0xf0) {
      if (i + 3 >= input.length) return { valid: true, complete: i }
      if (
        input[i + 1] < 0x90 ||
        input[i + 1] > 0xbf ||
        !isContinuation(input[i + 2]) ||
        !isContinuation(input[i + 3])
      ) {
        return { valid: false, complete: i }
      }
      i += 4
      continue
    }

    if (byte >= 0xf1 && byte <= 0xf3) {
      if (i + 3 >= input.length) return { valid: true, complete: i }
      if (!isContinuation(input[i + 1]) || !isContinuation(input[i + 2]) || !isContinuation(input[i + 3])) {
        return { valid: false, complete: i }
      }
      i += 4
      continue
    }

    if (byte === 0xf4) {
      if (i + 3 >= input.length) return { valid: true, complete: i }
      if (
        input[i + 1] < 0x80 ||
        input[i + 1] > 0x8f ||
        !isContinuation(input[i + 2]) ||
        !isContinuation(input[i + 3])
      ) {
        return { valid: false, complete: i }
      }
      i += 4
      continue
    }

    return { valid: false, complete: i }
  }

  return { valid: true, complete: input.length }
}

function decodeGb18030(input: Uint8Array) {
  return new TextDecoder("gb18030").decode(input)
}

function gb18030Prefix(input: Uint8Array) {
  for (let i = 0; i < input.length; ) {
    const byte = input[i]
    if (byte <= 0x7f) {
      i += 1
      continue
    }

    if (byte < 0x81 || byte > 0xfe) {
      i += 1
      continue
    }

    if (i + 1 >= input.length) return i
    const second = input[i + 1]
    if (second >= 0x30 && second <= 0x39) {
      if (i + 3 >= input.length) return i
      const third = input[i + 2]
      const fourth = input[i + 3]
      if (third >= 0x81 && third <= 0xfe && fourth >= 0x30 && fourth <= 0x39) {
        i += 4
        continue
      }
      i += 1
      continue
    }

    if (second >= 0x40 && second <= 0xfe && second !== 0x7f) {
      i += 2
      continue
    }

    i += 1
  }

  return input.length
}

function createGb18030Decoder() {
  let pending = new Uint8Array()

  const decode = (chunk: Uint8Array) => {
    const bytes = concatBytes(pending, chunk)
    const complete = gb18030Prefix(bytes)
    pending = complete < bytes.length ? bytes.slice(complete) : new Uint8Array()
    if (complete === 0) return ""
    return decodeGb18030(bytes.slice(0, complete))
  }

  const flush = () => {
    if (pending.length === 0) return ""
    const out = decodeGb18030(pending)
    pending = new Uint8Array()
    return out
  }

  return { decode, flush }
}

function cjkCount(input: string) {
  return Array.from(input).filter((char) => cjkPattern.test(char)).length
}

function highByteRunStart(input: Uint8Array, end: number) {
  for (let i = end; i > 0; i--) {
    if (input[i - 1] <= 0x7f) return i
  }
  return 0
}

function utf8SequenceLength(byte: number) {
  if (byte >= 0xc2 && byte <= 0xdf) return 2
  if (byte >= 0xe0 && byte <= 0xef) return 3
  if (byte >= 0xf0 && byte <= 0xf4) return 4
  return 0
}

function ambiguousUtf8TailStart(input: Uint8Array, complete: number) {
  const start = highByteRunStart(input, complete)
  if (start === complete) return complete

  let hold = complete
  for (let i = start; i < complete; ) {
    const length = utf8SequenceLength(input[i])
    if (length === 0 || i + length > complete) return complete
    const bytes = input.slice(i, i + length)
    const ambiguous = bytes.length === 2 && !cjkPattern.test(utf8.decode(bytes)) && cjkCount(decodeGb18030(bytes)) > 0
    hold = ambiguous ? Math.min(hold, i) : complete
    i += length
  }
  return hold
}

function decodeGb18030Tail(input: Uint8Array, complete: number, decoder: ReturnType<typeof createGb18030Decoder>) {
  const start = highByteRunStart(input, complete)
  if (start === complete) return

  const gb18030Tail = decodeGb18030(input.slice(start))
  const mixedTail = utf8.decode(input.slice(start, complete)) + decodeGb18030(input.slice(complete))
  if (cjkCount(gb18030Tail) <= cjkCount(mixedTail)) return
  return (start > 0 ? utf8.decode(input.slice(0, start)) : "") + decoder.decode(input.slice(start))
}

export function createPtyOutputDecoder() {
  let pending = new Uint8Array()
  let fallback: ReturnType<typeof createGb18030Decoder> | undefined

  const decode = (chunk: string | Uint8Array) => {
    if (typeof chunk === "string") return chunk

    if (fallback) return fallback.decode(chunk)

    const bytes = concatBytes(pending, chunk)
    const prefix = utf8Prefix(bytes)
    if (!prefix.valid) {
      const head = prefix.complete > 0 ? utf8.decode(bytes.slice(0, prefix.complete)) : ""
      fallback = createGb18030Decoder()
      pending = new Uint8Array()
      const bridged = decodeGb18030Tail(bytes, prefix.complete, fallback)
      if (bridged) return bridged
      return head + fallback.decode(bytes.slice(prefix.complete))
    }

    if (prefix.complete === 0) {
      pending = new Uint8Array(bytes)
      return ""
    }
    const hold = ambiguousUtf8TailStart(bytes, prefix.complete)
    const out = hold > 0 ? utf8.decode(bytes.slice(0, hold)) : ""
    pending = hold < bytes.length ? bytes.slice(hold) : new Uint8Array()
    return out
  }

  const flush = () => {
    if (fallback) return fallback.flush()
    if (pending.length === 0) return ""
    const out = utf8.decode(pending)
    pending = new Uint8Array()
    return out
  }

  return { decode, flush }
}
