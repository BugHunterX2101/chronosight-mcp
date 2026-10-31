"use client";

import { useEffect, useRef } from "react";

// Counts a verified figure up to its final value once it scrolls into view. The text a screen reader
// and a non-JS or reduced-motion visitor get is always the final value, formatted the same way;
// the count is a 600 ms ease-out over the same string, never a different number. It writes to the
// text node React rendered (nodeValue), so React's own reconciliation stays valid.
export function CountUp({ value, digits = 2, className }: { value: number; digits?: number; className?: string }) {
  const el = useRef<HTMLSpanElement>(null);
  const final = value.toFixed(digits);

  useEffect(() => {
    const text = el.current?.firstChild;
    if (text === null || text === undefined) return;
    text.nodeValue = final;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      const t0 = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / 600);
        text.nodeValue = (value * (1 - (1 - k) ** 3)).toFixed(digits);
        if (k < 1) raf = requestAnimationFrame(step);
        else text.nodeValue = final;
      };
      raf = requestAnimationFrame(step);
    });
    io.observe(el.current!);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
      text.nodeValue = final;
    };
  }, [value, digits, final]);

  return (
    <span ref={el} className={className}>
      {final}
    </span>
  );
}
