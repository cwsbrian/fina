import { Buffer } from "node:buffer";
import { Prisma, type ReceiptDocument } from "@prisma/client";
import sharp from "sharp";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { prisma } from "../db.js";
import {
  CloudflareR2ReceiptInfrastructure,
  type ReceiptStorageEnv,
  type ReceiptStorageLocation,
} from "./storage.js";

const RECEIPT_OCR_MODELS = ["gpt-5-nano", "gpt-5.6-luna"] as const;
const PROMPT_VERSION = "receipt-v1";

export type ReceiptOcrEnv = ReceiptStorageEnv & {
  OPENAI_API_KEY?: string | undefined;
  RECEIPT_OCR_MODEL?: string | undefined;
};

const ReceiptExtractionSchema = z.object({
  merchantName: z.string().nullable(),
  receiptDate: z.string().nullable(),
  currency: z.string().nullable(),
  totalCents: z.number().int().nullable(),
  subtotalCents: z.number().int().nullable(),
  taxCents: z.number().int().nullable(),
  tipCents: z.number().int().nullable(),
  discountCents: z.number().int().nullable(),
  lineItems: z.array(z.object({
    description: z.string(),
    quantity: z.string().nullable(),
    unitPriceCents: z.number().int().nullable(),
    lineTotalCents: z.number().int(),
    page: z.number().int(),
  })),
});

type OpenAiResponse = {
  id?: string;
  model?: string;
  status?: string;
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  error?: { message?: string };
};

export function receiptOcrModel(env: Pick<ReceiptOcrEnv, "RECEIPT_OCR_MODEL">): (typeof RECEIPT_OCR_MODELS)[number] {
  const model = env.RECEIPT_OCR_MODEL ?? "gpt-5-nano";
  if (!RECEIPT_OCR_MODELS.includes(model as (typeof RECEIPT_OCR_MODELS)[number])) {
    throw new Error("receipt_ocr_model_not_supported");
  }
  return model as (typeof RECEIPT_OCR_MODELS)[number];
}

function config(env: ReceiptOcrEnv) {
  if (!env.OPENAI_API_KEY) throw new Error("openai_receipt_ocr_not_configured");
  return { apiKey: env.OPENAI_API_KEY, model: receiptOcrModel(env) };
}

function isoDate(value: string | null): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("receipt_ocr_date_invalid");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== value) throw new Error("receipt_ocr_date_invalid");
  return date;
}

function quantity(value: string | null): Prisma.Decimal | null {
  if (!value || !/^\d+(?:\.\d{1,3})?$/.test(value)) return null;
  return new Prisma.Decimal(value);
}

function money(cents: number | null): Prisma.Decimal | null {
  return cents === null ? null : new Prisma.Decimal(cents).div(100);
}

export function normalizeOpenAiExpense(input: unknown) {
  const parsed = ReceiptExtractionSchema.parse(input);
  const currency = parsed.currency?.trim().toUpperCase() ?? null;
  return {
    merchantName: parsed.merchantName?.trim() || null,
    totalAmount: money(parsed.totalCents),
    receiptDate: isoDate(parsed.receiptDate),
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    lineItems: parsed.lineItems.map((item) => ({
      description: item.description.trim() || "Unrecognized item",
      lineTotal: money(item.lineTotalCents)!,
      quantity: quantity(item.quantity),
      unitPrice: money(item.unitPriceCents),
      confidence: null,
      page: Math.max(1, item.page),
    })),
    extraction: parsed,
  };
}

