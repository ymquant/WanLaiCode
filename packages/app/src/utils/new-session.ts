export function newSessionHref(slug: string, prompt?: string) {
  if (!prompt) return `/${slug}/session`
  return `/${slug}/session?prompt=${encodeURIComponent(prompt)}`
}

export function openNewSession(input: {
  slug: string
  prompt?: string
  reset: (slug: string) => void
  navigate: (href: string) => void
}) {
  input.reset(input.slug)
  input.navigate(newSessionHref(input.slug, input.prompt))
}
