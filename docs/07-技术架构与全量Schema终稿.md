# 07 技术架构与全量 Schema 终稿（开发蓝图）

> 版本：2026-11-24（整合第 1–8 轮定稿 + 架构总审 8 项修补终版）
> 定位：**研发开工唯一技术权威文档**。整合了 `03-项目设计.md` 前后章节及第 3–8 轮与架构总审全部变更，消除全部历史冲突与并发/账务漏洞。业务背景与历史决策见 `01`、`03`、`04`；外部依赖闸门见 `05`。

---

## 1. 总体架构与分期定位

### 1.1 主体与分期策略
| 阶段 | 主体 | 范围与核心链路 |
|---|---|---|
| **阶段 0（验证，立即并行）** | 个体户 | 3–5 位熟人织女；固定款；抖店在线寄件 / 服务市场打单 ERP（首选 `service_id=50` 中通吉 / `10` 快递100）；运营审照；手工结款；主供应商表格一件代发验证。 |
| **阶段 1（首版，≤6 个月）** | 个体户 | **双池并行 + 江浙沪圆心起盘**：①**地域策略**：主供应商落点江浙沪，全国划分为大区（`jzh` 江浙沪核心区、`north` 北方区域、`sw_ygc` 云贵川、`nw` 西北方向、`south_central` 华南华中等），**一期优先招募江浙沪及周边的织女**（实现材料 1–2 日极速达与低邮费），按阶段解锁新大区；②**小程序池（无上限，全自动）**：`mp-buyer` + 微信支付 + 快递100 上门取件 API；③**直播池（≤500）**：抖店 CSV 导入 + 服务市场打单 ERP 过渡；④**共同能力**：`mp-weaver`、准入漏斗（含 200 元保证金）、**粉丝志愿者审核**（上线前就绪）、每周线材+标准辅料包表格代发、复式账本、网银批量代发导出、分级实名。 |
| **阶段 2（放大迁移）** | 迁移有限公司 | 微信主体迁移（凭内部 `userId` + 手机号不断链）；启动软著与抖店开放平台 API（订单 + 电子面单）；外部创作者注册与分成、非固定款、团队（`orgId`）、区域点（`hubId`）、灵活用工代发、B 端代钩。 |

### 1.2 Monorepo 结构与端职责
独立新仓，复刻小棉鸭验证过的工程骨架，包名作用域统一为 **`@wxtz/*`**：

```text
wuxiantianzhen/
├── packages/
│   ├── shared/          # 纯 TS：Fen 整数分、状态机规格、COLLECTIONS 常量、错误码、校验、时区(CST)
│   ├── cloud/           # 微信云开发云函数（TS + esbuild 打包），所有数据库读写唯一入口
│   ├── mp-buyer/        # 买家/粉丝端小程序（电商类目）：商城、余货专区、微信支付、售后/客服 + 【粉丝志愿者审核工作台】
│   ├── mp-weaver/       # 织女/创作者端小程序（工具类目）：接单、歌词式图解、成品照/袋码封签、线材申领与收货确认、收入 + 【内部图解编辑器】
│   └── admin/           # 运营 Web 后台（Vue 3 + Vite）：抖店 CSV 导入/回导、派单干预、漏斗与审照、待发货、线材导表、14 天结款、配置中心
└── scripts/             # verify-rw-cloud-bundles.cjs / deploy-fns.mjs / check-indexes.mjs / push-mp-preview.mjs
```

> **建仓防误连铁律（3 处必改）**：① `cloudbaserc.json` 禁用旧 `envId`（`cloudbase-d4gcssqbv06865479`）；② `project.config.json` 禁用旧 `appid`（`wxcbd2fb68b81bcfb1`），且为 `mp-buyer` 和 `mp-weaver` 分别配置独立 AppID（共用同一云环境）；③ 全部包作用域为 `@wxtz/*`。

### 1.3 6 条工程不变量（开发强约束）
1. **单源集合名册 + 全锁权限**：所有集合名定义在 `shared/src/collections.ts`；云数据库安全规则全部锁死（仅云函数可读写，客户端零直连 DB）。
2. **金额全链整数分 `Fen`**：严禁浮点数存储或计算金额；账本记录不可修改/删除，纠错只允许写冲正分录。
3. **唯一状态流转入口**：所有状态变更必须走 `cloud/src/kit/transition.ts` 的 DB 层 CAS 条件更新；任何一次性副作用（扣线材池、发通知、写账本、预约取件）严绑 `moved === true`。
4. **确定性 `_id` 幂等**：导单索引、派单尝试、线材申领、支付/退款回调、账本流水全部采用确定性主键，天然防重入与并发脏写。
5. **下单快照隔离**：订单包创建时把售价、工价、工时、色号、运费分摊写入 `itemsSnapshot`，后续修改商品/款式目录绝不影响在途与历史订单。
6. **主体迁移与跨端解耦**：`users._id` 严禁使用 `openid`，统一采用平台内部 `usr_<ulid>` + `phone` 唯一索引；微信支付商户配置与回调验签抽离至 `secureConfig`，支持无痛切换新主体商户号。

---

## 2. 跨端身份、角色与隔离边界

### 2.1 一账号多角色（`users.roles[]`）
一个自然人通过唯一 `userId` 贯通双端小程序，允许多角色共存：`buyer`（买家/粉丝）、`weaver`（织女）、`volunteer`（粉丝志愿者审核员）、`creator`（图解创作者）、`admin`（运营）。

* **登录归并规则**：客户端登录时先按当前端对应的 `buyerOpenid` 或 `weaverOpenid` 查 `users`；未命中时要求微信授权手机号（或短信验证），按 `phone` 匹配已有 `userId` 并补写该端 `openid`；若 `phone` 亦不存在则新建 `usr_<ulid>`。绑定微信开放平台后同步落库 `unionid`。
* **主体迁移自愈**：将来个体户迁有限公司导致小程序 `openid` 变更时，老用户重新授权手机号即可命中原 `userId`，历史订单、信用分、线材池余额与账本零丢失。

