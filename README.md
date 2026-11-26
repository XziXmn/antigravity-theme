<div align="center">

<h1>antigravity-theme</h1>

<p><strong>Google Antigravity 的 Codex 昼夜主题、中文系本地化、液态玻璃用量卡、系统级提示词与 Hooks 增强插件</strong></p>

<p>
  <a href="#快速安装">快速安装</a> ·
  <a href="#按需安装">按需安装</a> ·
  <a href="#功能详解">功能详解</a> ·
  <a href="#自定义与卸载">自定义与卸载</a> ·
  <a href="#致谢与协议">致谢与协议</a> ·
  <a href="#english-overview">English</a>
</p>

<p>
  不修改安装包，通过本地 CDP 实时注入 Codex 昼夜主题、中文系多变体界面、零闪烁嵌入式「增强设置」面板、Liquid Glass 用量卡与系统级提示词 / Hooks 托管。<br>
  40 个核心文件，支持 <code>--only</code> 按需安装、面板内检查并直接更新与上游词库一键同步。
</p>

<p>
  <a href="https://github.com/XziXmn/antigravity-theme/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/XziXmn/antigravity-theme/ci.yml?branch=main&label=CI&labelColor=363636&logo=githubactions&logoColor=white" alt="CI"></a>
  <img src="https://img.shields.io/static/v1?label=Antigravity&message=2.30.x%20~%202.35.1%2B&color=2B7FFF&labelColor=363636" alt="Antigravity 2.30.x ~ 2.35.1+">
  <img src="https://img.shields.io/static/v1?label=Node.js&message=%3E%3D%2022.13.0&color=339933&labelColor=363636&logo=nodedotjs&logoColor=white" alt="Node.js >= 22.13.0">
  <img src="https://img.shields.io/static/v1?label=platform&message=macOS%20%C2%B7%20Windows%20%C2%B7%20Linux&color=4B5563&labelColor=363636" alt="macOS · Windows · Linux">
  <img src="https://img.shields.io/static/v1?label=version&message=v1.3.5&color=2B7FFF&labelColor=363636" alt="version v1.3.5">
  <a href="LICENSE"><img src="https://img.shields.io/static/v1?label=license&message=GPL--3.0&color=10B981&labelColor=363636" alt="GPL-3.0 License"></a>
</p>

<p>
  <a href="#命令行安装"><img src="https://img.shields.io/static/v1?label=CLI%20INSTALL&message=v1.3.5&color=2B7FFF&style=for-the-badge&labelColor=181818&logo=gnubash&logoColor=white" alt="CLI Install"></a>
  <a href="#ai-一键安装"><img src="https://img.shields.io/static/v1?label=AI%20ONE-CLICK&message=SKILL.md&color=0D9488&style=for-the-badge&labelColor=181818&logo=googlegemini&logoColor=white" alt="AI One-Click Install"></a>
  <a href="#按需安装"><img src="https://img.shields.io/static/v1?label=SELECTIVE%20INSTALL&message=--only&color=6366F1&style=for-the-badge&labelColor=181818&logo=codesandbox&logoColor=white" alt="Selective Install"></a>
</p>

</div>

https://github.com/user-attachments/assets/749990f3-f2ce-48e7-8f66-3d7c88a7d49d

![Codex 浅色与深色模式对比](assets/light-dark-themes.png)

| 模块 | 核心能力 | 启用方式 |
| :--- | :--- | :--- |
| **Codex 昼夜主题** | 纯白浅色 (`codex-pure-white`) 与中性炭灰深色 (`codex-dark`)，无外部字体依赖，随 IDE 外观自动切换 | 默认开启 |
| **原生设置面板与更新** | 直接嵌入 **设置 → 增强设置**（零闪烁就地更新），可视化管理模块开关、多语言风格、模型档位、`sshHosts`、系统提示词、Hooks 与 **检查并直接更新** | 默认内置 |
| **系统级提示词与 Hooks** | 无损托管 `~/.gemini/GEMINI.md`、`~/.gemini/config/rules/*.md`（`trigger: always_on`）与 `hooks.json`（`SessionStart` / `PreInvocation` 系统角色注入 + `PreToolUse` 安全放行守卫） | **默认关闭**（按需开启） |
| **会话状态与用量统计** | 底部四态指示与 **Liquid Glass 液态玻璃** 一/二级用量面板、每轮悬浮详情卡，覆盖主对话、旁路提问与可选 **SSH Remote** | 默认开启（SSH 可选） |
| **中文系界面汉化** | 融合上游精校 `2,300+` 词条，支持 **简体中文 (`zh-CN`) / 英文术语简中 (`zh-SG`) / 繁體中文 (`zh-TW`) / 原版英文** 即时切换，可选联动 AI 思考与回复语言 | 默认开启 |
| **输入框下一句预测** | 回复结束后在空输入框显示 Ghost Text，按 `Tab` / `→` 补全，内置 `agy models` 二级级联模型选择 | **默认关闭**（按需开启） |

