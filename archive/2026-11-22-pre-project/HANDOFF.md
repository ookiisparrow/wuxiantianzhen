# 无限天真（织女平台）业务与架构交接文档（HANDOFF）

交接日期：2026-11-21　　当前阶段：**全局业务与技术架构已定稿；一期 MVP 工作流正在逐段推敲中（尚未开始业务代码开发）**

> **给接手人的阅读说明**：本文件是当前唯一权威的综合交接总纲，完整覆盖了商业定位、已定稿业务规则、已废弃旧方案、系统架构、一期数据库 Schema、状态机、抖店 CSV 增量导入规范、复刻 `luckyducky-fable` 底座清单，以及尚未拍板的待办决策。同目录下的 `architecture-blueprint.md` 为拆分参考版，**术语约定：「款号」= 抖店商家编码 `skuCode`（款级）；「袋码」= 封袋贴纸二维码 `bagQrCode`（订单包级，一包一码）；全文不使用「件码」**。若旧版外部文档（如历史 `business-requirements.md`）与本文件冲突，**一律以本文件为准**。

## 1. 品牌定位、品类与商业盈利模型

### 1.1 品牌与产品聚焦

- **品牌定位**：「无限天真」（想让世界好一点点），本质是**去中心化的云端手工艺工厂**。对外公开声明不从织女手作中赚取利润，保障手工艺人应得报酬与松弛的创作状态。
- **品类聚焦**：主攻**无实际功能的摆件与挂件**，对标泡泡玛特做 **IP 化、形象化、系列化**（例如「天真宝宝」sasa / papa / haha 及梦想厨房、奇幻森林、旅行家、小花园等主题系列），避开服装/实用类产品的尺码与高退换难题（包包等实用类暂留待定）。
- **直播间极简选款策略**：直播间只主推**个位数稳定款，甚至持续单款打爆**，大幅压缩织女备料和学习成本，提升品控稳定性与直播转化率，同时降低同行抄款价值。

### 1.2 平台盈利闭环（不赚织女钱，靠什么活）

1. **直播间日常消耗品带货（主收入）**：高频回购的消耗品作为直播间核心收入。
2. **精品教程与配套内容盈利**：涵盖图解创作、成品拍摄、软件配套，以及博主上传的教学视频。
3. **付费图解制作服务**：不会做图解的创作者可付费制作图解，完成后图解可对外收费。
4. **第三方 B 端与达人服务费**：向入驻使用云端织女产能的第三方博主、达人、商家、中间商收费（包括帮爆火视频博主承接代钩订单，博主拿创作收益 + 流量收益）。

### 1.3 双层渠道分流

- **抖音直播间（一期主阵地）**：只推极少量已验证的稳定爆款 + 日常消耗品带货，所有一期成交均在抖店完成。
- **微信小程序（二期开放自主下单）**：承接高意向老玩家，专门售卖更新、更多样的小众款/测新款；老玩家测稳定后，再推上直播间主推。

## 2. 已定稿核心业务规则（最新终版）

### 2.1 订单与双通道物流分流

- **统一内部订单包（`orderPackages`）**：外部订单统一在入口转为内部订单包（自建主键 + `channel` + `externalOrderIds` + `tier` + 下单快照）。派单前的合单窗口内（晚间直播、次日 9:00 起派单，由直播与派单时间自然形成，不要求严格 12 小时），同顾客多笔订单合并为一个订单包，交期从付款起 14 天。每天派单前（约 8:30）先重新导出订单与售后 CSV 并处理退款，再派单。
- **双通道物流自动分流（对织女端完全透明）**：
  - 织女端最后一步永远统一：**装袋贴封签拍照 → 选择方便上门的取件时段 → 点提交发货**。
  - **通道一 `douyin_online`（一期主通道，发抖店订单）**：不接抖店开放平台 API 和快递 API；Web 后台导入抖店 CSV → 织女回报完工后进入 Web 后台「待发货清单」→ 运营在抖店后台用低价**在线寄件**发货 → 定期回导抖店订单/售后 CSV 更新单号、退款与签收。系统不存抖店买家明文地址，仅存省市用于同省优先派单。
  - **通道二 `kuaidi100_pickup`（二期接入，发小程序自主订单/商家单/退货再售单）**：买家完整地址存入仅云函数可读的独立 `addresses` 集合；织女提交后云函数自动调**快递100线上支付版**预约上门取件，回调更新单号与签收。
  - **账务分两类**：买家订单——抖店在线寄件扣抖店钱包、快递100线上支付版扣预充余额，平台统一付运费、织女无需现付，共用同一套邮费分担公式；**织女样品寄回（二期）——走快递100 线下支付，织女现付快递员，验收后平台按固定额度补贴**，不预充、不向织女收款（避免微信支付、二清与税务问题）。

