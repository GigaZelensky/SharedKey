/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findComponentByCodeLazy, findComponentLazy } from "@webpack";

// Use the components behind Discord's own attachments, with their native CSS,
// icon selection, size formatting and image hit areas. No custom download overlay.
export const NativeFile = findComponentByCodeLazy("renderAdjacentContent:", "fileSize:", "fileName:");
export const NativeImage = findComponentByCodeLazy("imageContainerStyle:", "mosaicStyleAlt:");
export const NativeMediaPlayer = findComponentLazy(component => typeof component === "function" && component?.Types?.AUDIO && component?.Types?.VIDEO);
