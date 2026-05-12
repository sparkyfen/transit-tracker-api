import { walkingOffsetSecondsForStop } from "src/schedule/schedule.service"

describe("walkingOffsetSecondsForStop", () => {
  it("returns 0 for identical points", () => {
    const here = { lat: 47.614593, lon: -122.317244 }
    expect(walkingOffsetSecondsForStop(here, here)).toBe(0)
  })

  it("returns a negative value (subtracts from arrival)", () => {
    const sign = { lat: 47.614593, lon: -122.317244 } // Capitol Hill area
    const stop = { lat: 47.620, lon: -122.320 } // ~700m away
    expect(walkingOffsetSecondsForStop(sign, stop)).toBeLessThan(0)
  })

  it("scales with distance roughly linearly", () => {
    const origin = { lat: 0, lon: 0 }
    const near = { lat: 0, lon: 0.001 } // ~111m
    const far = { lat: 0, lon: 0.01 } // ~1.11km

    const nearOffset = Math.abs(walkingOffsetSecondsForStop(origin, near))
    const farOffset = Math.abs(walkingOffsetSecondsForStop(origin, far))

    expect(farOffset / nearOffset).toBeGreaterThan(9.5)
    expect(farOffset / nearOffset).toBeLessThan(10.5)
  })

  it("respects walkSpeedMs (faster speed = smaller offset)", () => {
    const origin = { lat: 0, lon: 0 }
    const stop = { lat: 0, lon: 0.01 }

    const slow = Math.abs(walkingOffsetSecondsForStop(origin, stop, 1.0))
    const fast = Math.abs(walkingOffsetSecondsForStop(origin, stop, 2.0))

    expect(slow).toBeCloseTo(fast * 2, 0)
  })

  it("approximates known distance for ~1km walk at default speed", () => {
    // 1 degree of longitude at the equator is ~111km, so 0.009 degrees ~= 1km.
    const origin = { lat: 0, lon: 0 }
    const stop = { lat: 0, lon: 0.009 }
    // 1000m / 1.4 m/s = ~714s (12 min)
    const offset = walkingOffsetSecondsForStop(origin, stop)
    expect(offset).toBeLessThan(-650)
    expect(offset).toBeGreaterThan(-780)
  })
})