### 2.2 织女筛选、治理与线性履约

- **四轮筛选漏斗（二期全面启用，一期种子织女点名邀请）**：海选（答题）→ 初选（历史作品）→ 复试（按指定款制作）→ 终选（做真实产品款，合格长期合作）。二期补充：终选前织女寄一件样品到直播间验收、入库、评分（快递100 上门取件，线下支付）；转正前以首批真实订单验证在线寄件可用。
- **四类人员分流**：①淘汰、②常规代钩（1、2 类自动化处理）；③常规创作（人工判断）；④流量博主创作者（开通特殊通道）。
- **织女作品快速检阅与公开标准榜**：Web 后台快速点选「入选 / 不采纳」、填具体理由并打 Tag，同时对外公布入选与不采纳名单，供其他织女参考学习品质标准。
- **线性履约与封装降本**：
  - 每天 9:00–13:00 整点优先派单（不抢单），每次最多 3 单、1 小时内确认接单；按可用工时 70% 上限与第 12 天前可完工过滤。
  - 队首订单包解锁图解；完工后使用**通用半透明八边封袋 + 平台定做的唯一二维码贴纸 + 一次性防拆封签**（大幅低于定制印刷袋成本）；先拍成品照送审（一期运营审、二期 2 位志愿评委瀑布流投票），审过装袋贴封签再拍，选取件时段回报完工，队首推进下一包。
  - 织女与买家全程信息隔离，问题统一由平台客服处理。
- **直播与派单节奏（自然形成的缓冲）**：晚间直播成交 → 次日 9:00–13:00 整点派单，付款到派单天然间隔约半天，降低开工后取消概率；不要求严格 12 小时。每天派单前（约 8:30）重新导出订单与售后 CSV，先处理退款，再派单。凌晨较晚付款的订单可能错过当天窗口，顺延次日。
- **固定款 / 非固定款分级（`styles.riskClass`）**：
  - **固定款 `core`（一期仅此类）**：直播间主推的个位数稳定款。开工后被取消的，织女继续做完并登记为**余货**（`weaverStock`）；之后同款订单优先派给持有余货的织女，她只需换新订单的袋码贴纸、重新拍封签照即可发货，工价按新订单结算，不另补偿。
  - **非固定款 `trial`（二期）**：测款、小众款，存在取消后无法售出的不可消除风险，须单独设计兜底：①仅 `acceptsTrial` 为真的织女可接，其他织女隔离、不显示入口；②成团制（同款累计 N 单才派单）；③订单卡明确标注“测款，开工后取消有风险”；④工价含风险溢价；⑤开工后取消仅有限补偿已用线材成本（或封顶进度补偿，流水 `trial_comp`）；⑥余货由织女自留或平台按材料成本买断后做福利款/清货；⑦仅对完成率与品控稳定的织女开放。N、溢价比例、补偿封顶额度待定。
- **袋码贴纸发放**：平台批量寄给织女，用完后在小程序申领下一批；每张贴纸状态 `unused → bound → void`（集合 `bagStickers`），织女小程序扫码绑定订单包；余货复用时旧贴纸作废换新；未使用数低于阈值时提示申领。袋码只绑订单包，不绑实物。

### 2.3 材料体系与个人线材预算池（终版统一规则）

- **12 色基础包 + 每周按需领料**：织女入驻自备 12 色基础包；所有平台指定的补充色号与特殊材料，一律通过小程序**每周按需申领**，由运营每周固定一天汇总打包寄出。平台直接掌握完整发料记录，既不外流材料供应链，也降低织女囤货抵触心理。
- **个人专属线材预算池（严禁透支）**：
  - 每位织女拥有独立的个人线材预算池，**不允许透支**（新人先接基础 12 色订单攒够额度再申领补色，平台零垫资、零坏账）。
  - 每单结款时从织女应得中按约定划出一笔入池（`yarn_pool_accrual`）；每周申领时服务端校验 `池内余额 >= 线材成本 + 实际低价邮费` 后扣减（`yarn_claim_deduct`）；签收后系统自动点亮她的扩展色号 `extraColors`。
  - **邮费口径**：暂定每周补色邮费直接从个人线材预算池扣减。
  - **退出条款**：织女协议中明确，织女彻底退出不接单时，池内未用余额随最后一次 14 天结款退还。

