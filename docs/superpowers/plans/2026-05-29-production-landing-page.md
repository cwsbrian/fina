# Production Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current simple homepage with a launch-ready production landing page that combines GSAP Calm Data Cinema storytelling, app showcase moments, product proof, pricing, and signup conversion.

**Architecture:** Keep `/` as a server-rendered Next.js entry that renders a client landing component. Split the landing into scene components, keep motion setup in focused helpers, lazy-load GSAP on the client, and source pricing values from `@fina/shared`.

**Tech Stack:** Next.js App Router, React 18, CSS Modules, GSAP + ScrollTrigger, Vitest, Playwright screenshots for visual verification.

---

## Scope and Blast Radius

- **Tables/migrations:** None.
- **APIs:** None. CTA links use existing `/sign-up` and `/sign-in` routes.
- **SDK/dependencies:** Add `gsap` to `apps/web/package.json` via pnpm.
- **Auth/tier rules:** No backend changes. Copy assumes signup starts the existing Pro trial.
- **Persistence/rehydration:** No new persistence. Client animation must gracefully initialize after SSR.
- **UI/client assumptions:** Root homepage becomes the production launch landing. Existing simple waitlist form is removed from `/`.
- **Tests:** Add unit tests for landing data/pricing and reduced-motion helper; run web typecheck; run Playwright screenshots after implementation.
- **Acceptance criteria:** Page has cinematic hero, month/organize story, app showcase, product proof, pricing, final CTA, reduced-motion path, mobile layout, and no hard-coded paid plan prices that diverge from shared constants.

## File Structure

- Modify `apps/web/package.json`: add `gsap`.
- Modify `apps/web/src/app/layout.tsx`: update metadata for launch positioning.
- Replace `apps/web/src/app/page.tsx`: render the new landing page.
- Delete or stop using `apps/web/src/app/page.module.css`: old waitlist-only styles are no longer used.
- Create `apps/web/src/app/landing/LandingPage.client.tsx`: top-level client component, refs, scene composition, animation initialization.
- Create `apps/web/src/app/landing/landing.module.css`: all landing styles and responsive/reduced-motion states.
- Create `apps/web/src/app/landing/data.ts`: copy, product proof, nav, scene, and pricing data.
- Create `apps/web/src/app/landing/data.test.ts`: pricing and CTA data tests.
- Create `apps/web/src/app/landing/animation/reducedMotion.ts`: reduced-motion detector.
- Create `apps/web/src/app/landing/animation/reducedMotion.test.ts`: helper tests.
- Create `apps/web/src/app/landing/animation/useLandingGsap.ts`: GSAP dynamic import and ScrollTrigger lifecycle.
- Create `apps/web/src/app/landing/scenes/Preloader.tsx`: data-organizing loader markup.
- Create `apps/web/src/app/landing/scenes/HeroScene.tsx`: pinned hero and bank-noise fragments.
- Create `apps/web/src/app/landing/scenes/MonthScene.tsx`: month-in-motion data timeline.
- Create `apps/web/src/app/landing/scenes/OrganizeScene.tsx`: transaction fragments resolving into insights.
- Create `apps/web/src/app/landing/scenes/AppShowcaseScene.tsx`: CSS 3D phone reveal and exploded UI layers.
- Create `apps/web/src/app/landing/scenes/ProductProof.tsx`: concrete product value sections.
- Create `apps/web/src/app/landing/scenes/Pricing.tsx`: Free/Lite/Pro pricing cards from shared constants.
- Create `apps/web/src/app/landing/scenes/FinalCta.tsx`: final conversion section.

## Task 1: Add GSAP Dependency

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add GSAP to the web package**

Run:

```bash
pnpm --filter @fina/web add gsap
```

Expected: `apps/web/package.json` contains a `gsap` dependency and `pnpm-lock.yaml` updates.

- [ ] **Step 2: Verify dependency install**

Run:

```bash
pnpm --filter @fina/web exec node -e "console.log(require('gsap').gsap ? 'gsap ok' : 'missing')"
```

Expected output:

```txt
gsap ok
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml
git commit -m "chore(web): add gsap"
```

## Task 2: Add Landing Data and Helper Tests

**Files:**
- Create: `apps/web/src/app/landing/data.ts`
- Create: `apps/web/src/app/landing/data.test.ts`
- Create: `apps/web/src/app/landing/animation/reducedMotion.ts`
- Create: `apps/web/src/app/landing/animation/reducedMotion.test.ts`

