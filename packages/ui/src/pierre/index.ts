import { DiffLineAnnotation, FileContents, FileDiffOptions, type SelectedLineRange } from "@pierre/diffs"
import { ComponentProps } from "solid-js"
import { lineCommentStyles } from "../components/line-comment-styles"
import { fileThemeName } from "./monokai-theme"

export type DiffProps<T = {}> = FileDiffOptions<T> & {
  before: FileContents
  after: FileContents
  annotations?: DiffLineAnnotation<T>[]
  selectedLines?: SelectedLineRange | null
  commentedLines?: SelectedLineRange[]
  onLineNumberSelectionEnd?: (selection: SelectedLineRange | null) => void
  onRendered?: () => void
  class?: string
  classList?: ComponentProps<"div">["classList"]
}

const unsafeCSS = `
[data-diff],
[data-file] {
  --diffs-bg: var(--diffs-bg-override, var(--diffs-custom-bg));
  --diffs-bg-buffer: var(--diffs-bg-buffer-override, var(--diffs-custom-bg));
  --diffs-bg-hover: var(--diffs-bg-hover-override, var(--diffs-custom-bg));
  --diffs-bg-context: var(--diffs-bg-context-override, var(--diffs-custom-bg));
  --diffs-bg-separator: var(--diffs-bg-separator-override, var(--diffs-custom-bg));
  --diffs-fg: light-dark(var(--diffs-light), var(--diffs-dark));
  --diffs-fg-number: var(--diffs-fg-number-override, color-mix(in lab, var(--diffs-fg) 65%, var(--diffs-custom-bg)));
  --diffs-deletion-base: var(
    --diffs-deletion-color-override,
    light-dark(#e14775, #fc618d)
  );
  --diffs-addition-base: var(
    --diffs-addition-color-override,
    light-dark(#269d69, #7bd88f)
  );
  --diffs-bg-deletion: var(
    --diffs-bg-deletion-override,
    light-dark(
      color-mix(in lab, var(--diffs-bg) 88%, var(--diffs-deletion-base)),
      color-mix(in lab, var(--diffs-bg) 80%, var(--diffs-deletion-base))
    )
  );
  --diffs-bg-deletion-number: var(
    --diffs-bg-deletion-number-override,
    light-dark(
      color-mix(in lab, var(--diffs-bg) 91%, var(--diffs-deletion-base)),
      color-mix(in lab, var(--diffs-bg) 85%, var(--diffs-deletion-base))
    )
  );
  --diffs-bg-deletion-hover: var(
    --diffs-bg-deletion-hover-override,
    light-dark(
      color-mix(in lab, var(--diffs-bg) 80%, var(--diffs-deletion-base)),
      color-mix(in lab, var(--diffs-bg) 75%, var(--diffs-deletion-base))
    )
  );
  --diffs-bg-deletion-emphasis: var(
    --diffs-bg-deletion-emphasis-override,
    light-dark(
      rgb(from var(--diffs-deletion-base) r g b / 0.15),
      rgb(from var(--diffs-deletion-base) r g b / 0.2)
    )
  );
  --diffs-bg-addition: var(
    --diffs-bg-addition-override,
    light-dark(
      color-mix(in lab, var(--diffs-bg) 88%, var(--diffs-addition-base)),
      color-mix(in lab, var(--diffs-bg) 80%, var(--diffs-addition-base))
    )
  );
  --diffs-bg-addition-number: var(
    --diffs-bg-addition-number-override,
    light-dark(
      color-mix(in lab, var(--diffs-bg) 91%, var(--diffs-addition-base)),
      color-mix(in lab, var(--diffs-bg) 85%, var(--diffs-addition-base))
    )
  );
  --diffs-bg-addition-hover: var(
    --diffs-bg-addition-hover-override,
    light-dark(
      color-mix(in lab, var(--diffs-bg) 80%, var(--diffs-addition-base)),
      color-mix(in lab, var(--diffs-bg) 70%, var(--diffs-addition-base))
    )
  );
  --diffs-bg-addition-emphasis: var(
    --diffs-bg-addition-emphasis-override,
    light-dark(
      rgb(from var(--diffs-addition-base) r g b / 0.15),
      rgb(from var(--diffs-addition-base) r g b / 0.2)
    )
  );
  --diffs-selection-base: var(--diffs-selection-border, #a59fa0);
  --diffs-selection-border: #a59fa0;
  --diffs-selection-number-fg: #29242a;
  --diffs-bg-selection: var(--diffs-bg-selection-override, #706b6e26);
  --diffs-bg-selection-number: var(--diffs-bg-selection-number-override, #706b6e33);
  --diffs-bg-selection-text: rgb(from var(--diffs-selection-base) r g b / 0.2);
}

:host([data-color-scheme='dark']) [data-diff],
:host([data-color-scheme='dark']) [data-file] {
  --diffs-selection-border: #69676c;
  --diffs-selection-number-fg: #f7f1ff;
  --diffs-bg-selection: var(--diffs-bg-selection-override, #bab6c026);
  --diffs-bg-selection-number: var(--diffs-bg-selection-number-override, #bab6c040);
}

/* 浏览器默认选中色，自动适配深色/浅色 */
[data-diff] ::selection,
[data-file] ::selection {
  background-color: Highlight;
  color: HighlightText;
}

::highlight(opencode-find) {
  background-color: rgb(from var(--surface-warning-base) r g b / 0.35);
}

::highlight(opencode-find-current) {
  background-color: rgb(from var(--surface-warning-strong) r g b / 0.55);
}

[data-diff] [data-line][data-comment-selected]:not([data-selected-line]) {
  box-shadow: none;
}

[data-file] [data-line][data-comment-selected]:not([data-selected-line]) {
  box-shadow: none;
}

[data-diff] [data-column-number][data-comment-selected]:not([data-selected-line]) {
  box-shadow: none;
  color: inherit;
}

[data-file] [data-column-number][data-comment-selected]:not([data-selected-line]) {
  box-shadow: none;
  color: inherit;
}

[data-diff] [data-line-annotation][data-comment-selected]:not([data-selected-line]) [data-annotation-content] {
  box-shadow: none;
}

[data-file] [data-line-annotation][data-comment-selected]:not([data-selected-line]) [data-annotation-content] {
  box-shadow: none;
}

[data-diff] [data-line][data-selected-line] {
  background-color: var(--diffs-bg-selection);
  box-shadow: inset 2px 0 0 var(--diffs-selection-border);
}

[data-file] [data-line][data-selected-line] {
  background-color: var(--diffs-bg-selection);
  box-shadow: inset 2px 0 0 var(--diffs-selection-border);
}

[data-diff] [data-column-number][data-selected-line] {
  background-color: var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

[data-file] [data-column-number][data-selected-line] {
  background-color: var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

[data-diff] [data-column-number][data-line-type='context'][data-selected-line],
[data-diff] [data-column-number][data-line-type='context-expanded'][data-selected-line],
[data-diff] [data-column-number][data-line-type='change-addition'][data-selected-line],
[data-diff] [data-column-number][data-line-type='change-deletion'][data-selected-line] {
  color: var(--diffs-selection-number-fg);
}

/* The deletion word-diff emphasis is stronger than additions; soften it while selected so the selection highlight reads consistently. */
[data-diff] [data-line][data-line-type='change-deletion'][data-selected-line] {
  --diffs-bg-deletion-emphasis: light-dark(
    rgb(from var(--diffs-deletion-base) r g b / 0.07),
    rgb(from var(--diffs-deletion-base) r g b / 0.1)
  );
}

[data-diff-header],
[data-diff],
[data-file] {
  [data-separator] {
    height: 24px;
  }
  [data-column-number] {
    background-color: var(--diffs-column-number-bg);
    cursor: default !important;
  }

  &[data-interactive-line-numbers] [data-column-number] {
    cursor: default !important;
  }

  &[data-interactive-lines] [data-line] {
    cursor: auto !important;
  }
  [data-code] {
    overflow-x: auto !important;
    overflow-y: clip !important;
  }
}

/* 评论固定在代码可视区域内，同时避开左侧行号栏。 */
[data-overflow='scroll'] [data-annotation-content] {
  left: 75px !important;
  width: calc(var(--diffs-column-content-width, 100%) - 75px) !important;
}

${lineCommentStyles}

`

