/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getIntlMessage } from "@utils/discord";
import { findCssClassesLazy } from "@webpack";
import { Timestamp } from "@webpack/common";

const MessageClasses = findCssClassesLazy("edited", "communicationDisabled", "isSystemMessage");

export function EditedMarker({ timestamp }: { timestamp?: Date | null; }) {
    if (!timestamp) return null;
    return <Timestamp timestamp={timestamp} isEdited isInline={false}>
        <span className={MessageClasses.edited}>{" "}({getIntlMessage("MESSAGE_EDITED")})</span>
    </Timestamp>;
}
