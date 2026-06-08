import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Landing from "./page";

describe("Landing", () => {
  it("renders an email waitlist form in the final CTA", () => {
    const html = renderToStaticMarkup(<Landing />);

    expect(html).toContain('id="waitlist"');
    expect(html).toContain('type="email"');
    expect(html).toContain('placeholder="you@email.com"');
  });

  it("uses the processed branding asset only in the nav logo", () => {
    const html = renderToStaticMarkup(<Landing />);

    expect(html).toContain('src="/branding/fina-wordmark-white.png"');
    expect(html).not.toContain('src="/branding/fina-hero.png"');
    expect(html).toContain(
      'src="/landing/mq18xqya-ChatGPT-Image-Jun-5_-2026_-11_16_57-AM.png"',
    );
  });

  it("wraps the page with scoped GSAP animation targets", () => {
    const html = renderToStaticMarkup(<Landing />);

    expect(html).toContain("data-gsap-root");
    expect(html).toContain('data-gsap="hero-art"');
    expect(html).toContain('data-gsap="hero-copy"');
    expect(html).toContain('data-gsap="reveal"');
    expect(html).toContain('data-gsap="mock-row"');
  });

  it("marks hero and feature mockups for scroll-synced GSAP animation", () => {
    const html = renderToStaticMarkup(<Landing />);

    expect(html).toContain('data-gsap-scrub="hero"');
    expect(html).toContain('data-gsap-scrub="section"');
    expect(html).toContain('data-gsap-scrub="mock"');
    expect(html).toContain('data-gsap-scrub="safe"');
    expect(html).toContain('data-gsap-scrub="safe-art"');
    expect(html).toContain('data-gsap-scrub="price-card"');
  });

  it("implements GSAP through the React skill patterns", () => {
    const source = readFileSync(
      join(__dirname, "LandingAnimations.client.tsx"),
      "utf8",
    );

    expect(source).toContain('"use client"');
    expect(source).toContain('from "gsap"');
    expect(source).toContain('from "@gsap/react"');
    expect(source).toContain('from "gsap/ScrollTrigger"');
    expect(source).toContain("gsap.registerPlugin(useGSAP, ScrollTrigger)");
    expect(source).toContain("useRef<HTMLElement");
    expect(source).toContain("{ scope: rootRef }");
    expect(source).toContain("gsap.matchMedia()");
    expect(source).toContain("prefers-reduced-motion: reduce");
    expect(source).toContain("gsap.timeline");
    expect(source).toContain("scrollTrigger");
    expect(source).toContain("scrub: 0.8");
    expect(source).toContain("scrub: 0.65");
    expect(source).toContain("scrub: 1");
    expect(source).toContain("scale: 0.9");
    expect(source).toContain("y: 120");
    expect(source).toContain("y: -72");
    expect(source).toContain("scale: 1.04");
    expect(source).toContain("y: -64");
    expect(source).toContain("ScrollTrigger.batch");
    expect(source).not.toContain("document.querySelector");
    expect(source).not.toContain("gsap.defaults");
  });

  it("guards hero scroll animation against reload scroll restoration", () => {
    const source = readFileSync(
      join(__dirname, "LandingAnimations.client.tsx"),
      "utf8",
    );

    expect(source).toContain("window.scrollY > 4");
    expect(source).toContain("ScrollTrigger.refresh()");
    expect(source).toContain("invalidateOnRefresh: true");
    expect(source).toContain("window.cancelAnimationFrame");
    expect(source).toContain("{ y: 0, autoAlpha: 1 }");
  });

  it("uses compositor-friendly GSAP CSS hints", () => {
    const css = readFileSync(join(__dirname, "page.module.css"), "utf8");

    expect(css).toContain('[data-gsap="hero-art"]');
    expect(css).toContain('[data-gsap="reveal"]');
    expect(css).toContain('[data-gsap-scrub="mock"]');
    expect(css).toContain('[data-gsap-scrub="safe-art"]');
    expect(css).toContain('[data-gsap-scrub="price-card"]');
    expect(css).toContain("will-change: transform, opacity;");
  });

  it("declares the GSAP React dependencies for the web app", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    );

    expect(packageJson.dependencies.gsap).toBeTruthy();
    expect(packageJson.dependencies["@gsap/react"]).toBeTruthy();
  });

  it("keeps the white header readable on the bright hero image", () => {
    const css = readFileSync(join(__dirname, "page.module.css"), "utf8");

    expect(css).toContain(".landing :global(header.nav)::before");
    expect(css).toContain("rgba(20, 18, 15, 0.34)");
    expect(css).toContain("background: rgba(255, 255, 255, 0.22)");
  });

  it("includes narrow-screen layout rules for mobile overflow risks", () => {
    const css = readFileSync(join(__dirname, "page.module.css"), "utf8");

    expect(css).toContain("@media (max-width: 640px)");
    expect(css).toContain(".landing :global(.hero-copy)");
    expect(css).toContain(".landing :global(.orbit)");
    expect(css).toContain(".landing :global(.kyb),");
    expect(css).toContain(".landing :global(.waitlist-form)");
  });

  it("keeps a comfortable mobile gutter instead of pinning content to screen edges", () => {
    const css = readFileSync(join(__dirname, "page.module.css"), "utf8");

    expect(css).toContain("padding-left: 24px !important;");
    expect(css).toContain("padding-right: 24px !important;");
    expect(css).toContain("padding: 18px 24px;");
    expect(css).toContain("padding: 64px 24px 68px;");
    expect(css).toContain("padding: 0 24px 34px;");
  });
});
