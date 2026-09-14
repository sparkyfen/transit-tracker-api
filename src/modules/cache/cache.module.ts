import KeyvRedis from "@keyv/redis"
import { Global, Module } from "@nestjs/common"
import { Cacheable, createKeyv as createKeyvMemory } from "cacheable"
import Keyv from "keyv"
import ms from "ms"
import { FeedCacheGeneration } from "./feed-cache-generation.service"

@Global()
@Module({
  providers: [
    {
      provide: Cacheable,
      useFactory: () =>
        new Cacheable({
          primary: createKeyvMemory({
            lruSize: 1000,
            checkInterval: ms("15m"),
          }),
          secondary: process.env.REDIS_URL
            ? new Keyv({
                serialize: JSON.stringify,
                deserialize: JSON.parse,
                store: new KeyvRedis(process.env.REDIS_URL, {
                  namespace: "cache",
                }),
              })
            : undefined,
        }),
    },
    FeedCacheGeneration,
  ],
  exports: [Cacheable, FeedCacheGeneration],
})
export class CacheModule {}
