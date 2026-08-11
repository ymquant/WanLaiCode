// settings context (settings.tsx) 深度依赖 solid-js store + platform context，
// 无法在裸 bun test 环境实例化。有价值的纯逻辑测试（如 resolveChannel /
// resolveChannelPath）位于 packages/desktop/scripts/utils.ts，留给 desktop 包补充。
