/** Pinned UUID for uuidv5-derivation of Apple `appAccountToken` from
 *  Fina userId. NEVER change this — changing it breaks the binding
 *  for every existing IAP subscriber and forces them through a manual
 *  support resync. Source-code disclosure does NOT weaken security:
 *  the binding tokens are identifiers, not authenticators (see
 *  spec §3 "These binding tokens are identifiers, not authenticators").
 *
 *  Generated once via `uuidgen` on 2026-05-26. */
export const IAP_NAMESPACE = "8f3a7c2e-1b4d-4e5f-9a6b-7c8d9e0f1a2b";
