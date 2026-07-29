-- Re-run the direction-aware classifier for every automatic transaction.
-- The original income/refund migration intentionally used a smaller SQL
-- subset; this closes the gap for existing rows whose transfer signal lived
-- in merchant_name/name or in registered-account markers such as TFSA/RRSP.
-- Explicit user include/exclude choices remain authoritative.
UPDATE "transactions" AS t
SET "budgetImpact" = CASE
  WHEN t."amount" = 0
    THEN 'excluded'::"BudgetImpact"
  WHEN t."source" <> 'plaid'
    THEN CASE
      WHEN t."amount" > 0 THEN 'expense'::"BudgetImpact"
      ELSE 'income'::"BudgetImpact"
    END
  WHEN t."amount" < 0
    AND (
      UPPER(COALESCE(t."rawData" #>> '{personal_finance_category,detailed}', '')) LIKE '%REFUND%'
      OR UPPER(CONCAT_WS(
        ' ',
        t."merchantRaw",
        t."rawData" #>> '{name}',
        t."rawData" #>> '{merchant_name}'
      )) ~ '(^|[^A-Z0-9])(REFUND|REFUNDED|REVERSAL)([^A-Z0-9]|$)'
      OR EXISTS (
        SELECT 1
        FROM "transaction_allocations" a
        JOIN "categories" c ON c."id" = a."categoryId"
        WHERE a."transactionId" = t."id"
          AND c."type" = 'income'
          AND LOWER(c."name") = 'refund'
      )
    )
    THEN 'refund'::"BudgetImpact"
  WHEN t."amount" > 0
    AND (
      UPPER(COALESCE(t."rawData" #>> '{personal_finance_category,detailed}', '')) LIKE 'TRANSFER_OUT_WITHDRAWAL%'
      OR UPPER(COALESCE(t."rawData" #>> '{personal_finance_category,detailed}', '')) LIKE 'LOAN_PAYMENTS_MORTGAGE_PAYMENT%'
      OR UPPER(COALESCE(t."rawData" #>> '{personal_finance_category,detailed}', '')) LIKE 'LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT%'
      OR UPPER(COALESCE(t."rawData" #>> '{personal_finance_category,detailed}', '')) LIKE 'LOAN_PAYMENTS_BNPL%'
      OR UPPER(COALESCE(t."rawData" #>> '{personal_finance_category,detailed}', '')) LIKE 'BANK_FEES%'
    )
    THEN 'expense'::"BudgetImpact"
  WHEN UPPER(CONCAT_WS(
      ' ',
      t."merchantRaw",
      t."rawData" #>> '{name}',
      t."rawData" #>> '{merchant_name}'
    )) ~ '(^|[^A-Z0-9])(E-TRANSFER|E-TFR|INTERAC|ZELLE|VENMO|CASH APP|PAYPAL)([^A-Z0-9]|$)'
    THEN CASE
      WHEN t."amount" > 0 THEN 'expense'::"BudgetImpact"
      ELSE 'income'::"BudgetImpact"
    END
  WHEN t."amount" < 0
    AND UPPER(COALESCE(t."rawData" #>> '{personal_finance_category,detailed}', '')) LIKE '%ACCOUNT_TRANSFER%'
    THEN 'excluded'::"BudgetImpact"
  WHEN UPPER(COALESCE(t."rawData" #>> '{personal_finance_category,detailed}', '')) LIKE '%INVESTMENT%'
    OR UPPER(COALESCE(t."rawData" #>> '{personal_finance_category,detailed}', '')) LIKE '%RETIREMENT%'
    OR UPPER(COALESCE(t."rawData" #>> '{personal_finance_category,detailed}', '')) LIKE '%CREDIT_CARD_PAYMENT%'
    THEN 'excluded'::"BudgetImpact"
  WHEN UPPER(CONCAT_WS(
      ' ',
      t."merchantRaw",
      t."rawData" #>> '{name}',
      t."rawData" #>> '{merchant_name}'
    )) ~ '(^|[^A-Z0-9])(PAYMENT|PYMT|PMT)([^A-Z0-9]|$)'
    AND UPPER(CONCAT_WS(
      ' ',
      t."merchantRaw",
      t."rawData" #>> '{name}',
      t."rawData" #>> '{merchant_name}'
    )) ~ '(^|[^A-Z0-9])(CREDIT|CARD|VISA|MASTERCARD|AMEX)([^A-Z0-9]|$)'
    THEN 'excluded'::"BudgetImpact"
  WHEN UPPER(CONCAT_WS(
      ' ',
      t."merchantRaw",
      t."rawData" #>> '{name}',
      t."rawData" #>> '{merchant_name}'
    )) ~ '(^|[^A-Z0-9])(TFR-TO|TRANSFER TO|TRANSFER FROM|XFER TO|XFER FROM|XFR TO|XFR FROM|TRSF TO|TRSF FROM|TRNSFR TO|TRNSFR FROM|ONLINE TRANSFER|INTERNAL TRANSFER|ACCOUNT TRANSFER|BOOK TRANSFER|BETWEEN ACCOUNTS)([^A-Z0-9]|$)'
    THEN 'excluded'::"BudgetImpact"
  WHEN UPPER(CONCAT_WS(
      ' ',
      t."merchantRaw",
      t."rawData" #>> '{name}',
      t."rawData" #>> '{merchant_name}'
    )) ~ '(^|[^A-Z0-9])(RSP|RRSP|TFSA|RESP|RDSP|FHSA|LIRA|LRSP|RRIF|IRA|401K|403B|457B|HSA|529)([^A-Z0-9]|$)'
    THEN 'excluded'::"BudgetImpact"
  WHEN (
      UPPER(COALESCE(t."rawData" #>> '{personal_finance_category,primary}', '')) LIKE 'TRANSFER\_%' ESCAPE '\'
      OR UPPER(COALESCE(t."rawData" #>> '{personal_finance_category,detailed}', '')) LIKE 'TRANSFER\_%' ESCAPE '\'
    )
    AND UPPER(CONCAT_WS(
      ' ',
      t."merchantRaw",
      t."rawData" #>> '{name}',
      t."rawData" #>> '{merchant_name}'
    )) ~ '(^|[^A-Z0-9])(ROTH|INVEST|INVESTMENT|BROKERAGE|WEALTH|SECURITIES|TRADING|RETIREMENT|PENSION|REGISTERED|WEALTHSIMPLE|QUESTRADE|RBC DIRECT INVESTING|TD DIRECT INVESTING|FIDELITY|VANGUARD|SCHWAB|E-TRADE|ROBINHOOD|MERRILL)([^A-Z0-9]|$)'
    THEN 'excluded'::"BudgetImpact"
  WHEN t."amount" > 0
    THEN 'expense'::"BudgetImpact"
  ELSE 'income'::"BudgetImpact"
END
WHERE t."budgetImpactSource" = 'auto'
  AND t."removedAt" IS NULL;
