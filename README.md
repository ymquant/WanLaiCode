<div align="center">

<img src="assets/logo.png" alt="万来 Code" height="88" />

# 万来 Code

### 面向开发者的开源 AI 编程客户端

[简体中文](README.md) · [English](README.en.md)

[![Website](https://img.shields.io/badge/官网-wanlai.ai-000?style=flat-square)](https://wanlai.ai)
[![Release](https://img.shields.io/github/v/release/ymquant/WanLaiCode?style=flat-square&color=000)](https://github.com/ymquant/WanLaiCode/releases)
[![Issues](https://img.shields.io/github/issues/ymquant/WanLaiCode?style=flat-square&color=000)](https://github.com/ymquant/WanLaiCode/issues)
[![License](https://img.shields.io/badge/license-MIT-000?style=flat-square)](LICENSE)

[官网](https://wanlai.ai) ·
[文档](https://doc.wanlai.ai/) ·
[下载](https://github.com/ymquant/WanLaiCode/releases) ·
[反馈](https://github.com/ymquant/WanLaiCode/issues)

</div>

<img src="assets/readme-preview.png" alt="万来 Code 概念产品视觉图" width="100%" />

<p align="center"><sub>概念产品视觉图，实际界面可能随版本更新而变化。</sub></p>

## 项目介绍

万来 Code 是一款支持 macOS、Windows、Linux 和命令行的 AI 编程客户端，帮助开发者在一个工作空间内理解代码、编辑文件、运行命令并完成多步骤开发任务。

本仓库公开客户端、CLI、SDK、插件接口和公共 UI 的源码，方便社区审阅、构建和参与开发。

## 核心能力

- 桌面客户端与 CLI，覆盖常见开发环境
- AI 辅助的代码理解、编辑、命令执行和任务协作
- 可扩展的 SDK、插件接口与公共 UI 组件
- 面向 macOS、Windows 和 Linux 的自动化构建与发布流程

## 开源范围

本仓库聚焦可在本地构建和审阅的客户端能力。账号、计费、模型网关、企业服务、官网和内部部署基础设施不属于本仓库的开源范围。

客户端可以连接万来提供的在线服务，也可以按代码中已有能力配置其他兼容服务。完整的开源边界与上游声明见 [NOTICE.md](NOTICE.md)。

## 下载

正式安装包统一通过 [GitHub Releases](https://github.com/ymquant/WanLaiCode/releases) 发布：

| 平台 | 安装包 |
| --- | --- |
| macOS Apple Silicon / Intel | `.dmg`、`.zip` |
| Windows x64 | `.exe` |
| Linux x64 | `.AppImage`、`.deb`、`.rpm` |

只有经过项目维护者签名并出现在本仓库 Releases 中的安装包才是官方发行版。不要安装 PR、Issue 或第三方网盘提供的可执行文件。

## 本地开发

需要仓库 `package.json` 指定版本的 Bun，以及 Node.js、Rust 和各平台桌面打包工具链。

```bash
bun install --frozen-lockfile

cd packages/opencode
bun typecheck

cd ../desktop
bun typecheck
bun run build
```

测试必须从具体 package 目录运行，禁止从仓库根目录运行整仓测试。

## 参与贡献

提交 PR 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。来自 fork 的代码只会在无 Secret 的 GitHub-hosted runner 上执行；正式发版由受保护的独立流程完成。

如果你发现安全问题，请按 [SECURITY.md](SECURITY.md) 中的私密渠道报告，不要创建公开 Issue。

## 开源许可与上游声明

项目采用 [MIT License](LICENSE)。本项目包含基于 OpenCode 及其他开源项目修改的代码，详情见 [NOTICE.md](NOTICE.md) 和各依赖自身的许可证。
