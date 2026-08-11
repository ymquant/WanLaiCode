export const lineCommentStyles = `
[data-annotation-slot] {
  padding: 12px;
  box-sizing: border-box;
}

[data-component="line-comment"] {
  position: absolute;
  right: 24px;
  z-index: var(--line-comment-z, 30);
}

[data-component="line-comment"][data-inline] {
  position: relative;
  right: auto;
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: flex-start;
}

[data-component="line-comment"][data-open] {
  z-index: var(--line-comment-open-z, 100);
}

[data-component="line-comment"] [data-slot="line-comment-button"] {
  width: 20px;
  height: 20px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--icon-interactive-base);
  box-shadow: var(--shadow-xs);
  cursor: default;
  border: none;
}

[data-component="line-comment"][data-variant="add"] [data-slot="line-comment-button"] {
  background: var(--syntax-diff-add);
}

[data-component="line-comment"] [data-component="icon"] {
  color: var(--white);
}

[data-component="line-comment"] [data-slot="line-comment-icon"] {
  width: 12px;
  height: 12px;
  color: var(--white);
}

[data-component="line-comment"] [data-slot="line-comment-button"]:focus {
  outline: none;
}

[data-component="line-comment"] [data-slot="line-comment-button"]:focus-visible {
  box-shadow: var(--shadow-xs-border-focus);
}

[data-component="line-comment"] [data-slot="line-comment-popover"] {
  position: absolute;
  top: calc(100% + 4px);
  right: -8px;
  z-index: var(--line-comment-popover-z, 40);
  min-width: 220px;
  max-width: none;
  box-sizing: border-box;
  border-radius: 12px;
  border: 0;
  background: var(--surface-raised-stronger-non-alpha);
  box-shadow: none;
  padding: 12px 14px 10px;
}

[data-component="line-comment"][data-inline] [data-slot="line-comment-popover"] {
  position: relative;
  top: auto;
  right: auto;
  margin-left: 10px;
  flex: 1 1 0%;
  width: auto;
  max-width: 100%;
  min-width: 0;
}

[data-component="line-comment"][data-inline] [data-slot="line-comment-popover"][data-inline-body] {
  margin-left: 0;
}

[data-component="line-comment"][data-inline][data-variant="default"] [data-slot="line-comment-popover"][data-inline-body] {
  cursor: pointer;
}

[data-component="line-comment"][data-variant="editor"] [data-slot="line-comment-popover"] {
  width: 380px;
  max-width: none;
  padding: 10px;
  border-radius: 14px;
}

[data-component="line-comment"][data-inline][data-variant="editor"] [data-slot="line-comment-popover"] {
  width: 100%;
}

[data-component="line-comment"] [data-slot="line-comment-content"] {
  display: flex;
  flex-direction: column;
  gap: 0;
  width: 100%;
  min-width: 0;
}

[data-component="line-comment"] [data-slot="line-comment-header"] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  min-width: 0;
  min-height: 34px;
}

[data-component="line-comment"] [data-slot="line-comment-meta"] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

[data-component="line-comment"] [data-slot="line-comment-title-group"] {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

[data-component="line-comment"] [data-slot="line-comment-title-icon"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: rgba(17, 24, 39, 0.05);
  color: color-mix(in srgb, var(--text-secondary) 78%, var(--text-strong));
}

[data-component="line-comment"] [data-slot="line-comment-title"] {
  font-family: var(--font-family-sans);
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  letter-spacing: var(--letter-spacing-normal);
  color: color-mix(in srgb, var(--text-secondary) 80%, var(--text-strong));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

[data-component="line-comment"] [data-slot="line-comment-label"] {
  flex: 0 0 auto;
  text-align: right;
  color: color-mix(in srgb, var(--text-secondary) 84%, var(--text-weak));
}

[data-component="line-comment"] [data-slot="line-comment-divider"] {
  width: 100%;
  height: 1px;
  background: color-mix(in srgb, var(--border-base) 32%, transparent);
}

[data-component="line-comment"] [data-slot="line-comment-body"] {
  display: flex;
  align-items: flex-start;
  padding: 10px 0 10px;
  min-height: 76px;
  max-height: min(30dvh, 220px);
  overflow-y: auto;
  box-sizing: border-box;
  scrollbar-color: rgba(0, 0, 0, 0.24) transparent;
  scrollbar-width: thin;
}

[data-component="line-comment"] [data-slot="line-comment-body"]::-webkit-scrollbar {
  width: 8px;
}

[data-component="line-comment"] [data-slot="line-comment-body"]::-webkit-scrollbar-track {
  background: transparent;
}

[data-component="line-comment"] [data-slot="line-comment-body"]::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.24);
}

[data-component="line-comment"] [data-slot="line-comment-text"] {
  flex: 1;
  min-width: 0;
  font-family: var(--font-family-sans);
  font-size: 13px;
  font-weight: var(--font-weight-regular);
  line-height: 20px;
  letter-spacing: var(--letter-spacing-normal);
  color: var(--text-strong);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

[data-component="line-comment"] [data-slot="line-comment-footer"] {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  min-height: 30px;
  box-sizing: border-box;
}

[data-component="line-comment"] [data-slot="line-comment-tools"] {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}

[data-component="line-comment"] [data-slot="line-comment-label"],
[data-component="line-comment"] [data-slot="line-comment-editor-label"] {
  font-family: var(--font-family-sans);
  font-size: 11px;
  font-weight: var(--font-weight-medium);
  line-height: 16px;
  letter-spacing: var(--letter-spacing-normal);
  color: var(--text-weak);
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}

[data-component="line-comment"] [data-slot="line-comment-editor"] {
  display: flex;
  flex-direction: column;
  gap: 0;
  width: 100%;
  min-width: 0;
}

[data-component="line-comment"] [data-slot="line-comment-textarea"] {
  width: 100%;
  box-sizing: border-box;
  resize: none;
  min-height: 56px;
  height: 56px;
  max-height: 56px;
  padding: 0;
  border-radius: 0;
  background: transparent;
  border: 0;
  color: var(--text-strong);
  font-family: var(--font-family-sans);
  font-size: 13px;
  line-height: 20px;
}

[data-component="line-comment"] [data-slot="line-comment-textarea"]:focus {
  outline: none;
  box-shadow: none;
}

[data-component="line-comment"] [data-slot="line-comment-mention-list"] {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow: auto;
  padding: 4px;
  border: 1px solid var(--border-base);
  border-radius: var(--radius-md);
  background: var(--surface-base);
}

[data-component="line-comment"] [data-slot="line-comment-mention-item"] {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-strong);
  text-align: left;
}

[data-component="line-comment"] [data-slot="line-comment-mention-item"][data-active] {
  background: var(--surface-raised-base-hover);
}

[data-component="line-comment"] [data-slot="line-comment-mention-path"] {
  display: flex;
  align-items: center;
  min-width: 0;
  font-family: var(--font-family-sans);
  font-size: var(--font-size-small);
  line-height: var(--line-height-large);
}

[data-component="line-comment"] [data-slot="line-comment-mention-dir"] {
  min-width: 0;
  color: var(--text-weak);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

[data-component="line-comment"] [data-slot="line-comment-mention-file"] {
  color: var(--text-strong);
  white-space: nowrap;
}

[data-component="line-comment"] [data-slot="line-comment-actions"] {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 8px;
  min-width: 0;
  min-height: 40px;
}

[data-component="line-comment"] [data-slot="line-comment-actions-spacer"] {
  flex: 1 1 auto;
}

[data-component="line-comment"] [data-slot="line-comment-action"] {
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-strong);
  border-radius: 999px;
  height: 30px;
  padding: 0 10px;
  font-family: var(--font-family-sans);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  transition:
    background 120ms ease,
    color 120ms ease,
    border-color 120ms ease;
}

[data-component="line-comment"] [data-slot="line-comment-action"][data-variant="ghost"] {
  background: transparent;
  color: color-mix(in srgb, var(--text-secondary) 82%, var(--text-strong));
}

[data-component="line-comment"] [data-slot="line-comment-action"][data-variant="primary"] {
  background: color-mix(in srgb, var(--text-strong) 92%, var(--black));
  border-color: color-mix(in srgb, var(--text-strong) 92%, var(--black));
  color: var(--background-base, var(--white));
  min-width: 60px;
  padding: 0 8px;
  justify-content: center;
}

[data-component="line-comment"] [data-slot="line-comment-action"][data-variant="danger-soft"] {
  background: color-mix(in srgb, var(--red-500, #ff6f61) 14%, var(--background-base));
  color: color-mix(in srgb, var(--red-500, #ff6f61) 78%, var(--text-strong));
}

[data-component="line-comment"] [data-slot="line-comment-action"]:hover {
  background: color-mix(in srgb, var(--surface-secondary) 72%, var(--background-base));
}

[data-component="line-comment"] [data-slot="line-comment-action"][data-variant="primary"]:hover {
  background: color-mix(in srgb, var(--text-strong) 96%, var(--black));
}

[data-component="line-comment"] [data-slot="line-comment-action"][data-variant="danger-soft"]:hover {
  background: color-mix(in srgb, var(--red-500, #ff6f61) 18%, var(--background-base));
}

[data-component="line-comment"] [data-slot="line-comment-action"]:disabled {
  opacity: 0.5;
  pointer-events: none;
}

[data-lc-host] [data-component="line-comment"][data-inline],
[data-lc-host] [data-slot="line-comment-popover"] {
  max-width: 100% !important;
}
`

export function installLineCommentStyles() {
  if (typeof document === "undefined") return

  const id = "opencode-line-comment-styles"
  const existing = document.getElementById(id)
  if (existing?.tagName === "STYLE") {
    existing.textContent = lineCommentStyles
    return
  }

  const style = document.createElement("style")
  style.id = id
  style.textContent = lineCommentStyles
  document.head.appendChild(style)
}

installLineCommentStyles()
