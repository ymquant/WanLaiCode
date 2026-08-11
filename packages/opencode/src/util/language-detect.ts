// 按目标语言的主文字脚本，判断文本是否"已经是该语言"（是则跳过翻译以省 token）。
// 非拉丁文字按 Unicode 区段占比判断；英文按 ASCII 占比判断；其它拉丁语系无法可靠区分，返回 false（默认翻译）。

// BCP47 主语言码 → 该语言主文字的 Unicode 区段正则
const TARGET_RE: Record<string, RegExp> = {
  zh: /[㐀-䶿一-鿿豈-﫿]/g, // 汉字（含繁体兼容区）
  ja: /[぀-ゟ゠-ヿ㐀-䶿一-鿿]/g, // 假名 + 汉字
  ko: /[ᄀ-ᇿ가-힯]/g, // 谚文
  ru: /[Ѐ-ӿ]/g, // 西里尔
  ar: /[؀-ۿ]/g, // 阿拉伯
  th: /[฀-๿]/g, // 泰文
}

// 经验阈值：去空白后目标脚本字符占比 ≥20% 即认定「已是该语言」。偏低是有意的——
// 推理摘要常夹杂英文术语/代码，目标若为中日韩等非拉丁语系，达到 20% 已足够判定无需翻译。
// 代价：以技术英文为主、仅含少量中文姓名的文本可能被误判为中文而跳过（概率低，可接受）。
const SCRIPT_THRESHOLD = 0.2
// 英文目标：ASCII 占比 ≥70% 即认定已是英文（拉丁文本天然高 ASCII，留余量给标点/数字）。
const ASCII_THRESHOLD = 0.7

export function isLikelyLanguage(text: string, tag: string): boolean {
  const compact = text.replace(/\s+/g, "")
  if (compact.length === 0) return true
  const lang = tag.toLowerCase().split("-")[0]
  if (lang === "en") {
    const ascii = (compact.match(/[\x00-\x7f]/g) ?? []).length
    return ascii / compact.length >= ASCII_THRESHOLD
  }
  const re = TARGET_RE[lang]
  if (!re) return false // 拉丁语系（德/法/西…）：检测不可靠 → 默认翻译
  const hits = (compact.match(re) ?? []).length
  return hits / compact.length >= SCRIPT_THRESHOLD
}

export * as LanguageDetect from "./language-detect"