### 2.4 创作者生态与小程序结构化图解

- **五级创作者与双轨分配**：按创作与流量能力分五级（流量创作博主 > 钩织创作博主 > 原创形象+图解 > 按已有形象做图解 > 按图解制作）。无独创性/低创新款式按「贡献者」分配、不注册版权；具独创性与商业价值的款式申请版权，并按「创作者」获得**按件固定金额分成**（`royaltyFen`）。
- **小程序端创作者图解编辑器（一期先内部用它录首批款，二期开放外部创作者）**：
  - 挂在同一个微信小程序的 `creator` 角色下（一账号支持 `roles` 多角色，织女兼创作者无缝切换）。
  - 针对手机习惯设计：**钩织专属快捷符号栏**（`X / V / A / T / F / CH / SL / BLO / (...)× / 下一圈` 自动递增圈号）、**粘贴整段文本一键拆行**、**平台色卡直选**（置顶 12 基础色，折叠扩展色）、**手机现拍步骤细节图**、**自动存草稿**、**一键预览织女歌词视角**。
  - Web 后台负责图解审核、核定标准工时/工价/分成与上架。
- **织女端歌词式图解界面**：
  - 纯微信小程序无法实现 Android 跨 App 桌面歌词悬浮窗，一期采用**“歌词式滚动界面 + 分屏精简模式 + 屏幕常亮”**（当前圈放大高亮、上下行预览、大按钮步进与针数进度自动存档，引导织女配合手机分屏或把短视频缩成画中画“反浮”实现边看视频边钩织）。
  - 底层存为**按部位 → 圈/行拆分的结构化步骤 JSON**，天然支持三期模块化图解定制与按需打包安卓独立悬浮窗 APK。
  - 全屏织女工号水印、云存储短时效链接、订单结束失效，开启微信截屏/录屏保护。

### 2.5 已明确废弃的旧方案（切勿回退）

- 废弃 **“现货一次性清仓计划”**（织女现货零散，仅作入驻能力证明）。
- 废弃 **“7/12/24 色三档囤线”** 与 **“挂橱窗链接让织女自采”**（统一改为 12 基础色 + 每周个人预算池领料）。
- 废弃 **“一期在微信小程序做买家商城与微信支付”**（一期交易全走抖店，二期再开小程序老玩家测款）。
- 废弃 **“一期对接抖店开放平台 API / 办软著 / 迁抖店云 / 顺丰蓝牙热敏打单”**（一期改为抖店 CSV + 抖店在线寄件）。
- 废弃 **“把织女平台合并进 `luckyducky-fable` 生产仓和同一个小程序”**（坚持独立建仓、独立 AppID、独立云环境，只抽骨架复用）。
- 废弃 **“20% 定金 / 接单后取消补偿定金”**（不启用定金；开工后取消：固定款转余货并优先复用，非固定款走二期兜底）。

## 3. 系统架构与工程研发规格

### 3.1 独立建仓与复刻 `luckyducky-fable` 底座

- **技术栈**：沿用已验证的 `luckyducky-fable/rewrite` 全栈 TypeScript 架构——原生 TS 微信小程序（`mp`）+ TS/esbuild 微信云开发（`cloud` + `shared`）+ Vue 3/Vite Web 后台（`admin`）+ 第三方短信派单提醒。
- **工程不变量**：①集合名册 `COLLECTIONS` 单源且控制台全锁仅云函数读写；②金额全链 `Fen` 整数分品牌类型；③状态流转唯一走 `kit/transition.ts` 的 DB 层 CAS，一次性副作用严绑 `moved === true`；④导单/派单/补色/流水全用确定性 `_id` 天然幂等；⑤下单价格/工时快照落单不回读目录。
- **从 `/Users/sparrow/luckyducky-fable` 抽骨架取舍**：
  - **保留骨架**：`rewrite/{shared, cloud, admin, mp}`；`shared/src/{money,status,cst,limits,errors,index}.ts`；`cloud/src/kit/{db,transition,gate,paging,throttle,validate,reply,ids,storage,audit,secureConfig,notify}.ts` 及 `build.mjs`；`admin` 的 `Shell.vue`、`tokens.css`、`console.css`、`components/ui/*` 及通用 `lib/` 工具；`scripts/` 仅留 `verify-rw-cloud-bundles.cjs`、`deploy-fns.mjs`、`check-indexes.mjs`、`push-mp-preview.mjs`。
  - **整包/整块剔除**：`rewrite/{agent,site,spike-skyline}`、商城/支付/课程/客服/进销存全部业务代码、`scripts/check-structure.mjs`、`guard-deploy.mjs`、`red-paths.mjs`、`stryker.config.json`、`modules.json`。
  - **防误连小棉鸭生产环境的 3 处必改项**：①`cloudbaserc.json` 替换 `envId`（禁连 `cloudbase-d4gcssqbv06865479`）；②`project.config.json` 替换 `appid`（禁连 `wxcbd2fb68b81bcfb1`）；③包名作用域 `@ldrw/*` 统一替换为新前缀（如 `@wxtz/*`）。