- [ ] **Step 1: Create landing data**

Create `apps/web/src/app/landing/data.ts`:

```ts
import { PRICING } from "@fina/shared";
import { TIER_LIMITS } from "@fina/shared";

export const SIGN_UP_HREF = "/sign-up";
export const SIGN_IN_HREF = "/sign-in";

export const landingNavItems = [
  { label: "Product", href: "#product" },
  { label: "Pricing", href: "#pricing" },
  { label: "Security", href: "#security" },
] as const;

export const heroCopy = {
  eyebrow: "AI money companion",
  headline: "Know what to do next with your money.",
  question: "Am I okay this month?",
  body:
    "Fina turns accounts, spending, bills, and goals into one calm answer for the month ahead.",
  cta: "Start your Pro trial",
  secondaryCta: "See pricing",
} as const;

export const monthEvents = [
  { label: "Payday", amount: "+$4,820", tone: "positive" },
  { label: "Rent", amount: "-$2,100", tone: "fixed" },
  { label: "Subscriptions", amount: "-$86", tone: "recurring" },
  { label: "Groceries", amount: "-$342", tone: "variable" },
  { label: "Goal transfer", amount: "-$450", tone: "goal" },
] as const;

export const insightGroups = [
  {
    label: "Recurring spend",
    value: "$486",
    detail: "Three subscriptions renewed before payday.",
  },
  {
    label: "Flexible room",
    value: "$620",
    detail: "Safe-to-spend estimate after bills and goals.",
  },
  {
    label: "Goal pace",
    value: "On track",
    detail: "Emergency fund contribution can stay unchanged.",
  },
] as const;

export const appLayers = [
  "Transactions",
  "Recurring spend",
  "Goals",
  "Fina answer",
] as const;

export const productProof = [
  {
    title: "Connect the accounts you actually use",
    body:
      "Fina reads your everyday spending context so you do not have to rebuild your month by hand.",
  },
  {
    title: "Ask what changed",
    body:
      "Chat with Fina about bills, categories, recurring charges, and what is safe to do next.",
  },
  {
    title: "Keep goals in the same conversation",
    body:
      "See whether your month still supports the savings goals you already care about.",
  },
] as const;

export const securityProof = {
  title: "Built for private financial context",
  body:
    "Fina keeps sensitive money context behind authenticated product flows and uses conservative public marketing copy.",
} as const;

export const pricingPlans = [
  {
    key: "free",
    name: "Free",
    price: "$0",
    cadence: "forever",
    description: "Start with manual entry and a lighter money ritual.",
    features: ["Manual entry", "Basic monthly view", "Upgrade when you are ready"],
    cta: "Start free",
    href: SIGN_UP_HREF,
  },
  {
    key: "lite",
    name: "Lite",
    price: PRICING.lite.displayPrice,
    cadence: "CAD / month",
    description: "For read-oriented tracking after your Pro trial.",
    features: [
      `${TIER_LIMITS.lite.plaidItems} connected bank items`,
      "Recurring spend visibility",
      "Daily money ritual",
    ],
    cta: "Choose Lite after trial",
    href: SIGN_UP_HREF,
  },
  {
    key: "pro",
    name: "Pro",
    price: PRICING.pro.displayPrice,
    cadence: "CAD / month",
    description: "For AI guidance, planning, and deeper financial context.",
    features: [
      `${TIER_LIMITS.pro.plaidItems} connected bank items`,
      "AI chat and advisor mode",
      "Plan generation and deeper audits",
    ],
    cta: "Start Pro trial",
    href: SIGN_UP_HREF,
    featured: true,
  },
] as const;
```

- [ ] **Step 2: Create data tests**

Create `apps/web/src/app/landing/data.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PRICING, TIER_LIMITS } from "@fina/shared";
import { pricingPlans, SIGN_IN_HREF, SIGN_UP_HREF } from "./data";

describe("landing data", () => {
  it("uses shared pricing values for paid plans", () => {
    expect(pricingPlans.find((plan) => plan.key === "lite")?.price).toBe(
      PRICING.lite.displayPrice,
    );
    expect(pricingPlans.find((plan) => plan.key === "pro")?.price).toBe(
      PRICING.pro.displayPrice,
    );
  });

  it("uses shared connected-account limits for paid plan feature copy", () => {
    expect(pricingPlans.find((plan) => plan.key === "lite")?.features).toContain(
      `${TIER_LIMITS.lite.plaidItems} connected bank items`,
    );
    expect(pricingPlans.find((plan) => plan.key === "pro")?.features).toContain(
      `${TIER_LIMITS.pro.plaidItems} connected bank items`,
    );
  });

  it("routes all pricing CTAs to signup and preserves the signin route", () => {
    expect(SIGN_UP_HREF).toBe("/sign-up");
    expect(SIGN_IN_HREF).toBe("/sign-in");
    expect(pricingPlans.every((plan) => plan.href === SIGN_UP_HREF)).toBe(true);
  });
});
```

