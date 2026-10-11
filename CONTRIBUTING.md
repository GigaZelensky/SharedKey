# Contributing

Run `npm ci`, `npm test`, `npm run test:browser`, and `npm run format:check` before submitting changes. Plugin source follows Vencord's ESLint rules; run `npm run check:vencord` against the supported checkout.

Keep fixes focused and include a regression case for behavior changes. Prefer Discord's existing UI components over recreating them. Preserve the wire format and retained-key behavior unless the change includes a versioned migration.

Describe what changed, how to reproduce the original problem, and which checks passed. For security issues, use the private reporting route in [SECURITY.md](SECURITY.md).
