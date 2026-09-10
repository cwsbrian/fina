# Business receipt infrastructure

Receipt originals live only in private Cloudflare R2 buckets. There is no Amazon S3 bucket or temporary S3 copy in this flow.

## 1. R2 buckets

Create two private buckets:

```sh
npx wrangler r2 bucket create fina-receipts-ca --location enam
npx wrangler r2 bucket create fina-receipts-us --jurisdiction us
```

- Keep `r2.dev` public access disabled.
- Apply `infra/receipts/r2-cors.json` in each bucket's Cloudflare dashboard when browser uploads are enabled. Native mobile uploads do not require browser CORS.
- Create one Object Read & Write R2 API token scoped only to these two buckets.
- R2 encrypts all objects at rest automatically. The application never overwrites an original: replacements receive a new random object key.
- The US jurisdiction guarantees US storage and processing. `enam` is only an Eastern North America location hint; Cloudflare does not currently offer a Canada-only R2 jurisdiction. Do not describe the CA bucket as Canada-resident without a separate Cloudflare contractual commitment.

API environment:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
- `R2_RECEIPTS_CA_BUCKET`, `R2_RECEIPTS_US_BUCKET`
- `RECEIPTS_CA_QUEUE_URL`, `RECEIPTS_US_QUEUE_URL`

The API issues five-minute R2 presigned PUT/GET URLs after workspace authorization. It verifies size, MIME magic, SHA-256, and page count before queueing OCR. Invalid uploads and owner-deleted receipts are physically removed from R2. Unfinalized upload intents are removed after 24 hours by the worker.

## 2. OCR queues and workers

Deploy `infra/receipts/queue-stack.yaml` in `ca-central-1` and `us-east-1`. Map its queue URLs to the API variables above.

Deploy `infra/receipts/worker-stack.yaml` once per queue:

- CA worker: `ReceiptStorageLocation=enam`
- US worker: `ReceiptStorageLocation=us`

The worker image runs `pnpm --filter @fina/api receipt:worker`. Private subnets need NAT or endpoints for SQS, ECR, Logs, Secrets Manager, Cloudflare R2, and the OpenAI API.

Supply one OpenAI API key secret and set:

- `OPENAI_API_KEY`
- `RECEIPT_OCR_MODEL=gpt-5-nano`

R2 bytes are sent inline to the OpenAI Responses API with `store=false`; no second object store is used. JPEG/PNG/TIFF pages are normalized to PNG before analysis, while PDFs use direct file input. The application keeps its 20-page and 25 MB limits. R2 location controls do not make OpenAI processing Canada- or US-resident, so production rollout still requires the appropriate OpenAI data-processing and retention configuration.

To promote OCR after the fixed receipt evaluation set fails its accuracy thresholds, change only `RECEIPT_OCR_MODEL` to `gpt-5.6-luna` and redeploy the workers. Do not enable per-document model routing.

## 3. Rollout gate

Before enabling business workspace creation:

1. Upload JPEG, PNG, PDF, and TIFF fixtures through a presigned R2 URL.
2. Confirm finalize rejects incorrect length, MIME magic, checksum, and files over 20 pages.
3. Confirm each queue uses `gpt-5-nano` and produces `ocr_review` line items.
4. Confirm a US receipt uses the `.us.r2.cloudflarestorage.com` endpoint.
5. Confirm expired URLs, cross-workspace reads, duplicate queue delivery, reprocessing, and physical deletion.