async function rasterImages(receipt: ReceiptDocument, bytes: Uint8Array): Promise<string[]> {
  const pages = receipt.mimeType === "image/tiff" ? receipt.pageCount ?? 1 : 1;
  const images: string[] = [];
  for (let page = 0; page < pages; page += 1) {
    const png = await sharp(bytes, receipt.mimeType === "image/tiff" ? { page, pages: 1 } : undefined)
      .rotate()
      .resize({ width: 1800, height: 2400, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
    images.push(`data:image/png;base64,${png.toString("base64")}`);
  }
  return images;
}

function responseText(response: OpenAiResponse): string {
  if (response.output_text) return response.output_text;
  for (const output of response.output ?? []) {
    for (const content of output.content ?? []) {
      if (content.type === "refusal") throw new Error("openai_receipt_ocr_refused");
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  throw new Error("openai_receipt_ocr_empty");
}

async function analyzeExpense(env: ReceiptOcrEnv, receipt: ReceiptDocument, bytes: Uint8Array) {
  const { apiKey, model } = config(env);
  const fileContent = receipt.mimeType === "application/pdf"
    ? [{
        type: "input_file",
        filename: receipt.originalName,
        file_data: `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}`,
      }]
    : (await rasterImages(receipt, bytes)).map((image_url) => ({
        type: "input_image",
        image_url,
        detail: model === "gpt-5.6-luna" ? "original" : "high",
      }));

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: model === "gpt-5.6-luna" ? "none" : "minimal" },
      max_output_tokens: 12_000,
      instructions: [
        "Extract only facts visible in this receipt. Do not invent missing values.",
        "Return all monetary values as signed integer cents. Discounts are negative.",
        "Use ISO 4217 currency codes and YYYY-MM-DD dates; use null when unknown.",
        "Include purchased item rows only, not subtotal, tax, tip, payment, or balance rows.",
        "Quantity must be a plain decimal string or null. Page numbers are one-based.",
      ].join(" "),
      input: [{ role: "user", content: fileContent }],
      text: {
        format: {
          type: "json_schema",
          name: "receipt_extraction",
          strict: true,
          schema: zodToJsonSchema(ReceiptExtractionSchema, { target: "openAi", $refStrategy: "none" }),
        },
      },
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI API error ${response.status}: ${text.slice(0, 300)}`);
  }
  const result = (await response.json()) as OpenAiResponse;
  if (result.error?.message) throw new Error(`OpenAI API error: ${result.error.message.slice(0, 300)}`);
  const normalized = normalizeOpenAiExpense(JSON.parse(responseText(result)) as unknown);
  return {
    ...normalized,
    rawData: {
      provider: "openai",
      model: result.model ?? model,
      responseId: result.id ?? null,
      promptVersion: PROMPT_VERSION,
      usage: result.usage ?? null,
      extraction: normalized.extraction,
    } as Prisma.InputJsonValue,
  };
}

async function saveExpenseDocument(receipt: ReceiptDocument, normalized: Awaited<ReturnType<typeof analyzeExpense>>): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.receiptDocument.updateMany({
      where: { id: receipt.id, status: "processing", deletedAt: null },
      data: {
        status: "ocr_review",
        merchantName: normalized.merchantName,
        totalAmount: normalized.totalAmount,
        receiptDate: normalized.receiptDate,
        currency: normalized.currency,
        ocrRawData: normalized.rawData,
      },
    });
    if (claimed.count !== 1) return;
    await tx.receiptLineItem.deleteMany({ where: { receiptId: receipt.id } });
    if (normalized.lineItems.length) await tx.receiptLineItem.createMany({ data: normalized.lineItems.map((item) => ({
      receiptId: receipt.id,
      description: item.description,
      lineTotal: item.lineTotal,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      confidence: item.confidence,
      page: Math.min(item.page, receipt.pageCount ?? item.page),
    })) });
  });
}

/** Queue worker entry point. A status CAS makes duplicate deliveries harmless. */
export async function processReceiptOcr(env: ReceiptOcrEnv, receiptId: string): Promise<void> {
  const receipt = await prisma.receiptDocument.findUnique({ where: { id: receiptId } });
  if (!receipt || receipt.deletedAt || receipt.status === "superseded" || receipt.status === "reviewed") return;
  const claimed = await prisma.receiptDocument.updateMany({
    where: { id: receipt.id, status: { in: ["queued", "failed"] }, deletedAt: null },
    data: { status: "processing", ocrError: null },
  });
  if (claimed.count !== 1) return;
  try {
    const storage = new CloudflareR2ReceiptInfrastructure(env);
    const bytes = await storage.read({
      location: receipt.storageRegion as ReceiptStorageLocation,
      bucket: receipt.storageBucket,
      key: receipt.storageKey,
    });
    await saveExpenseDocument(receipt, await analyzeExpense(env, receipt, bytes));
  } catch (error) {
    await prisma.receiptDocument.updateMany({
      where: { id: receipt.id, status: "processing" },
      data: { status: "failed", ocrError: error instanceof Error ? error.message.slice(0, 500) : "ocr_failed" },
    });
    throw error;
  }
}

export async function handleReceiptQueueMessage(env: ReceiptOcrEnv, body: string): Promise<void> {
  const message = JSON.parse(body) as { receiptId?: unknown; location?: unknown };
  if (typeof message.receiptId !== "string" || !["enam", "us"].includes(String(message.location))) {
    throw new Error("invalid_receipt_queue_message");
  }
  await processReceiptOcr(env, message.receiptId);
}
