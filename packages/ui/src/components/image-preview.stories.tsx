// @ts-nocheck
import { onMount } from "solid-js"
import * as mod from "./image-preview"
import { Button } from "./button"
import { useImagePreview } from "../context/image-preview"

const docs = `### Overview
Floating image preview window for full-size image inspection.

### API
- Required: \`src\`.
- Optional: \`alt\` text.

### Behavior
- Intended to be used via \`useImagePreview().show\`.
- Supports drag, resize, zoom, and pan.

### Theming/tokens
- Uses \`data-component="image-preview"\` and slot attributes.

`

export default {
  title: "UI/ImagePreview",
  id: "components-image-preview",
  component: mod.ImagePreview,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const Basic = {
  render: () => {
    const imagePreview = useImagePreview()
    const src = "https://placehold.co/640x360/png"

    const open = () => imagePreview.show({ src, alt: "Preview" })

    onMount(open)

    return (
      <Button variant="secondary" onClick={open}>
        Open image preview
      </Button>
    )
  },
}
