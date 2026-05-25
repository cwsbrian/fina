import { z } from "zod";

export const CATEGORIZATION_MODES = ["flexible", "strict", "auto"] as const;
export type CategorizationMode = (typeof CATEGORIZATION_MODES)[number];

export const CategorizationModeSchema = z.enum(CATEGORIZATION_MODES);
