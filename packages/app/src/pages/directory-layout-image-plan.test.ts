import { describe, expect, test } from "bun:test"

describe("directory image generation plan access", () => {
  test("opens the authenticated purchase tab for denied image generation", async () => {
    const source = await Bun.file(new URL("./directory-layout.tsx", import.meta.url)).text()
    const globalSync = await Bun.file(new URL("../context/global-sync.tsx", import.meta.url)).text()
    const zh = await Bun.file(new URL("../i18n/zh.ts", import.meta.url)).text()

    // app 必须把 UI 包的升级操作接回已有用户中心，且中文拒绝提示保持产品要求的精确文本。
    expect(source).toContain('import { openUserCenterOverlay } from "@/context/open-user-center"')
    expect(source).toContain('openPurchasePlans={() => openUserCenterOverlay("purchase")}')
    // DataProvider 订阅全局 QueryClient：缓存命中直接展示，miss 才由 ensurePurchasePlans 获取真实套餐。
    expect(source).toContain(
      "purchasePlanCatalog={() => purchasePlanCatalog.data ?? (purchasePlanCatalog.isError ? null : undefined)}",
    )
    expect(source).toContain("await ensurePurchasePlans(queryClient, sdk.client)")
    // 同窗口登录、退出和切换账号只要 dispose 全局实例，也必须让下一次读取重新获取当前账号套餐。
    expect(globalSync).toContain('if (event.type === "global.disposed") clearPurchasePlansCache(queryClient)')
    expect(zh).toContain('"prompt.imageGeneration.error.groupDisabled": "当前套餐不支持生图"')
  })
})
