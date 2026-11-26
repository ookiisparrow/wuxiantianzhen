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
3. **前端设计与 UX 双轨工作流（默认草稿提案，按需精修定稿）**：
	- **阶段 A · 轻量草稿提案（`ux-draft`，`design/*` 默认模式）**：新增或迭代 `design/*` 原型且用户未明确要求「精修 / 定稿」时，仅读取 `.agents/skills/ux-draft/SKILL.md`（多方案比选按需加读 `prototype` 或 `variant`）。全项目统一沿用已采纳的**质检靛青灰（`slate_indigo`: `#293B63` / `#F5F6F8`）**与 WeUI 字阶，集中精力保证**设计提案质量与全流程 UI 界面完整可点**，并在完成后通过本地开发服务在侧边浏览器打开供用户即时审阅；织女端草稿完结前仅运行毫秒级静态检查 `node .agents/skills/weaver-ux-guard/scripts/check-weaver-ux.mjs <target>`（免 `--browser` 多视口矩阵、免 `break-ui` 极限挑刺、未改生产代码免跑 `npm test`）。
	- **阶段 B · 精修定稿与生产落包（全链路流水线，点名「精修 / 定稿」或修改 `packages/mp-*`、`packages/admin` 时启用）**：读取 `.agents/skills/weaver-ux-guard/SKILL.md`，按需串联 `mobile-native` + `gestures` → `emil-design-eng` + `choreograph` → `better-ui` + `better-accessibility` → `break-ui`，完结前实跑 `node .agents/skills/weaver-ux-guard/scripts/check-weaver-ux.mjs <target> --browser` 确保双视口零溢出与无障碍门禁全绿。
	- **规范冲突裁决优先级**（两阶段通用）：`AGENTS.md` 与项目设计规范（`ux-draft` / `weaver-ux-guard`） > 工具型专项约束（Emil / Jakub 触控、手势、WCAG） > 通用视觉审美建议（`impeccable` / `frontend-design`）。
4. **日常研发与复审 (`pstack`)**：
	- 非平凡开发、排障与重构优先遵循 `/poteto-mode` 及其 `principle-*` 原则，完结前用真实运行产物证明结果。
	- 跨包接口设计或接入微信支付、快递100、中通吉等真实适配器前，先运行 `/architect` 比选边界与类型签名。
	- 多模块改动提交前，运行 `/interrogate` 派生隔离工作树子代理做可执行对抗复审，并将确认的缺陷转化为永久回归测试。
	- 修改底层公共函数或状态机边时，运行 `/blast-radius` 实证上下游安全性。
	- 文档、提交说明与回复文案遵循 `/technical-writing` 与 `/unslop` 规范。

## 5. 织女端交互与文案设计铁律

设计或实现织女端页面（含原型与 `packages/mp-weaver`）时必须遵守以下规则：

### 交互与视觉铁律
1. **一屏一画面，禁止滑动**：默认不允许页面纵向滚动，手机屏幕可视高度即完整画面（实测内容不溢出 `scrollHeight <= clientHeight`）。
2. **一页一重点**：每个页面只承载一个核心决策或动作；宁可拆成多页，也绝不把多项内容塞成长页。
3. **极简动作直进与全程可返回**：选择题与拍照项优先支持点选后直接进入下一屏，需显式确认的页面仅保留底部单个主按钮，非首页左上角全程保留「返回」按钮。
4. **微信原生字号规范**：遵循微信 / WeUI 官方字阶（页面大标题 `22px` / `44rpx`、导航栏与主按钮及选项主文案 `17px` / `34rpx`、次要正文 `15px` / `30rpx`、辅助说明 `14px` / `28rpx`、次级标签 `12px` / `24rpx`），小程序端配合微信系统字号与关怀模式缩放，保持克制精致的字重（`400`–`600`）与留白。

### 文案五条铁律（全端织女可见界面逐字遵守，详见 `.agents/rules/design-copy-rules.md`）
1. **内部用语一律改为通用语言**：严禁向织女暴露业务/运营/财务内部词（如「织女入驻」「派单」「开单」「收线地址」「周转保证金」「质检组」「起步毛线」「织女库」「入档」等），全部替换为大众通用说法。
2. **小学生也能读懂**：优先使用少笔画、生活常见字，禁用生僻字（如「茜」「挺括」）、书面语和英文缩写（用「厘米」而非 `cm`）。
3. **对齐微信、抖音、淘宝成熟通用用语**：高频动作与名词直接复用用户已习惯的成熟表达（如「微信一键登录」「收货地址」「预约上门取件」「一键复制地址」「扫一扫」「开启消息提醒」「查看进度」「立即预约」「确认支付」「原路退回」）。
4. **「四不出现」过滤原则**：**如果一段文案，① 不应该被织女看到、② 织女看到后没有意义、③ 织女看到后会产生迷惑、④ 织女看到后不能指导她的具体行动，那么这段文案就绝不应该出现。**（静态守卫 `check-weaver-ux.mjs` 已编码拦截常见违规用语）。
5. **零同屏重复，零废话填充**：同一屏内同一层意思只说一次；标题已说清的不在副标题/卡片里重说；图示或控件能直接看懂的绝不配多余文字标签或同义副说明，考核题不写剧透式副标题——出现不能帮助理解、只会徒增阅读负担的文字一律删掉。
