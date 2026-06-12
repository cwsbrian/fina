import { z } from "zod";
import { IAP_PRODUCT_IDS_TUPLE } from "../iap/productIds.js";

export const IAPPlatform = z.enum(["ios", "android"]);
export type IAPPlatform = z.infer<typeof IAPPlatform>;

const IAPProductIdEnum = z.enum(IAP_PRODUCT_IDS_TUPLE);

export const IAPCheckoutBody = z.object({
  platform: IAPPlatform,
  productId: IAPProductIdEnum,
  /** iOS: signedTransaction JWS string (~2-3 KB, StoreKit 2).
   *  Android: purchaseToken (short opaque string). */
  receipt: z
    .string()
    .min(1)
    .describe("iOS: signedTransaction JWS string; Android: purchaseToken"),
});
export type IAPCheckoutBody = z.infer<typeof IAPCheckoutBody>;

export const IAPRestoreBody = z.object({
  platform: IAPPlatform,
  purchases: z
    .array(
      z.object({
        productId: IAPProductIdEnum,
        receipt: z.string().min(1),
      }),
    )
    .min(1)
    .max(20),
});
export type IAPRestoreBody = z.infer<typeof IAPRestoreBody>;

export const IAPIntegrityCheckBody = z.object({
  platform: IAPPlatform,
  result: z.enum(["matched", "mismatched"]),
  nativeProductId: IAPProductIdEnum.nullable(),
  /** Optional native proof for server-side verification.
   *  iOS: signedTransaction JWS string. Android: purchaseToken. */
  receipt: z.string().min(1).nullable().optional(),
});
export type IAPIntegrityCheckBody = z.infer<typeof IAPIntegrityCheckBody>;