- [ ] **Step 3: Create reduced-motion helper**

Create `apps/web/src/app/landing/animation/reducedMotion.ts`:

```ts
export function prefersReducedMotion(win: Pick<Window, "matchMedia"> | undefined): boolean {
  if (!win || typeof win.matchMedia !== "function") return false;
  return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
```

- [ ] **Step 4: Create reduced-motion tests**

Create `apps/web/src/app/landing/animation/reducedMotion.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { prefersReducedMotion } from "./reducedMotion";

describe("prefersReducedMotion", () => {
  it("returns false without a window object", () => {
    expect(prefersReducedMotion(undefined)).toBe(false);
  });

  it("returns true when the media query matches", () => {
    expect(
      prefersReducedMotion({
        matchMedia: () => ({ matches: true }) as MediaQueryList,
      }),
    ).toBe(true);
  });

  it("returns false when the media query does not match", () => {
    expect(
      prefersReducedMotion({
        matchMedia: () => ({ matches: false }) as MediaQueryList,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 5: Run tests and verify they pass**

Run:

```bash
pnpm --filter @fina/web test -- src/app/landing/data.test.ts src/app/landing/animation/reducedMotion.test.ts
```

Expected: both new test files pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/landing/data.ts apps/web/src/app/landing/data.test.ts apps/web/src/app/landing/animation/reducedMotion.ts apps/web/src/app/landing/animation/reducedMotion.test.ts
git commit -m "test(web): define landing data contracts"
```

## Task 3: Build Static Landing Markup

**Files:**
- Modify: `apps/web/src/app/page.tsx`
- Create: `apps/web/src/app/landing/LandingPage.client.tsx`
- Create: `apps/web/src/app/landing/landing.module.css`
- Create: all scene files under `apps/web/src/app/landing/scenes/`

- [ ] **Step 1: Replace the root page entry**

Replace `apps/web/src/app/page.tsx`:

```tsx
import { LandingPage } from "./landing/LandingPage.client";

export default function HomePage() {
  return <LandingPage />;
}
```

- [ ] **Step 2: Create scene components**

Create `apps/web/src/app/landing/scenes/Preloader.tsx`:

```tsx
import styles from "../landing.module.css";

export function Preloader() {
  return (
    <section className={`${styles.scene} ${styles.preloader}`} aria-label="Fina loading story">
      <div className={styles.preloaderGrid} aria-hidden="true">
        {["+$4,820", "-$2,100", "-$86", "-$342", "-$450", "$620"].map((item) => (
          <span key={item} data-animate="fragment" className={styles.fragment}>
            {item}
          </span>
        ))}
      </div>
      <p className={styles.kicker}>Money noise becomes context</p>
    </section>
  );
}
```

Create `apps/web/src/app/landing/scenes/HeroScene.tsx`:

```tsx
import styles from "../landing.module.css";
import { SIGN_UP_HREF, heroCopy } from "../data";

export function HeroScene() {
  return (
    <section data-landing-scene="hero" className={`${styles.scene} ${styles.darkScene} ${styles.hero}`}>
      <div className={styles.heroFragments} aria-hidden="true">
        {["coffee", "rent", "payday", "subscription", "goal", "groceries"].map((item) => (
          <span key={item} data-animate="fragment" className={styles.fragment}>
            {item}
          </span>
        ))}
      </div>
      <div className={styles.heroContent}>
        <p className={styles.kicker}>{heroCopy.eyebrow}</p>
        <h1>{heroCopy.headline}</h1>
        <p className={styles.heroQuestion}>{heroCopy.question}</p>
        <p className={styles.heroBody}>{heroCopy.body}</p>
        <div className={styles.ctaRow}>
          <a className={styles.primaryCta} href={SIGN_UP_HREF}>
            {heroCopy.cta}
          </a>
          <a className={styles.secondaryCta} href="#pricing">
            {heroCopy.secondaryCta}
          </a>
        </div>
      </div>
    </section>
  );
}
```