## 快速安装

> **前置要求**：**Node.js >= 22.13.0**（见 [package.json](package.json)）与 Google Antigravity（`2.30.x` ~ `2.35.1+`），已完成 **macOS / Windows / Linux** 桌面端实机安装与卸载验证。插件仅部署至 `~/.gemini/antigravity/codex-theme`，**不修改应用安装包**；若安装前应用已在无调试端口状态下运行，重启一次或在外部终端运行 `node install.mjs relaunch` 即可生效。

<details>
<summary>查看各平台实测细节与 Antigravity 2.33.0+ 调试端口说明</summary>

- **实机验证范围**：覆盖 Antigravity `2.31.0` / `2.32.1` / `2.33.0` / `2.34.0` / `2.35.1`，包括 macOS `LaunchAgent`、Windows `schtasks` / VBS / 注册表与 `.lnk` 参数配置、Linux `systemd --user` 与 `.desktop` 启动项；GitHub Actions CI 在 `ubuntu-latest` 上持续执行 `npm run check` 与 `npm test`。
- **Antigravity `2.33.0+` 适配**：新版本默认关闭本地 `DevToolsActivePort`，需携带 `--remote-debugging-port=0` 启动。macOS 默认采用单图标模式，后台服务仅在冷启动前 `12s`（自动更新重启时 `25s`）内补参接力重启，不中断运行中的会话；Windows 与 Linux 自动为快捷方式或 `.desktop` 追加参数，并兼容写入 `~/.antigravity/argv.json`。

</details>

### 命令行安装

```bash
git clone https://github.com/XziXmn/antigravity-theme.git
cd antigravity-theme
node install.mjs install
node --disable-warning=ExperimentalWarning install.mjs doctor
```

### AI 一键安装

将下面这段提示词直接发给 Antigravity、Claude Code、Codex 或 Cursor：

> 请读取 `https://github.com/XziXmn/antigravity-theme.git`，使用 `git clone --depth=1 --filter=blob:none --sparse` 拉取核心文件（参考仓库内的 `SKILL.md`，跳过 `assets/` 和 `tests/`；如需只装部分功能可追加 `--only` 参数），运行 `node install.mjs install`、`node --disable-warning=ExperimentalWarning install.mjs doctor` 和 `verify` 完成安装并确认实时注入正常。

### 按需安装

通过 `--only` 从 `theme`、`i18n`、`metrics`、`fixes`（默认）以及 `suggest`（可选，默认关闭）中按需组合：

```bash
# 示例：仅启用中文界面与实时统计，保留 Antigravity 原生配色
node install.mjs install --only i18n,metrics
```

<details>
<summary>查看模块列表与精简拉取命令（跳过截图或单模块下载）</summary>

| 模块 | 说明 |
| :--- | :--- |
| `theme` | Codex 浅色 (`codex-pure-white`) 与深色 (`codex-dark`) 昼夜主题 |
| `i18n` | 中文界面本地化（`1,900+` 条词条，`WeakMap` 原地更新） |
| `metrics` | 实时会话状态指示、一/二级用量面板与每轮尾部统计（含旁路提问与可选 SSH Remote） |
| `fixes` | 设置弹窗路由死锁修复与 `Cmd/Ctrl + -/=/0` 界面缩放快捷键 |
| `suggest` | 输入框下一句预测（Ghost Text + `Tab` / `→` 补全，默认关闭） |

**1. 跳过 `assets/` 与 `tests/`，仅拉取核心代码（全平台通用）：**

```bash
git clone --depth=1 --filter=blob:none --sparse https://github.com/XziXmn/antigravity-theme.git
cd antigravity-theme
git sparse-checkout set core user
node install.mjs install --only i18n,metrics
```

