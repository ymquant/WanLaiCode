import { createMemo } from "solid-js"
import { useMutation } from "@tanstack/solid-query"
import { showToast } from "@opencode-ai/ui/toast"
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useGlobalSync } from "@/context/global-sync"
import { withoutQuestion } from "@/pages/session/composer/session-request-tree"

export function questionAnswersWithSelection(
  questions: readonly unknown[],
  answers: readonly (QuestionAnswer | undefined)[],
  tab: number,
  answer: QuestionAnswer,
): QuestionAnswer[] {
  return questions.map((_, i) => {
    const current = answers[i]
    if (i === tab) return [...answer]
    if (current) return [...current]
    return []
  })
}

export function createQuestionReply(input: {
  requestID: () => string
  sessionID: () => string
  onSubmit: VoidFunction
  onReplied: VoidFunction
}) {
  const sdk = useSDK()
  const language = useLanguage()
  const globalSync = useGlobalSync()

  const fail = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    showToast({ title: language.t("common.requestFailed"), description: message })
  }

  const removeQuestion = () => {
    const [, setChild] = globalSync.child(sdk.directory, { bootstrap: false })
    setChild("question", input.sessionID(), (list) =>
      withoutQuestion(list as QuestionRequest[] | undefined, input.requestID()),
    )
  }

  const settled = () => {
    input.onReplied()
    removeQuestion()
  }

  const replyMutation = useMutation(() => ({
    mutationFn: (answers: QuestionAnswer[]) => sdk.client.question.reply({ requestID: input.requestID(), answers }),
    onMutate: () => {
      input.onSubmit()
    },
    onSuccess: settled,
    onError: fail,
  }))

  const rejectMutation = useMutation(() => ({
    mutationFn: () => sdk.client.question.reject({ requestID: input.requestID() }),
    onMutate: () => {
      input.onSubmit()
    },
    onSuccess: settled,
    onError: fail,
  }))

  const sending = createMemo(() => replyMutation.isPending || rejectMutation.isPending)

  const reply = async (answers: QuestionAnswer[]) => {
    if (sending()) return
    await replyMutation.mutateAsync(answers)
  }

  const reject = async () => {
    if (sending()) return
    await rejectMutation.mutateAsync()
  }

  return { sending, reply, reject }
}
