import { View, Text, StyleSheet, Pressable } from "react-native";
import { router } from "expo-router";
import type { PresentationBlock as Block } from "@fina/shared";
import { colors, space, type as type$ } from "../design/tokens";
import { BlockPresentationProvider } from "./blocks/_primitives";
import { RecapBlock } from "./blocks/RecapBlock";
import { RecurringFormBlock } from "./blocks/RecurringFormBlock";
import type {
  FormBlockActions,
  FormBlockActionState,
} from "./blocks/RecurringFormBlock";
import { RecurringListBlock } from "./blocks/RecurringListBlock";
import { TransactionsListBlock } from "./blocks/TransactionsListBlock";
import { BudgetListBlock } from "./blocks/BudgetListBlock";
import { AccountsListBlock } from "./blocks/AccountsListBlock";
import { ScheduledListBlock } from "./blocks/ScheduledListBlock";
import { RecurringCandidatesBlock } from "./blocks/RecurringCandidatesBlock";
import { TransactionDetailBlock } from "./blocks/TransactionDetailBlock";
import { CategoryListBlock } from "./blocks/CategoryListBlock";
import { GoalsListBlock } from "./blocks/GoalsListBlock";
import { GoalDetailBlock } from "./blocks/GoalDetailBlock";
import { GoalFormBlock } from "./blocks/GoalFormBlock";
import { PlanProposalCardBlock } from "./blocks/PlanProposalCardBlock";

type Props = {
  block: Block;
  role: "user" | "assistant" | "tool";
  presentation?: "card" | "sheet";
  onAccept?: (intent: string) => void;
  onReject?: (intent: string | undefined) => void;
  /** Form submission for recurring_form_card. Resolves once the server
   *  finishes consuming the intent so the form can render its "Added"
   *  state. Throw to surface an error to the user. */
  onSubmitForm?: (intentId: string, overrides: Record<string, unknown>) => Promise<void>;
  /** Form is actively in-edit. Parent uses this to step the chat composer
   *  out of the way while the user fills in fields. */
  onFormFocusChange?: (focused: boolean) => void;
  formActions?: "inline" | "header";
  onFormActionsChange?: (actions: FormBlockActions | null) => void;
  onFormActionStateChange?: (state: FormBlockActionState) => void;
};

/** Renders a single presentation block. Exhaustive over the
 *  PresentationBlock union; new block types fail at the never-cast and
 *  show a debug pill so the user sees something instead of nothing. */
