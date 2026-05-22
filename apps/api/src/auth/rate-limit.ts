import { RATE_LIMITS, type RateLimitKey } from "@fina/shared";
import { ipKey, userKey } from "./session-decorator.js";

/** Returns a Fastify route config that scopes that route to a specific
 *  rate-limit bucket. Spread the result into the route's `config`:
 *
 *    app.post("/chat/threads/:tid/messages", {
 *      config: withRateLimit("chatMessages"),
 *    }, handler);
 */
export function withRateLimit(key: RateLimitKey) {
  const policy = RATE_LIMITS[key];
  return {
    rateLimit: {
      max: policy.max,
      timeWindow: policy.windowMs,
      keyGenerator:
        key === "chatMessages" || key === "plaidExchange" ? userKey : ipKey,
    },
  };
}