### 2.2 五条硬安全与合规隔离线
| 隔离项 | 强制技术实现 |
|---|---|
| **织女看不到买家明文信息** | `addresses` 集合仅云函数可读；`mp-weaver` 所有接口只返回 `buyerProvince`、`buyerCity`，绝不吐出姓名/手机/详细地址。抖店订单系统本身不落买家明文地址。 |
| **禁止自买自接（防刷单）** | 派单候选过滤硬条件：`orderPackage.buyerUserId !== candidate.userId`（为空则不限制，抖店订单无 `buyerUserId`）。 |
| **图解防外泄** | 仅队首订单包（`queueSeq === 1` 且 `status === 'making'`）可请求图解接口；图片下发 5 分钟短时效私有云存储 URL；前端叠全屏织女工号水印 + 开启 `wx.setVisualEffectOnCapture` 防截屏/录屏。 |
| **粉丝志愿者盲审防串通** | 审核接口不下发 `weaverId`/`weaverNo`/昵称；按 `volunteerId !== weaverId` 排除自己，限制每日审单上限与同一织女回避窗口；前端强制每张审核卡停留 ≥8 秒才允许提交；随机混入约 5% 标准校准题检测准确率。 |
| **UGC 图片内容安全与压缩** | 凡跨用户展示的上传图片（作品照、成品照、售后图等）强制接入微信 `security.mediaCheckAsync` 图片内容安全审核（防小程序提审拒审）；前端上传前统一压缩至 ≤500KB 控制云存储流量成本。 |

### 2.3 `admin` Web 后台鉴权方案
Web 端无微信 `OPENID`，严禁前端暴露任何云开发密钥。`admin` 所有请求经云函数 HTTP 触发器/云托管网关进入，采用**管理员账号密码 + 短时效 JWT（或微信扫码绑定 `roles` 含 `admin` 的账号）**双重校验；所有写操作写入 `auditLog`。

### 2.4 织女端歌词图解「后台听书 / 小窗追剧」伴随体验硬规范（不做独立 App）
阶段 0 与阶段 1 坚决采用微信小程序（规避独立 App 的企业主体限制、ICP 备案、软著与双端商店长审核），通过以下 4 条前端工程硬约束实现准原生伴随体验：
1. **严禁抢占系统音频焦点**：图解与工作流页面不挂载任何自动发声或独占音频焦点的 `<video>`/媒体组件；翻圈与步进反馈统一采用轻微触感震动 `wx.vibrateShort({ type: 'light' })`；若未来增加提示音效，必须前置调用 `wx.setInnerAudioOption({ mixWithOther: true, obeyMuteSwitch: false })` 开启混音，**100% 保证喜马拉雅/小宇宙/番茄畅听/微信读书等后台有声书与播客不断流**。
2. **自动保持屏幕常亮**：进入歌词图解页自动调用 `wx.setKeepScreenOn({ keepScreenOn: true })`，退出页面恢复默认，避免织女双手绕线时频繁黑屏锁机。
3. **OLED 深色护眼省电模式**：图解页内置深色底（黑底浅字）一键切换并记忆偏好，降低连续数小时屏幕常亮的电量消耗与夜间视觉疲劳。
4. **画中画小窗（PiP）与安卓分屏布局适配**：将“当前高亮圈针数”与超大“下一圈”交互热区排布在屏幕**中下部**，顶部预留安全留白区以避让 iOS/Android 视频 App 的右上角画中画追剧小窗，同时自适应安卓系统上下分屏的矮视口高度。

---

## 3. 全量数据库 Schema（26 核心集合 + 4 系统集合）

> 约定：时间字段统一为 UTC 毫秒时间戳（`number`），展示与业务日界线统一按 `CST (UTC+8)` 计算；金额字段均以 `Fen` 结尾（整数分）。

### 3.1 账号、地址、准入漏斗与志愿者（4 集合）

#### 1) `users`
* `_id`：`usr_<ulid>`（**平台内部主键，禁用 `openid`**）
* 核心字段：
  * 身份与跨端：`buyerOpenid?`, `weaverOpenid?`, `unionid?`, `phone`（唯一索引）, `nickname`, `avatarFileId`
  * 角色与标签：`roles: ('buyer'|'weaver'|'volunteer'|'creator'|'admin')[]`, `tags: string[]`
  * 分级实名：`verifyLevel: 'none' | 'phone' | 'payee' | 'full'`, `realName?`, `idCardHash?`, `bankCardEncrypted?`（仅云函数解密，供结款导出）
  * 织女属性：`weaverNo?`（唯一短号，如 `W0012`）, `regionCode?: 'jzh' | 'north' | 'sw_ygc' | 'nw' | 'south_central'`（所属业务大区，一期优先开放 `jzh` 江浙沪圈）, `shippingMode: 'auto_pickup' | 'self_dropoff'`（默认系统自动上门取件；村镇不上门的好织女可切为驿站自寄+填单号按标准价补邮费）, `pool?: 'live' | 'mp'`, `poolRank?`, `cityQuotaKey?`（`省-市`）, `funnelStage: 'none'|'apply_entry'|'trial_make'|'sample_inspect'|'pending_deposit'|'approved'|'rejected'`, `acceptingOrders: boolean`, `acceptsTrial: boolean`（阶段 2）, `restDays: string[]`（`YYYY-MM-DD`）, `dailyCapacityMin: number`（自报每日可钩分钟数）, `speedFactor: number`（历史交货手速修正系数，初始 `1.0`，按近 10 单实际耗时在 `0.6 ~ 1.3` 平滑微调）, `stockQuota: Record<string, number>`（常青爆款淡季预做现货配额，如 `{ "TZ-SASA-01": 2 }`）, `yarnInventory: Record<string, { wholeSkeins: number, usedSinceCheckG: number, needCheck: boolean, status: 'ok' | 'low' | 'empty', lastCheckedAt?: number }>`（**“整团 + 克重”双颗粒度台账**：转正时自动为 12 基础色初始化 `wholeSkeins=1`，12 基础色耗尽照样可申领；余货复用绝不重复扣减；每累计满 1 团即触发核对；**校准后 `wholeSkeins <= 1` 剩最后 1 整团时即提前弹补线预警**，边钩边等新线实现零断料）, `creditScore: number`, `consecutiveTimeouts: number`, `pauseUntil?: number`, `doudianAddressAlias?`, `defaultSendAddrId?`
  * 预留字段：`orgId?: string`（二期团队）, `creatorLevel?: number`
* 索引：`phone (unique)`, `buyerOpenid (sparse unique)`, `weaverOpenid (sparse unique)`, `unionid (sparse)`, `weaverNo (sparse unique)`, `(pool, acceptingOrders, funnelStage)`

#### 2) `addresses`（仅云函数可读，加密/隔离）
* `_id`：`addr_<ulid>`
* 字段：`ownerUserId`, `type: 'buyer_recv' | 'weaver_send'`, `contactName`, `contactPhone`, `province`, `city`, `district`, `detail`, `isDefault: boolean`, `createdAt`, `updatedAt`
* 索引：`(ownerUserId, type)`

