import { callBuyerCloud } from "../../utils/cloud";

declare const wx: any;
declare function Page(opts: Record<string, any>): void;

Page({
  _timer: null as any,

  data: {
    isActiveVolunteer: false,
    points: 0,
    reviewIdInput: "",
    card: null as any,
    cardOpenedAt: 0,
    countdownSec: 8,
    selectedScore: 5,
    selectedTags: [] as string[],
    availableTags: ["针目匀称", "塞棉饱满", "比例尺达标", "收口微露棉", "尺寸偏小"],
  },

  onUnload() {
    if (this._timer) clearInterval(this._timer);
  },

  async onPassOnboardingExam() {
    const vol = await callBuyerCloud("volunteer.passExam", { correctCount: 5 });
    this.setData({
      isActiveVolunteer: vol.status === "active",
      points: vol.points ?? 10,
    });
    wx.showToast({ title: "5题找茬满分 · 荣任陪审员！", icon: "success" });
  },

  onInputReviewId(e: any) {
    this.setData({ reviewIdInput: e.detail.value || "" });
  },

  async onLoadBlindCard() {
    if (!this.data.reviewIdInput) {
      wx.showToast({ title: "请输入待盲审单号", icon: "none" });
      return;
    }
    const card = await callBuyerCloud("volunteer.getCard", { reviewId: this.data.reviewIdInput });
    if (this._timer) clearInterval(this._timer);

    this.setData({
      card,
      cardOpenedAt: Date.now(),
      countdownSec: 8,
      selectedScore: 5,
      selectedTags: [],
    });

    // Enforced 8-second careful inspection lock (docs/07 §4.3)
    this._timer = setInterval(() => {
      const next = this.data.countdownSec - 1;
      if (next <= 0) {
        clearInterval(this._timer);
        this._timer = null;
        this.setData({ countdownSec: 0 });
      } else {
        this.setData({ countdownSec: next });
      }
    }, 1000);
  },

  onSelectScore(e: any) {
    this.setData({ selectedScore: Number(e.currentTarget.dataset.score) });
  },

  onToggleTag(e: any) {
    const tag = String(e.currentTarget.dataset.tag);
    const cur = new Set(this.data.selectedTags);
    if (cur.has(tag)) cur.delete(tag);
    else cur.add(tag);
    this.setData({ selectedTags: [...cur] });
  },

  async onSubmitVote() {
    if (this.data.countdownSec > 0 || !this.data.card) return;
    const dwellMs = Math.max(8000, Date.now() - this.data.cardOpenedAt);
    const res = await callBuyerCloud("volunteer.vote", {
      reviewId: this.data.card._id,
      score: this.data.selectedScore,
      tags: this.data.selectedTags,
      dwellMs,
    });
    this.setData({
      card: null,
      points: this.data.points + 2,
    });
    wx.showToast({ title: `投票已收录（状态：${res.reviewStatus}）`, icon: "success" });
  },
});
