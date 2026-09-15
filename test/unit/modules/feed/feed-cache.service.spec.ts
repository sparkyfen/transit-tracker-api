import { FeedCacheGeneration } from "src/modules/cache/feed-cache-generation.service"
import { FeedCacheService } from "src/modules/feed/modules/feed-cache/feed-cache.service"

/**
 * A feed's cached entries must stop being served once its data is replaced by
 * an import. In production a sign showed "no upcoming arrivals" for hours
 * after a successful import, because results computed from the expired data
 * stayed cached. Clearing Redis was not enough: the cache also has an
 * in-process memory tier, so the key itself has to change.
 */
describe("FeedCacheService cache generation", () => {
  const feedCode = "kcm"

  function makeService(generation: FeedCacheGeneration) {
    const store = new Map<string, any>()
    const cacheManager = {
      get: vi.fn(async (key: string) => store.get(key)),
      set: vi.fn(async (key: string, value: any) => {
        store.set(key, value)
      }),
    }

    const service = Object.create(FeedCacheService.prototype) as FeedCacheService
    Object.assign(service, {
      cacheManager,
      feedCode,
      generation,
      pendingCache: new Map(),
    })

    return { service, cacheManager, store }
  }

  it("serves a cached value on the second call", async () => {
    const generation = new FeedCacheGeneration()
    const { service } = makeService(generation)
    const compute = vi.fn().mockResolvedValue("first")

    await service.cached("schedule-a", compute, 60_000)
    const second = await service.cached("schedule-a", compute, 60_000)

    expect(second).toBe("first")
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it("recomputes after the feed's generation is bumped", async () => {
    const generation = new FeedCacheGeneration()
    const { service } = makeService(generation)
    const compute = vi
      .fn()
      .mockResolvedValueOnce("stale")
      .mockResolvedValueOnce("fresh")

    const before = await service.cached("schedule-a", compute, 60_000)
    expect(before).toBe("stale")

    // An import replaced the feed's data.
    generation.bump(feedCode)

    const after = await service.cached("schedule-a", compute, 60_000)

    expect(after).toBe("fresh")
    expect(compute).toHaveBeenCalledTimes(2)
  })

  it("does not recompute when a different feed is bumped", async () => {
    const generation = new FeedCacheGeneration()
    const { service } = makeService(generation)
    const compute = vi.fn().mockResolvedValue("value")

    await service.cached("schedule-a", compute, 60_000)
    generation.bump("some-other-feed")
    await service.cached("schedule-a", compute, 60_000)

    expect(compute).toHaveBeenCalledTimes(1)
  })

  it("writes the generation into the cache key", async () => {
    const generation = new FeedCacheGeneration()
    const { service, cacheManager } = makeService(generation)
    generation.bump(feedCode)

    await service.cached("schedule-a", async () => "v", 60_000)

    expect(cacheManager.set).toHaveBeenCalledWith(
      `${feedCode}-g1-schedule-a`,
      "v",
      60_000,
    )
  })
})
