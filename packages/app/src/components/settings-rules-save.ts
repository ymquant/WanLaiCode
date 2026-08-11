export function createSettingsRulesSaveQueue() {
  let queue = Promise.resolve()
  return <T>(save: () => Promise<T>) => {
    const result = queue.then(save)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

export function restoreSettingsRulesConfig<T>(input: { current: T | undefined; optimistic: T; previous: T | undefined }) {
  return input.current === input.optimistic ? input.previous : input.current
}
