import { createSignal, For, Show, type JSX } from "solid-js"
import { createQuery, useMutation, useQueryClient } from "@tanstack/solid-query"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import type { RegistryComment } from "@opencode-ai/sdk/v2"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"

// 5-star interactive rating control
function StarRating(props: {
  value: number
  onChange: (v: number) => void
  onClear: () => void
  loading: boolean
}): JSX.Element {
  const language = useLanguage()
  const [hover, setHover] = createSignal(0)

  const effective = () => hover() || props.value

  return (
    <div class="flex items-center gap-1">
      <For each={[1, 2, 3, 4, 5]}>
        {(s) => (
          <button
            type="button"
            class="text-xl leading-none transition-opacity disabled:opacity-40"
            style={{ color: effective() >= s ? "#f59e0b" : undefined }}
            disabled={props.loading}
            aria-label={language.t("plugins.social.rating.star", { count: s })}
            onMouseEnter={() => setHover(s)}
            onMouseLeave={() => setHover(0)}
            onClick={() => {
              if (props.value === s) {
                props.onClear()
              } else {
                props.onChange(s)
              }
            }}
          >
            {effective() >= s ? "★" : "☆"}
          </button>
        )}
      </For>
      <Show when={props.value > 0}>
        <span class="ml-2 text-13-regular text-text-weak">
          {language.t("plugins.social.rating.selected", { count: props.value })}
        </span>
      </Show>
    </div>
  )
}

const AVATAR_PALETTE = [
  "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-200",
  "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200",
  "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200",
  "bg-pink-100 text-pink-700 dark:bg-pink-900 dark:text-pink-200",
  "bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-200",
]

function avatarClass(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]
}

// 应用 locale → toLocaleDateString 的 BCP-47 标签。
function dateLocale(locale: string): string {
  if (locale === "zh") return "zh-CN"
  if (locale === "zht") return "zh-TW"
  return "en-US"
}

function formatCommentTime(iso: string, locale: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ""
  return d.toLocaleDateString(dateLocale(locale), { year: "numeric", month: "long", day: "numeric" })
}

function CommentRow(props: {
  comment: RegistryComment
  canDelete: boolean
  onDelete: () => void
  deleting: boolean
}): JSX.Element {
  const language = useLanguage()
  // username 已在 query 层填充（含多语言「匿名用户」），这里直接用。
  const name = () => props.comment.username?.trim() || "?"
  const initial = () => [...name()][0]?.toUpperCase() ?? "?"
  return (
    <div class="group flex gap-3 py-4">
      <div
        class={`size-9 rounded-full shrink-0 flex items-center justify-center text-14-medium ${avatarClass(
          props.comment.author_uuid ?? name(),
        )}`}
      >
        {initial()}
      </div>
      <div class="flex-1 min-w-0 flex flex-col gap-1">
        <div class="flex items-center gap-2">
          <span class="text-13-medium text-text-strong truncate">{name()}</span>
          <span class="text-12-regular text-text-weaker shrink-0">
            {formatCommentTime(props.comment.created_at, language.locale())}
          </span>
          <Show when={props.canDelete}>
            <button
              type="button"
              class="ml-auto size-6 flex items-center justify-center rounded-md text-text-weaker opacity-0 group-hover:opacity-100 hover:text-text-danger hover:bg-surface-base disabled:opacity-40 transition-all shrink-0"
              aria-label={language.t("plugins.social.comment.delete")}
              disabled={props.deleting}
              onClick={props.onDelete}
            >
              <Icon name="trash" size="small" />
            </button>
          </Show>
        </div>
        <div class="text-14-regular text-text-base whitespace-pre-line break-words">
          {props.comment.content}
        </div>
      </div>
    </div>
  )
}

