"use client";

import React, { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(useGSAP, ScrollTrigger);

type LandingAnimationsProps = {
  children: React.ReactNode;
  className: string | undefined;
};

export function LandingAnimations({
  children,
  className,
}: LandingAnimationsProps) {
  const rootRef = useRef<HTMLElement | null>(null);

  useGSAP(
    () => {
      const root = rootRef.current;

      if (!root) {
        return;
      }

      const select = gsap.utils.selector(root);
      const mm = gsap.matchMedia();

      mm.add("(prefers-reduced-motion: reduce)", () => {
        gsap.set(select("[data-gsap], [data-gsap-scrub]"), {
          autoAlpha: 1,
          scale: 1,
          y: 0,
          clearProps: "all",
        });
      });

      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const heroSection = select('[data-gsap-scrub="hero"]');
        const heroArt = select('[data-gsap="hero-art"]');
        const heroCopy = select('[data-gsap="hero-copy"] > *');
        const revealItems = select('[data-gsap="reveal"]:not([data-gsap-scrub])');
        const mockRows = select('[data-gsap="mock-row"]');
        const scrubSections = select('[data-gsap-scrub="section"]');
        const safeSection = select('[data-gsap-scrub="safe"]');
        const safeArt = select('[data-gsap-scrub="safe-art"]');
        const priceCards = select('[data-gsap-scrub="price-card"]');
        const createdTriggers: ScrollTrigger[] = [];

        const intro = gsap.timeline({
          defaults: { duration: 0.72, ease: "power2.out" },
        });

        intro
          .fromTo(heroArt, { scale: 1.035 }, { scale: 1, duration: 1.35 }, 0)
          .fromTo(
            heroCopy,
            { autoAlpha: 0, y: 22 },
            {
              autoAlpha: 1,
              y: 0,
              stagger: 0.08,
              clearProps: "transform,opacity,visibility",
            },
            0.12,
          );

        const heroTrigger = heroSection[0];

        if (heroTrigger && heroArt.length) {
          gsap
            .timeline({
              scrollTrigger: {
                trigger: heroTrigger,
                start: "top top",
                end: "bottom top",
                scrub: 1,
              },
            })
            .to(heroArt, { scale: 0.9, y: 120, ease: "none" }, 0)
            .to(heroCopy, { y: -72, autoAlpha: 0.52, ease: "none" }, 0);
        }

        scrubSections.forEach((section) => {
          const scrubMock = section.querySelector('[data-gsap-scrub="mock"]');

          if (!scrubMock) {
            return;
          }

          gsap.fromTo(
            scrubMock,
            { y: 96, scale: 0.92, autoAlpha: 0.72 },
            {
              y: -64,
              scale: 1.04,
              autoAlpha: 1,
              ease: "none",
              scrollTrigger: {
                trigger: section,
                start: "top 88%",
                end: "bottom 18%",
                scrub: 0.8,
              },
            },
          );
        });

        const safeTrigger = safeSection[0];

        if (safeTrigger && safeArt.length) {
          gsap.fromTo(
            safeArt,
            { y: -72, scale: 1.14 },
            {
              y: 72,
              scale: 1.02,
              ease: "none",
              scrollTrigger: {
                trigger: safeTrigger,
                start: "top bottom",
                end: "bottom top",
                scrub: 0.65,
              },
            },
          );
        }

        priceCards.forEach((card) => {
          gsap.fromTo(
            card,
            { y: 84, scale: 0.94, autoAlpha: 0.76 },
            {
              y: -28,
              scale: 1,
              autoAlpha: 1,
              ease: "none",
              scrollTrigger: {
                trigger: card,
                start: "top 92%",
                end: "bottom 48%",
                scrub: 0.65,
              },
            },
          );
        });

        if (revealItems.length) {
          gsap.set(revealItems, { autoAlpha: 0, y: 28 });

          createdTriggers.push(
            ...ScrollTrigger.batch(revealItems, {
              start: "top 86%",
              once: true,
              onEnter: (batch) => {
                gsap.to(batch, {
                  autoAlpha: 1,
                  y: 0,
                  duration: 0.75,
                  ease: "power2.out",
                  stagger: 0.08,
                  overwrite: true,
                  clearProps: "transform,opacity,visibility",
                });
              },
            }),
          );
        }

        if (mockRows.length) {
          gsap.set(mockRows, { autoAlpha: 0, y: 14 });

          createdTriggers.push(
            ...ScrollTrigger.batch(mockRows, {
              start: "top 90%",
              once: true,
              interval: 0.08,
              batchMax: 6,
              onEnter: (batch) => {
                gsap.to(batch, {
                  autoAlpha: 1,
                  y: 0,
                  duration: 0.55,
                  ease: "power2.out",
                  stagger: 0.045,
                  overwrite: true,
                  clearProps: "transform,opacity,visibility",
                });
              },
            }),
          );
        }

        return () => {
          createdTriggers.forEach((trigger) => trigger.kill());
        };
      });

      return () => mm.revert();
    },
    { scope: rootRef },
  );

  return (
    <main ref={rootRef} className={className} data-gsap-root>
      {children}
    </main>
  );
}