#### 3) `recruitFunnel`（四步准入漏斗，2026-11-24 第 9 轮正式定型）
* `_id`：`funnel_${userId}`（确定性主键）
* 字段：
  * `userId`, `stage: 'apply_entry' | 'trial_make' | 'sample_inspect' | 'pending_deposit' | 'approved' | 'rejected'`
  * 第 1 步（初筛报名页一次提交）：`regionCheckPassed: boolean`（校验在 `activeRecruitRegions` 如江浙沪内）, `quizAttempts: number`（≤2，8 道常识自动判分）, `portfolioAttempts: number`（≤2，3 张旧作盲审）, `portfolioReviewId?`, `depositNoticeAckAt?`（过审后明确告知：考级小样通过须缴 200 元合作履约保证金）
  * 第 2 步（专用非卖品考级小样拍照初验，**绝不外泄在售爆款商业图解**）：`examSampleCode: string`, `trialAttempts: number`（≤2）, `trialReviewId?`, `trialPassedAt?`
  * 第 3 步（自费寄考级小样实物入库终验）：`sampleAttempts: number`（≤1，邮费织女自理不报销）, `sampleTrackingNo?`, `sampleReceivedAt?`, `sampleInspectResult?: 'pass'|'fail'`
  * 第 4 步（缴付 200 元合作履约保证金转正）：`depositStatus: 'unpaid' | 'paid' | 'refunded'`, `depositAmountFen: number`（固定 20000 分 = 200 元）, `depositChannel?: 'mp_buyer_cashier' | 'manual_transfer_verify'`, `depositPaidAt?`, `depositRefId?`
  * `cooldownUntil?: number`（超次淘汰后 +30 天）, `firstOrderPkgId?`, `updatedAt`
* 索引：`(stage, updatedAt)`

#### 4) `volunteers`（粉丝志愿者档案，正式运行前上线 + 上岗找茬考核）
* `_id`：`vol_${userId}`（确定性主键）
* 字段：`userId`, `source: 'fan' | 'weaver' | 'staff'`, `status: 'examining' | 'active' | 'paused' | 'revoked'`（**上岗前必须连过 5 道含歪眼/漏针/缩水真次品的“找茬题”才激活 `active`**）, `onboardingExamPassedAt?`, `dailyLimit: number`, `todayCount: number`, `todayDate: string`, `points: number`（荣誉积分，不发钱）, `calibrationTotal: number`, `calibrationCorrect: number`, `recentWeaverIds: string[]`（回避记录）, `joinedAt`
* 索引：`(status, todayDate)`

---

### 3.2 款式、商品、图解与余货（4 集合）

#### 5) `styles`（款级主数据）
* `_id`：`<skuCode>`（如 `TZ-SASA-01`，与抖店商家编码一致）
* 字段：
  * 基础与工时：`name`, `riskClass: 'core' | 'trial'`（阶段 1 仅 `core`）, `standardMin: number`（标准工时分钟）, `patternId`
  * **线材克重 BOM（2026-11-24 新增）**：`yarnBom: Array<{ yarnCode: string, netWeightG: number }>`（每色实测净耗克重，整数克）, `wasteRateBp: number`（损耗冗余万分比，默认 `1000` 即 10%，应对手劲松紧与接线头损耗）, `extraAccessoryCostFen: number`（眼睛/填充棉/扣件等固定辅料费）
  * **自动核算材料费与线材池计提**：
    * 单色含损耗克重：`consumedG = ceil(netWeightG * (10000 + wasteRateBp) / 10000)`
    * 单件材料费 `materialCostFen = sum( ceil(consumedG * yarn.unitCostFen / yarn.unitWeightG) ) + extraAccessoryCostFen`
    * `yarnPoolAccrualFen`（每单划入织女线材池，**≥ `materialCostFen` 且直接计入产品定价成本**，从数学上保证线材池永不亏空）
  * 费用、博主把关与版权：`craftFeeFen`, `royaltyFen`（创作固定分成，自有款为 0）, `creatorQcFeeFen`（**预留接缝**：博主亲自审照把关分成，自有款为 0）, `trafficCommissionBp`（**预留接缝**：博主自带流量成交分成万分比）, `creatorUserId?`（原创手工博主 `userId`）, `tutorialVideoUrl?`（博主教学视频）, `qcOwner: 'volunteer_or_admin' | 'creator_led'`（开启 `creator_led` 时该款成品照与试做照直接推给原创博主把关，超时运营兜底）, `requiresEnrollment: boolean`（是否限量报名特色材料款）, `enrollmentQuota?: number`, `enrollmentMinOrderCount?: number`, `weaverShipShareFen`（织女分摊固定邮费，如 300 分）, `ownerType: 'platform' | 'creator'`, `licenseDocId`, `status: 'draft' | 'active' | 'archived'`

#### 6) `products`（小程序买家端上架商品）
* `_id`：`prod_<ulid>`
* 字段：`skuCode`, `saleType: 'made_to_order' | 'ready_stock'`（定制排单 3–5 天发 / 成品余货专区 48h 发）, `title`, `coverFileIds: string[]`, `detailFileIds: string[]`, `priceFen`, `buyerShipFeeFen`, `etaText: string`（默认“下单后 3–5 天内发出”或“现货 48 小时内发出”）, `sortOrder`, `isOnSale: boolean`, `updatedAt`
* 索引：`(isOnSale, saleType, sortOrder)`, `skuCode`

#### 7) `patterns`（歌词式图解）与 `patternModules`（可拼装图解部件库）
* `patterns._id`：`pat_<ulid>`；字段：`skuCode`, `version`, `sourceModuleIds?: string[]`, `parts: Array<{ partName, moduleId?, steps: Array<{ rowNo, text, stitchCount?, note?, imageFileId? }> }>`, `authorUserId`, `copyrightDocId`, `status: 'draft' | 'approved'`, `updatedAt`
* `patternModules._id`：`mod_<code>`；字段：`name`, `category: 'body' | 'head' | 'outfit' | 'accessory' | 'joint'`, `standardMin`, `yarnBom: Array<{ yarnCode, netWeightG, slotKey? }>`（支持按 `slotKey` 换色定制）, `extraAccessoryCostFen`, `steps`, `authorUserId`, `status`——由 `@wxtz/shared` 的 `composeModularPatternAndBom()` 自动合并局部工时、局部克重 BOM 与歌词步骤。

