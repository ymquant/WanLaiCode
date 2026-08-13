<div align="center">

<img src="assets/logo.png" alt="WanLai Code" height="88" />

# WanLai Code

### More than answers—an agent that keeps moving development work forward

Built on OpenCode · Codex-style interaction · Desktop / CLI · macOS / Windows / Linux

[简体中文](README.md) · [English](README.en.md)

[Website](https://wanlai.ai) ·
[Documentation](https://doc.wanlai.ai/) ·
[Download](https://github.com/ymquant/WanLaiCode/releases) ·
[Contributing](CONTRIBUTING.md) ·
[Feedback](https://github.com/ymquant/WanLaiCode/issues)

</div>

<img src="assets/readme-preview.en.png" alt="WanLai Code English interface preview" width="100%" />

<p align="center"><sub>Conceptual product visual. The actual interface may change between releases.</sub></p>

## Overview

WanLai Code is an open-source AI coding client built on OpenCode and designed around real development workflows. It goes beyond explaining code: it can inspect projects, edit files, run commands, use tools, and keep moving a multi-step task toward a defined goal.

On top of OpenCode's agent core, WanLai Code adds a fuller desktop workspace and Codex-style interaction. You can steer a task while it is running, let Goal Mode continue autonomously, schedule recurring work with Automations, and extend the workflow with plugins, skills, MCP, project memory, and remote control.

This repository contains the source code for the client, CLI, SDK, plugin interfaces, and public UI so the community can inspect, build, and contribute to the project.

## Core experience

| Capability | What it solves | Best suited for |
| --- | --- | --- |
| Goal Mode | Keeps the agent implementing and validating toward an outcome without repeated “continue” prompts | Cross-file changes, complete features, long-running tasks |
| In-flight steering | Adds or corrects requirements during an active task while preserving completed tool results and context | Requirement changes, review feedback, new constraints |
| Automations | Saves prompts with schedules and keeps a record of each run | Code checks, daily summaries, repository maintenance |
| Plugins, skills, and MCP | Connects team tools and specialized workflows through managed extensions | Team conventions, internal tools, repeatable workflows |
| Global and project memory | Reuses relevant preferences and project knowledge without repeating the same background | Long-lived projects, collaboration, work across sessions |
| Remote control | Lets another device inspect and continue a desktop task | Builds, test suites, and long-running development work |

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

### Contributor support

We welcome long-term maintenance, feature development, bug fixes, testing, documentation, and localization. For well-scoped contributions that can be merged and maintained, the project may provide a development stipend based on scope, implementation quality, and practical impact. Please agree on the scope and stipend before starting substantial work.

| Contribution area | Examples | Support available |
| --- | --- | --- |
| Product and UX | Agent workflows, desktop experience, cross-platform features | Scope definition, code review, development stipend |
| Reliability and security | Bug fixes, tests, dependency and supply-chain security | Reproduction support, technical collaboration, development stipend |
| Documentation and community | Guides, tutorials, localization, community support | Editorial review, attribution, contribution record |

To get involved, open a [GitHub Issue](https://github.com/ymquant/WanLaiCode/issues) with your proposal, or contact the team through the [WanLai website](https://wanlai.ai) for the WeChat or Telegram community entry. Do not post private contact details in a public issue.

## License and upstream projects

WanLai Code is available under the [MIT License](LICENSE). It includes modified code based on OpenCode and other open-source projects. See [NOTICE.md](NOTICE.md) and the licenses of individual dependencies for details.
