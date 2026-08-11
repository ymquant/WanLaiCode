type ReplyGenerationState = {
  current: number
  active: Set<number>
  handled: Set<number>
}

export function createReplyGenerationTracker() {
  const sessions = new Map<string, ReplyGenerationState>()
  // 会话状态可以在空闲时释放，但 generation 本身必须保持进程内唯一，避免异常残留的旧清理句柄命中新回合。
  let nextGeneration = 0

  const begin = (sessionID: string) => {
    const state = sessions.get(sessionID) ?? { current: 0, active: new Set(), handled: new Set() }
    const generation = ++nextGeneration
    state.current = generation
    state.active.add(generation)
    sessions.set(sessionID, state)
    return generation
  }

  const invalidate = (sessionID: string) => {
    const state = sessions.get(sessionID)
    if (!state) return
    // 停止或 shell 只需要让仍存活的旧回复失效；没有活动回复时不创建常驻会话状态。
    state.current = ++nextGeneration
  }

  const finish = (sessionID: string, generation: number) => {
    const state = sessions.get(sessionID)
    if (!state) return
    // handled 只服务于当前回复内部的多层失败上报；回复结束后必须同步释放，避免长会话逐轮累积。
    state.active.delete(generation)
    state.handled.delete(generation)
    if (state.active.size === 0) sessions.delete(sessionID)
  }

  return {
    begin,
    invalidate,
    finish,
    current: (sessionID: string, generation: number | undefined) => sessions.get(sessionID)?.current === generation,
    // 生命周期诊断只判断该会话是否仍持有回复代次，不暴露可变集合给业务调用方。
    active: (sessionID: string) => sessions.has(sessionID),
    handled: (sessionID: string, generation: number) => sessions.get(sessionID)?.handled.has(generation) === true,
    markHandled: (sessionID: string, generation: number | undefined) => {
      if (generation === undefined) return
      sessions.get(sessionID)?.handled.add(generation)
    },
    // 仅暴露状态数量用于验证生命周期；业务逻辑不依赖该诊断值。
    size: () => sessions.size,
  }
}