#### 8) `weaverStock`（织女成品余货与淡季配额预备现货，带并发防超卖预占锁）
* `_id`：`stock_${weaverId}_${skuCode}`（确定性主键）
* 字段：`weaverId`, `skuCode`, `availableQty: number`（可售现货数）, `reservedQty: number`（下单未支付预占数，15 分钟超时释放）, `reservations: Array<{ orderId, qty, expireAt }>`, `items: Array<{ sourceType: 'cancelled_order' | 'premade_quota', sourcePkgId?, reviewId?, createdAt, clearedAt? }>`（支持取消转余货 + 常青款淡季配额预做现货，售出后按正常签收周期结款）, `oldestCreatedAt: number`（超 7 天未清触发直播专场提醒）, `updatedAt`
* **防超卖硬约束**：小程序现货下单必须执行 DB 原子条件更新 `where({ _id, availableQty: _.gte(qty) }).update({ availableQty: _.inc(-qty), reservedQty: _.inc(qty) })`；未支付超 15 分钟由定时任务释放回 `availableQty`。
* 索引：`(skuCode, availableQty)`, `(availableQty, oldestCreatedAt)`

---

### 3.3 订单、派单、质检与物流（7 集合）

#### 9) `orders`（买家订单主表，与 `orderPackages` 一对多）
* `_id`：`ord_<ulid>`
* 字段：`channel: 'douyin_online' | 'mp_wechat'`, `externalOrderId?`（抖店订单号）, `buyerUserId?`（小程序订单必填）, `referrerCreatorId?`（**预留接缝**：短视频/专属码引流归因的手工博主 `userId`）, `receiverAddrId?`（小程序订单引用 `addresses._id`）, `productId?`, `skuCode`, `qty: number`（小程序首版一单一款）, `totalPaidFen`, `buyerShipFeeFen`, `paymentId?`, `status: 'unpaid' | 'paid' | 'fulfilled' | 'refunding' | 'refunded' | 'closed'`, `paidAt?`, `createdAt`, `updatedAt`
* 索引：`(buyerUserId, createdAt)`, `(channel, status, createdAt)`

#### 10) `orderPackages`（核心履约单元——订单包）
* `_id`：`pkg_<ulid>`
* 字段：
  * 来源与归属：`channel: 'douyin_online' | 'mp_wechat'`, `poolTarget: 'live' | 'mp'`, `orderIds: string[]`, `externalOrderIds: string[]`, `buyerUserId?`, `buyerProvince`, `buyerCity`, `mergeKey?`（抖店合单 `sha256`）
  * 下单快照：`itemsSnapshot: Array<{ skuCode, qty, standardMin, yarnBomSnapshot: Array<{ yarnCode, consumedG }>, materialCostFen, craftFeeFen, yarnPoolAccrualFen, weaverShipShareFen, saleType }>`, `totalMin: number`
  * 状态与派单：`status`（见 §4.1）, `assignedWeaverId?`, `queueSeq?: number`（织女队列序号，1 为队首）, `isReadyStockReuse: boolean`, `attemptCount: number`, `reviewMode: 'required' | 'sampled' | 'skip'`
  * 实物绑定与时间：`bagQrCode?`, `dispatchableAt`, `acceptedAt?`, `dueAt?`（付款+14 天）, `shippedAt?`, `signedAt?`, `settleEligibleAt?`（签收+7 天）, `settledBatchId?`, `version: number`（CAS 乐观锁）
* 索引：`(status, poolTarget, dispatchableAt)`, `(assignedWeaverId, status, queueSeq)`, `(status, settleEligibleAt)`, `(channel, mergeKey, status)`

#### 11) `externalOrderIndex`（外部订单幂等去重表）
* `_id`：`${channel}:${externalOrderId}`
* 字段：`orderId`, `packageId`, `createdAt`

#### 12) `dispatchOffers`（派单邀约记录）
* `_id`：`offer_${packageId}_${attemptNo}`（确定性主键）
* 字段：`packageId`, `attemptNo`, `weaverId`, `matchTier: 'stock' | 'repeat' | 'same_province' | 'same_region' | 'national'`, `status: 'pending' | 'accepted' | 'rejected' | 'timeout' | 'cancelled'`, `offeredAt`, `smsReminderSentAt?`（50 分钟补发短信标记）, `expireAt`（+60 分钟）, `respondedAt?`, `yarnAvailabilityConfirmed: boolean`（注：线团无条码可扫，色号归属由小程序领线记录掌控，接单仅确认手头有余量）
* 索引：`(status, expireAt)`, `(weaverId, status)`

#### 13) `photoReviews`（统一审照单：3 张固定标准机位 + 2 小时超时快审 SLA）
* `_id`：`rev_<ulid>`
* 字段：`scene: 'shipment_qc' | 'funnel_portfolio' | 'funnel_trial'`, `targetId`（`packageId` 或 `funnelId`）, `weaverId`（**仅后端校验用，严禁下发给志愿者**）, `skuCode?`, `photoSlots?: { frontOnScaleCard: string, backStitch: string, sidePlumpness: string }`（**出货成品照强制 3 机位：正面压标准刻度比对卡验尺寸 / 背面特写验藏线 / 侧面捏压验饱满度**；随袋码贴纸一并寄发纸质标准刻度比对卡）, `photoFileIds: string[]`, `imageHashes: string[]`（pHash 跨单/跨织女查重）, `duplicateFlag: boolean`, `exifMeta?: object`, `isCalibrationSample: boolean`, `requiredVotes: number`（默认 5）, `slaDeadlineAt: number`（**默认提交 +2 小时：超时未凑齐 5 票时，若已有 ≥2 位高准确率志愿者全给通过且无差评则自动放行，否则弹运营秒审**）, `voteCount: number`, `avgScore?: number`, `scoreSpread?: number`（极差 ≥3 转复议）, `status: 'pending' | 'needs_admin' | 'approved' | 'rejected'`, `rejectReason?`, `finalDecisionBy?`, `createdAt`, `decidedAt?`
* 索引：`(status, slaDeadlineAt)`, `(status, scene, createdAt)`, `imageHashes`, `(targetId, scene)`

#### 14) `volunteerVotes`（粉丝志愿者匿名打分票）
* `_id`：`vote_${reviewId}_${volunteerUserId}`（确定性主键，一人一票）
* 字段：`reviewId`, `volunteerUserId`, `score: number`（1–5 或通过/不通过）, `tags: string[]`, `dwellMs: number`（强制校验 `>= 8000`）, `isCalibrationHit?: boolean`, `createdAt`
* 索引：`(reviewId)`, `(volunteerUserId, createdAt)`

