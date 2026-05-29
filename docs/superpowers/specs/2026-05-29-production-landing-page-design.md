# Fina Production Landing Page Design

**Date:** 2026-05-29  
**Status:** Design approved  
**Owner:** Brian  
**Scope:** Launch-ready production landing page for Fina web

## 1. Goal

Build a launch-ready production landing page for Fina. This is not a waitlist
replacement. It is the homepage that can ship with the product launch and
support real conversion into signup, trial, plan education, and paid upgrade.

The page should feel like a portfolio-level GSAP site in the spirit of
high-end reference sites such as Fifth & Dune and Fame Estate, while remaining
specific to Fina's domain: personal finance, AI guidance, and calm clarity.

Primary outcome:

- A visitor understands that Fina turns everyday money anxiety into a clear
  next step.
- A visitor sees enough product proof to trust the app.
- A visitor understands the Free, Lite, and Pro plan model.
- A visitor is guided toward signup, which starts a Pro trial immediately.

## 2. Positioning

Fina should be positioned as an AI money companion, not as a licensed financial
advisor or a generic budgeting app.

Preferred public language:

- AI money companion
- Chat-first personal finance app
- Money companion for everyday decisions
- Helps you understand your spending and decide what to do next

Avoid:

- Claims that imply licensed investment, tax, legal, or securities advice
- Guaranteed savings or guaranteed financial outcomes
- Messaging that says Fina replaces a professional advisor

## 3. Creative Direction

The approved creative direction is **Calm Data Cinema**.

The page opens like a controlled cinematic system: dark, precise, quiet, and
premium. Financial fragments move through the page as visual material:
transactions, balances, calendar blocks, categories, recurring charges, goals,
and chat answers. The animation should make money feel less noisy and more
legible.

The page can borrow choreography from portfolio GSAP sites, but it should not
copy their domain language. Fina is not luxury real estate. The visual language
should be more like a premium financial intelligence system: calm, exact, and
human.

## 4. Narrative Arc

The page follows a three-act structure.

### Act 1: Cinematic Problem to Relief

This is the GSAP showpiece section.

1. **Preloader**  
   Short data-organizing loader. Scattered money fragments briefly assemble,
   then the Fina wordmark lands.

2. **Pinned Hero**  
   Lead with the emotional question: "Am I okay this month?" Bank-noise data
   fragments move behind the headline.

3. **Month in Motion**  
   A pinned scroll scrub visualizes a month: payday, bills, subscriptions,
   surprises, goals, and remaining runway.

4. **Organize**  
   Transaction fragments collapse into categories, recurring spend, anomalies,
   and goals. The chaos resolves into structure.

5. **Fina Answers**  
   Product/chat UI appears for the first time and gives a calm answer that
   explains what changed and what to do next.

### Act 2: Product Proof

The page becomes more concrete and less theatrical. The animation remains
polished, but content clarity matters more than spectacle.

Sections:

- Connected accounts
- AI chat/advisor
- Recurring spend and budget insights
- Goals and planning
- Security and trust

The product proof sections should make Act 1's abstract motion legible. If Act
1 showed a recurring charge as a moving data object, Act 2 explains how Fina
detects recurring spend and helps users respond.

### Act 3: Pricing to Conversion

Pricing is a first-class launch-page section, not a footer afterthought.

The pricing section educates users on what happens after the Pro trial and helps
them understand the plan ladder.

Current plan model:

- **Free:** entry-level experience, manual entry / limited use
- **Lite:** `$7 CAD/mo`, up to 2 connected bank items, read-oriented money
  ritual
- **Pro:** `$15 CAD/mo`, up to 5 connected bank items, AI chat/advisor, plan
  generation, deeper audits

These values should be sourced from `@fina/shared` where possible:

- `libs/shared/src/pricing.ts`
- `libs/shared/src/tier.ts`

## 5. Conversion Model

The main CTA is **Start your Pro trial**.

Rationale: signup immediately starts a Pro trial, so the page should not force
visitors into plan-selection work before they have experienced the product's
core promise.

CTA model:

- Hero primary CTA: `Start your Pro trial`
- Header secondary CTA: `Sign in`
- Product proof CTA: `Try Fina free`
- Pricing CTAs:
  - Free: `Start free`
  - Lite: `Choose Lite after trial`
  - Pro: `Start Pro trial`
- Final CTA: `Start your Pro trial`

