# AGENTS.md

本文件定义 `wuxiantianzhen` 仓库的工程边界、验证门禁与技能路由规则。任何代理修改代码或文档前必须遵守以下约束。

## 1. 权威设计与业务范围

- **唯一技术基准**：以 `docs/07-技术架构与全量Schema终稿.md` 为最高优先级技术规范。`archive/` 为只读历史存档，不得参考或修改。
- **终端形态边界**：全平台仅包含织女端微信小程序 `packages/mp-weaver`、买家与志愿者端微信小程序 `packages/mp-buyer` 以及运营 Web 总控台 `packages/admin`，不构建原生 iOS 或 Android 客户端。
- **主体迁移解耦**：阶段 0 与阶段 1 以个体户主体运行，后续迁移至有限公司。所有集合主键必须使用内部 ID，例如 `usr_<id>`、`ord_<id>`、`pkg_<id>`，严禁将微信 `openid` 作为集合主键或外键。

## 2. 结构化防错门禁表

每条工程铁律均有对应的静态或运行时检查守卫，提交前必须全绿：

| 规则内容 | 守卫位置 | 运行命令 |
|---|---|---|
| 严禁连接历史旧项目云环境、AppID 或旧包作用域 | `scripts/guard-env.mjs` | `node scripts/guard-env.mjs` |
| `packages/cloud` 必须通过 `@wxtz/shared` 引包，且 `services/*` 之间零横向互引 | `packages/cloud/src/__tests__/modularity.test.ts` | `npm test` |
| 金额全链整数 `Fen`，先校验账户不透支再写不可变 `ledgerEntries`，纯工价与材料费及运费补贴分立科目 | `packages/shared/src/money.ts`, `packages/cloud/src/kit/ledger.ts` | `npm test` |
| 状态流转只走 `transitionStatus()` CAS，单次副作用仅在 `moved === true` 时触发 | `packages/cloud/src/kit/transition.ts` | `npm test` |
| 拦截小程序直调 `webhook.*` 与 `cron.*`，服务端核定运费补贴、招募大区与正整数数量 | `packages/cloud/src/main.ts`, `packages/cloud/src/runtime/router.ts`, `packages/cloud/src/__tests__/interrogate_regression.test.ts` | `npm test` |
| 歌词式图解页保持屏幕常亮、轻触震动、防截屏且零音频焦点抢占；志愿者盲审强制满 8 秒 | `packages/admin/src/__tests__/adminAndClients.test.ts` | `npm test` |
| 运营总控台六大工作区与 `wxtz-api` 真实 HTTP 联调取证 | `.agents/skills/verify-wxtz/SKILL.md` | `node .agents/skills/verify-wxtz/scripts/control-wxtz.mjs` |

## 3. 本机运行环境

- 本机 Node v22 路径为 `/Users/sparrow/.local/share/pi-node/node-v22.23.1-darwin-arm64/bin/node`。若默认沙盒拦截该路径、本地端口监听或 Git 锁文件写入，按最小权限原则单独对受阻命令申请宿主机执行权限。
- 浏览器自动化工具路径为 `/Users/sparrow/.local/bin/ego-browser`。首次在会话中操作浏览器前，先运行 `/Users/sparrow/.local/bin/ego-browser skill` 读取当前版本接口说明。
- 新增或移动跨包文件后，先运行 `node scripts/link-workspaces.mjs` 刷新工作区软链，再执行测试套件。

## 4. 项目技能与 pstack 协作规范

1. **应用实操验收 (`verify-wxtz`)**：改动涉及 `packages/admin`、`packages/cloud/src/runtime/router.ts` 或核心业务流转时，读取 `.agents/skills/verify-wxtz/SKILL.md` 与 `.agents/skills/verify-wxtz/features/README.md`，用独立 `--run-id` 启动服务、通过 `doctor` 自检、驱动 `ego-browser` 与 `control-wxtz.mjs` 留存截图与数据库只读快照至 `.verify-artifacts/<RUN_ID>/`，最后执行 `cleanup` 销毁临时进程。
2. **特性地图维护 (`/maintain-verification-skill`)**：当新增工作区、修改 DOM 选择器或调整 `wxtz-api` 入参返回结构时，同步更新 `.agents/skills/verify-wxtz/features/` 下的旅程文档并实跑验证。
3. **日常研发与复审 (`pstack`)**：
	- 非平凡开发、排障与重构优先遵循 `/poteto-mode` 及其 `principle-*` 原则，完结前用真实运行产物证明结果。
	- 跨包接口设计或接入微信支付、快递100、中通吉等真实适配器前，先运行 `/architect` 比选边界与类型签名。
	- 多模块改动提交前，运行 `/interrogate` 派生隔离工作树子代理做可执行对抗复审，并将确认的缺陷转化为永久回归测试。
	- 修改底层公共函数或状态机边时，运行 `/blast-radius` 实证上下游安全性。
	- 文档、提交说明与回复文案遵循 `/technical-writing` 与 `/unslop` 规范。
