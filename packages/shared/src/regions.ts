import type { RegionCode } from "./schemas.ts";

/**
 * National regional concentric expansion mapping (docs/07 §1.1).
 * Phase 1 activates `['jzh']` (Jiang-Zhe-Hu hub around the main yarn supplier),
 * then progressively unlocks `north`, `sw_ygc`, `nw`, and `south_central`.
 */
export const REGION_LABELS: Readonly<Record<RegionCode, string>> = {
  jzh: "江浙沪核心区",
  north: "北方区域",
  sw_ygc: "云贵川西南区",
  nw: "西北方向",
  south_central: "华南华中区",
};

const PROVINCE_TO_REGION: Readonly<Record<string, RegionCode>> = {
  上海市: "jzh",
  上海: "jzh",
  江苏省: "jzh",
  江苏: "jzh",
  浙江省: "jzh",
  浙江: "jzh",
  安徽省: "jzh",
  安徽: "jzh",

  北京市: "north",
  北京: "north",
  天津市: "north",
  天津: "north",
  河北省: "north",
  山西省: "north",
  内蒙古自治区: "north",
  辽宁省: "north",
  吉林省: "north",
  黑龙江省: "north",
  山东省: "north",
  河南省: "north",

  云南省: "sw_ygc",
  贵州省: "sw_ygc",
  四川省: "sw_ygc",
  重庆市: "sw_ygc",
  重庆: "sw_ygc",

  陕西省: "nw",
  甘肃省: "nw",
  青海省: "nw",
  宁夏回族自治区: "nw",
  新疆维吾尔自治区: "nw",
  西藏自治区: "nw",
};

export function inferRegionFromProvince(province: string): RegionCode {
  return PROVINCE_TO_REGION[province.trim()] ?? "south_central";
}