Create `apps/web/src/app/landing/scenes/MonthScene.tsx`:

```tsx
import styles from "../landing.module.css";
import { monthEvents } from "../data";

export function MonthScene() {
  return (
    <section data-landing-scene="month" className={`${styles.scene} ${styles.monthScene}`}>
      <div className={styles.sectionIntro}>
        <p className={styles.kicker}>Month in motion</p>
        <h2>Your month is not a spreadsheet. It is a sequence.</h2>
      </div>
      <div className={styles.monthTrack} aria-label="Example monthly cashflow">
        {monthEvents.map((event) => (
          <article
            key={event.label}
            data-animate="month-event"
            className={`${styles.monthEvent} ${styles[event.tone]}`}
          >
            <span>{event.label}</span>
            <strong>{event.amount}</strong>
          </article>
        ))}
      </div>
    </section>
  );
}
```

Create `apps/web/src/app/landing/scenes/OrganizeScene.tsx`:

```tsx
import styles from "../landing.module.css";
import { insightGroups } from "../data";

export function OrganizeScene() {
  return (
    <section data-landing-scene="organize" className={`${styles.scene} ${styles.darkScene}`}>
      <div className={styles.sectionIntro}>
        <p className={styles.kicker}>Organized context</p>
        <h2>Fina turns the noise into things you can act on.</h2>
      </div>
      <div className={styles.insightGrid}>
        {insightGroups.map((insight) => (
          <article key={insight.label} data-animate="insight" className={styles.insightCard}>
            <span>{insight.label}</span>
            <strong>{insight.value}</strong>
            <p>{insight.detail}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
```

Create `apps/web/src/app/landing/scenes/AppShowcaseScene.tsx`:

```tsx
import type { CSSProperties } from "react";
import styles from "../landing.module.css";
import { SIGN_UP_HREF, appLayers } from "../data";

export function AppShowcaseScene() {
  return (
    <section data-landing-scene="app-showcase" className={`${styles.scene} ${styles.appShowcase}`}>
      <div className={styles.sectionIntro}>
        <p className={styles.kicker}>Fina answers</p>
        <h2>All that context becomes one calm next step.</h2>
        <p>
          The app appears only after the data has resolved, so the product feels
          earned instead of decorative.
        </p>
        <a className={styles.primaryCta} href={SIGN_UP_HREF}>
          Start your Pro trial
        </a>
      </div>
      <div className={styles.phoneStage} aria-label="Fina app showcase">
        <div data-animate="phone" className={styles.phone}>
          <div className={styles.phoneTop} />
          <div className={styles.chatBubble}>You are still okay this month.</div>
          <div className={`${styles.chatBubble} ${styles.chatBubbleAccent}`}>
            Keep groceries under $180 and your goal stays on track.
          </div>
        </div>
        {appLayers.map((layer, index) => (
          <span
            key={layer}
            data-animate="app-layer"
            className={styles.appLayer}
            style={{ "--layer-index": index } as CSSProperties}
          >
            {layer}
          </span>
        ))}
      </div>
    </section>
  );
}
```

Create `apps/web/src/app/landing/scenes/ProductProof.tsx`:

```tsx
import styles from "../landing.module.css";
import { productProof, securityProof } from "../data";

export function ProductProof() {
  return (
    <section id="product" className={`${styles.scene} ${styles.productProof}`}>
      <div className={styles.sectionIntro}>
        <p className={styles.kicker}>Product proof</p>
        <h2>Built for everyday money decisions.</h2>
      </div>
      <div className={styles.proofGrid}>
        {productProof.map((item) => (
          <article key={item.title} className={styles.proofCard}>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
          </article>
        ))}
        <article id="security" className={`${styles.proofCard} ${styles.securityCard}`}>
          <h3>{securityProof.title}</h3>
          <p>{securityProof.body}</p>
        </article>
      </div>
    </section>
  );
}
```

Create `apps/web/src/app/landing/scenes/Pricing.tsx`:

