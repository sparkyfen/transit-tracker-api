import { GtfsSyncService } from "src/modules/feed/modules/gtfs/sync/gtfs-sync.service"

/**
 * The sync lock is a single row keyed by feed code, released in a finally
 * block. A process that dies before that finally runs leaves the row behind,
 * and nothing expires it, so the feed stops syncing permanently. That happened
 * in production: a lock sat for 60 days, the feed's schedule data aged out, and
 * the only symptom was one warning a night.
 */
describe("GtfsSyncService sync lock", () => {
  const feedCode = "kcm"

  function makeService(query: ReturnType<typeof vi.fn>) {
    const service = Object.create(GtfsSyncService.prototype) as GtfsSyncService
    Object.assign(service, {
      feedCode,
      db: { query },
      logger: { warn: vi.fn(), log: vi.fn() },
    })
    return service
  }

  // obtainSyncLock is private; the behaviour is what matters here.
  function obtain(service: GtfsSyncService) {
    return (service as any).obtainSyncLock()
  }

  it("takes the lock when no other sync holds it", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ reclaimed: false }], rowCount: 1 })
    const service = makeService(query)

    await expect(obtain(service)).resolves.toBeUndefined()

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, bindings] = query.mock.calls[0]
    expect(sql).toContain("INSERT INTO sync_lock")
    expect(bindings[0]).toBe(feedCode)
  })

  it("reclaims a lock left behind by a dead sync", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ reclaimed: true }], rowCount: 1 })
    const service = makeService(query)

    await expect(obtain(service)).resolves.toBeUndefined()

    expect((service as any).logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Reclaimed a stale sync lock"),
    )
  })

  it("refuses the lock while a recent sync still holds it", async () => {
    // No row comes back when the WHERE clause rejects the takeover.
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    const service = makeService(query)

    await expect(obtain(service)).rejects.toThrow(/still holding it/)
  })

  it("decides staleness in the database, not in the process", async () => {
    // Two syncs racing must not both conclude the lock is stale, so the
    // takeover has to be one statement rather than a read then a write.
    const query = vi.fn().mockResolvedValue({ rows: [{ reclaimed: true }], rowCount: 1 })
    const service = makeService(query)

    await obtain(service)

    expect(query).toHaveBeenCalledTimes(1)
    const [sql] = query.mock.calls[0]
    expect(sql).toContain("ON CONFLICT")
    expect(sql).toContain("locked_at")
    expect(sql).toMatch(/now\(\)/)
  })

  it("surfaces a database failure as a lock error", async () => {
    const query = vi.fn().mockRejectedValue(new Error("connection refused"))
    const service = makeService(query)

    await expect(obtain(service)).rejects.toThrow(/Could not obtain sync lock/)
  })
})
