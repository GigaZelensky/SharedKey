/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { messageTint, opaqueMessageTint } from "./MessageColors";

interface Appearance { enabled: boolean; color: string; }
export function bindComposerAccent(icon: SVGSVGElement, initial: Appearance) {
    let appearance = initial;
    let composer: HTMLElement | null = null;
    let surface: HTMLElement | null = null;
    let watched: HTMLElement | null = null;
    let disposed = false;
    let initialSurface: HTMLElement | null = null;
    let initialFrame = 0;
    const properties = ["--vc-sharedkey-composer-color", "--vc-sharedkey-composer-border", "--vc-sharedkey-composer-fill"];
    function release() {
        cancelAnimationFrame(initialFrame);
        initialFrame = 0;
        initialSurface?.classList.remove("vc-sharedkey-composer-initial");
        initialSurface = null;
        composer?.classList.remove("vc-sharedkey-composer");
        surface?.classList.remove("vc-sharedkey-composer-surface");
        properties.forEach(property => composer?.style.removeProperty(property));
    }
    function sync() {
        if (disposed) return;
        const nextComposer = icon.closest<HTMLElement>('[class*="channelTextArea"]');
        const iconSurface = icon.closest<HTMLElement>('[class*="scrollableContainer"]');
        const nextSurface = iconSurface && nextComposer?.contains(iconSurface) ? iconSurface
            : nextComposer?.querySelector<HTMLElement>('[class*="scrollableContainer"]') ?? nextComposer;
        if (nextComposer !== composer || nextSurface !== surface) {
            release();
            composer = nextComposer;
            surface = nextSurface;
            if (surface) {
                initialSurface = surface;
                surface.classList.add("vc-sharedkey-composer-initial");
            }
        }
        const root = composer?.closest("form") ?? composer?.parentElement ?? icon.parentElement;
        if (root !== watched) {
            observer.disconnect();
            watched = root;
            if (root) observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
        }
        if (!composer || !surface) return;
        // Write only differences so observing React's native class updates cannot
        // create a self-triggering mutation loop.
        if (composer.classList.contains("vc-sharedkey-composer") !== appearance.enabled) composer.classList.toggle("vc-sharedkey-composer", appearance.enabled);
        if (!surface.classList.contains("vc-sharedkey-composer-surface")) surface.classList.add("vc-sharedkey-composer-surface");
        const values = [appearance.color, messageTint(appearance.color, 0.7), opaqueMessageTint(appearance.color, 0.12, composer)];
        properties.forEach((property, i) => { if (composer!.style.getPropertyValue(property) !== values[i]) composer!.style.setProperty(property, values[i]); });
        if (initialSurface === surface && !initialFrame) {
            // A newly mounted/replaced input starts in its saved state. Animate
            // subsequent toggles, rather than fading in from a fabricated off state.
            void getComputedStyle(surface).backgroundColor;
            const mounted = surface;
            initialFrame = requestAnimationFrame(() => {
                initialFrame = 0;
                mounted.classList.remove("vc-sharedkey-composer-initial");
                if (initialSurface === mounted) initialSurface = null;
            });
        }
    }
    const observer = new MutationObserver(sync);
    sync();
    return {
        update(next: Appearance) { appearance = next; sync(); },
        dispose() { disposed = true; observer.disconnect(); release(); }
    };
}