export function PresentationBlock({
  block,
  role,
  presentation = "card",
  onAccept,
  onReject,
  onSubmitForm,
  onFormFocusChange,
  formActions = "inline",
  onFormActionsChange,
  onFormActionStateChange,
}: Props) {
  const renderBlock = () => {
    if (block.type === "text") {
      return (
        <Text style={role === "user" ? styles.userText : styles.assistantText}>
          {block.markdown}
        </Text>
      );
    }
    if (block.type === "confirm_card") {
      return (
        <View style={presentation === "sheet" ? styles.sheetAction : styles.card}>
          <Text style={styles.cardQuestion}>{block.question}</Text>
          {presentation === "sheet" ? null : (
            <View style={styles.cardActions}>
              <Pressable
                style={({ pressed }) => [
                  styles.cardBtn,
                  styles.cardBtnReject,
                  pressed && { opacity: 0.7 },
                ]}
                onPress={() => onReject?.(block.reject_intent)}
              >
                <Text style={styles.cardBtnRejectText}>{block.reject_label}</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.cardBtn,
                  styles.cardBtnAccept,
                  pressed && { opacity: 0.85 },
                ]}
                onPress={() => onAccept?.(block.accept_intent)}
              >
                <Text style={styles.cardBtnAcceptText}>{block.accept_label}</Text>
              </Pressable>
            </View>
          )}
        </View>
      );
    }
    if (block.type === "recap") {
      return <RecapBlock block={block} />;
    }
    if (block.type === "transactions_list") {
      return <TransactionsListBlock block={block} />;
    }
    if (block.type === "recurring_list") {
      return <RecurringListBlock block={block} />;
    }
    if (block.type === "recurring_form_card") {
      return (
        <RecurringFormBlock
          block={block}
          onSubmit={async (id, overrides) => {
            if (onSubmitForm) await onSubmitForm(id, overrides);
          }}
          onCancel={() => {
            // Cancel doesn't hit the server — the intent simply expires
            // after its TTL (1 hour). Mirror confirm-card's reject path.
            onReject?.(undefined);
          }}
          formActions={formActions}
          {...(onFormActionsChange ? { onActionsChange: onFormActionsChange } : {})}
          {...(onFormActionStateChange ? { onActionStateChange: onFormActionStateChange } : {})}
          {...(onFormFocusChange ? { onFocusChange: onFormFocusChange } : {})}
        />
      );
    }
    if (block.type === "categorize_confirm_card") {
      return (
        <View style={presentation === "sheet" ? styles.catSheet : styles.catCard}>
          <Text style={styles.catCardTitle}>오늘 분류한 {block.count}개 확인해주세요</Text>
          {block.items.map((it) => (
            <Text key={it.txId} style={styles.catCardItem}>
              {it.merchant} → {it.categoryName}
            </Text>
          ))}
          {block.moreCount > 0 && (
            <Text style={styles.catCardMore}>외 {block.moreCount}건</Text>
          )}
          <Pressable
            style={styles.catCardCta}
            onPress={() => router.push("/(tabs)/activity" as never)}
          >
            <Text style={styles.catCardCtaText}>Activity에서 보기</Text>
          </Pressable>
        </View>
      );
    }
    if (block.type === "budget_list") {
      return <BudgetListBlock block={block} />;
    }
    if (block.type === "accounts_list") {
      return <AccountsListBlock block={block} />;
    }
    if (block.type === "scheduled_list") {
      return <ScheduledListBlock block={block} {...(onSubmitForm ? { onSubmitForm } : {})} />;
    }
    if (block.type === "recurring_candidates") {
      return (
        <RecurringCandidatesBlock
          block={block}
          {...(onSubmitForm ? { onSubmitForm } : {})}
          {...(onFormFocusChange ? { onFormFocusChange } : {})}
        />
      );
    }
    if (block.type === "transaction_detail") {
      return <TransactionDetailBlock block={block} />;
    }
    if (block.type === "category_list") {
      return <CategoryListBlock block={block} />;
    }
    if (block.type === "goals_list") {
      return <GoalsListBlock block={block} />;
    }
    if (block.type === "goal_detail") {
      return <GoalDetailBlock block={block} />;
    }
    if (block.type === "goal_form_card") {
      return (
        <GoalFormBlock
          block={block}
          onSubmit={async (id, overrides) => {
            if (onSubmitForm) await onSubmitForm(id, overrides);
          }}
          onCancel={() => onReject?.(undefined)}
          formActions={formActions}
          {...(onFormActionsChange ? { onActionsChange: onFormActionsChange } : {})}
          {...(onFormActionStateChange ? { onActionStateChange: onFormActionStateChange } : {})}
          {...(onFormFocusChange ? { onFocusChange: onFormFocusChange } : {})}
        />
      );
    }
    if (block.type === "plan_proposal_card") {
      return (
        <PlanProposalCardBlock
          block={block}
          presentation={presentation}
          {...(onAccept ? { onAccept } : {})}
          {...(onReject ? { onReject } : {})}
        />
      );
    }
    // Exhaustiveness — newer block types render a debug pill so users
    // see SOMETHING rather than a blank message.
    const _exhaustive: never = block;
    return (
      <View style={styles.unknown}>
        <Text style={styles.unknownText}>
          (Unsupported message type. Update the app.)
        </Text>
        <Text style={{ display: "none" }}>{JSON.stringify(_exhaustive)}</Text>
      </View>
    );
  };

  return (
    <BlockPresentationProvider value={presentation}>
      {renderBlock()}
    </BlockPresentationProvider>
  );
}

const styles = StyleSheet.create({
  userText: {
    ...type$.bodyMd,
    color: colors.onPrimary,
  },
  assistantText: {
    ...type$.bodyMd,
    color: colors.ink,
  },
  card: {
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 14,
    padding: space.base,
    marginVertical: 4,
  },
  cardQuestion: {
    ...type$.titleSm,
    color: colors.ink,
    marginBottom: space.sm,
  },
  cardActions: {
    flexDirection: "row",
    gap: space.xs,
  },
  cardBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 999,
    alignItems: "center",
  },
  cardBtnAccept: { backgroundColor: colors.primary },
  cardBtnReject: {
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  cardBtnAcceptText: { ...type$.button, color: colors.onPrimary },
  cardBtnRejectText: { ...type$.button, color: colors.ink },
  sheetAction: {
    gap: space.sm,
  },
  catCard: {
    backgroundColor: colors.surfaceSoft,
    borderRadius: 14,
    padding: space.base,
    gap: 6,
  },
  catSheet: {
    gap: 6,
  },
  catCardTitle: { ...type$.titleSm, color: colors.ink },
  catCardItem: { ...type$.bodySm, color: colors.body },
  catCardMore: { ...type$.bodySm, color: colors.muted, fontStyle: "italic" },
  catCardCta: { marginTop: space.sm, alignSelf: "flex-start" },
  catCardCtaText: { ...type$.captionStrong, color: colors.primary },
  unknown: {
    padding: space.sm,
    borderRadius: 8,
    backgroundColor: colors.surfaceSoft,
  },
  unknownText: { ...type$.caption, color: colors.muted },
});