### 3.2 一期云数据库集合与后期接缝（13 核心集合 + 2 占位）

| 集合名 | 确定性 `_id` 规则 | 核心字段与后期演进接缝 | 必建索引 |
|---|---|---|---|
| `users` | 微信 `openid` | `roles[]`（支持多身份）、`tags[]`、`weaverNo`、`status`、`acceptingOrders`、`acceptsTrial`（是否接受非固定款风险，二期）、`restDays`、`dailyCapacityMin`、`extraColors[]`、`doudianAddressAlias`、`doudianAddressText`、`screeningStage`、`creatorLevel` | `weaverNo`（唯一）、`roles + status + acceptingOrders` |
| `styles` | `skuCode` | `title`、`series`、`tier`、`status`、`standardMin`、`requiredColors[]`、`patternId`、`creatorId`、`attributionType`、`craftFeeFen`、`riskClass`（`core` 固定款 / `trial` 非固定款）、`royaltyFen`、`yarnPoolAccrualFen`、`shippingShareFen` | `status + updatedAt` |
| `patterns` | `pat_<id>` | `styleId`、`creatorId`、`version`、`status`、`parts: [{ partId, name, colorCode, steps: [{ rowNo, label, text, stitchCount?, imageFileId? }] }]`、`copyrightClaim` | `styleId + status`、`creatorId + updatedAt` |
| `yarnCatalog` | `yarnCode` | `name`、`hexColor`、`isBase12`、`barcode`、`unitCostFen`、`active` | `barcode`（唯一）、`isBase12 + active` |
| `orderPackages` | `pkg_<id>` | `channel`（一期 `douyin_online`）、`externalOrderIds[]`、`buyerRegion`、`addressId`（一期 `null`）、`tier`、`itemsSnapshot`、`totalMin`、`status`、`assignedWeaverId`、`queueSeq`、`bagQrCode`、`patternProgress`、`paidAt`、`dispatchableAt`（派单前合单窗口结束时刻）、`dueAt`、`signedAt`、`settleEligibleAt` | `status + dispatchableAt`、`assignedWeaverId + status + queueSeq`、`status + settleEligibleAt` |
| `externalOrderIndex` | `${channel}:${externalOrderId}` | `packageId`、`channel`、`externalOrderId`、`externalStatus`、`lastImportedAt` | 主键唯一、`packageId` |
| `dispatchOffers` | `offer_${packageId}_${attemptNo}` | `packageId`、`weaverId`、`attemptNo`、`status`、`offeredAt`、`expiresAt`、`respondedAt`、`verifiedBarcodes[]` | `weaverId + status`、`status + expiresAt` |
| `photoReviews` | `rev_<id>` | `scene`（`shipment_qc\|portfolio_screen`）、`packageId`、`weaverId`、`imageFileIds[]`、`status`、`votes[]`、`isPublicStandard` | `scene + status + createdAt`、`isPublicStandard + decidedAt` |
| `shipments` | `ship_${packageId}` | `packageId`、`weaverId`、`fulfillMode`（一期 `douyin_online`）、`pickupWindow`、`sealedPhotoFileId`、`doudianAddressAlias`、`carrierCode`、`trackingNo`、`shippingCostFen`、`status`、`dispatchedAt`、`signedAt` | `status + fulfillMode`、`trackingNo` |
| `yarnClaims` | `claim_${weaverId}_${weekKey}` | `weaverId`、`weekKey`、`items[]`、`materialsCostFen`、`shippingFeeFen`、`totalCostFen`、`status`、`trackingNo`、`receivedAt` | `weekKey + status`、`weaverId + createdAt` |
| `ledger` | 确定性幂等键 | `payeeId`、`accountType`（`settlement\|yarn_pool`）、`entryType`、`amountFen`、`refType`、`refId`、`settlementBatchId`、`note`、`createdAt` | `payeeId + accountType + createdAt`、`settlementBatchId` |
| `weaverStock` | `stock_${weaverId}_${styleId}` | `weaverId`、`styleId`、`qty`、`sourcePackageIds[]`、`updatedAt`（固定款开工后取消形成的余货，同款派单优先） | `weaverId + styleId`、`styleId + qty` |
| `bagStickers` | `stk_<code>` | `code`、`weaverId`、`batchId`、`status`（`unused\|bound\|void`）、`boundPackageId`、`issuedAt` | `weaverId + status`、`boundPackageId` |
| `sampleShipments`（二期占位） | `smp_<id>` | 织女筛选样品寄回：`weaverId`、`pickupOrderId`、`trackingNo`、`status`、`reviewScore`；快递100 线下支付 | — |
| `addresses`（二期占位） | `addr_<id>` | 仅云函数可读，存二期小程序买家完整地址，一期空置 | — |

