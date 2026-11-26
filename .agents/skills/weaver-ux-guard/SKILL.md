---
name: weaver-ux-guard
description: >-
  织女端适老、低识字与高信任交互守卫（融合 GOV.UK 一页一事、Vitaly Friedman 适老与 W3C COGA 认知友好规范、微信 WeUI 官方字阶及 Emil Kowalski 动效与触控准则）。凡设计、实现或审查织女端界面（design/*weaver* 与 packages/mp-weaver）必读并实跑校验脚本。
---

# 织女端适老与低认知负载 UX 守卫 (`weaver-ux-guard`)

织女端目标用户包含大量文化程度偏低、年长或老花眼的手艺人。本技能将 **GOV.UK 一页一事表单规范（Adam Silver）**、**老年与低识字认知无障碍（Vitaly Friedman / W3C COGA）**、**微信 WeUI 原生字阶** 与 **Emil Kowalski 触控/动效工程准则** 收敛为可执行门禁。

## 1. 四维硬约束清单

### A. 表单与决策极简（GOV.UK / `@adamsilverhq`）
1. **一屏一决策（One Thing Per Page）**：每屏最多承载 **1 个输入域或 1 组互斥选择**。严禁同屏混放两个独立决策（例如「录入快递单号」与「选择后续接单发货方式」必须拆成两屏）。
2. **持久标签，禁纯占位符**：所有输入框上方必须有持久可见的明确标题或说明，严禁仅靠输入即消失的 `placeholder` 提示填什么。
3. **平铺取代隐藏滚轮**：选项 `<= 6` 项时一律平铺为单选卡片或双列按钮，严禁折叠进 `<select>` 或需要精细拨动的滚轮选择器。

### B. 适老与低识字直观引导（Older Adults & W3C COGA / `@vitalyf`）
1. **图示直给与文案五条铁律**：凡拍照标准页必须提供直观**正误图示**；所有给织女看的文字必须逐条满足 `.agents/rules/design-copy-rules.md` 五条铁律：① **内部用语改通用语言**；② **小学生也能理解**；③ **参考微信/抖音/淘宝成熟通用用语**；④ **「四不出现」**；⑤ **零同屏重复、零废话填充**（能不写就不写，图示/直白选项不配同义副说明，考核题不加剧透副标题）。
2. **输入减负优先**：凡可通过「微信授权、扫码、一键复制、单点直进」完成的步骤，必须把免打字入口放在首位，手动键盘输入仅作备选兜底。
3. **44px 触控热区底线**：所有可交互控件的有效触控高度 `>= 44px`（主按钮 `>= 48px`）。
4. **禁单靠颜色表意 & 高对比**：选中态、合格/不合格、警告提示必须同时具备图形（勾/叉/感叹号）或文字标签；正文与主按钮对比度 `>= 4.5:1`。

### C. 微信 WeUI 字阶与零滚动铁律（`AGENTS.md` §5）
1. **零滚动视口锁死**：在 `375×667`（标准小屏）与 `320×620`（超窄压力视口）下，所有步骤屏实测 `scrollHeight <= clientHeight` 且 `scrollWidth <= clientWidth`。
2. **点选直进与单一主按钮**：单选与上传步骤点选即自动推进，需确认的页面仅保留底部单一主按钮；非首页左上角全程保留「返回」。
3. **WeUI 官方字阶**：界面字号严格落在 `[12, 14, 15, 17, 22]`（及看板数字 `34px` + `tabular-nums`），字重保持 `400–600`，禁用全屏超粗黑体或规范外随意字号，且手机端零 Emoji。

### D. 触控手感与动效克制（Emil Kowalski 准则）
1. **缓动与时长**：严禁 `ease-in` 与 `scale(0)` 起始缩放；仅使用自定义 `ease-out`，UI 过渡 `< 300ms`（微淡入 `125ms`），触发式浮层与底部抽屉必须从触发源方向展开（Origin-Aware）。
2. **何时不动**：键盘快捷键切屏、评审跳页、同屏切换选项一律 `0ms` 瞬时更新；完整声明 `@media (prefers-reduced-motion: reduce)`。
3. **移动端叠加防坑（`/mobile-native`）**：所有 `:hover` 必须包裹在 `@media (hover: hover) and (pointer: fine)` 内防触屏悬停残留；交互元素声明 `touch-action: manipulation` 与 `user-select: none`；`<input>` 字号 `>= 16px`（WeUI `17px`）防 iOS 自动放大视口。

## 2. 分阶段验证命令（配合 `ux-draft` 双轨制）

```bash
# 阶段 A（design/* 草稿提案默认）：仅跑毫秒级静态 CSS / WeUI Token / Emoji 规范检查（< 50ms，不启浏览器）
node .agents/skills/weaver-ux-guard/scripts/check-weaver-ux.mjs design/<target>.html

# 阶段 B（精修定稿或落入 packages/mp-weaver 前）：叠加 ego-browser 多视口（375x667 / 320x620）、触控热区、对比度与零溢出实测
node .agents/skills/weaver-ux-guard/scripts/check-weaver-ux.mjs design/<target>.html --browser
```