#### 15) `shipments`（物流发货单，兼容村镇驿站自寄兜底）
* `_id`：`ship_${packageId}`（确定性主键）
* 字段：`packageId`, `fulfillMode: 'douyin_online' | 'douyin_erp' | 'kuaidi100_pickup' | 'weaver_self_ship'`（村镇快递员不上门时，允许切为 `weaver_self_ship` 驿站自寄+填单号，随结款按平台标准协议价补织女邮费）, `hubId?: string`（二期预留）, `pickupWindow?: string`, `sealedPhotoFileId?`, `doudianAddressAlias?`, `senderAddrId?`, `receiverAddrId?`, `kuaidi100TaskId?`, `carrierCode?`, `trackingNo?`, `shippingCostFen?: number`, `selfShipReimbFen?: number`, `insuredFeeFen?: number`, `pickupRetryCount: number`（失败自动重约 ≤2 次）, `status: 'awaiting_seal' | 'ready_to_ship' | 'pickup_scheduled' | 'in_transit' | 'signed' | 'lost_or_damaged' | 'cancelled'`, `updatedAt`
* 索引：`(status, fulfillMode)`, `trackingNo (sparse)`, `kuaidi100TaskId (sparse)`

---

### 3.4 支付、退款与工单（3 集合）

#### 16) `payments`（微信小程序支付单）
* `_id`：`pay_${orderId}`（确定性主键）
* 字段：`orderId`, `buyerUserId`, `mchId`（记录收款商户号，支持主体迁移对账）, `outTradeNo`, `wxTransactionId?`, `amountFen`, `wxFeeFen?`, `status: 'init' | 'paid' | 'closed'`, `paidAt?`, `rawNotifyAt?`
* 索引：`wxTransactionId (sparse unique)`, `outTradeNo (unique)`

#### 17) `refunds`（退款单）
* `_id`：`ref_${orderId}_${seq}`（确定性主键）
* 字段：`orderId`, `packageId`, `channel`, `trigger: 'buyer_pre_dispatch' | 'buyer_in_making' | 'buyer_return_7d' | 'quality_defect' | 'logistics_loss'`, `autoApproved: boolean`, `amountFen`, `wxRefundId?`, `weaverCraftPolicy: 'none' | 'keep_as_stock' | 'keep_paid' | 'forfeit_craft_only'`, `status: 'pending_review' | 'refunding' | 'succeeded' | 'rejected' | 'failed'`, `operatorId?`, `reason`, `createdAt`, `completedAt?`
* 索引：`(status, createdAt)`, `orderId`, `packageId`

#### 18) `tickets`（织女工单 & 小程序售后单）
* `_id`：`tkt_<ulid>`
* 字段：`userId`, `role: 'buyer' | 'weaver'`, `type: 'order_issue' | 'after_sale' | 'yarn_issue' | 'pattern_bug' | 'other'`, `relatedId?`, `content`, `photoFileIds: string[]`, `status: 'open' | 'processing' | 'resolved'`, `reply?`, `handlerId?`, `createdAt`, `updatedAt`
* 索引：`(status, role, createdAt)`, `userId`

---

### 3.5 线材、袋码与复式账本（6 集合）

#### 19) `yarnCatalog`（线材与标准辅料包目录）
* `_id`：`<yarnCode>`
* 字段：`name`, `brand`, `itemType: 'yarn' | 'accessory_kit' | 'material_pack'`（**将指定规格 PP 填充棉、安全眼、钥匙扣件、胶水套件化并入江浙沪主供应商同仓代发**，统一锁死辅料品质）, `isBase12: boolean`, `isMaterialPack: boolean`, `packItems?: Array<{ yarnCode, qty }>`, `unitWeightG: number`（每团标准克重，整数克，如 50g；辅料包可为 0）, `unitCostFen`, `supplierId`（默认江浙沪主供应商，后期支持按 `regionCode` 路由区域供应商）, `supplierSkuCode`（**严格对齐主供应商官方编码**）, `status: 'active' | 'out_of_stock' | 'archived'`

#### 20) `yarnClaims`（每周线材申领，表格一件代发）
* `_id`：`claim_${weaverId}_${weekKey}`（确定性主键，如 `claim_usr_xxx_2026W48`）
* 字段：`weaverId`, `weekKey`, `sendAddrId`（引用织女地址）, `items: Array<{ yarnCode, supplierSkuCode, qty, unitWeightG, unitCostFen }>`, `totalQty: number`（校验 `>= 3` 团或含整包材料包）, `materialsCostFen`, `shippingFeeFen`（按锁定运费表含偏远加价算）, `status: 'reserved' | 'confirmed' | 'dispatched' | 'received' | 'cancelled'`（`exported` 与 `shipped` 合并为 `dispatched`，不强制回导几百条运单号）, `exportBatchId?`, `receivedConfirmedAt?`, `confirmPhotoFileId?`（织女收货点击确认并可选拍到货合照，按 `qty` 自动累加 `users.yarnInventory[yarnCode].wholeSkeins`）, `createdAt`
* 索引：`(status, weekKey)`, `exportBatchId (sparse)`

#### 21) `bagStickers`（封袋贴纸袋码）
* `_id`：`stk_<code>`
* 字段：`code`, `weaverId`, `batchId`, `status: 'unused' | 'bound' | 'void'`, `boundPackageId?`, `boundAt?`
* 索引：`(weaverId, status)`

#### 22) `ledgerAccounts`（复式账科目表，待会计终审口径）
* `_id`：`<accountCode>`（如 `ASSET_WXPAY_CASH`、`LIAB_WEAVER_PAYABLE`、`LIAB_YARN_POOL` 等，见 §6）
* 字段：`name`, `category: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'`, `normalSide: 'debit' | 'credit'`

#### 23) `ledgerEntries`（不可变复式账分录——资金唯一事实）
* `_id`：确定性幂等键（见 §6）
* 字段：`eventType`, `bizId`（关联 `packageId`/`orderId`/`claimId`/`batchId`）, `payeeId?`（织女/创作者 `userId`，与账号解耦支持将来团队收款）, `settlementBatchId?`, `lines: Array<{ accountCode, subAccountId?, debitFen: number, creditFen: number }>`, `memo`, `createdAt`
* **强校验**：写入云函数必须校验 `lines.length >= 2` 且 `sum(debitFen) === sum(creditFen) > 0`；禁止任何 update/delete。
* 索引：`(payeeId, createdAt)`, `(settlementBatchId)`, `(bizId, eventType)`

#### 24) `weaverAccounts`（织女余额原子并发锁闸门）
* `_id`：`acc_${userId}`（确定性主键）
* 字段：`userId`, `yarnPoolBalanceFen: number`, `payableBalanceFen: number`, `depositFen: number`, `version: number`, `updatedAt`
* **并发安全与对账铁律**：`ledgerEntries` 仍是唯一账务事实；`weaverAccounts` 用于高并发防透支原子锁（申领扣池与退出退还统一执行 DB 条件更新 `where({ _id, yarnPoolBalanceFen: _.gte(costFen) })`）；每日 `cron` 全量校验 `weaverAccounts === sum(ledgerEntries)`，发现 1 分差异立即告警。

