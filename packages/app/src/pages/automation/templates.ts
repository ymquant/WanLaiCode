// 自动化模板库 —— 复刻 Codex「查看模板」弹层的预设模板。
// 每个模板:emoji 图标 + 标题 + 触发周期 + 发给 AI 的 prompt。
// template 统一用 "custom"(后端 daily_brief/weekly_review/project_monitor 是另一组固定值)。

export type TemplateScheduleConfig = { time: string } | { weekday: number; time: string } | { minute: number }

export interface AutomationTemplate {
  id: string
  emoji: string
  title: string
  scheduleKind: "hourly" | "daily" | "weekly"
  scheduleConfig: TemplateScheduleConfig
  prompt: string
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: "bug_scan",
    emoji: "🐞",
    title: "扫描 Bug",
    scheduleKind: "daily",
    scheduleConfig: { time: "09:00" },
    prompt:
      "扫描最近的 commit(自上次运行以来,或过去 24 小时内),查找可能的 bug 并提出最小修复方案。依据规则:- 只使用仓库中的具体证据(commit SHA、PR、文件路径、diff、失败的测试、CI 信号)。- 不要臆造 bug;如果证据不足,请说明并跳过。- 优先选择最小且安全的修复;避免重构和无关清理。",
  },
  {
    id: "release_notes",
    emoji: "📖",
    title: "每周发布说明",
    scheduleKind: "weekly",
    scheduleConfig: { weekday: 5, time: "17:00" },
    prompt:
      "根据已合并的 PR 起草每周发布说明(如有链接请附上)。范围与依据:- 严格以该仓库当周历史记录为限;不要添加超出数据支持的额外部分。- 使用 PR 编号/标题;除非仓库中的 PR 描述、测试或指标支持,否则避免对影响作出结论。",
  },
  {
    id: "standup",
    emoji: "💬",
    title: "站会总结",
    scheduleKind: "daily",
    scheduleConfig: { time: "09:00" },
    prompt:
      "为站会总结昨天的 git 活动。依据规则:- 陈述应锚定到 commit/PR/文件;不要臆测意图或未来工作。- 保持便于快速浏览,并适合团队同步。",
  },
  {
    id: "ci_summary",
    emoji: "🎯",
    title: "CI 失败总结",
    scheduleKind: "daily",
    scheduleConfig: { time: "10:00" },
    prompt:
      "总结上一个 CI 窗口中的 CI 失败和不稳定测试;提出首要修复建议。依据规则:- 尽可能引用具体作业、测试、错误信息或日志片段。- 避免过度自信地断言根因;区分“已观察到”与“疑似”。",
  },
  {
    id: "mini_game",
    emoji: "⭐️",
    title: "经典小游戏",
    scheduleKind: "weekly",
    scheduleConfig: { weekday: 5, time: "15:00" },
    prompt:
      "创建一个范围尽可能小的经典小游戏。约束:- 除非必要,否则不要添加额外功能、样式系统、内容或新的依赖项。- 复用现有仓库的工具和模式。",
  },
  {
    id: "skill_suggest",
    emoji: "🗂️",
    title: "技能提升建议",
    scheduleKind: "weekly",
    scheduleConfig: { weekday: 1, time: "09:00" },
    prompt:
      "根据近期 PR 和评审,建议下一步需要深入提升的技能。依据规则:- 每条建议都要锚定具体证据(PR 主题、评审意见、反复出现的问题)。- 避免空泛建议;每条建议都要可执行且具体。",
  },
  {
    id: "weekly_update",
    emoji: "🧑‍💻",
    title: "每周更新汇总",
    scheduleKind: "weekly",
    scheduleConfig: { weekday: 5, time: "16:00" },
    prompt:
      "将本周的 PR、发布、故障事件和评审汇总成一份每周更新。依据规则:- 不要虚构事件;如果数据缺失,请简要说明。- 在条件允许时,优先使用具体引用(PR 编号、故障事件 ID、发布说明、文件路径)。",
  },
  {
    id: "regression_check",
    emoji: "📊",
    title: "回归标记",
    scheduleKind: "daily",
    scheduleConfig: { time: "08:00" },
    prompt:
      "将最近的更改与基准测试或追踪结果进行比较,并尽早标记回归。依据规则:- 所有判断都应以可测量的信号(基准测试、追踪、耗时、火焰图)为依据。- 如果没有测量数据,请注明“未找到测量数据”,不要猜测。",
  },
  {
    id: "dep_align",
    emoji: "✅",
    title: "依赖对齐",
    scheduleKind: "weekly",
    scheduleConfig: { weekday: 2, time: "10:00" },
    prompt:
      "检测依赖项和 SDK 漂移,并提出最小对齐方案。依据规则:- 尽可能从仓库中引用当前版本和目标版本(锁文件、包清单文件)。- 不要猜测版本;如果目标不明确,请提出可选方案并标明为建议。",
  },
  {
    id: "test_coverage",
    emoji: "🔥",
    title: "补充测试",
    scheduleKind: "daily",
    scheduleConfig: { time: "11:00" },
    prompt:
      "找出近期变更中未测试的路径;补充有针对性的测试,并对草稿 PR 使用 $yeet。约束:- 范围仅限变更区域;避免大范围重构。- 优先编写小而可靠的测试,确保修改前失败、修改后通过。",
  },
  {
    id: "release_check",
    emoji: "🟢",
    title: "发布前检查",
    scheduleKind: "weekly",
    scheduleConfig: { weekday: 4, time: "15:00" },
    prompt:
      "打标签前,请核对变更日志、迁移、功能开关和测试。依据规则:- 仅报告您能从仓库和 CI 上下文中确认的内容。- 如果某项检查无法验证,请明确标记为“未知”。",
  },
  {
    id: "agents_md",
    emoji: "📄",
    title: "更新 AGENTS.md",
    scheduleKind: "weekly",
    scheduleConfig: { weekday: 5, time: "14:00" },
    prompt:
      "用新发现的工作流程和命令更新 AGENTS.md。约束:- 保持改动最小、准确,并以仓库中的实际用法为依据。- 不要改动无关部分或自动生成的文件。- 如果不确定,优先添加带简短说明的 TODO,而不是编造内容。",
  },
  {
    id: "pr_summary",
    emoji: "📋",
    title: "PR 周报",
    scheduleKind: "weekly",
    scheduleConfig: { weekday: 1, time: "09:30" },
    prompt:
      "按团队成员和主题总结上周的 PR,并突出显示风险。依据规则:- 有 PR 编号或标题时请使用。- 避免推测影响;只说明 PR 实际变更的内容。",
  },
  {
    id: "issue_triage",
    emoji: "⚠️",
    title: "问题分诊",
    scheduleKind: "daily",
    scheduleConfig: { time: "09:00" },
    prompt:
      "分诊新问题;建议负责人、优先级和标签。依据规则:- 根据问题内容 + 仓库上下文(CODEOWNERS、涉及区域、以往类似问题)给出建议。- 没有明确信号时不要猜测负责人;如不明确,请写“Owner: Unknown”,并改为建议一个团队。",
  },
  {
    id: "ci_root_cause",
    emoji: "⌨️",
    title: "CI 根因分组",
    scheduleKind: "daily",
    scheduleConfig: { time: "10:30" },
    prompt:
      "检查 CI 失败;按可能的根本原因分组,并建议最小修复方案。依据规则:- 引用作业、测试、错误和日志证据。- 避免过于自信地断定根本原因;将不确定项标记为“疑似”。",
  },
  {
    id: "dep_upgrade",
    emoji: "📦",
    title: "依赖升级",
    scheduleKind: "weekly",
    scheduleConfig: { weekday: 3, time: "10:00" },
    prompt:
      "扫描过时的依赖项;以最小改动提出安全升级方案。规则:- 优先采用最小可行的升级集合。- 明确标出破坏性变更风险和所需迁移。- 在未从仓库识别出当前版本前,不要提出升级建议。",
  },
  {
    id: "perf_audit",
    emoji: "⚡️",
    title: "性能审计",
    scheduleKind: "weekly",
    scheduleConfig: { weekday: 4, time: "11:00" },
    prompt:
      "审计性能回归,并提出收益最高的修复建议。依据规则:- 有测量数据或跟踪信息时,所有判断都应以其为依据。- 若证据不足,应简要说明不确定性,并建议下一步要测量的内容。",
  },
  {
    id: "changelog",
    emoji: "✏️",
    title: "更新变更日志",
    scheduleKind: "weekly",
    scheduleConfig: { weekday: 5, time: "16:30" },
    prompt:
      "用本周亮点和关键 PR 链接更新变更日志。约束:- 仅包含有仓库历史支持的条目。- 保持结构简洁,并与现有变更日志格式一致。",
  },
]
