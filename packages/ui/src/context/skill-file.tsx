import { createContext, useContext, type ParentProps } from "solid-js"

export type OpenSkillFileInput = {
  path: string
  name?: string
  displayName?: string
}

export type OpenSkillFile = (input: string | OpenSkillFileInput) => void | Promise<void>

const SkillFileContext = createContext<OpenSkillFile | undefined>()

export function SkillFileProvider(props: ParentProps<{ openSkillFile?: OpenSkillFile }>) {
  return <SkillFileContext.Provider value={props.openSkillFile}>{props.children}</SkillFileContext.Provider>
}

export function useSkillFile() {
  return useContext(SkillFileContext)
}