#### 25) `styleEnrollments`（特色款限量报名池——手工博主生态预留接缝）
* `_id`：`enroll_${skuCode}_${weaverId}`（确定性主键）
* 字段：`skuCode`, `weaverId`, `creatorUserId`, `status: 'applied' | 'materials_ready' | 'certified' | 'revoked'`, `certifiedBy?`, `certifiedAt?`, `createdAt`
* **用途**：针对用到非 12 基础色特殊材料的博主款，限量开放织女报名名额；派单引擎只需一行判断（当 `style.requiresEnrollment=true` 时，仅从 `status='certified'` 的已报名织女中派单），彻底解决特色款备料与囤货风险。阶段 1 建表留接缝，自有款跑顺后即无缝启用。

#### 系统支撑集合（4 个）
* `settlementBatches`（`_id: batch_${YYYYMMDD}`）：14 天批量结款批次、人数、总金额、**网银标准批量代发模板（招行/网商银行格式）Excel 导出记录**、打款回执一键核销态。
* `notifications`（`_id: ntf_<ulid>`）：订阅消息授权余量池（在织女端开关接单、交成品照、确认收货、看收入、核对余线等高频按钮顺手挂载订阅授权蓄水，大幅节省短信费）、触达结果、超时前 10 分钟短信补发记录。
* `auditLog`（`_id: aud_<ulid>`）：运营关键动作审计（改派、强制审过、修改配置、导出结款）。
* `config`（`_id: <key>`）：动态配置项，含 `regions` 与 `activeRecruitRegions`（一期 `['jzh']`）、`recruitGate`、`dispatchWindow`（8–21 整点）、**`queueHorizonDays`（按渠道分开锁排队工时上限：`mp_wechat: 3` 天可用工时，匹配“3–5 天内发出”承诺；`douyin_online` 按预售天数单独配）**、**`stallGuard`（中途停工快速熔断：接单 `12h` 内无责主动转单；队首超 `24h` 无动静自动询问，`6h` 不回自动收回改派，夜间睡眠时段顺延）**、`reviewSlaHours`（`2`，盲审超 2 小时满 2 票全优自动放行否则弹运营）、`monthlyRevenueTaxAlertFen`（个体户月流水免税临界预警线）、`yarnShippingRates`、`yarnMinQty`（3 团）、`yarnLowAlertSkeins`（`1`）、`payoutChannel`、`depositChannel`、`wxpayActiveMch`、`kuaidi100Config`、`stockClearDays`（7 天）。

---

## 4. 核心状态机设计

### 4.1 订单包主状态机 `ORDER_PACKAGE_STATUS_SPEC`
抖店（`douyin_online`）与小程序（`mp_wechat`）共用同一套状态机，唯一流转入口为 `kit/transition.ts`：

```text
[confirming] ──(合单窗结束/小程序支付即过)──► [waiting_dispatch]
      │                                              │
 (派单前取消)                                   (整点派单)
      ▼                                              ▼
[cancelled_full]                              [offered] ──(拒接/1h超时, <上限)──► [waiting_dispatch]
                                                 │  │
                                          (连续无人接/超24h)
                                                 │  └──────────────────────────► [manual_hold]
                                            (一键接单·确认有线)
                                                 │  │
                   (余货复用 isReadyStockReuse=true：不扣线材克重，跳过制作与审照)──┐
                                                 ▼                                │
                                              [making] ──(开工后买家退款, 固定款)──► [cancelled_made] (继续做完入 weaverStock)
                                                 │  │                             │
                                  (需审单：裸拍成品照)  └─(高信用免审单 reviewMode=skip：一次完成裸拍+扫袋码装袋封签)──┐
                                                 ▼                                │                             │
                                           [photo_review] ──(驳回重做)──► [making] │                             │
                                                 │                                │                             │
                                              (审过)                              │                             │
                                                 ▼                                │                             │
                                           [awaiting_seal] ◄──────────────────────┘                             │
                                                 │                                                              │
                                     (装袋+扫袋码+贴封签拍照)                                                    │
                                                 ▼                                                              │
                                           [ready_to_ship] ◄────────────────────────────────────────────────────┘
                                                 │
                      ┌── 抖店：运营在在线寄件/ERP取号并回导CSV ──┐
                      └── 小程序：云函数调快递100 API回调运单号 ──┘
                                                 ▼
                                             [shipped] ──(快递确认丢件/破损)──► [lost_compensated] (赔买家+照结工价)
                                                 │
                                              (签收)
                                                 ▼
                                             [signed] ──(7天内退货/质量退款)──► [returned] / [quality_refunded]
                                                 │
                                            (满7天无售后)
                                                 ▼
                                           [settled_ready] ──(14天批量结款)──► [settled]
```

**两渠道差异收敛（仅发生在入口与出口 2 处）**：
1. **入池与取消**：抖店订单经 CSV 导入进 `confirming`（次日 8:30 重导先处理退款）；小程序订单微信支付回调成功直接进 `waiting_dispatch`，派单前买家申请退款由云函数自动调微信退款并转 `cancelled_full`，开工后申请退款进 `refunds(pending_review)` 由运营审核通过后转 `cancelled_made` 并继续做完转入 `weaverStock`。
2. **发货与签收**：`douyin_online` 在 `ready_to_ship` 进后台待发货清单，运营在中通吉 ERP / 在线寄件操作并回导运单/签收；`mp_wechat` 进入 `ready_to_ship` 时自动触发快递100 上门取件 API（失败自动重约 ≤2 次，仍失败进 `manual_hold`），由快递100 HTTPS 回调驱动 `shipped` 与 `signed`。

### 4.2 四步准入漏斗状态机 `RECRUIT_FUNNEL_SPEC`（2026-11-24 第 9 轮正式定型）
```text
[apply_entry] (第1步·初筛报名页一次提交：校验江浙沪等开放大区 + 8道常识自动判分 + 3张旧作盲审，≤2次)
   │ 审查通过 ──► 明确告知：即将考察【专用非卖品考级小样】，通过后须缴 200 元合作履约保证金
   ▼
[trial_make] (第2步·专用非卖品考级小样拍照初验：40分钟涵盖核心针法，零商业图解泄密风险，≤2次)
   │ 通过
   ▼
[sample_inspect] (第3步·自费寄考级小样实物入库终验，邮费织女自理不报销，允许重寄1次)
   │ 终验通过
   ▼
[pending_deposit] (第4步·缴付 200 元合作履约保证金，写 LIAB_WEAVER_DEPOSIT 专账负债不挪用)
   │ 缴付成功
   ▼
[approved]（正式开通接单权限，初始化12基础色 wholeSkeins=1；无违约退出原路全额退还）
   │
   └── 任一阶段超重提次数 ──► [rejected]（设置 cooldownUntil = now + 30天）
```

