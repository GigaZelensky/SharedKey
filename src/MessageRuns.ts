/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Paint-only strips cover native gaps and final-message spacing. Never rewrite margins, padding,
// heights or scroll offsets: Discord's virtual list owns that geometry.
const managers = new WeakMap<HTMLElement, { acquire(row: HTMLElement): () => void; }>();
export function joinMessageRun(row: HTMLElement): () => void {
    const parent = row.parentElement;
    if (!parent) return () => {};
    let manager = managers.get(parent);
    if (!manager) {
        const rows = new Map<HTMLElement, number>();
        const saved = new Map<HTMLElement, Map<string, [string, string]>>();
        const surfaces = new Map<HTMLElement, HTMLElement>();
        let tailPaint: HTMLSpanElement | undefined;
        let frame = 0;
        const properties = ["--vc-sharedkey-gap", "--vc-sharedkey-gap-top", "--vc-sharedkey-gap-fill", "--vc-sharedkey-body-top", "--vc-sharedkey-body-bottom", "--vc-sharedkey-tail", "--vc-sharedkey-paint-bottom"];
        function reset(element: HTMLElement) {
            if (tailPaint?.parentElement === element) tailPaint.remove();
            const original = saved.get(element);
            if (!original) return;
            original.forEach(([value, priority], property) => {
                if (value) element.style.setProperty(property, value, priority);
                else element.style.removeProperty(property);
            });
            element.classList.remove("vc-sharedkey-run-continuation", "vc-sharedkey-run-end");
            saved.delete(element);
        }
        function layout() {
            frame = 0;
            let end: HTMLElement | undefined;
            // Backgrounds snap in content coordinates, before scrolling and translation.
            let paintOffset = -window.scrollY;
            for (let node: HTMLElement | null = parent; node; node = node.parentElement) {
                if (node !== document.scrollingElement) paintOffset -= node.scrollTop;
                const { transform } = getComputedStyle(node);
                if (transform !== "none") {
                    const matrix = new DOMMatrixReadOnly(transform);
                    if (matrix.m11 === 1 && matrix.m22 === 1 && !matrix.m12 && !matrix.m21) paintOffset += matrix.m42;
                }
            }
            const children = Array.from(parent!.children);
            const lastMessage = children.findLast(child => child.querySelector(":scope > [class*=message_]"));
            for (const element of rows.keys()) {
                const previous = element.previousElementSibling as HTMLElement | null;
                const consecutive = element.classList.contains("vc-sharedkey-row") && previous?.classList.contains("vc-sharedkey-row")
                    && previous.dataset.sharedkeyChannel === element.dataset.sharedkeyChannel
                    && previous.style.getPropertyValue("--vc-sharedkey-color") === element.style.getPropertyValue("--vc-sharedkey-color");
                const bounds = element.getBoundingClientRect();
                const surface = element.querySelector<HTMLElement>(":scope > [class*=message_]") ?? element;
                if (surfaces.get(element) !== surface) {
                    const oldSurface = surfaces.get(element);
                    if (oldSurface && oldSurface !== element) resize.unobserve(oldSurface);
                    surfaces.set(element, surface);
                    if (surface !== element) resize.observe(surface);
                }
                const body = surface.getBoundingClientRect();
                // Absolute offsets start at the row's padding edge, not its outer border.
                const origin = bounds.top + (parseFloat(getComputedStyle(element).borderTopWidth) || 0);
                const previousBody = previous?.querySelector<HTMLElement>(":scope > [class*=message_]") ?? previous;
                const gapTop = consecutive && previousBody ? previousBody.getBoundingClientRect().bottom : body.top;
                const gapBottom = body.top;
                // Match native background snapping before display scaling is applied.
                const snap = (value: number) => Math.round(value - paintOffset) + paintOffset;
                const paintTop = snap(gapTop);
                const gap = consecutive ? Math.max(0, snap(gapBottom) - paintTop) : 0;
                let tail = 0;
                if (element === lastMessage && element.classList.contains("vc-sharedkey-row")) {
                    let spacing = 0;
                    for (let row: Element | null = element; row && !spacing; row = row.previousElementSibling) {
                        const body = row.querySelector(":scope > [class*=message_]");
                        if (body) spacing = Math.max(0, parseFloat(getComputedStyle(body).marginTop) || 0);
                    }
                    spacing ||= parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
                    // Stay inside Discord's existing footer space, preserving scroll geometry.
                    tail = Math.max(0, Math.min(spacing, parent!.getBoundingClientRect().bottom - body.bottom));
                }
                if (!saved.has(element)) saved.set(element, new Map(properties.map(property => [property, [element.style.getPropertyValue(property), element.style.getPropertyPriority(property)]])));
                const values = [
                    `${gap}px`, `${paintTop - origin}px`,
                    getComputedStyle(element).getPropertyValue("--vc-sharedkey-accent-fill") || getComputedStyle(element).getPropertyValue("--vc-sharedkey-fill"),
                    `${body.top - origin}px`, `${body.bottom - origin}px`, `${tail}px`, `${snap(body.bottom) - origin}px`
                ];
                properties.forEach((property, i) => { if (element.style.getPropertyValue(property) !== values[i]) element.style.setProperty(property, values[i]); });
                element.classList.toggle("vc-sharedkey-run-continuation", !!consecutive && gap > 0);
                element.classList.toggle("vc-sharedkey-run-end", tail > 0);
                if (tail > 0) end = element;
            }
            if (end) {
                tailPaint ??= Object.assign(document.createElement("span"), { className: "vc-sharedkey-tail", ariaHidden: "true" });
                if (tailPaint.parentElement !== end || tailPaint !== end.lastElementChild) end.append(tailPaint);
            } else tailPaint?.remove();
        }
        function schedule() { if (!frame) frame = requestAnimationFrame(layout); }
        const observer = new MutationObserver(schedule);
        observer.observe(parent, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
        const resize = new ResizeObserver(schedule);
        resize.observe(parent);
        manager = { acquire(element) {
            rows.set(element, (rows.get(element) ?? 0) + 1);
            resize.observe(element);
            layout();
            return () => {
                const count = rows.get(element)! - 1;
                if (count) rows.set(element, count);
                else { rows.delete(element); resize.unobserve(element); const surface = surfaces.get(element); if (surface && surface !== element) resize.unobserve(surface); surfaces.delete(element); reset(element); }
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
