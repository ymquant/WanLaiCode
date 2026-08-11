# 参与贡献

感谢参与万来 Code 的开发。

## 提交 Issue

提交前请搜索现有 Issue，并提供版本、操作系统、复现步骤、预期结果和实际结果。日志、截图和示例工程必须先脱敏；不要提交任何真实凭据或个人信息。

安全漏洞请按照 [SECURITY.md](SECURITY.md) 私密报告，不要创建公开 Issue。

## 提交 Pull Request

1. 从最新 `main` 创建小而聚焦的分支。
2. 只修改解决当前问题所必需的文件，不夹带重构或格式化。
3. 为行为变化添加测试，并在对应 package 目录运行测试和类型检查。
4. 更新与用户行为或架构契约相关的文档。
5. 在 PR 中说明变更范围、风险和验证结果。

来自 fork 的 PR 会在无 Secret 的 GitHub-hosted runner 上验证。PR 工作流不会访问发布证书、生产 Token 或内部服务凭据。

## Commit 格式

```text
<type>(<scope>): <subject>
```

常用类型包括 `feat`、`fix`、`docs`、`refactor`、`test` 和 `chore`。`scope` 使用小写英文，主题保持简洁。

## 开发检查

```bash
bun install --frozen-lockfile

cd packages/opencode
bun typecheck

cd ../desktop
bun typecheck
```

测试必须从具体 package 目录运行，不能从仓库根目录运行。

## 许可证

提交贡献即表示你有权提供该内容，并同意按仓库的 MIT License 分发。
