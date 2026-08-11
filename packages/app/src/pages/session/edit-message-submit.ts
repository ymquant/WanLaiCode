type RevertState = { messageID: string } | undefined

type EditMessageSubmitInput = {
  sessionID: string
  messageID: string
  hasLaterMessages: boolean
  previousRevert: RevertState
  preflight: () => Promise<void>
  busy: () => boolean
  setBusy: (busy: boolean) => void
  setLocalRevert: (revert: RevertState) => void
  revert: (messageID: string) => Promise<void>
  unrevert: () => Promise<void>
  send: () => Promise<void>
  fail: (error: unknown) => void
}

const activeEdits = new Set<string>()

export async function runEditMessageSubmit(input: EditMessageSubmitInput) {
  const key = `${input.sessionID}\0${input.messageID}`
  if (activeEdits.has(key)) return
  activeEdits.add(key)

  try {
    try {
      await input.preflight()
    } catch (error) {
      input.fail(error)
      return
    }
    if (input.busy()) return

    input.setBusy(true)
    try {
      if (input.hasLaterMessages) {
        input.setLocalRevert({ messageID: input.messageID })
        try {
          await input.revert(input.messageID)
        } catch (error) {
          input.setLocalRevert(input.previousRevert)
          input.fail(error)
          return
        }
      }

      try {
        await input.preflight()
      } catch (error) {
        input.fail(error)
        if (input.hasLaterMessages) {
          try {
            if (input.previousRevert) await input.revert(input.previousRevert.messageID)
            else await input.unrevert()
          } catch (restoreError) {
            input.fail(restoreError)
          }
          input.setLocalRevert(input.previousRevert)
        }
        return
      }

      try {
        await input.send()
      } catch (error) {
        input.fail(error)
      }
    } finally {
      input.setBusy(false)
    }
  } finally {
    activeEdits.delete(key)
  }
}
