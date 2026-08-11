import { describe, expect, test } from "bun:test"
import { hideAllBrowserViews, showAllBrowserViews } from "../components/session/browser-tab"

function countBrowserViewShows() {
  let count = 0
  const onShow = () => {
    count += 1
  }
  window.addEventListener("wanlaicode:browser-views-show", onShow)
  return {
    count: () => count,
    dispose: () => window.removeEventListener("wanlaicode:browser-views-show", onShow),
  }
}

describe("layout browser views", () => {
  test("keeps browser views hidden while any hide reason remains", () => {
    const shows = countBrowserViewShows()

    hideAllBrowserViews("overlay")
    hideAllBrowserViews("session-panel")
    showAllBrowserViews("session-panel")

    expect(shows.count()).toBe(0)

    showAllBrowserViews("overlay")

    expect(shows.count()).toBe(1)

    shows.dispose()
  })

  test("keeps browser views hidden until the same hide reason is released as many times as it was acquired", () => {
    const shows = countBrowserViewShows()

    hideAllBrowserViews("overlay")
    hideAllBrowserViews("overlay")
    showAllBrowserViews("overlay")

    expect(shows.count()).toBe(0)

    showAllBrowserViews("overlay")

    expect(shows.count()).toBe(1)

    shows.dispose()
  })

})
