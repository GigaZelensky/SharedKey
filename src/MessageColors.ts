/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function opaqueMessageTint(color: string, opacity: number, row: HTMLElement): string {
    let background = [0, 0, 0];
    for (let parent = row.parentElement; parent; parent = parent.parentElement) {
        const rgb = getComputedStyle(parent).backgroundColor.match(/[\d.]+/g)?.map(Number);
        if (rgb && (rgb.length === 3 || rgb[3] === 1)) { background = rgb.slice(0, 3); break; }
    }
    const hex = /^#[0-9a-f]{6}$/i.test(color) ? color : "#7d52ff";
    const rgb = [1, 3, 5].map((offset, i) => Math.round(parseInt(hex.slice(offset, offset + 2), 16) * opacity + background[i] * (1 - opacity)));
    return `rgb(${rgb.join(", ")})`;
}

export function messageTint(color: string, opacity: number): string {
    const hex = /^#[0-9a-f]{6}$/i.test(color) ? color : "#7d52ff";
    return `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${opacity})`;
}