export function createDefaultOptions<T>(style: FileDiffOptions<T>["diffStyle"]) {
  return {
    theme: fileThemeName,
    themeType: "system",
    disableLineNumbers: false,
    overflow: "wrap",
    diffStyle: style ?? "unified",
    diffIndicators: "bars",
    lineHoverHighlight: "both",
    disableBackground: false,
    expansionLineCount: 20,
    hunkSeparators: "line-info-basic",
    lineDiffType: style === "split" ? "word-alt" : "none",
    maxLineDiffLength: 1000,
    maxLineLengthForHighlighting: 1000,
    disableFileHeader: true,
    unsafeCSS,
  } as const
}

export const styleVariables = {
  "--diffs-font-family": "var(--font-family-mono)",
  "--diffs-font-size": "var(--font-size-small)",
  "--diffs-line-height": "24px",
  "--diffs-tab-size": 2,
  "--diffs-font-features": "var(--font-family-mono--font-feature-settings)",
  "--diffs-header-font-family": "var(--font-family-sans)",
  "--diffs-gap-block": 0,
  "--diffs-min-number-column-width": "4ch",
  "--diffs-light-bg": "var(--background-base)",
  "--diffs-dark-bg": "var(--background-base)",
  "--diffs-light": "var(--text-base)",
  "--diffs-dark": "var(--text-base)",
  "--diffs-fg-number-override": "var(--file-line-number)",
}
