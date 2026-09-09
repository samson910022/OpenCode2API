# OpenCode2API Docs

<p align="center">
  <img src="https://img.shields.io/badge/version-1.6.0-blue" alt="Version">
</p>

> **Language:** [English](./README.md) | [简体中文](./README.zh-CN.md) *(per-guide Chinese versions, see Translation status below)*
>
> 🏠 [Main README](../README.md) | [简体中文 README](../README.zh-CN.md) | 🐛 [Issues](https://github.com/samson910022/OpenCode2API/issues)

Welcome to the OpenCode2API documentation.

---

## 📚 Index

| Section | Description |
|:-----|:-----|
| 📖 [Getting Started](./getting-started.md) | Quick start guide |
| ⚙️ [Configuration](./configuration.md) | Env vars + `config.json` reference |
| 🔌 [API Reference](./api-reference.md) | Endpoints, auth, streaming, errors |
| 🐳 [Docker Deployment](./docker.md) | Compose + `docker run` + multi-arch |
| 🔧 [Troubleshooting](./troubleshooting.md) | FAQ + debug mode |
| 💻 [Development](./development.md) | Build + test + layout |
| 🏗️ [Architecture](./architecture.md) | Runtime shape + extension points |
| 📄 [Main README](../README.md) | English canonical entrypoint |
| 📄 [README (简体中文)](../README.zh-CN.md) | Simplified Chinese mirror of the main README |

Detailed endpoint diagnostics live with the configuration guide for now: `/health/details` and `/metrics` are specified in [Configuration](./configuration.md) and summarized in the [Main README](../README.md#api-reference). A dedicated section in [API Reference](./api-reference.md) is tracked below.

---

## 🌐 Translation status

Docs are migrating to **English-first**: the root [`README.md`](../README.md) is the English canonical homepage and [`README.zh-CN.md`](../README.zh-CN.md) is its Simplified Chinese mirror. The per-guide files below remain **Simplified Chinese for now**; their English canonical versions are tracked as follow-ups and must fix the naming drifts first (env `OPENCODE_*` vs file short keys, see `docs/configuration.md`).

| Guide | Current language | English version |
|:------|:-----------------|:----------------|
| Getting Started | 简体中文 | tracked |
| Configuration | 简体中文 | tracked (canonical env names fixed; see `AGENTS.md` §4) |
| API Reference | 简体中文 + EN examples | tracked (needs `/health/details` + `/metrics` sections) |
| Docker Deployment | 简体中文 | tracked |
| Troubleshooting | 简体中文 | tracked (smallest, do first) |
| Development | 简体中文 | tracked (dedupe with `CONTRIBUTING.md`) |

> Note: `docs/host-deployments.md` and `custom-bin/` are **local-only** (git-ignored via `.gitignore` / `.git/info/exclude`, never committed). They are intentionally absent from this index.

---

## 🔗 Related links

- 📄 [README (English)](../README.md)
- 📄 [README (简体中文)](../README.zh-CN.md)
- 🐙 [GitHub repo](https://github.com/samson910022/OpenCode2API)
- 🐛 [Issues](https://github.com/samson910022/OpenCode2API/issues)
