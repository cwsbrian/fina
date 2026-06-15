import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  HERO_FRAME_COUNT,
  HERO_FRAME_END_SECONDS,
  HERO_FRAME_SOURCES,
  HERO_FRAME_START_SECONDS,
  heroFrameForProgress,
} from "./hero-frames";
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
    expect(html).toContain('data-hero-sequence-frame="true"');
    expect(html).toContain(`src="${HERO_FRAME_SOURCES[0]}"`);
  });

  it("uses a WebP image sequence cut from seconds 6 through 10 of the hero video", () => {
    expect(HERO_FRAME_START_SECONDS).toBe(6);
    expect(HERO_FRAME_END_SECONDS).toBe(10);
    expect(HERO_FRAME_COUNT).toBe(48);
    expect(HERO_FRAME_SOURCES).toHaveLength(HERO_FRAME_COUNT);
    expect(HERO_FRAME_SOURCES[0]).toBe(
      "/landing/hero-sequence/hero-0001.webp",
    );
    expect(HERO_FRAME_SOURCES[HERO_FRAME_SOURCES.length - 1]).toBe(
      "/landing/hero-sequence/hero-0048.webp",
    );
    expect(HERO_FRAME_SOURCES.every((src) => src.endsWith(".webp"))).toBe(true);
  });

  it("maps scrub progress to a clamped hero frame index", () => {
    expect(heroFrameForProgress(-1)).toBe(0);
    expect(heroFrameForProgress(0)).toBe(0);
    expect(heroFrameForProgress(0.5)).toBe(24);
    expect(heroFrameForProgress(1)).toBe(47);
    expect(heroFrameForProgress(2)).toBe(47);
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
    expect(source).toContain("heroFrameForProgress");
    expect(source).toContain("data-hero-sequence-frame");
    expect(source).toContain("gsap.timeline");
    expect(source).toContain("scrollTrigger");
    expect(source).toContain("pin: true");
    expect(source).toContain("scrub: 0.8");
    expect(source).toContain("scrub: 0.65");
    expect(source).toContain("scrub: 0.35");
    expect(source).toContain("window.innerHeight * 0.82");
    expect(source).toContain("scale: 1.045");
    expect(source).toContain("y: -340");
    expect(source).toContain("duration: 1");
    expect(source).toContain('{ xPercent: -50, y: 0 }');
    expect(source).toContain('{ xPercent: -50, y: -340, duration: 1, ease: "none" }');
    expect(source).not.toContain('[data-gsap="hero-copy"] > *');
    expect(source).not.toContain('{ y: -180, duration: 0.32, ease: "none" }');
    expect(source).not.toContain("{ y: 0, autoAlpha: 1 }");
    expect(source).not.toContain("autoAlpha: 0.08");
    expect(source).not.toContain("autoAlpha: 0, y: 22");
    expect(source).toContain("scale: 1.04");
    expect(source).toContain("y: -64");
    expect(source).toContain("ScrollTrigger.batch");
    expect(source).not.toContain("document.querySelector");
    expect(source).not.toContain("gsap.defaults");
    expect(source).not.toContain("y: 120");
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
    expect(source).toContain("{ xPercent: -50, y: 0 }");
  });

  it("uses compositor-friendly GSAP CSS hints", () => {
    const css = readFileSync(join(__dirname, "page.module.css"), "utf8");

    expect(css).toContain('[data-gsap="hero-art"]');
    expect(css).toContain('[data-gsap="hero-copy"]');
    expect(css).not.toContain('[data-gsap="hero-copy"] > *');
    expect(css).toContain('[data-gsap="reveal"]');
    expect(css).toContain('[data-gsap-scrub="mock"]');
    expect(css).toContain('[data-gsap-scrub="safe-art"]');
    expect(css).toContain('[data-gsap-scrub="price-card"]');
    expect(css).toContain("will-change: transform, opacity;");
  });

  it("renders the hero sequence as an edge-to-edge fullscreen scene", () => {
    const css = readFileSync(join(__dirname, "page.module.css"), "utf8");

    expect(css).toContain("min-height: 100dvh;");
    expect(css).toContain("height: 100dvh;");
    expect(css).toContain("object-fit: cover;");
    expect(css).toContain(".landing :global(.hero-fade)");
    expect(css).toContain("position: absolute;");
    expect(css).toContain("inset: auto 0 0;");
    expect(css).toContain("position: absolute;\n  left: 50%;");
    expect(css).toContain("transform: translateX(-50%);");
    expect(css).toContain("max-width: min(760px, calc(100% - 48px));");
    expect(css).not.toContain("object-fit: contain;");
    expect(css).not.toContain("margin-top: -90px;");
    expect(css).not.toContain("margin-top: -62px;");
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