**2. 仅下载目标模块文件（`--no-cone` 单模块拉取，适用于 macOS / Linux / Git Bash）：**

```bash
# 示例：仅下载并安装中文界面模块 (i18n)
git clone --depth=1 --filter=blob:none --sparse https://github.com/XziXmn/antigravity-theme.git
cd antigravity-theme
git sparse-checkout set --no-cone \
  /install.mjs /package.json /SKILL.md /LICENSE \
  /user/config.json /user/custom.css /user/custom.js /user/i18n.override.json \
  /core/daemon.mjs /core/shared.mjs /core/manifest.json /core/installer \
  /core/daemon/paths.mjs /core/daemon/cdp-bridge.mjs /core/daemon/cdp-relaunch.mjs /core/daemon/updater.mjs \
  /core/daemon/hooks-sync.mjs /core/daemon/hook-runner.mjs \
  /core/styles/45-settings-ui.css /core/runtime/00-head.js /core/runtime/75-settings-ui.js /core/runtime/90-tail.js \
  /core/i18n.json /core/i18n /core/runtime/60-i18n-engine.js
node install.mjs install --only i18n --minimal
```

也可通过 `node install.mjs sparse-paths --only theme,metrics` 查询任意模块组合对应的文件列表。

</details>

<details>
<summary>查看常用运维、更新、回滚与测试命令</summary>

| 命令 | 用途 |
| :--- | :--- |
| `node install.mjs install [--channel auto\|stable\|insiders] [--only <features>] [--minimal] [--with-launcher] [--sync-user]` | 部署插件并注册后台自启服务 |
| `node install.mjs update [--check] [--ref <branch\|tag>]` | 检查 GitHub 更新并直接升级（校验文件完整性、自动备份 `core.prev/`，保留 `user/`） |
| `node install.mjs relaunch [--channel auto\|stable\|insiders] [--force]` | 携带 `--remote-debugging-port=0` 重启 Antigravity 并校验注入（含 15s 活跃会话保护） |
| `node --disable-warning=ExperimentalWarning install.mjs doctor` | 检查 Node 版本、CDP 状态、`core/manifest.json` 哈希及页面挂载状态 |
| `node --disable-warning=ExperimentalWarning install.mjs verify [--safe-mode]` | 单次注入并校验；`--safe-mode` 跳过 `user/` 自定义脚本以便排障 |
| `node install.mjs sparse-paths --only <features>` | 输出指定模块组合的文件路径清单 |
| `node install.mjs sync-i18n` / `npm run sync-i18n` | 从已登记上游（见 [`UPSTREAMS.md`](UPSTREAMS.md) 与 `core/upstreams.json`）拉取最新中文系词库并同步哈希 |
| `node install.mjs rollback` | 回滚至上一份备份的 `core/` 版本 |
| `node install.mjs uninstall` | 停止服务、清理自启项与启动参数，恢复英文界面与原生样式 |
| `npm run check` / `npm test` | 校验全部 `.mjs` 与拼接后的前端脚本语法，运行 64 项 `node:test` 单元测试 |

</details>

## 功能详解

### 嵌入式设置面板与一键更新

在 Antigravity 原生设置弹窗的侧边栏（`内置浏览器` 下方）直接嵌入 **增强设置** 页签，日常切换无需手改 JSON：

- **可视化控制全部模块**：分组管理核心模块（昼夜主题 / 中文汉化 / 实时统计）、可选增强（输入预测与 `agy models` 二级级联模型选择器、SSH Remote 与 `sshHosts` 主机标签）及状态栏密度与缓存口径；关闭汉化后设置页也会同步切回英文。
- **头部快捷栏**：标题旁内置 **手动刷新 (`↻`)** 按钮，一键强制重建并热重载当前窗口；右上角直达 GitHub 仓库与反馈入口。
- **检查与直接更新**：底部 **版本与更新** 卡片支持一键检查 GitHub 新版本或 `main` 差异；点击 **立即更新** 后自动校验文件完整性、备份 `core.prev/` 与 `backups/`、保留 `user/` 个人配置，并在后台平滑重启热重载，无需重启 Antigravity。

![原生嵌入式 Codex 主题设置面板与二级模型选择器](assets/settings-panel.png)

### 输入框下一句预测（可选）

回复结束后根据当前对话上下文预测下一句指令，以幽灵灰字（Ghost Text）显示在空输入框中：

