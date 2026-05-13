import { BadRequestException, Injectable, Logger } from "@nestjs/common"
import { SentryTraced } from "@sentry/nestjs"
import * as Sentry from "@sentry/node"
import ms from "ms"
import {
  concat,
  defer,
  distinctUntilChanged,
  finalize,
  from,
  mergeMap,
  Observable,
  share,
  timer,
} from "rxjs"
import { FeedService } from "src/modules/feed/feed.service"
import type {
  FeedProvider,
  RouteAtStop,
} from "src/modules/feed/interfaces/feed-provider.interface"
import { ScheduleMetricsService } from "./schedule-metrics.service"

export interface ScheduleTrip {
  tripId: string
  routeId: string
  routeName: string
  routeColor: string | null
  stopId: string
  stopName: string
  headsign: string
  arrivalTime: number
  departureTime: number
  isRealtime: boolean
  remainingTrips?: number  // Number of trips remaining after this one for the same route/stop today
  tripsRemainingToday?: number  // Trips remaining for the rest of the GTFS service day for the same route/stop. Set by GTFS-static providers; undefined when only realtime data is available.
  delaySeconds?: number  // Seconds the realtime prediction differs from the static schedule. Positive = late, negative = early. Undefined when no realtime data is available.
}

export interface ScheduleUpdate {
  trips: ScheduleTrip[]
}

export type RouteAtStopWithOffset = RouteAtStop & { offset: number }

export interface ScheduleOptions {
  feedCode?: string
  routes: RouteAtStopWithOffset[]
  limit: number
  sortByDeparture?: boolean
  listMode?: "sequential" | "nextPerRoute"
  // When set, the API computes per-stop walking-time offsets
  // (haversine(walkingFrom, stop) / walkSpeedMs) and applies them as
  // negative offsets to each trip's arrival/departure times, in place
  // of any per-pair offset provided in `routes`.
  walkingFrom?: { lat: number; lon: number }
  walkSpeedMs?: number
}

const DEFAULT_WALK_SPEED_MS = 1.4 // ~5 km/h, typical adult pace
const EARTH_RADIUS_M = 6_371_000

function haversineMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}

// Exported for unit testing.
export function walkingOffsetSecondsForStop(
  walkingFrom: { lat: number; lon: number },
  stop: { lat: number; lon: number },
  walkSpeedMs: number = DEFAULT_WALK_SPEED_MS,
): number {
  const secs = Math.round(haversineMeters(walkingFrom, stop) / walkSpeedMs)
  return secs === 0 ? 0 : -secs
}

