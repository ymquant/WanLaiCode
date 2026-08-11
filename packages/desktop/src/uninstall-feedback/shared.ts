export const UNINSTALL_FEEDBACK_FLAG = "--uninstall-feedback"

export const EXIT_SUBMITTED = 0
export const EXIT_CANCELLED = 2

export function isUninstallFeedbackMode(argv: string[]): boolean {
  return argv.includes(UNINSTALL_FEEDBACK_FLAG)
}

export function countFeedbackChars(text: string): number {
  return [...text.trim()].length
}

export function isValidFeedbackText(text: string): boolean {
  const n = countFeedbackChars(text)
  return n >= 10 && n <= 2000
}
