export function redactCredentials(text: string) {
  return text
    .replace(
      /\b(?=[a-z_][a-z0-9_]*\s*=)[a-z0-9_]*(?:token|password|secret|api_key)[a-z0-9_]*\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      "[redacted]",
    )
    .replace(/\bauthorization\s*:\s*bearer\s+\S+/gi, "Authorization: Bearer [redacted]")
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, "[redacted]")
    .replace(/\b(?:gh[pousr]_[a-z0-9]{8,}|github_pat_[a-z0-9_]{8,})\b/gi, "[redacted]")
}
