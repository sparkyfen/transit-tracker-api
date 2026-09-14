import { Injectable } from "@nestjs/common"

/**
 * Tracks a generation number per feed, which cache keys embed.
 *
 * Bumping a feed's generation makes every existing entry for that feed
 * unreachable in one step, across both the in-memory and the Redis tier, and
 * the orphaned entries then age out on their own TTL. That matters after an
 * import: without it, a feed whose data was just replaced keeps serving
 * results computed from the old data until the TTL expires. A sign showing
 * "no upcoming arrivals" stayed that way for hours after a successful import
 * for exactly this reason.
 *
 * Deliberately process-local. The scheduled sync runs in the same process as
 * the requests it invalidates, which is the case that matters. An import run
 * from the CLI as a separate process cannot invalidate a running server this
 * way, and still needs a restart.
 */
@Injectable()
export class FeedCacheGeneration {
  private readonly generations = new Map<string, number>()

  current(feedCode: string): number {
    return this.generations.get(feedCode) ?? 0
  }

  bump(feedCode: string): number {
    const next = this.current(feedCode) + 1
    this.generations.set(feedCode, next)
    return next
  }
}
