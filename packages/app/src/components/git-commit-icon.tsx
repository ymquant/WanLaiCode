export const gitCommitIconClass = "size-4 shrink-0 text-icon-weak"

export function GitCommitIcon(props: { class?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" class={props.class ?? gitCommitIconClass} aria-hidden="true">
      <path d="M1.5 10H6M14 10H18.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      <circle cx="10" cy="10" r="4" stroke="currentColor" stroke-width="1.4" fill="none" />
    </svg>
  )
}