### 4.3 织女产能与安全可售库存算法 `CAPACITY_SPEC`（2026-11-24 定稿）

单看“人数 × 每日工时”会产生虚假产能（比如织女请假了、手里积压了旧单、或者**有空但手头白线不够钩 1 个**）。系统采用**「工时约束 × 余线约束」双木桶取小算法**：

1. **单织女窗口净可用工时 `freeMin(w, H)`**
   * 设渠道承诺对应的制作窗口天数为 $H$（小程序池 $H_{\text{mp}} = 3$ 天，匹配 3–5 天发；直播池 $H_{\text{live}}$ 按抖店预售天数减 2 天物流缓冲）。
   * 过滤不可接单织女：若 `acceptingOrders=false`、`pauseUntil > now`、或队首处于超 24h 停工预警中，直接 `freeMin = 0`。
   * 扣除窗口内休息日：`activeDays = H - count(restDays in next H days)`。
   * 结合个人手速修正系数 `speedFactor`（初始 `1.0`，按近 10 单实际交货速度在 `0.6 ~ 1.3` 平滑微调）与 `0.70` 安全垫，减去在途积压工时 `backlogMin`（`offered + making + photo_review` 订单包工时之和）：
     $$\text{freeMin}(w, H) = \max\Bigl(0,\; \lfloor \text{activeDays} \times \text{dailyCapacityMin} \times \text{speedFactor} \times 0.70 \rfloor - \text{backlogMin}(w)\Bigr)$$

2. **单织女对指定款 $S$ 的真实可接件数 `u(w, S)`（工时与余线双木桶取小）**
   * 工时能钩几件：$u_{\text{time}}(w, S) = \lfloor \text{freeMin}(w, H) / \text{standardMin}(S) \rfloor$
   * 手头余线够钩几件（防“有空但没线”假产能）：对款 $S$ 的每个 BOM 色号 $c$，估算可用克重 $\text{availG}(w, c) = \text{wholeSkeins} \times W_0 + \max(0, W_0 - \text{usedSinceCheckG})$（若 `status='empty'` 则为 0），取短板色号：
     $$u_{\text{yarn}}(w, S) = \min_{c \in \text{BOM}(S)} \left\lfloor \frac{\text{availG}(w, c)}{\text{consumedG}(S, c)} \right\rfloor$$
   * 该织女真实可接件数：$u(w, S) = \min\bigl(u_{\text{time}}(w, S),\; u_{\text{yarn}}(w, S)\bigr)$

3. **两端的库存输出方式（防多款重复透支同一批工时）**
   * **直播池开播前安全库存建议（`admin` 首页置顶照抄）**：
     * 单爆款主推：$\text{SafeQty}(S) = \text{availableStock}(S) + \lfloor \eta \times \sum_{w \in \text{live}} u(w, S) \rfloor$（$\eta = 0.85$ 为接单响应率折算）。
     * 多款同场开播：运营输入主副款预计比例（如 A 款 70%、B 款 30%），系统先按比例切分每位织女的 `freeMin(w, H)` 再分别与余线取小求和，**严防把同一位织女的空闲工时在 A、B 两款上重复卖两次**。
   * **小程序池实时动态控量**：所有在售定制款实时共享 `pool='mp'`（加直播池富余）的 `freeMin`；顾客每次点进商品页/下单前实时计算当前款 $S$ 是否有至少 1 位候选织女满足 $u(w, S) \ge 1$，为 0 则显示“暂时售罄”并开放到货提醒。

---

## 5. 云函数模块与定时任务规划

### 5.1 云函数分组（低冷启动、按域收口）
| 云函数名 | 服务对象 | 核心 Action |
|---|---|---|
| `auth` | 双端 + Admin | 跨端登录归并（openid → phone → `userId`）、分级实名提交、角色查询 |
| `buyer` | `mp-buyer` | 商品与余货列表（带实时剩余工时 70% 容量检查）、下单生成微信预支付单、地址管理、申请退款（派单前自动秒退 / 开工后转人工）、订单物流查询、到货提醒订阅 |
| `weaver` | `mp-weaver` | 一键接单/拒单（余货复用直通装袋且不重复扣线）、队列与歌词式图解获取（带短链+队首校验）、需审单裸拍送审 + 审过扫袋码装袋封签（免审单一步合二为一）、每周线材申领（基础 12 色耗尽后亦可申领，走 `weaverAccounts` 原子锁防透支 + ≥3 团校验）、收货整团入账与逢 50g 一键核对校准、200 元保证金缴付入口（按 `depositChannel` 路由）、收入账单、漏斗提交、工单、内部图解编辑器 |
| `volunteer` | `mp-buyer`（角色入口） | 拉取盲审卡片（去织女身份、回避规则、混入 5% 校准题）、提交评分（校验停留 ≥8 秒）、积分与荣誉榜 |
| `admin` | `admin` Web | JWT/扫码鉴权；**首页实时计算今晚直播各款安全可售件数**；**抖店导单页双框防呆（未传售后退款表且未勾选确认“今日0退款”时锁死派单按钮）**；待发货清单与按织女分组导出、每周线材申领按主供应商模板一键导出 CSV 并标 `dispatched`、漏斗终审与样品入库验收、200 元保证金人工核对/退出退还、成品照复核、异常改派、14 天结款网银批量模板生成与打款确认、款式 BOM/商品/配置管理 |
| `webhook-wxpay` | 微信支付回调 | 验签解密 → 幂等更新 `payments`/`refunds` → 写复式账 → 驱动 `orders`/`orderPackages` 状态 |
| `webhook-kuaidi100` | 快递100 回调 | 验签 → 写运单号/实际运费 → 驱动 `shipments` 与 `orderPackages`（`shipped` / `signed` / 异常重试） |
| `cron` | 定时触发器 | 见下表 |