export function PluginSocial(props: { namespace: string; slug: string }): JSX.Element {
  const sdk = useGlobalSDK()
  const qc = useQueryClient()
  const language = useLanguage()

  const ratingKey = () => ["registry", "rating", props.namespace, props.slug] as const
  const commentsKey = () => ["registry", "comments", props.namespace, props.slug] as const

  // My rating query — 401 means not logged in; treat as no rating
  const myRating = createQuery(() => ({
    queryKey: ratingKey(),
    queryFn: async () => {
      const res = await sdk.client.registry.getMyRating({
        namespace: props.namespace,
        slug: props.slug,
      })
      if (res.error) {
        // 401 / not logged in → silently return null
        return null
      }
      return res.data ?? null
    },
    retry: false,
  }))

  const currentRating = () => {
    const r = myRating.data?.rating
    if (typeof r !== "number" || !isFinite(r)) return 0
    return r
  }

  const rate = useMutation(() => ({
    mutationFn: async (value: number) => {
      const res = await sdk.client.registry.putRating({
        namespace: props.namespace,
        slug: props.slug,
        registryRatingRequest: { rating: value },
      })
      if (res.error) throw res.error
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ratingKey() })
    },
    onError: (err: unknown) => {
      showToast({
        variant: "error",
        title: formatServerError(err, language.t, language.t("plugins.social.error.rate")),
      })
    },
  }))

  const clearRating = useMutation(() => ({
    mutationFn: async () => {
      const res = await sdk.client.registry.deleteRating({
        namespace: props.namespace,
        slug: props.slug,
      })
      if (res.error) throw res.error
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ratingKey() })
    },
    onError: (err: unknown) => {
      showToast({
        variant: "error",
        title: formatServerError(err, language.t, language.t("plugins.social.error.clearRate")),
      })
    },
  }))

  // Comments list query
  const comments = createQuery(() => ({
    queryKey: commentsKey(),
    queryFn: async () => {
      const res = await sdk.client.registry.listComments({
        namespace: props.namespace,
        slug: props.slug,
      })
      if (res.error) throw res.error
      // 接口拿到后填充空用户名（多语言「匿名用户」），后续渲染直接用 comment.username。
      const anon = language.t("plugins.comment.anonymous")
      return (res.data?.items ?? []).map((c) => ({ ...c, username: c.username?.trim() || anon }))
    },
    retry: false,
  }))

  const [draft, setDraft] = createSignal("")
  const [deletingId, setDeletingId] = createSignal<string | null>(null)

  const submitComment = useMutation(() => ({
    mutationFn: async () => {
      const res = await sdk.client.registry.postComment({
        namespace: props.namespace,
        slug: props.slug,
        registryCommentRequest: { content: draft().trim() },
      })
      if (res.error) throw res.error
    },
    onSuccess: () => {
      setDraft("")
      void qc.invalidateQueries({ queryKey: commentsKey() })
    },
    onError: (err: unknown) => {
      showToast({
        variant: "error",
        title: formatServerError(err, language.t, language.t("plugins.social.error.comment")),
      })
    },
  }))

  const deleteComment = useMutation(() => ({
    mutationFn: async (id: string) => {
      setDeletingId(id)
      try {
        const res = await sdk.client.registry.deleteComment({
          namespace: props.namespace,
          slug: props.slug,
          publicId: id,
        })
        if (res.error) throw res.error
      } finally {
        setDeletingId(null)
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: commentsKey() })
    },
    onError: (err: unknown) => {
      showToast({
        variant: "error",
        title: formatServerError(err, language.t, language.t("plugins.social.error.deleteComment")),
      })
    },
  }))

  // Determine current user's UUID to detect author-owned comments
  // We use the registry /me endpoint — 401 means not logged in → null
  const me = createQuery(() => ({
    queryKey: ["registry", "me"],
    queryFn: async () => {
      const res = await sdk.client.registry.me()
      if (res.error) return null
      return res.data ?? null
    },
    retry: false,
  }))

  const myUuid = () => me.data?.wanlai_uuid ?? null

  return (
    <div class="flex flex-col gap-6">
      {/* Rating section */}
      <section class="flex flex-col gap-3">
        <div class="text-16-medium text-text-strong">{language.t("plugins.social.rating.title")}</div>
        <Show
          when={!myRating.isLoading}
          fallback={<div class="h-6 w-32 bg-surface-base rounded animate-pulse" />}
        >
          <StarRating
            value={currentRating()}
            loading={rate.isPending || clearRating.isPending}
            onChange={(v) => rate.mutate(v)}
            onClear={() => clearRating.mutate()}
          />
        </Show>
      </section>

      {/* Comments section */}
      <section class="flex flex-col gap-3">
        <div class="text-16-medium text-text-strong">
          {language.t("plugins.social.comments.title")}
          <Show when={(comments.data ?? []).length > 0}>
            <span class="ml-1.5 text-13-regular text-text-weak">{(comments.data ?? []).length}</span>
          </Show>
        </div>

        {/* Submit box */}
        <div class="flex flex-col gap-2">
          <textarea
            class="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-weak-base text-14-regular text-text-base placeholder:text-text-weaker outline-none resize-none min-h-[72px]"
            placeholder={language.t("plugins.social.comment.placeholder")}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
          />
          <div class="flex justify-end">
            <button
              type="button"
              class="h-8 px-4 rounded-full bg-text-strong text-background-stronger text-14-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
              disabled={!draft().trim() || submitComment.isPending}
              onClick={() => submitComment.mutate()}
            >
              <Show when={!submitComment.isPending} fallback={language.t("plugins.social.comment.submitting")}>
                {language.t("plugins.social.comment.submit")}
              </Show>
            </button>
          </div>
        </div>

        {/* Comments list */}
        <Show when={comments.isError}>
          <div class="text-13-regular text-text-danger">
            {language.t("plugins.social.comments.loadFailed")}：
            {formatServerError(comments.error, language.t, language.t("plugins.social.comments.loadFailed"))}
          </div>
        </Show>

        <Show when={comments.isLoading}>
          <div class="flex flex-col divide-y divide-border-weak-base">
            <For each={[0, 1, 2]}>
              {() => (
                <div class="flex gap-3 py-4">
                  <div class="size-9 rounded-full bg-surface-base animate-pulse shrink-0" />
                  <div class="flex-1 flex flex-col gap-2">
                    <div class="h-3 w-24 bg-surface-base rounded animate-pulse" />
                    <div class="h-4 w-3/4 bg-surface-base rounded animate-pulse" />
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={!comments.isLoading && !comments.isError}>
          <Show
            when={(comments.data ?? []).length > 0}
            fallback={
              <div class="py-10 text-14-regular text-text-weak text-center">
                {language.t("plugins.social.comments.empty")}
              </div>
            }
          >
            <div class="flex flex-col divide-y divide-border-weak-base">
              <For each={comments.data ?? []}>
                {(comment) => (
                  <CommentRow
                    comment={comment}
                    canDelete={myUuid() !== null && myUuid() === comment.author_uuid}
                    deleting={deleteComment.isPending && deletingId() === comment.id}
                    onDelete={() => deleteComment.mutate(comment.id)}
                  />
                )}
              </For>
            </div>
          </Show>
        </Show>
      </section>
    </div>
  )
}