*(另配 `settlementBatches`、`auditLog`、`rateLimit`、`config`。)*

### 3.3 订单包状态机（`ORDER_PACKAGE_STATUS_SPEC`）与不可变账本

- **完整状态流转**：`confirming`（派单前合单窗口）→ `waiting_dispatch`（待整点派单）→ `offered`（待 1h 接单）→ `making`（接单制作）→ `photo_review`（成品照审核，驳回回 `making`）→ `awaiting_seal`（装袋贴封签）→ `ready_to_ship`（已报期望取件时段，仅作提示、不保证；进待发货清单/二期快递100）→ `shipped`（已发货）→ `signed`（已签收，进入 7 天检视期）→ `settled_ready`（满 7 天入账终态）。异常态：`manual_hold`（5 次不接/卡单/超期）、`cancelled_full`（接单前取消终态）、`cancelled_made`（开工后取消终态：固定款登记余货 `weaverStock`、同款下单优先派给她、按新订单结工价；非固定款进入二期兜底）、`returned`（签收后退货终态）。
- **`ledger` 确定性幂等键**：`craft:${packageId}`（工价）、`ship_reimb:${packageId}`（邮费分担）、`trial_comp:${packageId}`（二期非固定款开工后取消的有限补偿，封顶）、`yarn_in:${packageId}`（划入线材池）、`yarn_out:${claimId}`（每周补色与邮费扣减）、`royalty:${packageId}:${creatorId}`（创作者分成）、`payout:${batchId}:${payeeId}`（14 天结款出账）。
- **个人线材池不可透支校验**：提交补色申领先写 `claim_${weaverId}_${weekKey}` 占坑 → 实时聚合该织女 `accountType === 'yarn_pool'` 流水求余额 → 严格校验 `balanceFen >= materialsCostFen + shippingFeeFen`，不足删占坑拒绝，足够写 `yarn_out:${claimId}` 负流水。

### 3.4 抖店 CSV 增量导入规范

- **编码与预检（Dry-Run）**：前端读 `ArrayBuffer`，先 `TextDecoder('utf-8', { fatal: true })`，失败降级 `gb18030`，去 BOM、引号和制表符；用 `PapaParse` 按中文表头名解析；正则拦截科学计数法订单号（`/e\+/i`）与未知 `skuCode`；先调 `previewDoudianCsv` 展示新增/更新/报错汇总，无阻断错误才允许提交。
- **去重与派单前合单**：先查 `externalOrderIndex`（`douyin_online:${externalOrderId}`）；新单按 `sha256(province|city|maskedName|maskedPhone)` 查找 `status === 'confirming'` 且仍在派单前窗口（`now < dispatchableAt`）的包合并（窗口不重置，超单客工时上限自动拆新包）；旧单绝不重建，仅按最新信号驱动 `transition()`。
- **状态回导**：接单前整包退款 → `cancelled_full`；接单后整包退款 → `cancelled_made`（固定款登记余货；非固定款二期走兜底）；合单部分退件高亮提醒，运营人工处理；出现快递单号 → `shipped`；出现签收/完成时间 → `signed` 并计算 `settleEligibleAt = signedAt + 7d`。
- **每日节奏**：约 8:30 重新导出订单与售后 CSV（先处理退款）→ 9:00 起整点派单；派单时同款订单优先匹配持有余货的织女。

## 4. 三期演进路线图与一期 MVP 冻结边界

