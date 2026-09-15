import { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Pool } from "pg"
import {
  OBTAIN_SYNC_LOCK_SQL,
  STALE_SYNC_LOCK_SECONDS,
} from "src/modules/feed/modules/gtfs/sync/gtfs-sync.service"
import { setupTestDatabase } from "./helpers/postgres"

/**
 * Exercises the real lock statement against a real Postgres.
 *
 * The behaviour under test lives entirely in SQL, so asserting on the query
 * text proves nothing: an inverted comparison, a dropped WHERE, or `xmax = 0`
 * would all keep a string-matching test green while breaking mutual exclusion.
 *
 * What this guards: a sync that dies without releasing its lock blocked its
 * feed from ever syncing again. In production one sat for 60 days, the feed's
 * schedule data expired, and the departure sign went blank.
 */
describe("sync lock", () => {
  let pool: Pool
  let container: StartedPostgreSqlContainer

  const FEED = "kcm"

  beforeAll(async () => {
    const db = await setupTestDatabase()
    container = db.postgresContainer
    pool = new Pool({ connectionString: db.connectionUrl.toString() })
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    await container?.stop()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM sync_lock")
  })

  /** Mirrors GtfsDbService.tx() so the role's grants are exercised too. */
  async function obtain(feedCode = FEED) {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SET LOCAL ROLE gtfs")
      const result = await client.query(OBTAIN_SYNC_LOCK_SQL, [
        feedCode,
        STALE_SYNC_LOCK_SECONDS,
      ])
      await client.query("COMMIT")
      return result
    } catch (e) {
      await client.query("ROLLBACK")
      throw e
    } finally {
      client.release()
    }
  }

  async function ageLock(interval: string) {
    await pool.query(
      `UPDATE sync_lock SET locked_at = now() - $1::interval WHERE feed_code = $2`,
      [interval, FEED],
    )
  }

  it("takes a lock that nobody holds", async () => {
    const result = await obtain()

    expect(result.rowCount).toBe(1)
    expect(result.rows[0].reclaimed).toBe(false)
  })

  it("refuses a lock a live sync is holding, without erroring", async () => {
    await obtain()

    const second = await obtain()

    // Zero rows, not an exception: the caller decides what that means.
    expect(second.rowCount).toBe(0)
  })

  it("reclaims a lock left behind by a dead sync", async () => {
    await obtain()
    await ageLock("7 hours")

    const result = await obtain()

    expect(result.rowCount).toBe(1)
    expect(result.rows[0].reclaimed).toBe(true)
  })

  it("refuses a lock that is not yet stale", async () => {
    await obtain()
    // A minute short of the threshold. Testing the exact boundary is not
    // possible against wall-clock time, since now() advances between the
    // update and the comparison.
    await ageLock(`${STALE_SYNC_LOCK_SECONDS - 60} seconds`)

    expect((await obtain()).rowCount).toBe(0)
  })

  it("reclaims as soon as the lock passes the threshold", async () => {
    await obtain()
    await ageLock(`${STALE_SYNC_LOCK_SECONDS + 60} seconds`)

    const result = await obtain()

    expect(result.rowCount).toBe(1)
    expect(result.rows[0].reclaimed).toBe(true)
  })

  it("lets exactly one of many concurrent syncs reclaim a stale lock", async () => {
    await obtain()
    await ageLock("7 hours")

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => obtain()),
    )

    const rejected = results.filter((r) => r.status === "rejected")
    expect(rejected).toHaveLength(0)

    const winners = results.filter(
      (r) => r.status === "fulfilled" && r.value.rowCount === 1,
    )
    expect(winners).toHaveLength(1)
  })

  it("keeps locks independent per feed", async () => {
    await obtain(FEED)

    // A sync of one feed must not block another feed.
    expect((await obtain("st_gtfs")).rowCount).toBe(1)
  })

  it("hands back a locked_at that identifies the holder", async () => {
    const first = await obtain()
    await ageLock("7 hours")
    const second = await obtain()

    // The release path deletes by this value, so a reclaim must change it.
    expect(second.rows[0].locked_at).not.toEqual(first.rows[0].locked_at)
  })
})
