import { RegisteredCustomThemes, registerCustomTheme, ResolvedThemes, type ThemeRegistrationResolved } from "@pierre/diffs"

const FILE_THEME = "MonokaiFile"

RegisteredCustomThemes.delete(FILE_THEME)
ResolvedThemes.delete(FILE_THEME)

registerCustomTheme(FILE_THEME, () => {
  return Promise.resolve({
    name: FILE_THEME,
    colors: {
      "editor.background": "var(--file-editor-background)",
      "editor.foreground": "var(--file-editor-foreground)",
      "gitDecoration.addedResourceForeground": "var(--file-syntax-diff-add)",
      "gitDecoration.deletedResourceForeground": "var(--file-syntax-diff-delete)",
    },
    tokenColors: [
      {
        scope: ["comment", "punctuation.definition.comment", "string.comment"],
        settings: {
          foreground: "var(--file-syntax-comment)",
        },
      },
      {
        scope: ["entity.other.attribute-name"],
        settings: {
          foreground: "var(--file-syntax-attribute)",
        },
      },
      {
        scope: ["constant", "entity.name.constant", "variable.other.constant", "variable.language", "entity"],
        settings: {
          foreground: "var(--file-syntax-constant)",
        },
      },
      {
        scope: ["entity.name", "meta.export.default", "meta.definition.variable"],
        settings: {
          foreground: "var(--file-syntax-type)",
        },
      },
      {
        scope: ["meta.object.member"],
        settings: {
          foreground: "var(--file-syntax-property)",
        },
      },
      {
        scope: [
          "variable.parameter.function",
          "meta.jsx.children",
          "meta.block",
          "meta.tag.attributes",
          "entity.name.constant",
          "meta.embedded.expression",
          "meta.template.expression",
          "string.other.begin.yaml",
          "string.other.end.yaml",
        ],
        settings: {
          foreground: "var(--file-syntax-punctuation)",
        },
      },
      {
        scope: ["entity.name.function", "support.type.primitive", "support.function"],
        settings: {
          foreground: "var(--file-syntax-function)",
        },
      },
      {
        scope: ["support.class.component"],
        settings: {
          foreground: "var(--file-syntax-type)",
        },
      },
      {
        scope: ["keyword.other.unit", "keyword.control.at-rule"],
        settings: {
          foreground: "var(--file-syntax-constant)",
        },
      },
      {
        scope: "keyword",
        settings: {
          foreground: "var(--file-syntax-keyword)",
        },
      },
      {
        scope: [
          "keyword.operator",
          "storage.type.function.arrow",
          "punctuation.separator.key-value.css",
          "entity.name.tag.yaml",
          "punctuation.separator.key-value.mapping.yaml",
        ],
        settings: {
          foreground: "var(--file-syntax-operator)",
        },
      },
      {
        scope: ["storage", "storage.type"],
        settings: {
          foreground: "var(--file-syntax-keyword)",
        },
      },
      {
        scope: ["storage.modifier.package", "storage.modifier.import", "storage.type.java"],
        settings: {
          foreground: "var(--file-syntax-primitive)",
        },
      },
      {
        scope: ["string", "punctuation.definition.string", "string punctuation.section.embedded source"],
        settings: {
          foreground: "var(--file-syntax-string)",
        },
      },
      {
        scope: "entity.name.tag",
        settings: {
          foreground: "var(--file-syntax-tag)",
        },
      },
      {
        scope: "support",
        settings: {
          foreground: "var(--file-syntax-function)",
        },
      },
      {
        scope: ["support.type.object.module", "variable.other.object"],
        settings: {
          foreground: "var(--file-syntax-object)",
        },
      },
      {
        scope: ["support.type.property-name.css"],
        settings: {
          foreground: "var(--file-syntax-property)",
        },
      },
      {
        scope: "meta.property-name",
        settings: {
          foreground: "var(--file-syntax-property)",
        },
      },
      {
        scope: "variable",
        settings: {
          foreground: "var(--file-syntax-variable)",
        },
      },
      {
        scope: "variable.other",
        settings: {
          foreground: "var(--file-syntax-variable)",
        },
      },
      {
        scope: [
          "invalid.broken",
          "invalid.illegal",
          "invalid.unimplemented",
          "invalid.deprecated",
          "message.error",
          "markup.deleted",
          "meta.diff.header.from-file",
          "punctuation.definition.deleted",
          "brackethighlighter.unmatched",
          "token.error-token",
        ],
        settings: {
          foreground: "var(--file-syntax-critical)",
        },
      },
      {
        scope: "carriage-return",
        settings: {
          foreground: "var(--file-syntax-keyword)",
        },
      },
      {
        scope: "string source",
        settings: {
          foreground: "var(--file-syntax-variable)",
        },
      },
      {
        scope: "string variable",
        settings: {
          foreground: "var(--file-syntax-constant)",
        },
      },
      {
        scope: [
          "source.regexp",
          "string.regexp",
          "string.regexp.character-class",
          "string.regexp constant.character.escape",
          "string.regexp source.ruby.embedded",
          "string.regexp string.regexp.arbitrary-repitition",
        ],
        settings: {
          foreground: "var(--file-syntax-regexp)",
        },
      },
      {
        scope: "support.constant",
        settings: {
          foreground: "var(--file-syntax-primitive)",
        },
      },
      {
        scope: "support.variable",
        settings: {
          foreground: "var(--file-syntax-variable)",
        },
      },
      {
        scope: "meta.module-reference",
        settings: {
          foreground: "var(--file-syntax-info)",
        },
      },
      {
        scope: "punctuation.definition.list.begin.markdown",
        settings: {
          foreground: "var(--file-syntax-punctuation)",
        },
      },
      {
        scope: ["markup.heading", "markup.heading entity.name"],
        settings: {
          fontStyle: "bold",
          foreground: "var(--file-syntax-info)",
        },
      },
      {
        scope: "markup.quote",
        settings: {
          foreground: "var(--file-syntax-info)",
        },
      },
      {
        scope: "markup.italic",
        settings: {
          fontStyle: "italic",
        },
      },
      {
        scope: "markup.bold",
        settings: {
          fontStyle: "bold",
          foreground: "var(--file-editor-foreground)",
        },
      },
      {
        scope: [
          "markup.raw",
          "markup.inserted",
          "meta.diff.header.to-file",
          "punctuation.definition.inserted",
          "markup.changed",
          "punctuation.definition.changed",
          "markup.ignored",
          "markup.untracked",
        ],
        settings: {
          foreground: "var(--file-editor-foreground)",
        },
      },
      {
        scope: "meta.diff.range",
        settings: {
          fontStyle: "bold",
          foreground: "var(--file-syntax-unknown)",
        },
      },
      {
        scope: "meta.diff.header",
        settings: {
          foreground: "var(--file-syntax-unknown)",
        },
      },
      {
        scope: "meta.separator",
        settings: {
          fontStyle: "bold",
          foreground: "var(--file-syntax-unknown)",
        },
      },
      {
        scope: "meta.output",
        settings: {
          foreground: "var(--file-syntax-unknown)",
        },
      },
      {
        scope: "meta.export.default",
        settings: {
          foreground: "var(--file-syntax-unknown)",
        },
      },
      {
        scope: [
          "brackethighlighter.tag",
          "brackethighlighter.curly",
          "brackethighlighter.round",
          "brackethighlighter.square",
          "brackethighlighter.angle",
          "brackethighlighter.quote",
        ],
        settings: {
          foreground: "var(--file-syntax-unknown)",
        },
      },
      {
        scope: ["constant.other.reference.link", "string.other.link"],
        settings: {
          fontStyle: "underline",
          foreground: "var(--file-syntax-unknown)",
        },
      },
      {
        scope: "token.info-token",
        settings: {
          foreground: "var(--file-syntax-info)",
        },
      },
      {
        scope: "token.warn-token",
        settings: {
          foreground: "var(--file-syntax-warning)",
        },
      },
      {
        scope: "token.debug-token",
        settings: {
          foreground: "var(--file-syntax-info)",
        },
      },
    ],
    semanticTokenColors: {
      comment: "var(--file-syntax-comment)",
      string: "var(--file-syntax-string)",
      number: "var(--file-syntax-constant)",
      regexp: "var(--file-syntax-regexp)",
      keyword: "var(--file-syntax-keyword)",
      variable: "var(--file-syntax-variable)",
      parameter: "var(--file-syntax-variable)",
      property: "var(--file-syntax-property)",
      function: "var(--file-syntax-primitive)",
      method: "var(--file-syntax-primitive)",
      type: "var(--file-syntax-type)",
      class: "var(--file-syntax-type)",
      namespace: "var(--file-syntax-type)",
      enumMember: "var(--file-syntax-primitive)",
      "variable.constant": "var(--file-syntax-constant)",
      "variable.defaultLibrary": "var(--file-syntax-unknown)",
    },
  } as unknown as ThemeRegistrationResolved)
})

export const fileThemeName = FILE_THEME