- **一期 MVP（当前目标）**：独立新仓复刻小棉鸭底座 + 3–5 位种子织女（**仅固定款**，余货可复用）+ 单款/少款抖店 CSV 导单与在线寄件 + 12 基础色与个人不可透支补色池 + 小程序内部录图解与织女歌词式图解 + 八边封袋贴纸 + 运营人工审照/作品快检最小版/14 天手工结款。**明确不做**：买家小程序商城与微信支付、抖店/快递 API、外部创作者注册、安卓悬浮窗 APK、自动银行打款与退货再售池。
- **二期增长**：小程序开放买家自主下单测新款 + 接入快递100上门取件双通道分流（买家单线上预充；**织女样品寄回线下支付**，织女现付、平台按固定额度补贴）+ **非固定款与风险兜底**（成团制开做、织女自愿接受风险、风险溢价、有限补偿、余货处置）+ 开放外部创作者按件分成 + 四轮筛选漏斗与 2 位志愿评委瀑布流审照 + 退货（抖店专用退货地址）验封签再售 + 批量结款工具。
- **三期生态**：精品/标准质量分档 + 吸纳小团队管理者与商家批量单 + 模块化图解定制 + 博主教学视频/代钩流量分佣/公益拍卖 + 按需打包安卓织女桌面歌词悬浮窗 APK。另有待评估项：小程序打赏（含打赏记录证明）、图解订阅或买断，均需微信支付，须先核实类目要求与税务口径，一期不做。

## 5. 接手后立即推进的待拍板清单（当前断点）

项目已决定**先完成一期闭环 5 段业务流程的毫米级推敲，再开始写代码**。当前刚好推敲到**第 1 段「开播前准备」待确认**，接手人可直接从这里继续：

### 5.1 一期闭环 5 段流程推敲进度

1. **第 1 段「开播前准备」（刚梳理完，待拍板 4 个细节）**：
   - 线材池初始为 0 且不透支：第一批主推款是否**严格只用 12 基础色**破冰？（推荐：是）
   - 织女扫线团条码遇纸腰封撕掉/无条码：是否**扫码为主、现场拍线团合照兜底**？（推荐：是）
   - 八边封袋「唯一二维码贴纸」与「一次性封签」：**分开两张**还是**二合一**？（推荐：分开两张）
   - 种子织女 3–5 位熟人：是否**挑 1 位异地织女、用第一批真实订单跑通 1 笔抖店在线寄件**？（推荐：是）；**织女保证金（原 100 元）：再考量，暂不定**——是否收取、是否免种子织女、金额，待定
2. **第 2 段「成交与导单」（待推敲）**：运营每日导 CSV 频次、抖店库存与工时联动纪律、每日 8:30 重导 CSV 的时点纪律、开工后被退款时固定款余货的登记与优先派单（已不设定金）。
3. **第 3 段「派单与制作」（待推敲）**：9:00–13:00 整点派单超时与队列卡单人工干预 SOP、歌词式图解异常反馈。
4. **第 4 段「质检与发货」（待推敲）**：成品照驳回重拍时限、**织女期望取件时段仅作提示、不保证（抖店在线寄件未确认可指定时段）**；袋码贴纸首批发放数量与申领阈值、贴纸损坏换码、快递员爽约重约。
5. **第 5 段「签收与结款」（待推敲）**：签收 CSV 回导周期、拆封/封签损坏纠纷举证、14 天手工转账与个人线材池对账流程。

### 5.2 开工前必须完成的 4 道外部/基础闸门

1. **法务与税务定性**：向律师和会计确认“平台自营委托加工 vs 撮合”、抖店标准商品无理由退货与定制商品的规则边界（不设定金）、每周从线材池发料的税务口径、前期市面款式的版权底线。
2. **抖店后台两项实测**：导出 1 份真实抖店订单 CSV 核对表头与合单字段；用第一批真实顾客订单（不自购、不刷单）验证 1 笔异地织女的真实“在线寄件”。
3. **首批业务参数表**：定好 3–5 位种子织女名单、首批 1–3 个主推款的标准工时、12 基础色色号与条码表、每单费用拆分（运营费/包装费/邮费分担）及线材池每单划入金额；二期待定参数：非固定款成团数 N、风险溢价比例、有限补偿封顶额度、样品运费补贴额度、袋码贴纸低库存阈值。
4. **独立环境准备**：注册独立小程序 AppID、开通独立微信云开发环境、按第 3.1 节抽骨架建新仓，并提前在抖店地址库按「织女工号 + 姓名」录好种子织女寄件地址，并在抖店设置专用退货地址。