```tsx
import styles from "../landing.module.css";
import { pricingPlans } from "../data";

export function Pricing() {
  return (
    <section id="pricing" className={`${styles.scene} ${styles.pricing}`}>
      <div className={styles.sectionIntro}>
        <p className={styles.kicker}>Pricing</p>
        <h2>Start with Pro. Choose how to continue after trial.</h2>
      </div>
      <div className={styles.pricingGrid}>
        {pricingPlans.map((plan) => (
          <article
            key={plan.key}
            className={`${styles.pricingCard} ${plan.featured ? styles.featuredPlan : ""}`}
          >
            <div>
              <h3>{plan.name}</h3>
              <p>{plan.description}</p>
            </div>
            <div className={styles.priceLine}>
              <strong>{plan.price}</strong>
              <span>{plan.cadence}</span>
            </div>
            <ul>
              {plan.features.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
            <a className={plan.featured ? styles.primaryCta : styles.secondaryCta} href={plan.href}>
              {plan.cta}
            </a>
          </article>
        ))}
      </div>
    </section>
  );
}
```

Create `apps/web/src/app/landing/scenes/FinalCta.tsx`:

```tsx
import styles from "../landing.module.css";
import { SIGN_UP_HREF } from "../data";

export function FinalCta() {
  return (
    <section className={`${styles.scene} ${styles.darkScene} ${styles.finalCta}`}>
      <p className={styles.kicker}>Launch access</p>
      <h2>Let Fina make this month easier to read.</h2>
      <a className={styles.primaryCta} href={SIGN_UP_HREF}>
        Start your Pro trial
      </a>
    </section>
  );
}
```

- [ ] **Step 3: Create the landing component**

Create `apps/web/src/app/landing/LandingPage.client.tsx`:

```tsx
"use client";

import { useRef } from "react";
import styles from "./landing.module.css";
import { SIGN_IN_HREF, SIGN_UP_HREF, landingNavItems } from "./data";
import { useLandingGsap } from "./animation/useLandingGsap";
import { AppShowcaseScene } from "./scenes/AppShowcaseScene";
import { FinalCta } from "./scenes/FinalCta";
import { HeroScene } from "./scenes/HeroScene";
import { MonthScene } from "./scenes/MonthScene";
import { OrganizeScene } from "./scenes/OrganizeScene";
import { Preloader } from "./scenes/Preloader";
import { Pricing } from "./scenes/Pricing";
import { ProductProof } from "./scenes/ProductProof";

export function LandingPage() {
  const rootRef = useRef<HTMLElement | null>(null);
  useLandingGsap(rootRef);

  return (
    <main ref={rootRef} className={styles.page}>
      <header className={styles.header}>
        <a className={styles.logo} href="/" aria-label="Fina home">
          Fina
        </a>
        <nav className={styles.nav} aria-label="Landing">
          {landingNavItems.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
        </nav>
        <div className={styles.headerActions}>
          <a href={SIGN_IN_HREF}>Sign in</a>
          <a className={styles.headerCta} href={SIGN_UP_HREF}>
            Start trial
          </a>
        </div>
      </header>
      <Preloader />
      <HeroScene />
      <MonthScene />
      <OrganizeScene />
      <AppShowcaseScene />
      <ProductProof />
      <Pricing />
      <FinalCta />
    </main>
  );
}
```

- [ ] **Step 4: Add base CSS**

Create `apps/web/src/app/landing/landing.module.css`:

