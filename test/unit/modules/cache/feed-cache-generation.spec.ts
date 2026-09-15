import { FeedCacheGeneration } from "src/modules/cache/feed-cache-generation.service"

describe("FeedCacheGeneration", () => {
  it("starts every feed at generation 0", () => {
    const generation = new FeedCacheGeneration()

    expect(generation.current("kcm")).toBe(0)
  })

  it("advances a feed's generation when bumped", () => {
    const generation = new FeedCacheGeneration()

    expect(generation.bump("kcm")).toBe(1)
    expect(generation.current("kcm")).toBe(1)
  })

  it("keeps feeds independent", () => {
    // Syncing one feed must not retire another feed's cached data.
    const generation = new FeedCacheGeneration()

    generation.bump("kcm")

    expect(generation.current("kcm")).toBe(1)
    expect(generation.current("st_gtfs")).toBe(0)
  })
})
