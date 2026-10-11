/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { gapPaint } from "./GapPaint";

// Paint-only strips cover native group gaps. Never rewrite margins, padding,
// heights or scroll offsets: Discord's virtual list owns that geometry.
const managers = new WeakMap<HTMLElement, { acquire(row: HTMLElement): () => void; }>();
export function joinMessageRun(row: HTMLElement): () => void {
    const parent = row.parentElement;
    if (!parent) return () => {};
    let manager = managers.get(parent);
    if (!manager) {
        const rows = new Map<HTMLElement, number>();
        const saved = new Map<HTMLElement, Map<string, [string, string]>>();
        let frame = 0;
        const properties = ["--vc-sharedkey-gap", "--vc-sharedkey-seam", "--vc-sharedkey-gap-fill", "--vc-sharedkey-gap-hover"];
        function reset(element: HTMLElement) {
            const original = saved.get(element);
            if (!original) return;
            original.forEach(([value, priority], property) => {
                if (value) element.style.setProperty(property, value, priority);
                else element.style.removeProperty(property);
            });
            element.classList.remove("vc-sharedkey-run-continuation");
            saved.delete(element);
        }
        function layout() {
            frame = 0;
            for (const element of rows.keys()) {
                const previous = element.previousElementSibling as HTMLElement | null;
                const consecutive = element.classList.contains("vc-sharedkey-row") && previous?.classList.contains("vc-sharedkey-row")
                    && previous.dataset.sharedkeyChannel === element.dataset.sharedkeyChannel
                    && previous.style.getPropertyValue("--vc-sharedkey-color") === element.style.getPropertyValue("--vc-sharedkey-color");
                const gap = consecutive && previous ? Math.max(0, element.getBoundingClientRect().top - previous.getBoundingClientRect().bottom) : 0;
                if (!consecutive) { reset(element); continue; }
                if (!saved.has(element)) saved.set(element, new Map(properties.map(property => [property, [element.style.getPropertyValue(property), element.style.getPropertyPriority(property)]])));
                const values = [
                    `${gap}px`, `${2 / (window.devicePixelRatio || 1)}px`,
                    gapPaint(element, getComputedStyle(element).getPropertyValue("--vc-sharedkey-fill")),
                    gapPaint(element, getComputedStyle(element).getPropertyValue("--vc-sharedkey-hover"))
                ];
                properties.forEach((property, i) => { if (element.style.getPropertyValue(property) !== values[i]) element.style.setProperty(property, values[i]); });
                if (!element.classList.contains("vc-sharedkey-run-continuation")) element.classList.add("vc-sharedkey-run-continuation");
            }
        }
        function schedule() { if (!frame) frame = requestAnimationFrame(layout); }
        const observer = new MutationObserver(schedule);
        observer.observe(parent, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
        const resize = new ResizeObserver(schedule);
        resize.observe(parent);
        manager = { acquire(element) {
            rows.set(element, (rows.get(element) ?? 0) + 1);
            resize.observe(element);
            schedule();
            return () => {
                const count = rows.get(element)! - 1;
                if (count) rows.set(element, count);
                else { rows.delete(element); resize.unobserve(element); reset(element); }
                if (!rows.size) {
                    observer.disconnect(); resize.disconnect(); cancelAnimationFrame(frame);
                    saved.forEach((_original, target) => reset(target)); managers.delete(parent);
                } else schedule();
            };
        } };
        managers.set(parent, manager);
    }
    return manager.acquire(row);
}
