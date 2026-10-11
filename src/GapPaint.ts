/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const paints = new Map<string, string>();
let context: OffscreenCanvasRenderingContext2D | null | undefined;

export function gapPaint(row: HTMLElement, fill: string): string {
    let background = "rgb(0, 0, 0)";
    for (let parent = row.parentElement; parent; parent = parent.parentElement) {
        const color = getComputedStyle(parent).backgroundColor;
        const channels = color.match(/[\d.]+/g)?.map(Number);
        if (channels && (channels.length === 3 || channels[3] === 1)) { background = color; break; }
    }
    const key = `${background}:${fill}`;
    let paint = paints.get(key);
    if (!paint) {
        // Let Chromium do the same alpha quantization as the row background.
        // An opaque strip can overlap its edge without stacking the tint twice.
        context ??= new OffscreenCanvas(1, 1).getContext("2d");
        if (!context) return fill;
        context.fillStyle = background;
        context.fillRect(0, 0, 1, 1);
        context.fillStyle = fill;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
        paint = `rgb(${r}, ${g}, ${b})`;
        if (paints.size >= 256) paints.delete(paints.keys().next().value!);
        paints.set(key, paint);
    }
    return paint;
}
