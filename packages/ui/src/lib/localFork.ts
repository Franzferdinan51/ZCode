import { ZCODE_PRODUCT_FLAVOR } from "@zcode/shared";

/**
 * ZCode Local 从不卖套餐：付费升级/购买入口（侧栏升级项、quota 横幅升级按钮、
 * 设置页购买按钮与 pricing 面板）在 local 身份下全部隐藏。
 *
 * 纯函数便于单测；模块常量供渲染层直接消费。桌面端与 Web 端构建期注入
 * __ZCODE_PRODUCT_FLAVOR__（见各自 vite.config.ts），缺省回退到 preview 语义，
 * 即保持官方行为不变。
 */
export function hidesPaidPlanUpsells(flavor: string): boolean {
  return flavor.trim().toLowerCase() === "local";
}

export const LOCAL_FORK_HIDES_PAID_PLAN_UPSELLS = hidesPaidPlanUpsells(ZCODE_PRODUCT_FLAVOR);
