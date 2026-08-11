export function shouldShowWanlaiCodeLoginError(input: {
  providerReady: boolean
  connected: boolean
  hasModels: boolean
  authenticated?: boolean
  authLoading: boolean
}) {
  if (!input.providerReady || input.connected || input.hasModels || input.authLoading) return false
  return input.authenticated === false
}
