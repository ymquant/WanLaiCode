export type PrRowState = "create" | "exists" | "gh-cli" | "gh-auth" | "unavailable" | "loading" | "error"

export type ExistingPullRequest = { title: string; url: string }

export function prRowState(
  git: boolean,
  ghCli: boolean | undefined,
  ghAuthenticated: boolean | undefined,
  existing?: ExistingPullRequest,
  pending?: boolean,
  failed?: boolean,
): PrRowState {
  if (existing?.url) return "exists"
  if (pending) return "loading"
  if (failed) return "error"
  if (!git) return "unavailable"
  if (ghCli === false) return "gh-cli"
  if (ghAuthenticated === false) return "gh-auth"
  if (ghCli === undefined || ghAuthenticated === undefined) return "loading"
  if (ghCli && ghAuthenticated) return "create"
  return "unavailable"
}
