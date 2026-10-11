/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Renderer-safe constants. Never import main-process crypto into the renderer.
export const EXCHANGE_PREFIX = "[VCKX1:";
export type EncryptionMethod = "shared" | "automatic" | "password";
