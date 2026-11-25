import { callWeaverCloud } from "../../utils/cloud";

declare const wx: any;
declare function Page(opts: Record<string, any>): void;

/**
 * Lyric Pattern Companion Page (docs/07 §2.4 Mandatory Rules):
 * 1. Auto screen-on (`wx.setKeepScreenOn({ keepScreenOn: true })`) while open; restored on hide/unload.
 * 2. ZERO background audio focus theft — never instantiate `InnerAudioContext` or `BackgroundAudioManager`
 *    so Ximalaya / Xiaoyuzhou / WeRead / Bilibili PiP keep playing uninterrupted!
 * 3. Tactile row step feedback via `wx.vibrateShort({ type: 'light' })`.
 * 4. OLED pure-black dark mode + lower-half primary controls avoiding top-right PiP floating video window.
 * 5. Anti-leak protection: `wx.setVisualEffectOnCapture({ visualEffect: 'hidden' })` + diagonal `weaverNo` watermark.
 */
Page({
  data: {
    packageId: "",
    darkMode: true,
    watermarkText: "",
    parts: [] as Array<{ partName: string; steps: Array<{ rowNo: number; text: string; stitchCount?: number }> }>,
    partIdx: 0,
    stepIdx: 0,
    currentPartName: "",
    prevStep: null as any,
    currStep: null as any,
    nextStep: null as any,
    watermarks: [1, 2, 3, 4, 5, 6],
  },

  onLoad(query: Record<string, string>) {
    const packageId = query.packageId || "";
    this.setData({ packageId });
    if (packageId) {
      this.loadHeadPattern(packageId);
    }
  },

  onShow() {
    if (wx.setKeepScreenOn) {
      wx.setKeepScreenOn({ keepScreenOn: true });
    }
    if (wx.setVisualEffectOnCapture) {
      wx.setVisualEffectOnCapture({ visualEffect: "hidden" });
    }
  },

  onHide() {
    if (wx.setKeepScreenOn) {
      wx.setKeepScreenOn({ keepScreenOn: false });
    }
  },

  onUnload() {
    if (wx.setKeepScreenOn) {
      wx.setKeepScreenOn({ keepScreenOn: false });
    }
    if (wx.setVisualEffectOnCapture) {
      wx.setVisualEffectOnCapture({ visualEffect: "none" });
    }
  },

  async loadHeadPattern(packageId: string) {
    const res = await callWeaverCloud("weaver.getHeadPattern", { packageId });
    const parts = res.pattern?.parts || [];
    this.setData({
      watermarkText: res.watermarkText || "无限天真防外流专用图解",
      parts,
      partIdx: 0,
      stepIdx: 0,
    });
    this.syncLyricWindow(0, 0);
  },

  syncLyricWindow(partIdx: number, stepIdx: number) {
    const part = this.data.parts[partIdx];
    if (!part) return;
    const steps = part.steps || [];
    this.setData({
      partIdx,
      stepIdx,
      currentPartName: part.partName,
      prevStep: stepIdx > 0 ? steps[stepIdx - 1] : null,
      currStep: steps[stepIdx] || null,
      nextStep: stepIdx + 1 < steps.length ? steps[stepIdx + 1] : null,
    });
  },

  onToggleDarkMode() {
    this.setData({ darkMode: !this.data.darkMode });
  },

  onStepDelta(e: any) {
    const delta = Number(e.currentTarget.dataset.delta || 1);
    const { parts, partIdx, stepIdx } = this.data;
    const curPart = parts[partIdx];
    if (!curPart) return;

    let nextPartIdx = partIdx;
    let nextStepIdx = stepIdx + delta;

    if (nextStepIdx >= curPart.steps.length) {
      if (partIdx + 1 < parts.length) {
        nextPartIdx = partIdx + 1;
        nextStepIdx = 0;
      } else {
        nextStepIdx = curPart.steps.length - 1;
      }
    } else if (nextStepIdx < 0) {
      if (partIdx > 0) {
        nextPartIdx = partIdx - 1;
        nextStepIdx = Math.max(0, parts[nextPartIdx]!.steps.length - 1);
      } else {
        nextStepIdx = 0;
      }
    }

    // Pure tactile feedback — zero audio focus搶占!
    if (wx.vibrateShort) {
      wx.vibrateShort({ type: "light" });
    }
    this.syncLyricWindow(nextPartIdx, nextStepIdx);
  },
});
