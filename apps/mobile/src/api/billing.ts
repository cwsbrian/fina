import type { IAPCheckoutBody, IAPRestoreBody, MeDTO } from "@fina/shared";
import { apiFetch } from "./client";

export async function postIAPCheckout(body: IAPCheckoutBody): Promise<MeDTO> {
  return apiFetch<MeDTO>("/billing/iap/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function postIAPRestore(body: IAPRestoreBody): Promise<MeDTO> {
  return apiFetch<MeDTO>("/billing/iap/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
