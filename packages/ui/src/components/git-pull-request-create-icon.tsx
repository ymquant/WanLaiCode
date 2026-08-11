import type { Component, ComponentProps } from "solid-js"
import { splitProps } from "solid-js"
import src from "../assets/icons/git-pull-request-create.png"

export type GitPullRequestCreateIconProps = Omit<ComponentProps<"img">, "src" | "alt"> & {
  size?: "small" | "normal" | "title" | "step"
}

const sizeClass = {
  small: "size-[14px]",
  normal: "size-[18px]",
  title: "size-[29px]",
  step: "size-[22px]",
} as const

export const GitPullRequestCreateIcon: Component<GitPullRequestCreateIconProps> = (props) => {
  const [local, rest] = splitProps(props, ["size", "class", "classList"])
  return (
    <img
      data-component="git-pull-request-create-icon"
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      classList={{
        ...local.classList,
        [sizeClass[local.size ?? "small"]]: true,
        [local.class ?? ""]: !!local.class,
      }}
      {...rest}
    />
  )
}
