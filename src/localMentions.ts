/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function mentionsUser(text: string | undefined, userId: string | undefined): boolean {
    if (!text || !userId || !/^\d+$/.test(userId)) return false;
    // Code and escaped mentions are literal text. Spoiler mentions still count,
    // matching Discord's behavior without revealing the spoiler's contents.
    const visible = text.replace(/```[\s\S]*?```|`[^`\n]*`|\\./g, "");
    return new RegExp(`<@!?${userId}>`).test(visible) || /(^|\s)@(?:everyone|here)\b/.test(visible);
}
