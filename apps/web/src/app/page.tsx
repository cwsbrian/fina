import type { Metadata } from "next";
import React from "react";
import styles from "./page.module.css";
import { LandingAnimations } from "./LandingAnimations.client";
import { WaitlistForm } from "./WaitlistForm.client";

export const metadata: Metadata = {
  title: "Fina — Your money, finally in conversation",
  description:
    "Fina helps you understand spending, plan the month, and make everyday money decisions through a chat-first companion that knows your real context.",
};

export default function Landing() {
  return (
    <LandingAnimations className={styles.landing}>
      <header className="nav">
        <div className="nav-inner">
          <a className="brand" href="#">
            <img
              src="/branding/fina-wordmark-white.png"
              alt="Fina"
              width="1202"
              height="302"
            />
          </a>
          <nav className="nav-links">
            <a href="#convert">Product</a>
            <a href="#personas">Who it&apos;s for</a>
            <a href="#pricing">Pricing</a>
            <a href="#safe">Security</a>
          </nav>
          <a className="nav-cta" href="#waitlist">
            Join waitlist
          </a>
        </div>
      </header>

      <section className="hero" data-gsap-scrub="hero">
        <div className="hero-art" data-gsap="hero-art">
          <img
            src="/landing/mq18xqya-ChatGPT-Image-Jun-5_-2026_-11_16_57-AM.png"
            alt="Calm morning kitchen ritual with soft garden light through the window"
            width="3840"
            height="1536"
          />
          <div className="hero-fade"></div>
        </div>
        <div className="hero-copy wrap" data-gsap="hero-copy">
          <h1 className="display" style={{ maxWidth: "18ch" }}>
            Your money, finally
            <br />
            in conversation
          </h1>
          <p className="lead" style={{ maxWidth: "70ch" }}>
            Fina helps you understand spending, plan the month, and make
            everyday money decisions through a chat-first companion that knows
            your real context.
          </p>
          <button className="pill-btn">Join waitlist</button>
          <p
            className="fine"
            style={{
              marginTop: "16px",
              fontSize: "13.5px",
              color: "var(--muted)",
            }}
          >
            Opening summer 2026. Early users get a 30-day Pro trial.
          </p>
        </div>
      </section>

 

      <div className="wrap">
        <div className="stats four" data-gsap="reveal">
          <div className="stat">
            <div className="num">30 days</div>
            <div className="lab">Pro trial included</div>
          </div>
          <div className="stat">
            <div className="num">1 chat</div>
            <div className="lab">To understand the month</div>
          </div>
          <div className="stat">
            <div className="num">3 tiers</div>
            <div className="lab">Free, Pro, and Max</div>
          </div>
          <div className="stat">
            <div className="num">Daily</div>
            <div className="lab">Briefs that keep you oriented</div>
          </div>
        </div>
      </div>
      <hr className="rule" style={{ marginTop: "60px", marginBottom: "60px" }} />
      <section className="sec wrap trusted" id="personas" data-gsap="reveal">
        <h2 className="h2">Designed for people who hate budgeting apps.</h2>
        <div className="persona-grid">
          <div className="pcard" data-gsap="reveal">
            <div className="pcard-img">
              <img
                src="/landing/mq19fgqk-ChatGPT-Image-Jun-5_-2026_-11_30_32-AM-_1_.png"
                alt="Bedside table with phone face-down and morning mug"
                loading="lazy"
              />
            </div>
            <div className="pcard-body">
              <h3>The anxious checker</h3>
              <p>
                You open your account only when something feels wrong. Fina
                helps you check earlier, calmly.
              </p>
            </div>
          </div>
          <div className="pcard" data-gsap="reveal">
            <div className="pcard-img">
              <img
                src="/landing/mq19fgsz-ChatGPT-Image-Jun-5_-2026_-11_30_32-AM-_2_.png"
                alt="Kitchen table with two mugs and shared morning notes"
                loading="lazy"
              />
            </div>
            <div className="pcard-body">
              <h3>The busy household</h3>
              <p>
                Shared money needs shared context. Fina helps couples and
                households stay on the same page.
              </p>
            </div>
          </div>
          <div className="pcard" data-gsap="reveal">
            <div className="pcard-img">
              <img
                src="/landing/mq19fgv9-ChatGPT-Image-Jun-5_-2026_-11_30_33-AM-_3_.png"
                alt="Desk with closed laptop and organized notebook"
                loading="lazy"
              />
            </div>
            <div className="pcard-body">
              <h3>The recovering spreadsheet person</h3>
              <p>
                Keep the structure, lose the maintenance. Fina tracks the
                context and lets you steer by chat.
              </p>
            </div>
          </div>
        </div>
      </section>
      <section className="sec wrap" id="convert" data-gsap="reveal">
        <h2 className="h2">
          Budgeting apps show you numbers. Fina helps you decide what to do
          next.
        </h2>
        <p className="lead" style={{ marginTop: "20px", maxWidth: "58ch" }}>
          Most finance apps stop at tracking. Fina is built for the moment after
          the chart: when you need to know what changed, what matters, and
          whether you are okay this month.
        </p>
        <div className="conv-grid">
          <div className="conv-col" data-gsap="reveal">
            <svg
              className="ico"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            >
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            <h3>You forget to check</h3>
            <p>
              Fina brings the important changes to you through a short daily
              brief.
            </p>
          </div>
          <div className="conv-col" data-gsap="reveal">
            <svg
              className="ico"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <h3>Charts do not answer questions</h3>
            <p>
              Ask about spending, bills, goals, or a purchase decision in plain
              language.
            </p>
          </div>
          <div className="conv-col" data-gsap="reveal">
            <svg
              className="ico"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            >
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            <h3>Money context gets scattered</h3>
            <p>
              Transactions, budgets, recurring bills, goals, and shared
              workspaces live in one conversation.
            </p>
          </div>
        </div>
      </section>

      

  
      <section className="safe-section" id="safe" data-gsap-scrub="safe">
        <div className="safe-art" data-gsap-scrub="safe-art">
          <img
            src="/landing/mq19wxd9-ChatGPT-Image-Jun-5_-2026_-11_33_33-AM-_3_.png"
            alt="Painterly kitchen counter with organized papers — private financial context handled with care"
            loading="lazy"
          />
          <div className="safe-scrim"></div>
        </div>
        <div className="safe-inner wrap">
          <div className="safe-content" data-gsap="reveal">
            <h2 className="h2">Built for sensitive money context.</h2>
            <p className="lead">
              Fina treats financial data as private infrastructure. The product
              is designed around secure bank connections, clear permissions, and
              careful handling of personal context.
            </p>
            <div className="safe-points">
              <span>Plaid-connected bank data</span>
              <span>Workspace permissions</span>
              <span>User-controlled access</span>
              <span>No investment, tax, or legal advice</span>
            </div>
            <a className="ghost-btn" href="#waitlist">
              Join waitlist{" "}
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
            </a>
          </div>
        </div>
      </section>

      <section className="feat wrap" data-gsap="reveal" data-gsap-scrub="section">
        <div className="feat-head" data-gsap="reveal">
          <div>
            <span className="eyebrow">Daily brief</span>
            <h2 className="h2">
              Start the day knowing             
              what changed.
            </h2>
            <p className="sub">
              A short morning check-in surfaces new transactions, upcoming
              bills, category drift, and goal progress before money anxiety has
              time to take over.
            </p>
          </div>
          <a className="ghost-btn" href="#waitlist">
            Join waitlist{" "}
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          </a>
        </div>
        <div className="feat-body">
          <div className="mock mock--brief" data-gsap="reveal" data-gsap-scrub="mock">
            <div className="kyb">
              <div className="row hl" data-gsap="mock-row">
                <span className="dot" style={{ background: "#e0eddc" }}>
                  ✓
                </span>{" "}
                Rent cleared yesterday.
              </div>
              <div className="row" data-gsap="mock-row">
                <span className="dot" style={{ background: "#fde7c9" }}>
                  ↑
                </span>{" "}
                Dining is trending $64 above usual.
              </div>
              <div className="row" data-gsap="mock-row">
                <span className="dot" style={{ background: "#d6e6f3" }}>
                  ◷
                </span>{" "}
                Hydro lands Friday.
              </div>
              <div className="row" data-gsap="mock-row">
                <span className="dot" style={{ background: "#dfeede" }}>
                  ◎
                </span>{" "}
                Emergency fund is still on pace.
              </div>
            </div>
          </div>
          <div className="flist">
            <div className="fitem active">
              <div className="ft">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>{" "}
                Morning orientation
              </div>
              <p>
                See what changed overnight — transactions, bills, and category
                drift — in one calm read.
              </p>
            </div>
            <div className="fitem">
              <div className="ft">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <path d="M8 2v4M16 2v4" />
                </svg>{" "}
                Upcoming bills
              </div>
            </div>
            <div className="fitem">
              <div className="ft">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M3 17l6-6 4 4 7-7" />
                </svg>{" "}
                Category drift
              </div>
            </div>
            <div className="fitem">
              <div className="ft">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M8 12l3 3 5-6" />
                </svg>{" "}
                Goal progress
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="feat wrap" data-gsap="reveal" data-gsap-scrub="section">
        <div className="feat-head" data-gsap="reveal">
          <div>
            <span className="eyebrow">Fina chat</span>
            <h2 className="h2">
              Ask the questions your
              
              bank app cannot answer.
            </h2>
            <p className="sub">
              Plain-language answers from your real financial context — not
              generic advice.
            </p>
          </div>
          <a className="ghost-btn" href="#waitlist">
            Join waitlist{" "}
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          </a>
        </div>
        <div className="feat-body">
          <div className="flist">
            <div className="fitem">
              <div className="ft">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M4 7h16M4 12h16M4 17h10" />
                </svg>{" "}
                Spending questions
              </div>
            </div>
            <div className="fitem active">
              <div className="ft">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>{" "}
                Purchase decisions
              </div>
              <p>
                Ask about spending, bills, goals, or a purchase decision in
                plain language.
              </p>
            </div>
            <div className="fitem">
              <div className="ft">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>{" "}
                Payday planning
              </div>
            </div>
            <div className="fitem">
              <div className="ft">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M3 17l6-6 4 4 7-7" />
                </svg>{" "}
                Savings forecasts
              </div>
            </div>
          </div>
          <div className="mock mock--chat" data-gsap="reveal" data-gsap-scrub="mock">
            <div className="inbox">
              <div className="ih">
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>{" "}
                Fina
              </div>
              <div className="ir sel" data-gsap="mock-row">
                <span className="lft">
                  <span className="bullet"></span>Can I still book the trip?
                </span>
              </div>
              <div className="ir" data-gsap="mock-row">
                <span className="lft">
                  <span className="bullet"></span>Why was this week more
                  expensive?
                </span>
              </div>
              <div className="ir" data-gsap="mock-row">
                <span className="lft">
                  <span className="bullet"></span>Move this charge to groceries.
                </span>
              </div>
              <div className="ir" data-gsap="mock-row">
                <span className="lft">
                  <span className="bullet"></span>What should I watch before
                  payday?
                </span>
              </div>
              <div className="ir" data-gsap="mock-row">
                <span className="lft">
                  <span className="bullet"></span>How much can I save this
                  month?
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="feat wrap" data-gsap="reveal" data-gsap-scrub="section">
        <div className="feat-head" data-gsap="reveal">
          <div>
            <span className="eyebrow">Actions</span>
            <h2 className="h2">
              Make changes without
              
              digging through menus.
            </h2>
            <p className="sub">
              Update budgets, goals, and categories from the same conversation.
            </p>
          </div>
          <a className="ghost-btn" href="#waitlist">
            Join waitlist{" "}
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          </a>
        </div>
        <div className="feat-body">
          <div className="mock mock--actions" data-gsap="reveal" data-gsap-scrub="mock">
            <div className="flow">
              <div className="fr" data-gsap="mock-row">
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M4 6h16M4 12h10M4 18h16" />
                </svg>{" "}
                Categorize a transaction.
              </div>
              <div className="fr" data-gsap="mock-row">
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <path d="M8 2v4M16 2v4" />
                </svg>{" "}
                Create or update a budget.
              </div>
              <div className="fr" data-gsap="mock-row">
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M8 12l3 3 5-6" />
                </svg>{" "}
                Add a savings goal.
              </div>
              <div className="fr" data-gsap="mock-row">
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 3v5h5" />
                </svg>{" "}
                Track recurring merchants.
              </div>
              <div className="fr" data-gsap="mock-row">
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>{" "}
                Review upcoming scheduled spend.
              </div>
              <div className="fr" data-gsap="mock-row">
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>{" "}
                Share context with a workspace.
              </div>
            </div>
          </div>
          <div className="flist">
            <div className="fitem">
              <div className="ft">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M4 6h16M4 12h10M4 18h16" />
                </svg>{" "}
                Categorize transactions
              </div>
            </div>
            <div className="fitem active">
              <div className="ft">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <path d="M8 2v4M16 2v4" />
                </svg>{" "}
                Budget updates
              </div>
              <p>Create or update a budget without leaving the conversation.</p>
            </div>
            <div className="fitem">
              <div className="ft">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M8 12l3 3 5-6" />
                </svg>{" "}
                Savings goals
              </div>
            </div>
            <div className="fitem">
              <div className="ft">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                </svg>{" "}
                Shared workspaces
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="pricing wrap" id="pricing" data-gsap="reveal">
        <div className="pricing-head" data-gsap="reveal">
          <h2 className="h2">30-day Pro trial, then choose your pace.</h2>
          <p className="lead">
            Start with the full product during early access. After that, keep
            the version that matches how much help you want from Fina.
          </p>
        </div>
        <div className="price-grid">
          <div className="price-card" data-gsap="reveal" data-gsap-scrub="price-card">
            <div className="tier">Free</div>
            <div className="amt">$0</div>
            <ul>
              <li>Manual transactions</li>
              <li>Category basics</li>
              <li>Workspace sharing</li>
              <li>Basic account view</li>
              <li>Keep your data after trial</li>
            </ul>
          </div>
          <div className="price-card featured" data-gsap="reveal" data-gsap-scrub="price-card">
            <div className="tier">Pro</div>
            <div className="amt">
              $7<span>/mo CAD</span>
            </div>
            <ul>
              <li>Up to 5 connected banks</li>
              <li>Full Fina chat</li>
              <li>Spending recap cards</li>
              <li>Basic budget tracking</li>
              <li>Upcoming recurring spend</li>
              <li>Standard AI usage</li>
            </ul>
          </div>
          <div className="price-card" data-gsap="reveal" data-gsap-scrub="price-card">
            <div className="tier">Max</div>
            <div className="amt">
              $15<span>/mo CAD</span>
            </div>
            <ul>
              <li>Up to 20 connected banks</li>
              <li>Full two-way chat</li>
              <li>Forecasting and goals</li>
              <li>Advanced spending analysis</li>
              <li>Shared household context</li>
              <li>Expanded AI usage</li>
            </ul>
          </div>
        </div>
      </section>



      <section className="waitlist wrap" id="waitlist" data-gsap="reveal">
        <h2 className="h2">Opening in small batches.</h2>
        <p className="lead">
          We are inviting early users gradually so Fina can stay calm, useful,
          and personal while the product grows.
        </p>
        <WaitlistForm />
        <p className="fine">No card required for the early Pro trial.</p>
      </section>
      <p className="disclaimer">
        Fina is an AI money companion. It does not provide licensed investment,
        tax, legal, or securities advice.
      </p>

      <footer>
        <div className="foot-art">
          <img
            src="/landing/mq18xqwf-ChatGPT-Image-Jun-5_-2026_-11_16_53-AM.png"
            alt="Same kitchen at dusk — warm table light and teal evening sky through the window"
            width="3840"
            height="1536"
          />
          <div className="foot-scrim"></div>
        </div>
        <div className="foot-inner">
          <nav className="foot-nav" aria-label="Footer">
            <a href="#convert">Product</a>
            <a href="#personas">Who it&apos;s for</a>
            <a href="#pricing">Pricing</a>
            <a href="#safe">Security</a>
            <a href="#waitlist">Join waitlist</a>
          </nav>
          <div className="foot-bottom">
            © Fina 2026 &nbsp;·&nbsp; <a href="#">Privacy</a> &nbsp;·&nbsp;{" "}
            <a href="#">Terms</a>
          </div>
        </div>
      </footer>
    </LandingAnimations>
  );
}
