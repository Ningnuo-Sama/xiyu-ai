# LOCAL_MAINTENANCE — xiyu-ai（DNF 恋人系统大脑定制）

- 上游：`origin → github.com/dimang01/xiyu-ai`；本地定制分支：`local/custom`
- 源码/运行：`D:\GitHub\xiyu-ai`（同一目录，`node index.mjs` 启动，端口 3366，见 PORTS.md）
- 定制内容与验收状态、下一步：见 `docs/handoff/DNF_BRAIN_HANDOFF_2026-10-09.md`
- 数据/密钥边界：`.env`（GAME_TOKEN、LLM 配置）、`data/`（SQLite）不进 Git
- 上游更新：候选分支 rebase 后必须重跑 handoff 第 5 节验收；不在本目录直接 pull
