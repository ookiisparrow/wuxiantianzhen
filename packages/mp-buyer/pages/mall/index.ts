import { callBuyerCloud, fenToYuanText } from "../../utils/cloud";

declare const wx: any;
declare function Page(opts: Record<string, any>): void;

Page({
  data: {
    tab: "made_to_order", // 'made_to_order' | 'ready_stock'
    products: [] as Array<any>,
  },

  onShow() {
    this.loadCatalog();
  },

  async loadCatalog() {
    try {
      const data = await callBuyerCloud("buyer.listCatalog");
      const readyStockBySku = data.readyStockBySku || {};
      const enriched = await Promise.all(
        (data.products || []).map(async (p: any) => {
          const sell = await callBuyerCloud("buyer.checkSellability", {
            productId: p._id,
            qty: 1,
          }).catch(() => ({ sellable: false, availableReadyUnits: 0 }));
          return {
            ...p,
            priceYuan: fenToYuanText(p.priceFen),
            readyCount: readyStockBySku[p.skuCode] || 0,
            sellable: Boolean(sell.sellable),
            availableUnits: sell.availableReadyUnits ?? sell.availableUnits ?? 0,
          };
        }),
      );
      this.setData({ products: enriched });
    } catch {
      // ignore offline preview
    }
  },

  onSwitchTab(e: any) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  onBuyProduct(e: any) {
    const { id, sellable } = e.currentTarget.dataset;
    if (!sellable) {
      wx.showToast({ title: "已为您登记手艺人空档到货提醒", icon: "none" });
      return;
    }
    wx.navigateTo({ url: `/pages/order/index?productId=${encodeURIComponent(id)}` });
  },
});