```css
.page {
  min-height: 100vh;
  background: var(--color-canvas);
  color: var(--color-ink);
  overflow-x: hidden;
}

.header {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 20;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 24px;
  padding: 22px 40px;
  color: var(--color-on-dark);
  mix-blend-mode: difference;
}

.logo {
  font-size: 22px;
  font-weight: 700;
}

.nav,
.headerActions,
.ctaRow {
  display: flex;
  align-items: center;
  gap: 18px;
}

.nav {
  justify-content: center;
  font-size: 13px;
}

.headerActions {
  justify-content: flex-end;
  font-size: 13px;
}

.headerCta,
.primaryCta,
.secondaryCta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 18px;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 700;
}

.primaryCta {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--color-on-primary);
}

.secondaryCta {
  color: inherit;
}

.scene {
  min-height: 100vh;
  padding: 120px clamp(20px, 5vw, 72px);
  display: grid;
  align-items: center;
  position: relative;
}

.darkScene,
.preloader {
  background: var(--color-surface-dark);
  color: var(--color-on-dark);
}

.preloader {
  min-height: 72vh;
}

.preloaderGrid,
.heroFragments {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.preloaderGrid {
  display: grid;
  grid-template-columns: repeat(3, minmax(120px, 1fr));
  gap: 14px;
  align-content: center;
  padding: 12vw;
}

.kicker {
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.hero {
  min-height: 120vh;
}

.heroContent,
.sectionIntro {
  max-width: 860px;
  display: grid;
  gap: 22px;
  position: relative;
  z-index: 2;
}

.heroContent h1,
.sectionIntro h2,
.finalCta h2 {
  font-size: clamp(48px, 9vw, 124px);
  line-height: 0.94;
  font-weight: 500;
  letter-spacing: 0;
}

.heroQuestion {
  color: var(--color-on-dark-soft);
  font-size: clamp(22px, 3vw, 38px);
}

.heroBody,
.sectionIntro p,
.proofCard p,
.pricingCard p {
  max-width: 620px;
  color: var(--color-body);
  font-size: 17px;
}

.darkScene .heroBody,
.darkScene .sectionIntro p {
  color: var(--color-on-dark-soft);
}

.fragment {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  padding: 0 14px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.72);
  background: rgba(255, 255, 255, 0.05);
}

.heroFragments .fragment {
  position: absolute;
}

.heroFragments .fragment:nth-child(1) { left: 8%; top: 24%; }
.heroFragments .fragment:nth-child(2) { right: 12%; top: 18%; }
.heroFragments .fragment:nth-child(3) { left: 54%; top: 48%; }
.heroFragments .fragment:nth-child(4) { left: 14%; bottom: 20%; }
.heroFragments .fragment:nth-child(5) { right: 18%; bottom: 24%; }
.heroFragments .fragment:nth-child(6) { right: 38%; top: 70%; }

.monthScene {
  background: var(--color-surface-strong);
  gap: 48px;
}

.monthTrack {
  display: flex;
  gap: 18px;
  width: max-content;
  max-width: none;
}

.monthEvent {
  width: min(42vw, 340px);
  min-height: 220px;
  display: grid;
  align-content: space-between;
  padding: 24px;
  background: var(--color-canvas);
  border: 1px solid var(--color-hairline);
}

.monthEvent span {
  color: var(--color-muted);
}

.monthEvent strong {
  font-size: 38px;
}

.positive { border-color: var(--color-primary); }
.fixed { background: var(--color-surface-dark); color: var(--color-on-dark); }
.recurring { border-color: var(--color-soft-blue); }
.variable { border-color: var(--color-accent-yellow); }
.goal { background: var(--color-primary); color: var(--color-on-primary); }

.insightGrid,
.proofGrid,
.pricingGrid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
}

.insightCard,
.proofCard,
.pricingCard {
  min-height: 280px;
  display: grid;
  align-content: space-between;
  gap: 20px;
  padding: 26px;
  border: 1px solid var(--color-hairline);
  background: var(--color-canvas);
  color: var(--color-ink);
}

.insightCard strong,
.priceLine strong {
  font-size: 44px;
  line-height: 1;
}

.appShowcase {
  grid-template-columns: minmax(0, 0.9fr) minmax(320px, 1.1fr);
  gap: clamp(32px, 7vw, 96px);
  background: var(--color-canvas);
}

.phoneStage {
  min-height: 620px;
  position: relative;
  display: grid;
  place-items: center;
  perspective: 1100px;
}

.phone {
  width: 240px;
  min-height: 470px;
  display: grid;
  align-content: start;
  gap: 14px;
  padding: 46px 18px 24px;
  border: 12px solid #0e1514;
  border-radius: 42px;
  background: white;
  box-shadow: 40px 52px 100px rgba(21, 32, 30, 0.24);
  transform: rotateY(-18deg) rotateX(6deg);
  transform-style: preserve-3d;
}

.phoneTop {
  width: 72px;
  height: 8px;
  border-radius: 999px;
  background: var(--color-hairline);
  justify-self: center;
}

.chatBubble {
  padding: 14px;
  border-radius: 18px;
  background: var(--color-surface-soft);
  color: var(--color-ink);
  font-size: 14px;
}

.chatBubbleAccent {
  background: var(--color-primary);
  color: var(--color-on-primary);
}

.appLayer {
  position: absolute;
  left: calc(50% + 80px);
  top: calc(18% + (var(--layer-index) * 90px));
  min-width: 180px;
  padding: 14px 18px;
  border: 1px solid var(--color-hairline);
  background: rgba(255, 255, 255, 0.86);
  box-shadow: var(--shadow-soft);
}

.productProof,
.pricing {
  background: var(--color-canvas);
  gap: 42px;
}

.proofCard h3,
.pricingCard h3 {
  font-size: 28px;
  line-height: 1.08;
}

.securityCard {
  background: var(--color-surface-dark);
  color: var(--color-on-dark);
}

.securityCard p {
  color: var(--color-on-dark-soft);
}

.pricingCard {
  min-height: 420px;
}

.featuredPlan {
  border-color: var(--color-primary);
  box-shadow: 0 24px 80px rgba(62, 179, 139, 0.18);
}

.priceLine {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.pricingCard ul {
  display: grid;
  gap: 10px;
  padding-left: 18px;
  color: var(--color-body);
}

.finalCta {
  min-height: 78vh;
  justify-items: start;
  gap: 24px;
}

@media (prefers-reduced-motion: reduce) {
  .fragment,
  .monthEvent,
  .insightGrid,
  .phone,
  .appLayer {
    transform: none;
    transition: none;
  }
}

@media (max-width: 820px) {
  .header {
    grid-template-columns: 1fr auto;
    padding: 18px 20px;
  }

  .nav {
    display: none;
  }

  .scene {
    min-height: auto;
    padding: 104px 20px;
  }

  .preloader {
    display: none;
  }

  .heroContent h1,
  .sectionIntro h2,
  .finalCta h2 {
    font-size: clamp(44px, 14vw, 68px);
  }

  .monthTrack,
  .insightGrid,
  .proofGrid,
  .pricingGrid,
  .appShowcase {
    display: grid;
    grid-template-columns: 1fr;
    width: 100%;
  }

  .monthEvent {
    width: 100%;
    min-height: 180px;
  }

  .phoneStage {
    min-height: 520px;
    overflow: hidden;
  }

  .appLayer {
    left: 50%;
    transform: translateX(-50%);
    width: min(86vw, 260px);
  }
}
```