- **默认关闭，零额外消耗**：未开启时不启动后台 `agy` 进程、不消耗模型额度；可在 **设置 → 增强设置** 随时开关（或安装时通过 `--only suggest` 启用），关闭后立即终止后台进程。
- **快捷补全与模型分级**：按 `Tab`、`→` 或点击 `Tab` 角标直接填入，开始输入或按 `Esc` 隐藏；支持在设置面板中按基础模型与 `Thinking effort` 档位自由切换预测模型（默认推荐 `Gemini 3.8 Flash Low`）。

![输入框下一句预测 Ghost Text 与 Tab 补全](assets/prompt-suggestions.png)

### 实时会话状态与用量统计

输入框底部工具栏中部嵌入紧凑的状态圆点与实时指标摘要（`● 248 tok/s · Ctx 42% · Cache 90.9%`），悬停即可预览一级面板，点击逐级展开或固定：

| 会话状态 | 圆点样式 | 触发条件 |
| :--- | :--- | :--- |
| 就绪 | **蓝色常亮** | 连接正常且空闲；主动取消生成后立即恢复 |
| 执行中 | **蓝色闪烁** | 模型流式输出、`/compact` 压缩或工具调用进行中 |
| 等待或重试 | **黄色脉冲** | 首字/单步等待 `>= 60s`（如跨模型 `/compact` 重算 KV 缓存）、模型自动重试或建连耗时 `3s ~ 11s` |
| 连接或执行异常 | **红色脉冲** | 网络离线、建连超时 `>= 12s`、API/步骤报错（不含主动取消）或后台心跳超时 `>= 90s` |

![会话状态：就绪、执行中、等待或重试、连接或执行异常](assets/led-status-states.png)

- **一/二级用量面板与上下文预警**：一级面板展示生成速度（含端到端均值）、上下文占比与剩余容量、累计缓存命中率及分段进度条；再次点击或点「展开明细」进入二级面板，补充首字延迟（TTFT）、思考/正文输出拆分、本轮多步汇总与会话累计用量。上下文达到 `>= 75%` 黄色预警、`>= 90%` 红色提醒，`/compact` 期间实时显示压缩提示与完成后的摘要体积。

![一级概览、二级详情、上下文预警及每轮对话尾部统计](assets/telemetry-bento-panels.png)

- **状态栏自适应布局**：支持 `compact`（默认紧凑）与 `detailed`（详细）两种形态——`compact` 在宽屏下居中嵌在工具栏中段，窄侧栏或旁路提问空间不足时自动切至底部居中虚线行；`detailed` 固定展开为底部居中独立行，完整呈现 `TTFT`、精确上下文与 `Out`，不挤压原生按钮，且与悬浮详情面板共用同一条中轴线（仅文字区域响应悬停，避免误触左右空白）。

![状态栏三种自适应布局](assets/telemetry-layouts.png)

- **每轮对话尾部统计**：每轮回复操作栏左侧附带当轮摘要，悬停即可弹出详情卡，展示步数、上下文占比、思考与正文/工具拆分、新增与读缓存输入及流式/总耗时。

![每轮对话尾部统计与悬浮详情卡](assets/turn-hover-card.png)

#### SSH Remote 远端只读统计

连接远端开发机时，可在 **设置 → 增强设置** 中开启 **SSH Remote 远端只读统计** 并添加主机别名（默认关闭，不扫描 `~/.ssh/config`）。后台通过单条常驻 `ssh` 会话执行 `~/.gemini/antigravity/codex-theme-remote/metrics_reader.py --serve`（纯明文只读脚本，无 `base64`/`exec`/`-c`，企业 HIDS 友好）以 `sqlite3` `mode=ro` 读取最新 WAL，**在远端剥离全部正文、Prompt 与 Checkpoint 文本**，仅回传脱敏数值元数据并在本地纯内存解析，不调用 `scp`，不在本地拷贝或残留任何 `.db` 文件。

<details>
<summary>查看 SSH Remote 手动配置示例（user/config.json）</summary>

前置要求远端具备 `python3` 且本地可无密码 SSH 登录：

```json
{
  "modules": {
    "sshRemote": true
  },
  "sshHosts": ["node032"]
}
```

</details>

### 中文界面汉化

