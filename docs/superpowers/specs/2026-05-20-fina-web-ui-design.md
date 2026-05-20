# Fina Web UI — Page Spec for Design

**Date:** 2026-05-20
**Audience:** Designer (no prior product context)
**Purpose:** Page-by-page specification of every screen on the Fina web app, so a designer can produce mockups/visual designs. Captures purpose, content, user actions, empty/error states, and tier-specific behavior.

---

## 1. Product context (for designer)

**Fina** is a personal-finance app for Canadian users. Users connect their bank accounts via Plaid (Open Banking), transactions sync automatically, and an AI agent helps them organize spending through chat — primarily on mobile.

**Web's role** (this app) — entry surface only, NOT the daily-use app:
- Landing/marketing
- Sign-up, sign-in, password reset, account/billing self-service
- Workspace settings (members, sharing)
- Plaid Link (bank connection)
- Subscription management (Stripe checkout)
- Invite accept

**Web is NOT for**: chat, transaction browsing, daily ritual, budget UI, recurring UI, scheduled-spend UI. Those live on mobile.

### Tier model (relevant to most pages)

| Tier | Price (CAD) | Plaid banks | AI chat | Workspace sharing |
|---|---|---|---|---|
| **Free** | $0 | None (manual/CSV) | None | ✅ |
| **Lite** | $7/mo | 1 | Daily ritual only (card responses, no free-form chat) | ✅ |
| **Pro** | $15/mo | Unlimited | Full two-way chat | ✅ |

- New accounts get a **30-day Pro trial** automatically (no card required). After trial ends → Free tier, Plaid items removed, AI locked. Data and sharing preserved.
- Subscription is **per-user**, not per-workspace. A workspace can have mixed-tier members.
- **Web prices are headline**. Mobile uses IAP at ~$6.99/$14.99. Apple/Google billing handled inside the mobile app.
- Web shows pricing for the **Stripe path only** ("Reader app" compliance — never reference IAP from web).

### Workspace model

Every user has at least one workspace (a personal one created at sign-up). Workspaces are containers for bank connections, transactions, categories, budgets. Users can be members of multiple workspaces (own + shared). The web header shows a **Workspace switcher** to flip between them.

Roles: `owner`, `editor`, `viewer`. Only owners can connect/disconnect banks, manage members, and invite. Editors can edit transactions. Viewers are read-only.

### Visual considerations (designer's lens)

- **Brand tone**: warm, calm, approachable. Not a Wall Street terminal. Pastel + soft accents acceptable.
- **Typography**: trust-conveying but not corporate-stiff.
- **Density**: low. Most users open web rarely — keep big tap targets, generous whitespace.
- **Empty/error states**: must be designed. Many pages are nearly empty for a brand-new account (no banks, no members, no invites).
- **Mobile responsive**: web is opened on a desktop most often (settings, billing), but the marketing landing page must work on mobile (App Store discoverability flow).
- **Korean + English**: app text is currently English. Designer should treat copy as placeholder — copywriting comes later.

---

## 2. Information architecture

```
PUBLIC
├── /                                Landing
├── /sign-in                         Sign in / Sign up
├── /forgot-password                 Password reset request
├── /reset-password?token=…          Password reset confirmation
└── /invites/[token]                 Invite accept

AUTH-REQUIRED (app shell)
├── /home                            Dashboard
└── /settings
    ├── /banks                       Plaid connections
    ├── /workspace                   Members, invites, rename
    ├── /plan                        Subscription / billing
    └── /account                     Profile, password, danger zone
```

**App shell** (all `/settings/*` and `/home`):
- Top bar: logo (left), nav links (Home, Banks, Workspace, Plan, Account), workspace switcher (right)
- Mobile: hamburger collapses nav
- No sidebar in v1

---

## 3. Public pages

### 3.1 Landing page — `/`

**Purpose:** First impression. Convert visitors to sign-up. Communicate the value prop in 5 seconds.

**Auth state:** If signed in, redirect to `/home`.

**Sections (top to bottom):**

