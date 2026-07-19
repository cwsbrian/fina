# Screenshot Preparation Guide

This directory intentionally contains no fabricated product screenshots. Capture images from a controlled demo environment with synthetic data, then complete the [public release checklist](../docs/public-release-checklist.md) before publishing them.

## Recommended Screenshots

| Filename                 | UI state to capture                                                                                              | Suggested caption                                                                    | Suggested alt text                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `home-overview.png`      | Mobile home with a populated budget summary, goal progress, recent activity, and one next-action card            | “A single overview connects current activity, plans, goals, and advisor follow-ups.” | “Fina mobile home showing a budget summary, goal progress, recent transactions, and an action card.” |
| `advisor-chat.png`       | A read-only advisor question with a useful answer and one structured transaction, budget, goal, or category card | “The advisor combines conversational guidance with structured financial results.”    | “Fina advisor conversation showing a financial answer and a structured result card.”                 |
| `activity-review.png`    | Activity list with search or category filters and a synthetic item that needs review                             | “Search, filters, and review states keep imported and manual activity manageable.”   | “Fina activity screen with transaction filters, category labels, and a review indicator.”            |
| `planning-analysis.png`  | Budget or analysis view with synthetic category totals and a clearly explained period                            | “Planning views connect category activity to a monthly financial picture.”           | “Fina planning screen showing synthetic category totals and a monthly budget summary.”               |
| `workspace-settings.png` | Workspace or bank settings with synthetic members and sandbox connections only                                   | “Shared workspaces provide role-aware access to household financial context.”        | “Fina workspace settings showing synthetic collaborators and a sandbox bank connection.”             |

Capture only the first three images for the initial showcase. Add the others when they materially improve the story and can be reviewed to the same standard.

## Capture Dimensions

- **Mobile:** Capture a current phone viewport at native resolution, ideally around 1179 × 2556 or 1290 × 2796 pixels in portrait orientation.
- **Web:** Capture at 1440 × 900 pixels, or at 2880 × 1800 and export at half size for a sharp 2× source.
- **Format:** Prefer PNG for interface detail. Use WebP only after confirming text remains crisp in GitHub's renderer.
- **Cropping:** Keep consistent outer margins and avoid excessive device chrome. Do not stretch or resample to a different aspect ratio.
- **Repository size:** Optimize images without making UI text unreadable. A concise set of strong screens is preferable to a full gallery.

## Demo Data Requirements

Create a dedicated synthetic workspace and use clearly invented content:

- A fictional person and email address reserved for documentation
- Sandbox institution connections only
- Invented merchants, transaction amounts, categories, budgets, and goals
- A conversation written specifically for the public screenshot
- Dates that do not reproduce a real financial timeline
- Subscription states created in a provider sandbox or a safe local fixture

Avoid using blurred real data. Redaction can fail, and context around a blurred field may remain identifying.

## Private Information to Remove

Review every pixel for:

- Real names, initials, avatars, email addresses, and invite recipients
- Bank and credit-card account names, balances, account suffixes, and institution-specific identifiers
- Real merchants, transaction descriptions, amounts, dates, notes, budgets, and goals
- Chat content generated from real financial records
- Subscription receipts, provider account details, or recovery diagnostics
- Notification tokens, QR codes, deep links, internal URLs, build labels, and debug menus
- Browser profiles, bookmarks, tabs, autofill suggestions, extensions, and local file paths
- Device carrier, personal notification banners, precise time/location clues, and background apps
- Analytics overlays, request inspectors, logs, stack traces, and environment labels

Also inspect image metadata before committing. Exported files should not contain a personal filesystem path, author name, device serial, or location metadata.

## Capture Notes by Screen

### Home overview

Use a state with enough financial data to demonstrate the overview, but keep the hierarchy legible. One budget, one goal, and three recent transactions are sufficient. Avoid showing every card simply because it exists.

### Advisor chat

Prefer a read-only question such as a category comparison or spending summary. If a confirmation card is shown, use a harmless synthetic change and make the pending state obvious. Do not display internal tool names, raw model output, prompts, or debug payloads.

### Activity review

Show a filter or needs-review state that explains the categorization workflow. Use varied synthetic merchants and categories without copying real transaction history.

### Planning or analysis

Choose either budget planning or category analysis for a single image. Ensure all figures reconcile visually and label the time period; inconsistent demo numbers undermine credibility.

### Workspace settings

Use fictional collaborators and sandbox bank connections. Avoid invitation tokens, real recipient addresses, internal roles beyond the public owner/editor/viewer model, and any production support or billing identifiers.

## Final Image Review

1. Review the uncropped original and the exported image at 100% zoom.
2. Ask a second person to inspect for personal, financial, provider, and development information.
3. Confirm the caption and alt text match the visible state.
4. Run the repository's approved secret and metadata scans.
5. Open the final README in GitHub preview and confirm text remains readable on desktop and mobile.
