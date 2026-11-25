# 上游仓库追踪与开源许可声明 (Upstreams & Licensing)

本仓库（`XziXmn/antigravity-theme`）基于多个优秀社区开源项目融合改进，机器可读的同步基线与最新 commit 记录维护在 [`core/upstreams.json`](core/upstreams.json)。

## 1. 上游来源清单

| 角色 | 仓库 | 许可协议 | 融合内容与用途 |
| :--- | :--- | :--- | :--- |
| **主题与核心框架上游** | [nkjDSLcvanv/antigravity-codex-theme](https://github.com/nkjDSLcvanv/antigravity-codex-theme) | MIT | Codex 昼夜主题、CDP 守护进程架构、四态状态机与用量面板、SSH Remote 只读统计、输入预测及嵌入式设置面板 |
| **中文系主词库上游** | [CHANPAJN/antigravity-langpack](https://github.com/CHANPAJN/antigravity-langpack) | **GPL-3.0** | 现代简体中文（`zh-CN`）、保留英文技术术语简中（`zh-SG`）、繁體中文（`zh-TW`）高覆盖率词典、翻译规范与 AI 思考/回复语言联动规则思路 |
| **补充词库与隔离规则上游** | [guuguo/antigravity-zh-launcher](https://github.com/guuguo/antigravity-zh-launcher) | MIT | 通用 IDE 菜单补充词条（`zh-CN` / `zh-TW`）、首页欢迎语动态模板、文件动作动词模板、`data-tooltip-content` 翻译、精细聊天正文 DOM 防误伤规则与 AI 中文全链路提示词思路 |

## 2. 开源协议说明

因本仓库直接内置整合了基于 **GNU General Public License v3.0 (GPL-3.0)** 发布的 `CHANPAJN/antigravity-langpack` 词典与本地化成果，本仓库整体遵循 **GPL-3.0** 协议发布（完整文本见 [`LICENSE`](LICENSE)），并保留原 MIT 上游的版权声明与致谢。

## 3. 同步上游汉化进度

执行以下命令即可从 GitHub 拉取 `antigravity-langpack` 与 `antigravity-zh-launcher` 的最新词典，自动合并生成 `core/i18n/zh-CN.json`、`core/i18n/zh-SG.json`、`core/i18n/zh-TW.json` 与 `core/i18n.json`，并更新 `core/upstreams.json` 中的最新 commit SHA 和校验哈希：

```bash
# 在线拉取上游最新汉化词库并更新 core/upstreams.json
npm run sync-i18n

# 或者使用 install CLI 入口
node install.mjs sync-i18n

# 预览变更统计（不写入文件）
node scripts/sync-i18n.mjs --dry-run

# 同步完成后重建完整性清单并运行校验与测试
node install.mjs build-manifest && npm run check && npm test
```

> 同步过程会自动过滤并保留英文模型名与思考档位（如 `Minimal` / `Low` / `Medium` / `High` / `Extra High` / `XHigh` / `Max` / `Orchestrator*`），并叠加 Antigravity `2.35.1+` 补充词条。