Pricing should support the trial conversion instead of interrupting it. The
page should explain that users can continue on Free, Lite, or Pro after the
trial.

## 6. App Showcase

The app should have one or two premium physical moments. Code-native data
motion alone is not enough for a production launch page because the product
needs to feel tangible.

Approved showcase approach:

1. **Short 3D phone reveal**  
   A dimensional phone/app shot appears during the transition from organized
   data to Fina's answer.

2. **Exploded UI layers**  
   The app UI separates into contextual layers: transactions, recurring spend,
   goals, and chat answer. These layers demonstrate that Fina understands
   financial context, not just isolated transactions.

Implementation options:

- First production version: GSAP + CSS 3D transforms + DOM/SVG UI layers
- Premium enhancement: Three.js phone scene or a short 40-80 frame WebP/AVIF
  sequence for a single product shot

Full-page pre-rendered frame sequences are out of scope for the first build.
GSAP should choreograph the full page, but most objects should remain editable
as code-native elements.

## 7. Technical Architecture

The web app uses Next.js App Router. The landing page should live at the root
homepage and be split into clear scene components.

Proposed structure:

```txt
apps/web/src/app/page.tsx
apps/web/src/app/landing/
  LandingPage.client.tsx
  landing.module.css
  data.ts
  scenes/
    Preloader.tsx
    HeroScene.tsx
    MonthScene.tsx
    OrganizeScene.tsx
    AppShowcaseScene.tsx
    ProductProof.tsx
    Pricing.tsx
    FinalCta.tsx
  animation/
    useGsapTimeline.ts
    reducedMotion.ts
    splitText.ts
```

GSAP should be loaded only on the client side. Server-rendered markup should
remain meaningful and readable before animation initializes.

Animation responsibilities:

- `LandingPage.client.tsx` owns section refs and timeline registration.
- Scene components own markup and static visual structure.
- Animation helpers own timeline creation, cleanup, reduced-motion decisions,
  and text splitting.
- Pricing data should come from shared constants instead of duplicated literals.

## 8. Motion System

Use GSAP and ScrollTrigger for the main choreography:

- Pinned hero scenes
- Scroll-scrubbed month timeline
- Data fragments moving, clustering, and resolving
- Headline transitions
- Section reveal transitions
- App showcase reveal and exploded UI layers

Use code-native objects for most animation material:

- DOM elements for transaction cards, category chips, labels, and pricing cards
- SVG for paths, orbit lines, simple charts, and connection lines
- CSS 3D transforms for first-pass phone depth

Use frame sequences only as a premium enhancement for one contained app
showcase scene, if needed.

## 9. Accessibility and Performance

The page must include a reduced-motion path.

For users with `prefers-reduced-motion`, pinned scrub sequences should become
static sections with simple fades or no animation. Content and CTAs must remain
fully accessible.

Performance constraints:

- Avoid full-page image frame sequences.
- Keep the phone/3D showcase isolated to one scene.
- Use responsive image formats for any bitmap assets.
- Avoid blocking the first contentful paint on GSAP initialization.
- Test desktop and mobile layouts, including small phones.

The page should remain usable if animation initialization fails.

## 10. Testing and Verification

Minimum verification:

- `pnpm nx run web:typecheck`
- Desktop Playwright screenshot
- Mobile Playwright screenshot
- Reduced-motion screenshot or manual check
- Pricing values checked against shared pricing/tier constants
- CTA routes checked for `/sign-up` and `/sign-in`

Manual visual QA:

- No overlapping text or clipped CTA on mobile
- Pinned sections release correctly
- Scroll restoration and browser back behavior are acceptable
- Pricing section is readable without relying on animation
- The phone/app showcase does not obscure pricing or conversion content

## 11. Out of Scope for First Implementation

- A full-page pre-rendered animation sequence
- Complex custom 3D physics
- User-specific authenticated landing content
- Checkout flow redesign
- New pricing model or tier changes
- Claims requiring legal/financial compliance review beyond conservative
  marketing copy

## 12. Open Implementation Decisions

These should be resolved during implementation planning:

- Whether the first app showcase uses CSS 3D only or Three.js
- Whether any generated bitmap texture is needed for the hero background
- Exact launch copy for hero, product proof, and pricing
- Whether pricing links go directly to `/sign-up` or include plan query params
- Whether the landing should preserve the current simple waitlist page as an
  archived route during development
