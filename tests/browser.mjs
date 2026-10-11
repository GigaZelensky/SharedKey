import { existsSync } from "node:fs";

export function chromeExecutable() {
    const candidates = [
        process.env.CHROME_PATH,
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ];
    const executable = candidates.find((candidate) => candidate && existsSync(candidate));
    if (!executable) throw new Error("Chrome not found. Set CHROME_PATH to its executable.");
    return executable;
}
