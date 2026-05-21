/** Response of `GET /ready`. `GET /live` returns `{ status: "ok" }` only —
 *  no checks payload, because liveness is "process responding" by definition. */
export type HealthDTO = {
  status: "ok" | "degraded";
  checks: { db: "ok" | "down" };
};
