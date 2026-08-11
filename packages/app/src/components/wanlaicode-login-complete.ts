export async function completeWanlaiCodeLogin(input: {
  dispose: () => Promise<unknown>
  invalidateBootstrap: () => Promise<unknown>
  invalidateProviders: () => Promise<unknown>
  openMainWindow?: () => Promise<unknown>
}) {
  await input.dispose().catch(() => undefined)
  await input.invalidateBootstrap()
  await input.invalidateProviders()
  await input.openMainWindow?.()
}