1. **Hero**
   - Headline: "AI Financial Advisor — chat with your money" (placeholder copy)
   - Sub: 1–2 sentences on what makes Fina different (daily ritual + chat + Plaid auto-import)
   - CTA: large "Get started" button → `/sign-in?mode=signUp`
   - Secondary: "Sign in" text link → `/sign-in`
   - Hero visual: phone mockup showing the chat / daily brief (designer's call)

2. **Value pillars (3-up)**
   - "Auto-import" — connect your bank, transactions appear
   - "Daily ritual" — morning push with what you spent + what's coming
   - "Just chat" — ask questions, make changes, in plain language

3. **How it works** (3 steps)
   - Sign up free → 30-day Pro trial included
   - Connect your bank (or skip and use manual entry)
   - Open the app every morning for your brief

4. **Pricing teaser**
   - 3 columns: Free / Lite / Pro with one-line summary + price
   - CTA per column: "Start free" / "Try Pro free for 30 days"
   - Link to full pricing details (in v1, this could just expand inline)

5. **Footer**
   - Links: Privacy policy, Terms, Contact, App Store / Google Play badges
   - Small print: "Made in Canada", currency note

**State variants:** None — fully static.

**Error states:** None.

**Mobile breakpoint:** Critical. Hero stacks, value pillars become vertical, footer compacts.

---

### 3.2 Sign in / Sign up — `/sign-in`

**Purpose:** Single page that handles both sign-up and sign-in via a mode toggle.

**Auth state:** Public; signed-in users may revisit (no auto-redirect).

**Two modes** (toggleable via "Already have an account?" / "New here?"):

- **Sign up** (default for new visitors)
- **Sign in** (when user has an account)

**Sections:**

1. **Header**
   - Page title: "Create account" or "Sign in"
   - Mode toggle text link below title

2. **Form fields**

   | Field | Sign up | Sign in |
   |---|---|---|
   | Name | ✅ optional (falls back to email prefix) | — |
   | Email | ✅ required | ✅ required |
   | Password | ✅ required, 8+ chars | ✅ required |

3. **Submit button**
   - Label: "Create account" or "Sign in"
   - Disabled while busy or required fields missing
   - Loading state: dot animation or spinner inline

4. **Below form**
   - Sign in mode: "Forgot password?" link → `/forgot-password`
   - Sign up mode: small print about ToS / Privacy acceptance
   - (Future) "Continue with Google" button — Google OAuth is already wired in the backend; design slot for it

5. **Error display**
   - Inline below submit button, red text
   - Examples: "Invalid email or password", "Email already registered", "Password must be at least 8 characters"

**Special mode — invite flow:**

When the user arrives via `/sign-in?inviteToken=…&from=/invites/<token>`:

- Page fetches invite preview from API, pre-fills email field, **locks email field** (visually disabled with subtle "🔒" or grey background)
- Small note under email: "Email locked to the invited address. To use a different email, open /sign-in directly."
- On successful sign-up, redirects back to the invite page (`from` param)

**Empty state:** N/A (form has clear initial state).

**Loading state:** While submitting, button shows "..." and is disabled.

**Designer notes:**
- This is where most users will spend their first 30 seconds. Trust signals matter.
- Form should be center-stage, ~360-400px wide on desktop.
- Mode toggle should be subtle but obvious (text link, not full button).

---

### 3.3 Forgot password — `/forgot-password` *(NEW)*

**Purpose:** User enters their email; receives a reset link via email.

**Auth state:** Public.

**Sections:**

1. **Header**
   - Title: "Reset your password"
   - Sub: "We'll email you a link to reset it."

2. **Form**
   - Single field: email
   - Submit button: "Send reset link"

3. **Success state** (after submit)
   - Replaces form with confirmation: "Check your email. We sent a link to {email}. The link expires in 30 minutes."
   - Secondary action: "Use a different email" → reset to form
   - Link back to `/sign-in`

4. **Error states**
   - Generic "Could not send. Try again." — **don't reveal whether email is registered** (privacy: no user enumeration)
   - Rate-limited: "Too many requests. Wait a few minutes."

**Designer notes:** Keep extremely simple. One field, one button. Success state should feel reassuring.

---

### 3.4 Reset password — `/reset-password?token=…` *(NEW)*

**Purpose:** User arrives from the email link; sets a new password.

**Auth state:** Public, but token-gated.

**Sections:**

1. **Header**
   - Title: "Set a new password"

2. **Form**
   - Field 1: New password (8+ chars, type=password)
   - Field 2: Confirm new password (must match)
   - Submit: "Update password"

3. **Success state**
   - Confirmation: "Password updated. Sign in with your new password."
   - CTA: "Sign in" → `/sign-in`

4. **Error states**
   - Invalid/expired token: "This link is invalid or expired. Request a new one." with CTA → `/forgot-password`
   - Passwords don't match: inline, before submit
   - Server error: generic retry

**Designer notes:** Two-field form. Show password strength meter (optional v1).

---

### 3.5 Invite accept — `/invites/[token]` *(EXISTING)*

**Purpose:** User arrives from an emailed invite link; previews the invite; signs in/up if needed; accepts.

**Auth state:** Mixed. The page works signed-out OR signed-in.

**Page card content** (always shown if token is valid):

- "From" line: inviter's email
- "Workspace" line: workspace name (large)
- "You'd join as" line: role (`editor` / `viewer`)

**Branching by state:**

| State | UI |
|---|---|
| Token invalid / deleted | Error: "This invite link is invalid or has been deleted." |
| Token expired / revoked / already accepted | Inline status: "This invite is expired/revoked/accepted." |
| Pending + signed out | CTA: "Sign in / Sign up as {invitedEmail}" → `/sign-in?inviteToken=…&from=…` |
| Pending + signed in + email matches | Big "Accept invite" button. On click → POST accept → redirect to `/home` |
| Pending + signed in + wrong email | Note: "This invite is for {email}. You're signed in as {currentEmail}." + "Sign out and try again" button |

**Designer notes:**
- This is a delight moment (someone shared with me!). Keep warm.
- Loading state while preview fetches: skeleton card or spinner.
- 480px wide centered card on desktop. Mobile: full-width with padding.

---

## 4. App shell (auth-required pages)

### Header bar — present on all `/home` and `/settings/*` pages

**Left:**
- Logo + product name (clickable → `/home`)

**Center / right (desktop):**
- Nav links: Home / Banks / Workspace / Plan / Account
- Active link state (underline, bold, or pill background)

**Far right:**
- **Workspace switcher**: dropdown showing current workspace name + chevron
  - Opens list of workspaces user is a member of
  - Active workspace highlighted
  - "Create new workspace" item at bottom (future — v1 may not include)
- User avatar / initials → opens menu: Sign out, Account settings

**Mobile:**
- Logo left, hamburger right
- Hamburger opens drawer with nav + workspace switcher + sign out

**Designer notes:**
- Workspace switcher is critical — many users will have a personal + shared workspace.
- Consider showing role badge ("owner" / "editor" / "viewer") next to active workspace name.
- Tier badge ("FREE" / "LITE" / "PRO" / "TRIAL") could go in the header for visibility — designer's call.

---

### 4.1 Home / Dashboard — `/home` *(EXISTING — needs design)*

**Purpose:** Post-login welcome screen. Confirms identity + workspace + tier. Provides a few key actions and a clear "open the mobile app" CTA.

**Sections:**

1. **Welcome line**
   - "Welcome back, {name}" or just "Welcome"
   - Date subtext (optional)

2. **Tier + trial banner** (top, dismissible/persistent)
   - During trial: "Pro trial — {N} days left. Ends {date}." + "Stay on Pro" button → `/settings/plan`
   - After trial expired (Free): "Your trial ended. Upgrade to keep Plaid + AI features." + "Upgrade" → `/settings/plan`
   - Lite or Pro: subtle "{TIER} plan" badge, no urgency

3. **Workspace summary card**
   - Workspace name (large)
   - Role badge
   - Member count ("Just you" / "3 members")
   - "Manage" link → `/settings/workspace`

4. **"Get the mobile app" CTA**
   - Big section: App Store + Google Play badges
   - Caption: "Fina's daily ritual + chat live on your phone. Open the app to start."
   - QR code optional (designer's call)

5. **Quick links** (3-up grid or list)
   - Connect a bank → `/settings/banks`
   - Invite a household member → `/settings/workspace`
   - Choose your plan → `/settings/plan`

6. **Recent activity** (v2 — leave space in design but not required for v1)
   - Last sync date, last login, etc.

**Empty states:**
- New account, no banks connected: prominent "Connect your first bank" card

**Error states:**
- API unreachable: "Couldn't load your profile. Try refreshing." with retry button

**Designer notes:**
- Don't try to recreate the mobile dashboard here. Keep web home as a "control center" — manage stuff, then go to mobile.
- Trial banner is the highest-priority visual element when active.

---

### 4.2 Banks — `/settings/banks` *(EXISTING — needs design)*

**Purpose:** Connect banks via Plaid Link, view connected institutions, disconnect, refresh.

**Tier-gated**: Free can't connect at all. Lite gets 1. Pro gets unlimited.

**Sections:**

1. **Page header**
   - Title: "Banks"
   - Sub: "Connect your bank account so Fina can import your transactions automatically."

2. **Connected banks list** (existing component)
   - Each row: institution name, account count, status badge (Active / Reconnect needed / Error), last sync time
   - Click row → expand to show accounts and a "Disconnect" action
   - Disconnect button: secondary, requires confirmation modal

3. **"Connect a bank" button** (primary CTA)
   - Tier-aware label:
     - Free: "Upgrade to connect a bank" (disabled state, links to plan)
     - Lite at limit (1 bank): "Lite plan: 1 bank connected. Upgrade to Pro for unlimited."
     - Pro: always enabled
   - Click → opens Plaid Link overlay (Plaid handles the UI inside their modal)

4. **Status messages**
   - "Only the workspace owner can connect, refresh, or disconnect a bank." (non-owners)
   - Error states: connection failed, expired token, etc.

**Empty state:**
- No banks connected: hero illustration + "Connect your first bank to start auto-import."

**Designer notes:**
- Each connected bank should feel like a real "item" — institution logo (from Plaid metadata), bank name, account types.
- Status badges: green (healthy), yellow (reconnect needed), red (error).
- Plaid Link itself is a Plaid-controlled modal, not designable.

---

### 4.3 Workspace — `/settings/workspace` *(EXISTING — needs design)*

**Purpose:** Manage workspace members, invites, and (future) workspace name/currency.

**Permission gating**: All members can see members list. Only owners see invite + pending-invites section.

**Sections:**

1. **Page header**
   - Title: "Workspace settings"
   - Sub: workspace name

2. **Workspace name + currency** *(NEW area — currently text-only)*
   - Workspace name (editable by owner via inline edit or modal)
   - Default currency (CAD) — informational for v1, editable v2

3. **Members list**
   - Each row: avatar/initials, name, email, role pill
   - Owner actions per row: change role (dropdown), remove member (icon button + confirm)
   - "You" indicator for current user
   - Empty state: just the current user, no removed/external members yet

4. **Invite a member** (owner-only)
   - Form: email field, role dropdown (editor / viewer), "Send invite" button
   - Inline validation (already a member, invalid email)
   - Confirmation on send: "Invite sent to {email}"

5. **Pending invites** (owner-only)
   - List of unaccepted invites: email, role, sent date, expires date
   - Per-row actions: resend, revoke
   - Empty state: "No pending invites"

6. **Danger zone** *(NEW)* — collapsed by default
   - "Leave workspace" (non-owners)
   - "Transfer ownership" (owner — only when other members exist)
   - "Delete workspace" (owner — only when no other members and not personal workspace)

**Empty states:**
- Solo workspace, no invites: clear "Invite your first member" prompt with form prominent

**Designer notes:**
- Role pill colors: owner = primary brand color; editor = neutral; viewer = light/muted.
- Confirmation modals for destructive actions (remove member, revoke invite, leave/delete workspace).

---

### 4.4 Plan / Subscription — `/settings/plan` *(NEW)*

**Purpose:** Show current plan, allow upgrade/downgrade via Stripe checkout, manage subscription (cancel, update card).

**Compliance note** (Apple's "Reader app" pattern): this page is **web-only**. The mobile app must not link here. Stripe-billed subscriptions stay separate from IAP subscriptions in the backend.

**Sections:**

1. **Page header**
   - Title: "Plan & billing"

2. **Current plan card** (top, prominent)
   - Plan name badge: Free / Lite / Pro / Trial (Pro)
   - Status: "Active" / "Trial — ends in N days" / "Canceled — ends {date}" / "Past due"
   - Renewal date
   - Manage actions:
     - During trial: "Add payment method" → Stripe → adds card so trial converts to paid
     - On paid plan: "Update payment method" / "Cancel subscription"
     - On Free: nothing here, just shows current state

3. **Plan comparison table** (only shown if user can change plan)
   - 3 columns: Free, Lite ($7), Pro ($15)
   - Rows: bank connections, AI access, daily ritual, workspace sharing, manual entry, CSV import
   - Per-column CTA:
     - Current plan: "Current plan" (disabled-style)
     - Lower plan: "Downgrade" (secondary)
     - Higher plan: "Upgrade" (primary) → triggers Stripe checkout

4. **Billing history** (collapsed/expandable)
   - Table: date, amount, status (paid/failed/refunded), invoice download (PDF)
   - Empty: "No invoices yet"

5. **FAQ / Help links**
   - "What happens when my trial ends?"
   - "Can I get a refund?"
   - "How do I cancel?"
   - Link to support contact

**Tier-specific behaviors:**

- **Trial active**: Big banner — "You're on Pro trial. N days left. Add a card to keep Pro after {date}." → Stripe customer portal flow
- **Free (post-trial)**: "Your trial ended. Connect a bank again by upgrading to Lite or Pro." with comparison table prominent
- **Lite or Pro**: Comparison shows the user's tier highlighted; the other two have actionable CTAs

**Stripe integration UX:**
- Upgrade/downgrade button → opens Stripe Checkout in new tab (or hosted page in same tab)
- On return, redirect back to `/settings/plan?status=success` (or `?status=cancel`)
- Page polls subscription status after return to reflect new state

**Mobile app reference:**
- A small footnote: "Subscriptions purchased through the iOS/Android app are managed in the App Store / Google Play, not here."

**Designer notes:**
- Don't mention IAP pricing here (Apple compliance — Reader app).
- Comparison table is the heart of the page. Designer should make tier choice obvious and low-pressure.
- "Cancel subscription" should feel like a normal action, not buried — Stripe requires easy cancellation.

---

### 4.5 Account — `/settings/account` *(NEW)*

**Purpose:** Edit personal profile, change password, manage sessions, delete account.

**Sections:**

1. **Page header**
   - Title: "Account"

2. **Profile**
   - Avatar (initials or uploaded; v1 = initials only)
   - Name (editable)
   - Email (editable — but requires re-verification via email link; show "Verify new email" flow)
   - Timezone (dropdown, default America/Toronto)
   - Locale (dropdown, English by default; Korean toggle as roadmap allows)
   - "Save" button (or auto-save on blur)

3. **Password**
   - "Change password" — opens modal or expands inline
   - Fields: current password, new password, confirm new password
   - On success: "Password updated. We'll keep you signed in."

4. **Sessions / Connected devices**
   - List of active sessions: device, browser, last active, location (rough — IP-based city)
   - Per-row: "Sign out this device"
   - Bottom: "Sign out everywhere"

5. **Connected accounts** (future-proofing)
   - Google linked (yes/no) — link/unlink (already wired backend-side)

6. **Danger zone**
   - "Sign out" (regular)
   - "Delete account" — opens confirmation flow with typed confirmation, lists what will be deleted (transactions, workspaces I own, etc.)

**Empty states:** Sessions list is never empty (current session always there).

**Designer notes:**
- This is the only page where "Save" semantics matter — most others are immediate-effect.
- Email change is a 2-step flow (request → click link in new email). Show pending state clearly.
- Delete account should be the last visual element on the page, in a muted "danger zone" frame.

---

## 5. Cross-cutting concerns

### 5.1 Tier indicator (global)

A subtle tier badge in the header (or near the workspace switcher) shows the user's current tier at all times:
- FREE = grey pill
- LITE = neutral accent
- TRIAL = warm accent (e.g., amber) with days remaining as tooltip
- PRO = primary brand color

Click → `/settings/plan`.

### 5.2 Trial nudges

- 5 days before trial ends: Top-of-page banner on `/home` and `/settings/banks` (the pages where Plaid value is visible) — "Trial ends in 5 days. Stay on Pro for $15/mo."
- Day of expiry: in-app banner "Your trial ended. Connect a bank by upgrading."
- Post-expiry: persistent (dismissible) banner with upgrade CTA until they upgrade or hide.

### 5.3 Loading states

Every page needs a loading state (data fetches on mount). Use skeletons over spinners where possible — keep layout stable.

### 5.4 Empty states

The web app is opened infrequently and most pages will be **mostly empty** for a new user. Empty-state design is critical:
- Banks: 0 connections
- Workspace: 0 invited members
- Plan: trial state
- Account: 1 session (this one)

Each empty state should have:
- Illustration or icon (low-key)
- One-line headline
- One sentence of explanation
- A primary CTA when applicable

### 5.5 Error states

Three categories:
- **Network/API down**: "Couldn't reach Fina. Check your connection." + Retry
- **Permission denied** (403): "You don't have access to this workspace." (rare — usually the UI hides such actions)
- **Validation**: inline next to the field

Avoid showing raw error codes; map them to friendly copy.

### 5.6 Authentication redirect rules

- Unauthenticated user hits `/home` or any `/settings/*` → redirect to `/sign-in?from=<originalPath>`
- Authenticated user hits `/` → redirect to `/home`
- Authenticated user hits `/sign-in` → stay (allow re-auth/account switch)

### 5.7 Internationalization

- Currency: CAD ($) is the only v1 currency. Format with `Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })`.
- Dates: long form on summary cards ("May 20, 2026"), relative on activity ("2 hours ago").
- Korean UI: roadmap, not v1.

---

## 6. Out of scope for v1 web

Designer should NOT design these — they live on mobile:
- Chat interface
- Daily ritual / morning brief
- Transaction list, edit, split, delete
- Budget UI
- Recurring expenses UI
- Scheduled spend UI
- Push notification preferences
- Receipt OCR / photo upload

Things deferred to v2 web:
- Chat web interface
- Transaction browse on web
- CSV import/export UI
- Multi-currency
- Workspace creation flow (currently auto-created at sign-up only)
- Annual billing

---

## 7. Page inventory checklist (for designer kickoff)

| Page | Status | Priority |
|---|---|---|
| `/` Landing | Skeleton exists, full redesign | P0 |
| `/sign-in` (combined sign-in/sign-up) | Functional, needs visual design | P0 |
| `/forgot-password` | **Not built** | P0 (Auth completeness) |
| `/reset-password` | **Not built** | P0 |
| `/invites/[token]` | Functional, needs visual design | P0 |
| App shell header | Functional, needs visual design | P0 |
| `/home` | Functional, needs visual + content design | P0 |
| `/settings/banks` | Functional, needs visual design | P0 |
| `/settings/workspace` | Functional, needs visual design | P0 |
| `/settings/plan` | **Not built** | P0 |
| `/settings/account` | **Not built** | P1 |

P0 = ship-blocking for web v1 launch. P1 = should ship but not blocking sign-up funnel.

---

## 8. Open questions for product/design alignment

1. **Tier badge placement**: header vs sidebar vs near workspace switcher? Recommend header.
2. **Marketing vs. dashboard separation**: landing page is the only marketing surface today. Do we plan a separate `/pricing`, `/features`, `/about`? Or keep all on landing? Recommend landing-only for v1, extract later.
3. **Korean copy**: when does the Korean version ship? Affects font choice (CJK fallback) and line-height defaults.
4. **App Store / Google Play badges on landing**: hardcoded for v1 even though the apps aren't published yet? Or hidden until shipped? Recommend hidden until both apps are at least in beta.
5. **OAuth providers**: Google is wired backend-side. Show on sign-in form for v1? Recommend yes — even a single "Continue with Google" button.
6. **Workspace name editing**: inline edit vs. modal? Designer's call.
7. **Account deletion**: hard-delete vs. soft-delete with grace period? Recommend soft-delete with 30-day grace (per PIPEDA best practices), but this is a product decision.
