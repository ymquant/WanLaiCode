<div align="center">

<img src="assets/logo.png" alt="WanLai Code" height="88" />

# WanLai Code

### More than answers—an agent that keeps moving development work forward

Built on OpenCode · Codex-style interaction · Desktop / CLI · macOS / Windows / Linux

[简体中文](README.md) · [English](README.en.md)

[![Website](https://img.shields.io/badge/website-wanlai.ai-000?style=flat-square)](https://wanlai.ai)
[![Release](https://img.shields.io/github/v/release/ymquant/WanLaiCode?style=flat-square&color=000)](https://github.com/ymquant/WanLaiCode/releases)
[![Issues](https://img.shields.io/github/issues/ymquant/WanLaiCode?style=flat-square&color=000)](https://github.com/ymquant/WanLaiCode/issues)
[![License](https://img.shields.io/badge/license-MIT-000?style=flat-square)](LICENSE)

[Website](https://wanlai.ai) ·
[Documentation](https://doc.wanlai.ai/) ·
[Download](https://github.com/ymquant/WanLaiCode/releases) ·
[Feedback](https://github.com/ymquant/WanLaiCode/issues)

</div>

<img src="assets/readme-preview.en.png" alt="WanLai Code English interface preview" width="100%" />

<p align="center"><sub>Conceptual product visual. The actual interface may change between releases.</sub></p>

## Overview

WanLai Code is an open-source AI coding client built on OpenCode and designed around real development workflows. It goes beyond explaining code: it can inspect projects, edit files, run commands, use tools, and keep moving a multi-step task toward a defined goal.

On top of OpenCode's agent core, WanLai Code adds a fuller desktop workspace and Codex-style interaction. You can steer a task while it is running, let Goal Mode continue autonomously, schedule recurring work with Automations, and extend the workflow with plugins, skills, MCP, project memory, and remote control.

This repository contains the source code for the client, CLI, SDK, plugin interfaces, and public UI so the community can inspect, build, and contribute to the project.

## Why try WanLai Code?

<table>
<tr>
<td width="50%" valign="top">
<h3>🎯 Goal Mode</h3>
<p>Define the outcome and let the agent continue implementing and validating it—without manually sending “continue” after every step.</p>
</td>
<td width="50%" valign="top">
<h3>↪️ Steer while it runs</h3>
<p>Add or correct requirements during an active task. New guidance joins the current turn without discarding completed tool results or context.</p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<h3>⏰ Automations</h3>
<p>Save a prompt with a schedule for recurring work such as code checks, daily summaries, and repository maintenance.</p>
</td>
<td width="50%" valign="top">
<h3>🧩 Plugins, skills, and MCP</h3>
<p>Manage plugins, reusable skills, and MCP servers in the client to connect team tools and specialized workflows.</p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<h3>🧠 Global and project memory</h3>
<p>Keep a small set of reusable preferences and project knowledge that future sessions can load when relevant.</p>
</td>
<td width="50%" valign="top">
<h3>📱 Remote control</h3>
<p>Connect to a desktop session from another device to inspect status and continue long-running development work.</p>
</td>
</tr>
</table>

## How is it different from OpenCode?

WanLai Code is not a simple rebrand. It preserves OpenCode's open-source agent foundation while developing further toward a desktop workspace, Codex-style interaction, and persistent development tasks.

| Area | OpenCode upstream focus | WanLai Code extensions |
| --- | --- | --- |
| Interaction | A general open-source coding agent and terminal workflow | Codex-style desktop sessions, in-flight steering, and visible response/tool phases |
| Long-running tasks | Tasks are initiated and followed up by the user | Goal Mode can continue autonomously with pause, resume, and goal-state controls |
| Recurring work | Usually organized with commands or external systems | Built-in scheduled Automations, run history, and result notifications |
| Extension management | Plugin, tool, and provider foundations | Visual plugin marketplace plus skill and MCP management |
| Context reuse | Project files and conversation context | Managed global/project memory with on-demand retrieval |
| Product surfaces | A local coding agent at the core | Desktop, CLI, SDK, and remote control for persistent workflows |
| Hosted services | Connects to model providers | Optional WanLai hosted services, while retaining supported compatible services |

> This comparison reflects the current repository and OpenCode's upstream positioning; both projects continue to evolve. WanLai Code preserves upstream licensing and attribution—see [NOTICE.md](NOTICE.md).

## A typical task flow

1. Open a local project and describe the desired outcome, not only a single code question.
2. The agent searches code, edits files, runs commands, and presents reasoning phases, tool activity, and changes in one session.
3. Add guidance while it runs; WanLai Code keeps that guidance inside the active task instead of creating an unrelated conversation.
4. Enable Goal Mode to continue checking gaps and running verification until the goal is complete, blocked on confirmation, or paused.
5. Turn repeated work into an Automation, and use remote control to monitor or continue longer tasks.

## Capabilities at a glance

- **End-to-end development loop:** understand code, search files, edit content, execute commands, inspect diffs, and verify results
- **Multi-project desktop workspace:** move between projects, sessions, files, terminals, and task output
- **Controllable agent:** permission modes, in-flight steering, pause/resume, goal state, and visible tool activity
- **Models and providers:** use providers and compatible services already supported by the project
- **Extension system:** SDKs, plugins, skills, MCP, and reusable public UI components
- **Cross-platform distribution:** desktop installers and CLI support for macOS, Windows, and Linux

## Open-source scope

This repository focuses on client-side capabilities that can be built and reviewed locally. Accounts, billing, model gateways, enterprise services, the website, and internal deployment infrastructure are outside this repository's open-source scope.

The client can connect to WanLai's hosted services and can also use other compatible services where supported by the code. See [NOTICE.md](NOTICE.md) for the complete scope and upstream attributions.

## Download

Official installers are published through [GitHub Releases](https://github.com/ymquant/WanLaiCode/releases):

| Platform | Packages |
| --- | --- |
| macOS, Apple Silicon / Intel | `.dmg`, `.zip` |
| Windows x64 | `.exe` |
| Linux x64 | `.AppImage`, `.deb`, `.rpm` |

Only packages signed by the project maintainers and published in this repository's Releases are official distributions. Do not install executables shared through pull requests, issues, or third-party file hosts.

## Local development

You need the Bun version declared in `package.json`, plus Node.js, Rust, and the platform-specific desktop packaging toolchain.

```bash
bun install --frozen-lockfile

cd packages/opencode
bun typecheck

cd ../desktop
bun typecheck
bun run build
```

Run tests from the relevant package directory. The repository intentionally prevents running the entire test suite from the repository root.

## Contributing

Before opening a pull request, read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Code from forks runs only on GitHub-hosted runners without access to secrets; official releases use a separate protected workflow.

If you discover a security issue, report it privately through the channel documented in [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License and upstream projects

WanLai Code is available under the [MIT License](LICENSE). It includes modified code based on OpenCode and other open-source projects. See [NOTICE.md](NOTICE.md) and the licenses of individual dependencies for details.