@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name)

  constructor(
    private readonly feedService: FeedService,
    private readonly metricsService: ScheduleMetricsService,
  ) {}

  @SentryTraced()
  private async getUpcomingTrips(
    provider: FeedProvider,
    {
      routes,
      limit,
      sortByDeparture,
      listMode,
      walkingFrom,
      walkSpeedMs,
    }: ScheduleOptions,
  ): Promise<ScheduleUpdate> {
    const span = Sentry.getActiveSpan()
    if (span) {
      span.setAttribute("schedule_options.routes", JSON.stringify(routes))
      span.setAttribute("schedule_options.limit", limit)
      span.setAttribute("schedule_options.sortByDeparture", sortByDeparture)
      span.setAttribute("schedule_options.listMode", listMode)
      span.setAttribute(
        "schedule_options.walking_from",
        walkingFrom ? JSON.stringify(walkingFrom) : "none",
      )
    }

    const upcomingTrips =
      await provider.getUpcomingTripsForRoutesAtStops(routes)

    // If walkingFrom is provided, compute per-stop walking-time offsets in
    // parallel. These override any per-pair offsets passed in `routes`.
    const walkingOffsetByStop = new Map<string, number>()
    if (walkingFrom) {
      const uniqueStopIds = Array.from(
        new Set(upcomingTrips.map((t) => t.stopId)),
      )
      const stopLookups = await Promise.all(
        uniqueStopIds.map((stopId) =>
          provider
            .getStop(stopId)
            .then((stop) => ({ stopId, stop }))
            .catch((e) => {
              this.logger.warn(
                `walking-offset: failed to resolve stop ${stopId}: ${e.message}`,
              )
              return null
            }),
        ),
      )
      for (const lookup of stopLookups) {
        if (!lookup) continue
        walkingOffsetByStop.set(
          lookup.stopId,
          walkingOffsetSecondsForStop(walkingFrom, lookup.stop, walkSpeedMs),
        )
      }
    }

    const sortKey = sortByDeparture ? "departureTime" : "arrivalTime"
    let trips: ScheduleTrip[] = upcomingTrips
      .map((trip) => {
        const walkingOffset = walkingOffsetByStop.get(trip.stopId)
        const pairOffset = routes.find(
          (r) => r.routeId === trip.routeId && r.stopId === trip.stopId,
        )?.offset
        const offset = walkingOffset ?? pairOffset ?? 0

        return {
          ...trip,
          arrivalTime: new Date(trip.arrivalTime).getTime() / 1000 + offset,
          departureTime: new Date(trip.departureTime).getTime() / 1000 + offset,
        }
      })
      .filter((trip) => trip[sortKey] > Date.now() / 1000)
      .sort((a, b) => a[sortKey] - b[sortKey])

    // Calculate remaining trips for each route/stop combination
    // This counts how many trips come after the current one for the same route and stop
    trips = trips.map((trip, index) => {
      const remainingTrips = trips.slice(index + 1).filter(
        (laterTrip) =>
          laterTrip.routeId === trip.routeId && laterTrip.stopId === trip.stopId
      ).length

      return {
        ...trip,
        remainingTrips,
      }
    })

    if (listMode === "nextPerRoute") {
      const pairKey = (trip: ScheduleTrip) => `${trip.routeId}-${trip.stopId}`

      const pairs = new Set<string>(trips.map((trip) => pairKey(trip)))

      trips = trips.filter((trip) => {
        const key = pairKey(trip)
        if (pairs.has(key)) {
          pairs.delete(key)
          return true
        }
        return false
      })
    }

    trips = trips.slice(0, limit)

    return {
      trips,
    }
  }

  private getFeedProvider(options: ScheduleOptions): FeedProvider {
    if (options.feedCode) {
      const provider = this.feedService.getFeedProvider(options.feedCode)
      if (!provider) {
        throw new BadRequestException("Invalid feed code")
      }

      return provider
    }

    return this.feedService.all
  }

  getSchedule(options: ScheduleOptions): Promise<ScheduleUpdate> {
    const provider = this.getFeedProvider(options)
    return this.getUpcomingTrips(provider, options)
  }

  parseRouteStopPairs(routeStopPairsRaw: string): RouteAtStopWithOffset[] {
    const routeStopPairs = routeStopPairsRaw
      .split(";")
      .map((pair) => pair.split(",").map((part) => part.trim()))
      .map(([routeId, stopId, offset]) => ({
        routeId,
        stopId,
        offset: parseInt(offset ?? "0"),
      }))

    for (const pair of routeStopPairs) {
      if (!pair.routeId || !pair.stopId) {
        throw new BadRequestException(
          "Invalid route-stop pair; must be in the format routeId,stopId[,offset]",
        )
      }

      if (isNaN(pair.offset)) {
        throw new BadRequestException("Invalid offset; must be a number")
      }
    }

    return routeStopPairs
  }

  subscribeToSchedule(
    subscription: ScheduleOptions,
  ): Observable<ScheduleUpdate | null> {
    const feedProvider = this.getFeedProvider(subscription)

    return defer(() => {
      this.logger.verbose(
        `Subscribed to schedule updates: ${JSON.stringify(subscription)}`,
      )

      this.metricsService.add(subscription)

      const initialDelay = Math.floor(Math.random() * 10000)
      const jitter = Math.floor(Math.random() * 1000)
      const period = ms("30s") + jitter

      const getTrips$ = defer(() =>
        from(this.getUpcomingTrips(feedProvider, subscription)),
      )

      return concat(
        getTrips$,
        timer(initialDelay, period).pipe(mergeMap(() => getTrips$)),
      ).pipe(
        distinctUntilChanged(
          (prev, curr) => JSON.stringify(prev) === JSON.stringify(curr),
        ),
        finalize(() => {
          this.logger.verbose(
            `Unsubscribed from schedule updates: ${JSON.stringify(subscription)}`,
          )

          this.metricsService.remove(subscription)
        }),
      )
    }).pipe(share())
  }
}