内置 `1,900+` 条词条，覆盖 Antigravity `2.30.x` ~ `2.35.1+` 的设置面板（含 Orchestrator 设置、输入框发送快捷键与沙箱权限）、菜单、权限选项、侧边栏、旁路提问、插件管理、工具审批状态，以及**模型额度耗尽与 AI 点数不足的动态时间/点数拼接提示**（自动保留英文模型名与思考档位）。采用 `WeakMap` 原地更新文本节点，不破坏 React 绑定；可通过 [user/i18n.override.json](user/i18n.override.json) 覆盖词条，或在设置面板一键关闭恢复英文。

### Codex 昼夜主题与实用修复

- **浅色 (`codex-pure-white`)**：`#FFFFFF` 主画布、`#F9F9F9` 侧边栏、`#EFEFEF` 选中项、`#2B7FFF` 主按钮，搭配 `#F7F7F8` 外托盘与 `#FFFFFF` 内卡片的同心圆角输入框。
- **深色 (`codex-dark`)**：中性炭灰深色方案，包含 `#181818` 主画布、`#232323` 侧边栏、`#353535` 选中项、`#262626` 外托盘、`#363636` 输入卡片与 `#2C67C5` 主按钮。
- **实用修复**：修复设置弹窗路由死锁，补充 macOS (`Cmd + -/=/0`) 与 Windows/Linux (`Ctrl + -/=/0`) 缩放快捷键，并支持 Antigravity `2.33.0+` 单图标冷启动自动接力。

## 自定义与卸载

### 日常配置与高级定制（`user/`）

日常模块开关、模型切换、主机白名单、系统提示词、Hooks 和状态栏偏好推荐直接在 **设置 → 增强设置** 中修改，保存后实时写入 `~/.gemini/antigravity/codex-theme/user/config.json` 并热重载生效，升级插件时不会覆盖 `user/` 目录。

<details>
<summary>查看 user/ 目录与 config.json 高级字段说明</summary>

- [user/config.json](user/config.json)
  - `preset`：`"codex-pure-white"` 或 `"codex-dark"`
  - `themeVars`：按需覆盖 `--background`、`--sidebar`、`--primary`、`--ag-composer-*`、`--ag-dark-*` 等 CSS 变量
  - `telemetryLayout`：`"compact"`（默认）或 `"detailed"`
  - `telemetryCacheMode`：`"session"`（会话累计命中率）或 `"step"`（单步命中率）
  - `modules`：独立控制 `theme`、`i18n`、`metrics`、`sshRemote`、`promptSuggestions`、`deadlockHealer`、`zoomShortcuts`、`cdpAutoRelaunch`、`customCss`、`customJs`
  - `promptSuggestionModel`：输入框预测模型 ID（默认 `"gemini-3.8-flash-low"`）
  - `sshHosts`：显式允许探测的远端 SSH 主机列表（如 `["node032"]`）
- [user/i18n.override.json](user/i18n.override.json)：追加或覆盖翻译词条。
- [user/custom.css](user/custom.css) 与 [user/custom.js](user/custom.js)：注入自定义样式与脚本钩子，热重载时自动清理旧副作用。

</details>

### 源码定制（`core/`）

核心代码拆分为 40 个独立文件，配套 64 项 `node:test` 单元测试：

| 定制方向 | 对应文件 |
| :--- | :--- |
| 昼夜主题配色与布局 | [core/styles/00-base.css](core/styles/00-base.css)、[10-light-codex.css](core/styles/10-light-codex.css)、[20-dark-codex.css](core/styles/20-dark-codex.css) |
| 原生设置面板与自更新 | [core/runtime/75-settings-ui.js](core/runtime/75-settings-ui.js)、[core/styles/45-settings-ui.css](core/styles/45-settings-ui.css)、[core/daemon/updater.mjs](core/daemon/updater.mjs) |
| 系统级提示词与 Hooks | [core/daemon/hooks-sync.mjs](core/daemon/hooks-sync.mjs)、[core/daemon/hook-runner.mjs](core/daemon/hook-runner.mjs) |
| 状态机与液态玻璃统计面板 | [core/runtime/40-status-machine.js](core/runtime/40-status-machine.js)、[core/daemon/telemetry-renderer.mjs](core/daemon/telemetry-renderer.mjs)、[core/styles/30-telemetry.css](core/styles/30-telemetry.css) |
| 输入预测与模型解析 | [core/daemon/prompt-suggest.mjs](core/daemon/prompt-suggest.mjs)、[core/runtime/70-prompt-suggestions.js](core/runtime/70-prompt-suggestions.js) |
| 词典与上游同步脚本 | [core/i18n/](core/i18n/)、[core/runtime/60-i18n-engine.js](core/runtime/60-i18n-engine.js)、[scripts/sync-i18n.mjs](scripts/sync-i18n.mjs) |

