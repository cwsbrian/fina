import { ensureMigrationsApplied } from "./migrate.js";

export default function setup(): void {
  ensureMigrationsApplied();
}