- [ ] **Step 5: Run typecheck**

Run:

```bash
pnpm nx run web:typecheck
```

Expected: typecheck passes.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/page.tsx apps/web/src/app/landing
git commit -m "feat(web): add production landing markup"
```

## Task 4: Add GSAP Scroll Choreography

**Files:**
- Create: `apps/web/src/app/landing/animation/useLandingGsap.ts`
- Modify: `apps/web/src/app/landing/LandingPage.client.tsx`
- Modify: `apps/web/src/app/landing/landing.module.css`

- [ ] **Step 1: Implement GSAP hook**

Create `apps/web/src/app/landing/animation/useLandingGsap.ts`:

```ts
import { RefObject, useEffect } from "react";
import { prefersReducedMotion } from "./reducedMotion";

type LandingRoot = HTMLElement;

export function useLandingGsap(rootRef: RefObject<LandingRoot | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || prefersReducedMotion(window)) return;

    let cleanup = () => {};
    let cancelled = false;

    async function init() {
      const gsapModule = await import("gsap");
      const scrollTriggerModule = await import("gsap/ScrollTrigger");
      if (cancelled) return;

      const gsap = gsapModule.gsap;
      const ScrollTrigger = scrollTriggerModule.ScrollTrigger;
      gsap.registerPlugin(ScrollTrigger);

      const ctx = gsap.context(() => {
        gsap.from("[data-animate='fragment']", {
          opacity: 0,
          y: 36,
          stagger: 0.06,
          duration: 0.8,
          ease: "power3.out",
        });

        gsap.to("[data-animate='month-event']", {
          xPercent: -45,
          ease: "none",
          scrollTrigger: {
            trigger: "[data-landing-scene='month']",
            start: "top top",
            end: "+=140%",
            scrub: true,
            pin: true,
          },
        });

        gsap.from("[data-animate='insight']", {
          opacity: 0,
          y: 48,
          stagger: 0.12,
          ease: "power3.out",
          scrollTrigger: {
            trigger: "[data-landing-scene='organize']",
            start: "top 70%",
            end: "center center",
            scrub: true,
          },
        });

        gsap.fromTo(
          "[data-animate='phone']",
          { rotateY: -32, rotateX: 10, y: 80, opacity: 0 },
          {
            rotateY: -12,
            rotateX: 4,
            y: 0,
            opacity: 1,
            ease: "power2.out",
            scrollTrigger: {
              trigger: "[data-landing-scene='app-showcase']",
              start: "top 70%",
              end: "center center",
              scrub: true,
            },
          },
        );

        gsap.from("[data-animate='app-layer']", {
          opacity: 0,
          z: -80,
          y: 40,
          stagger: 0.08,
          ease: "power2.out",
          scrollTrigger: {
            trigger: "[data-landing-scene='app-showcase']",
            start: "top center",
            end: "bottom center",
            scrub: true,
          },
        });
      }, root);

      cleanup = () => ctx.revert();
    }

    void init();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [rootRef]);
}
```

- [ ] **Step 2: Ensure markup has required data attributes**

Run these selector checks:

```bash
rg "data-animate=\"fragment\"" apps/web/src/app/landing/scenes
rg "data-animate=\"month-event\"" apps/web/src/app/landing/scenes
rg "data-animate=\"insight\"" apps/web/src/app/landing/scenes
rg "data-animate=\"phone\"" apps/web/src/app/landing/scenes
rg "data-animate=\"app-layer\"" apps/web/src/app/landing/scenes
rg "data-landing-scene=\"month\"" apps/web/src/app/landing/scenes
rg "data-landing-scene=\"organize\"" apps/web/src/app/landing/scenes
rg "data-landing-scene=\"app-showcase\"" apps/web/src/app/landing/scenes
```

Expected: every command prints at least one matching line. If any command prints
nothing, add the missing attribute exactly as shown in Task 3's component code.
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm nx run web:typecheck
```

