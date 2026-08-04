import type { AppleDistributionResponse } from "@fina/shared";
import { apiFetch } from "../api/client";
import { getSignedAppleAppTransaction } from "../iap/native-subscription-store";

export async function syncAppleSignupEnvironment(): Promise<AppleDistributionResponse | null> {
  const signedAppTransaction = await getSignedAppleAppTransaction();
  if (!signedAppTransaction) return null;

  return await apiFetch<AppleDistributionResponse>("/me/distribution", {
    method: "POST",
    body: JSON.stringify({ signedAppTransaction }),
  });
}
