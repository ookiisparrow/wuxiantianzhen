# 无限天真织女平台

无限天真是去中心化的云端手工艺工坊。直播间与小程序接收稳定款订单，分散在家的钩织手艺人接单制作并直发买家。

立项日期：2026-11-22。当前处于阶段 0 验证与阶段 1 研发期，首发主体为个体户，后续平滑迁移至有限公司，待完成开工前外部核对闸门后接真实订单，详见 `docs/05-待办与风险.md`。

## 项目文档索引

请按以下顺序阅读设计文档：

| 文件 | 内容 |
|---|---|
| `docs/01-项目意图.md` | 立项背景、目标人群、分期范围与已废弃方案 |
| `docs/02-调研记录.md` | 抖店、快递100、顺丰、京东与财税合规官方调研记录 |
| `docs/03-项目设计.md` | 业务流程、规则、数据模型、状态机、账本与 CSV 规范 |
| `docs/04-决策日志.md` | 关键业务与架构决议台账 |
| `docs/05-待办与风险.md` | 开工闸门、待定事项、外部咨询清单与风险登记 |
| `docs/06-人力成本节点台账.md` | 人工操作节点与后续自动化演进路径 |
| `docs/07-技术架构与全量Schema终稿.md` | 研发唯一技术基准：双端小程序、全量集合 Schema、状态机、复式账本与六边形端口 |
| `docs/08-织女日常习惯与体验推敲（待讨论）.md` | 居家织女真实使用习惯备忘池，逐条拍板后转入正式方案 |
| `docs/reference/全部资料汇总.md` | 立项前历史资料按主题汇总 |
| `docs/research/outbound/` | 待发出的抖店工单、快递100 商务问卷与律师咨询函 |
| `archive/2026-11-22-pre-project/` | 立项前原始存档，只读不改 |

## 代码仓库结构

本仓库采用 `@wxtz/*` Monorepo 结构，仅包含两个微信小程序端、一个运营 Web 后台、共享契约层与统一云函数路由，不开发原生 App：

| 路径 | 包名或标识 | 职责 |
|---|---|---|
| `packages/shared` | `@wxtz/shared` | 30 个集合 Schema、整数金额 `Fen`、状态机定义、北京时间日历、双桶产能与模块化图解拼装 |
| `packages/cloud` | `@wxtz/cloud` | 复式账本、现货 15 分钟原子锁、双粒度毛线库存、八大领域服务、六边形端口与 `wxtz-api` 统一路由 |
| `packages/mp-weaver` | `@wxtz/mp-weaver` | 织女与创作者工作台小程序：四步准入漏斗、接单队列、防截屏歌词式图解、三机位交片封签、周度领线 |
| `packages/mp-buyer` | `@wxtz/mp-buyer` | 买家商城与粉丝陪审团小程序：产能实时控量市集、下单锁库、8 秒盲审投票、200 元保证金收银台 |
| `packages/admin` | `@wxtz/admin` | 运营 Web 总控台：开播安全库存试算、抖店双 CSV 强校验导单、待打单与卡单、10 秒仲裁、线材与网银结款 CSV 导出 |
| `.agents/skills/verify-wxtz` | `verify-wxtz` | 项目级实操验收技能：本地仿真 `wxtz-api` 服务、`control-wxtz.mjs` 控制脚本与五条端到端特性地图 |
| `AGENTS.md` | 项目代理规则 | AI 代理进入本仓库时自动加载的工程红线、门禁命令与技能路由指南 |

Git 历史中的早期原型已隔离在本地分支 `legacy-prototype-2026-10`，不属于当前主干范围。

## 核心业务与工程约定

- **统一术语**：使用款号 `skuCode` 表示抖店商家编码，使用袋码 `bagQrCode` 表示订单包级八边封袋贴纸二维码，不使用“件码”。
- **资金铁律**：全链路金额只用整数分 `Fen`。复式账本分录不可变，委外纯工价 `EXP_CRAFT_COST`、材料费 `EXP_MATERIAL_COST` 与平台运费补贴 `EXP_SHIPPING_PLATFORM` 独立记账，严禁从织女工价倒扣材料费。
- **状态与边界**：所有状态变更只走 `transitionStatus()` 乐观锁。费率、补贴、准入大区、定时任务与支付回调全部在服务端收口校验。
- **真实调研原则**：外部规则只信官方来源并标注证据等级，严禁自买测试或刷单。遇到旧文档与新方案不一致时，以 `docs/07-技术架构与全量Schema终稿.md` 为准。

## 验证与技能用法

运行环境隔离检查与全量 44 项单元及对抗回归测试：

```bash
	npm run verify
```

当修改涉及 `packages/admin` 界面或 `wxtz-api` 跨端路由时，按 `.agents/skills/verify-wxtz/SKILL.md` 启动本地隔离实例并用 `ego-browser` 实操取证：

```bash
	node .agents/skills/verify-wxtz/scripts/control-wxtz.mjs launch --run-id dev01
	node .agents/skills/verify-wxtz/scripts/control-wxtz.mjs doctor --run-id dev01
	node .agents/skills/verify-wxtz/scripts/control-wxtz.mjs cleanup --run-id dev01
```

在 Antigravity 中协作开发时，可结合全局安装的 `pstack` 插件与项目级技能：

- `/poteto-mode`：非平凡功能开发、缺陷修复与重构的默认总入口。
- `/architect`：新增外部端口适配器或调整跨包边界前，先比选两套类型与模块方案。
- `/interrogate`：大改动合入前，派独立工作树子代理编写失败测试做对抗复审。
- `/blast-radius`：排查小改动在上下游的隐性连锁影响并运行代码实证。
- `/verify-wxtz` 与 `/maintain-verification-skill`：按特性地图驱动浏览器与云路由取证，并在界面或接口变更后同步更新特性地图。