### 5.2 定时任务清单
| 定时规则 | 任务 |
|---|---|
| 每天 8:00–21:00 整点 | `dispatchTick`：分别对 `mp` 池与 `live` 池（9:00–13:00）按优先级执行整点派单（余货优先 → 回头客 → 同省 → 同大区 → 全国，拦截自买自接） |
| 每 5 分钟 | `offerStockAndSlaWatchdog`：①派单距超时 10 分钟补短信、超 60 分钟 `timeout` 改派；②扫描超 15 分钟未支付的 `weaverStock` 现货预占锁并释放；③扫描超 2 小时未凑齐 5 票的 `photoReviews`（满 2 票全优自动放行，否则转 `needs_admin` 弹运营秒审）；④队首 `making` 超 24 小时无动静发询问，再超 6 小时（避开夜间 0–8 点）自动收回改派 |
| 每天 02:00 | `settleAndReconcileSweep`：签收满 7 天无售后的订单包转 `settled_ready` 并写入纯工价 + 材料费独立复式分录（若为村镇驿站自寄则同步计提标准协议价运费补贴）；同时全量对账校验 `weaverAccounts === sum(ledgerEntries)` |
| 每天 09:00 | `dueAndStockAlert`：临近交期提醒；成品余货超 7 天未清提醒运营开专场；检查当月流水是否接近个体户免税临界线（提醒迁公司与切换合规代发通道） |
| 每周一 09:00 | `weeklyGovernance`：计算 `recruitGate`（近 4 周人均单量）；汇总预计垫付现金流提醒 |

---

## 6. 复式账本科目草案与标准幂等键（待会计最终核定）

| 科目编码 | 名称 | 类别 | 说明 |
|---|---|---|---|
| `ASSET_WXPAY_CASH` | 微信支付商户号资金 | 资产 | 小程序买家实付货款 |
| `ASSET_DOUYIN_AR` | 抖店应收货款 | 资产 | 抖店订单货款 |
| `ASSET_KD100_PREPAID` | 快递100 预充余额 | 资产 | 小程序寄件运费预充 |
| `LIAB_WEAVER_PAYABLE` | 应付织女结款 | 负债 | 待 14 天批量打款的织女应得 |
| `LIAB_YARN_POOL` | 织女个人线材预算池 | 负债 | 严禁透支，按 `subAccountId = weaverId` 聚合 |
| `LIAB_WEAVER_DEPOSIT` | 织女合作履约保证金 | 负债 | 每位织女 200 元（20000 分），不计入收入，退出无违约全额原路退还 |
| `LIAB_CREATOR_PAYABLE` | 应付创作者分成 | 负债 | 阶段 2 外部创作者分成 |
| `REV_PRODUCT_SALES` | 商品销售收入 | 收入 | 自营卖方商品收入（含平台服务费口径） |
| `EXP_CRAFT_COST` | 委外钩织纯工价成本 | 费用 | 织女按款固定纯劳动工价（不含材料费） |
| `EXP_MATERIAL_COST` | 单件毛线与辅料材料费 | 费用 | 按款级克重 BOM 自动核算并计入售价的材料成本，专款划入织女线材池 |
| `EXP_SHIPPING_PLATFORM` | 平台承担物流费 | 费用 | 实际运费减去买家与织女分摊后的差额 |
| `EXP_PAYMENT_FEE` | 支付渠道手续费 | 费用 | 微信/抖店手续费 |
| `EXP_LOSS_COMP` | 售后与丢损兜底支出 | 费用 | 质量退款平台差额、快递丢件兜底赔付（理赔到账冲回） |

**核心资金事件与确定性幂等键**：
1. 小程序收款（`pay:${orderId}`）：借 `ASSET_WXPAY_CASH`，贷 `REV_PRODUCT_SALES`（同时记微信手续费 `fee:${orderId}`）。
2. 签收满 7 天计提织女工价与线材池（`accrue:${pkgId}`，**纯工价与材料费完全分离、绝不从织女纯工价倒扣材料费**）：
   * 劳动工价部分：借 `EXP_CRAFT_COST`（`craftFeeFen`），贷 `LIAB_WEAVER_PAYABLE`（`craftFeeFen − weaverShipShareFen`）+ 贷/冲减 `EXP_SHIPPING_PLATFORM`（`weaverShipShareFen`）；
   * 材料费入池部分（已计入商品售价）：借 `EXP_MATERIAL_COST`（`yarnPoolAccrualFen`，≥ `materialCostFen`），贷 `LIAB_YARN_POOL`（`yarnPoolAccrualFen`），并原子递增 `weaverAccounts.yarnPoolBalanceFen`。
3. 每周线材申领扣池（`yarn_out:${claimId}`）：通过 `weaverAccounts` 执行 DB 原子条件扣减 `where({ yarnPoolBalanceFen: _.gte(materialsCostFen + shippingFeeFen) })` → 成功后写不可变分录：借 `LIAB_YARN_POOL`，贷应付供应商/现金。
4. 织女缴付/退还合作履约保证金（`deposit_in:${userId}` / `deposit_out:${userId}`）：缴付时借银行/微信收款账户 20000 分，贷 `LIAB_WEAVER_DEPOSIT` 20000 分（不进收入）；织女无违约彻底退出且所有订单满 7 天无售后时，借 `LIAB_WEAVER_DEPOSIT`、贷付款账户原路全额退还。
5. 质量退款（`qual_ref:${refundId}`）：退买家全款，**不计提该单织女工价、不倒扣织女其他应得余额**，平台差额入 `EXP_LOSS_COMP`。
6. 快递丢件赔付（`loss_comp:${pkgId}`）：退买家或重做入 `EXP_LOSS_COMP`，**照常执行织女工价计提 `accrue:${pkgId}`**；快递理赔到账冲减 `EXP_LOSS_COMP`。
7. 14 天批量结款（`payout:${batchId}:${payeeId}`）：借 `LIAB_WEAVER_PAYABLE`，贷银行存款/支付通道。

---

## 7. 开工前最后 4 项外部核对（不阻塞写框架代码）

以下 4 项推进同时，即可按本文 §1–§6 搭建 Monorepo、数据库集合、状态机与核心云函数骨架：
1. **律师与会计定稿**：确认二清边界、**200 元合作履约保证金在承揽关系下的合规与退出退还条款（L6/T5）**、粉丝志愿者合规（L11）、复式账科目表。
2. **微信主体与资质**：核实个体户注册 `mp-buyer`（电商类目）与 `mp-weaver`（工具类目）备案时长、微信支付商户号、订阅消息额度与短信服务商。
3. **快递100 商务确认**：住宅上门取件覆盖、隐私面单隐藏规则、HTTPS 回调与预充对账。
4. **首家线材供应商 + 抖店 ERP 7 天试用**：拿到主供应商打单 Excel 模板/官方色号表/偏远运费表；用熟人织女真实订单实测 `service_id=50`（中通吉快递管家）或 `service_id=10`（快递100 快递管家）。