修改 `core/` 后运行以下命令即可重建哈希清单、跑完校验与测试并部署至本机：

```bash
node install.mjs build-manifest && npm run check && npm test && node install.mjs install
```

<details>
<summary>查看仓库目录结构</summary>

```text
antigravity-theme/
├── assets/                     # README 展示图
├── core/
│   ├── daemon/                 # 后台同步服务（热加载 / Protobuf / 重试日志 / 渲染 / SQLite / SSH Remote / 下一句预测 / 系统提示词与 Hooks / 自更新 / CDP / 2.33.0 接力）
│   ├── runtime/                # 按序注入的前端脚本（生命周期 / 修复 / 明暗同步 / 状态机 / 统计界面 / 汉化 / 输入预测 / 嵌入式增强设置面板）
│   ├── styles/                 # 样式模块（基础 / 浅色 / 深色 / 液态玻璃统计卡 / 输入预测 / 设置面板）
│   ├── installer/              # 模块分组 / Manifest 校验打包 / 环境探测 / 跨平台自启与 CDP 管理
│   ├── i18n/                   # zh-CN / zh-SG / zh-TW 多变体中文词库
│   ├── daemon.mjs              # 后台服务入口
│   ├── shared.mjs              # 公共工具函数
│   ├── i18n.json               # 默认简体中文词典（2,300+ 条）
│   ├── upstreams.json          # 上游追踪清单
│   └── manifest.json           # core/ 文件完整性哈希清单（40 个文件）
├── scripts/
│   └── sync-i18n.mjs           # 上游词库拉取与合并脚本
├── tests/                      # 64 项 node:test 单元测试
├── user/                       # 个人配置与热重载目录
├── install.mjs                 # 安装、更新、重启与运维 CLI
├── UPSTREAMS.md                # 上游项目追踪与许可说明
├── SKILL.md                    # AI Agent 操作指南
└── LICENSE                     # GNU GPL-3.0 License
```

</details>

### 卸载与保留

执行 `node install.mjs uninstall` 后：

- **移除与还原**：停止后台进程，清理系统自启项（macOS `LaunchAgent`、Linux `systemd --user`、Windows 计划任务/启动脚本）及托管的 CDP 启动参数，将当前窗口恢复为默认英文界面与原生样式。
- **默认保留**：保留 `~/.gemini/antigravity/codex-theme/user/` 个人配置、`backups/` 与 `core.prev/` 备份，以及 `~/.antigravity/argv.json` 中的 `"remote-debugging-port"` 字段；如需彻底清除，手动删除即可。

## 致谢与协议

感谢以下社区贡献者通过 Pull Request 完善本项目：