Expected: typecheck passes.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/landing
git commit -m "feat(web): choreograph landing scroll scenes"
```

## Task 5: Update Launch Metadata and Remove Waitlist Copy

**Files:**
- Modify: `apps/web/src/app/layout.tsx`
- Modify: `apps/web/src/app/page.tsx`
- Delete if unused: `apps/web/src/app/page.module.css`

- [ ] **Step 1: Update metadata**

Change `apps/web/src/app/layout.tsx` metadata to:

```ts
export const metadata = {
  title: "Fina · AI money companion",
  description:
    "Fina helps you understand your spending, plan your month, and decide what to do next with everyday money.",
  icons: {
    icon: "/images/icon-logo-light.png",
    shortcut: "/images/icon-logo-light.png",
    apple: "/images/icon-logo-light.png",
  },
};
```

- [ ] **Step 2: Remove unused old homepage CSS**

Run:

```bash
rg "page.module.css|styles\\.page|styles\\.headline" apps/web/src/app
```

Expected: no references to `apps/web/src/app/page.module.css`. If no references remain, delete `apps/web/src/app/page.module.css`.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm nx run web:typecheck
```

Expected: typecheck passes.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/layout.tsx apps/web/src/app/page.tsx apps/web/src/app/page.module.css
git commit -m "feat(web): update homepage launch metadata"
```

If `page.module.css` was already deleted in Task 3, omit it from `git add`.

## Task 6: Browser Verification and Polish

**Files:**
- Modify: `apps/web/src/app/landing/landing.module.css`
- Modify: `apps/web/src/app/landing/scenes/HeroScene.tsx`
- Modify: `apps/web/src/app/landing/scenes/MonthScene.tsx`
- Modify: `apps/web/src/app/landing/scenes/AppShowcaseScene.tsx`
- Modify: `apps/web/src/app/landing/scenes/Pricing.tsx`

- [ ] **Step 1: Start the web server**

Run:

```bash
pnpm --filter @fina/web smoke
```

Expected: Next dev server starts at `http://localhost:3100`.

- [ ] **Step 2: Capture desktop screenshot**

Run:

```bash
pnpm exec playwright screenshot --viewport-size=1440,1100 http://localhost:3100 /tmp/fina-landing-desktop.png
```

Expected: screenshot saves successfully.

- [ ] **Step 3: Capture mobile screenshot**

Run:

```bash
pnpm exec playwright screenshot --viewport-size=390,900 http://localhost:3100 /tmp/fina-landing-mobile.png
```

Expected: screenshot saves successfully.

- [ ] **Step 4: Check screenshots**

Open the screenshots and verify:

```txt
/tmp/fina-landing-desktop.png
/tmp/fina-landing-mobile.png
```

Acceptance checks:

- Header links are visible and not overlapping.
- Hero headline and CTA fit on mobile.
- Month and app showcase scenes do not create horizontal page overflow.
- Pricing cards are readable on mobile.
- Final CTA is visible and routes to `/sign-up`.

- [ ] **Step 5: Run final verification**

Run:

```bash
pnpm --filter @fina/web test -- src/app/landing/data.test.ts src/app/landing/animation/reducedMotion.test.ts
pnpm nx run web:typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 6: Commit polish**

```bash
git add apps/web/src/app/landing apps/web/src/app/layout.tsx apps/web/src/app/page.tsx apps/web/src/app/page.module.css
git commit -m "fix(web): polish production landing responsive states"
```

If no polish changes were needed, skip this commit.
