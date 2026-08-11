import { createSignal } from "solid-js"

export type OpenFileRequest = {
  path: string
  id: number
}

const [openFileRequest, setOpenFileRequest] = createSignal<OpenFileRequest>()
let nextOpenFileRequestID = 0

export function requestOpenFile(path: string) {
  setOpenFileRequest({
    path,
    id: nextOpenFileRequestID++,
  })
}

export function useOpenFileRequest() {
  return openFileRequest
}

export function consumeOpenFileRequest(id?: number) {
  const request = openFileRequest()
  if (!request) return
  if (id !== undefined && request.id !== id) return
  setOpenFileRequest(undefined)
  return request
}