- [@isdou](https://github.com/isdou)（[PR #1](https://github.com/nkjDSLcvanv/antigravity-codex-theme/pull/1)）：贡献输入框下一句预测（Ghost Text + `Tab` / `→` 补全）
- [@xiaoxiami-zyx](https://github.com/xiaoxiami-zyx)（[PR #3](https://github.com/nkjDSLcvanv/antigravity-codex-theme/pull/3)）：贡献 SSH Remote 远端只读统计元数据提取与纯内存解析
- [@chunbin1](https://github.com/chunbin1)（[PR #6](https://github.com/nkjDSLcvanv/antigravity-codex-theme/pull/6)）：贡献冷启动目标退避重试机制，修复主窗口附着失败导致的心跳超时

早期调研 Antigravity 的 CDP 运行时注入、`WeakMap` 原地文本替换、SQLite 增量读取及 `2.33.0` `--remote-debugging-port=0` 启动接力方案时，参考了 [Anarcadia/chuanban-antigravity-theme-patch](https://github.com/Anarcadia/chuanban-antigravity-theme-patch)（MIT），在此一并致谢。

本项目在此基础上重写了整体架构并扩展了以下能力：34 个独立模块与 61 项单元测试及 CI、无外部字体依赖的 Codex 昼夜主题、嵌入式 **Codex 主题** 设置面板与面板内检查更新、四态会话状态机与一/二级用量面板及每轮悬浮详情卡、可选 SSH Remote 只读统计与输入预测，以及 `--only` 按需安装与 `user/` 热重载分层。

本项目上游追踪与许可声明详见 [`UPSTREAMS.md`](UPSTREAMS.md) 与 [`core/upstreams.json`](core/upstreams.json)，特别致谢以下上游项目：

- [nkjDSLcvanv/antigravity-codex-theme](https://github.com/nkjDSLcvanv/antigravity-codex-theme)（MIT）：主题配色、CDP 守护进程架构、四态状态机与嵌入式设置面板核心框架
- [CHANPAJN/antigravity-langpack](https://github.com/CHANPAJN/antigravity-langpack)（GPL-3.0）：现代简体中文（`zh-CN`）、英文术语简中（`zh-SG`）与繁體中文（`zh-TW`）主词库及 AI 语言联动规则规范
- [guuguo/antigravity-zh-launcher](https://github.com/guuguo/antigravity-zh-launcher)（MIT）：通用 IDE 菜单补充词库、首页欢迎语模板、文件动作动态模板与聊天正文防误伤 DOM 隔离规则

基于 [GNU General Public License v3.0 (GPL-3.0)](LICENSE) 开源，欢迎 Fork 与定制。

## English Overview

`antigravity-theme` brings Codex light and dark themes, multi-variant Chinese localization (`zh-CN` / `zh-SG` / `zh-TW`), a zero-flicker embedded **Enhancements** Settings panel, Liquid Glass telemetry cards, and system-level custom prompt & lifecycle hook management to Google Antigravity (`2.30.x` – `2.35.1+`) without modifying the application bundle. Built as 40 modular files under `core/` with 64 `node:test` unit tests (requires Node.js `>= 22.13.0`, verified on macOS, Windows, and Linux desktops).

- **Codex Light & Dark Themes**: Pure white (`codex-pure-white`) and charcoal dark (`codex-dark`) palettes with zero external font dependencies and automatic light/dark switching.
- **Zero-Flicker Embedded Settings Panel & Self-Updater**: Mounts directly under **Settings → Enhancements** with in-place DOM updates to toggle modules, switch display locales, select prompt-suggestion models & thinking effort tiers via a 2-level `agy models` cascading menu, edit `sshHosts`, manage system prompts & hooks, and check/apply in-panel updates (`node install.mjs update`) while preserving `user/`.
- **System-Level Custom Prompt & Lifecycle Hooks**: Non-destructively manages `~/.gemini/GEMINI.md`, `~/.gemini/config/rules/*.md` (`trigger: always_on`), and `~/.gemini/config/hooks.json` (`SessionStart` / `PreInvocation` `systemMessage` + `PreToolUse` auto-allow with destructive-command guard).
- **Live Session Status & Liquid Glass Telemetry**: Bottom 4-state indicator (ready, running, waiting/retrying, error), expandable Liquid Glass L1/L2 usage panels, adaptive layouts, and per-turn hover breakdown cards across main chats, Side Question panes, and opt-in read-only SSH Remote sessions.
- **Multi-Variant Chinese Localization & Opt-In Prompt Suggestions**: `2,300+` `WeakMap` in-place UI translations (`zh-CN` / `zh-SG` / `zh-TW` / `en`) with optional AI thinking/reply language sync and tracked upstream dictionary syncing (`npm run sync-i18n`), plus opt-in Ghost Text + `Tab` prompt suggestions (`--only suggest`, off by default).

Thanks to community contributors [@isdou](https://github.com/isdou) ([PR #1](https://github.com/nkjDSLcvanv/antigravity-codex-theme/pull/1)), [@xiaoxiami-zyx](https://github.com/xiaoxiami-zyx) ([PR #3](https://github.com/nkjDSLcvanv/antigravity-codex-theme/pull/3)), and [@chunbin1](https://github.com/chunbin1) ([PR #6](https://github.com/nkjDSLcvanv/antigravity-codex-theme/pull/6)). Early CDP injection and `2.33.0` launch relay research drew inspiration from [Anarcadia/chuanban-antigravity-theme-patch](https://github.com/Anarcadia/chuanban-antigravity-theme-patch) (MIT). Licensed under the [GNU General Public License v3.0 (GPL-3.0)](LICENSE).
