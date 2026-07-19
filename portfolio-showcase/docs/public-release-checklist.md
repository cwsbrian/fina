# Public Release Checklist

Use this checklist on the final standalone repository, not only on the private source workspace. Repeat it whenever screenshots or architecture details change.

## Content and Evidence

- [ ] Every product and technology claim is supported by the private repository.
- [ ] Implemented, planned, prototype, and unverified behavior are clearly distinguished.
- [ ] No user counts, revenue, performance, scale, coverage percentage, launch date, certification, or business outcome is claimed without publishable evidence.
- [ ] Engineering scope is described neutrally unless individual authorship can be proven.
- [ ] No unreleased product information, internal roadmap dates, confidential pricing, or private operating metrics are included.
- [ ] The showcase is understandable without access to production source or private design documents.

## Secrets and Credentials

- [ ] No API keys, access tokens, refresh tokens, passwords, session cookies, webhook secrets, signing secrets, certificates, private keys, or database credentials are present.
- [ ] No `.env`, `.env.*`, credential export, keystore, provisioning profile, service-account file, or secret-bearing log is included.
- [ ] Environment variable names are included only when they add public value; all values are omitted.
- [ ] Git history is scanned for secrets, not only the current working tree.
- [ ] Example commands use obvious placeholders rather than production-looking values.

## URLs and Internal Identifiers

- [ ] No private URL, internal hostname, raw server address, local-network address, database connection string, tunnel address, or webhook endpoint is present.
- [ ] No bundle identifier, team ID, app-store account ID, cloud project ID, database ID, organization ID, OAuth client ID, analytics key, or provider resource ID is present.
- [ ] No private email address, support recipient, test account, developer username, local filesystem path, or repository access URL is present.
- [ ] Evidence paths name only general source locations and do not disclose secrets or sensitive route details.

## Personal and Financial Data

- [ ] No real name, email, profile photo, bank name tied to a person, account suffix, transaction, merchant history, budget, goal, conversation, receipt, device token, or support attachment is present.
- [ ] Demonstration content is synthetic and visibly realistic without matching a real person.
- [ ] Dates and amounts in examples cannot be combined to identify a real account or household.
- [ ] Logs and debug payloads are excluded even if obvious secrets appear redacted.

## Screenshots and Media

- [ ] Every screenshot follows the redaction guidance in [`assets/README.md`](../assets/README.md).
- [ ] Status bars, notification banners, browser profiles, bookmarks, tabs, developer menus, QR codes, and background windows have been reviewed.
- [ ] Screens show synthetic accounts, transactions, names, email addresses, goals, and conversations.
- [ ] Image metadata has been removed or inspected for personal paths and device information.
- [ ] Alt text and captions describe the product without exposing hidden identifiers.
- [ ] No production screen recording or image is published without frame-by-frame review.

## Database and Security Detail

- [ ] No full schema, migration, table dump, internal ID format, token format, provider payload, or security-sensitive field list is included.
- [ ] Public data diagrams use generalized entities and omit internal identifiers, indexes, secrets, audit payloads, and defensive thresholds.
- [ ] Authentication and authorization are described at a boundary level without publishing bypass-relevant implementation detail.
- [ ] No security certification, penetration-test result, or compliance statement is implied.
- [ ] Encryption, rate limiting, webhook verification, and logging claims match implemented behavior and remain high level.

## Proprietary Code and Assets

- [ ] No production source, copied function body, prompt text, proprietary query, configuration file, migration SQL, or large code excerpt is included.
- [ ] No private design export, paid asset, provider dashboard capture, or third-party logo is included without publication rights.
- [ ] Only documentation written for the showcase and approved media are present.
- [ ] A repository license has been selected deliberately; it applies to the public documentation and assets, not the private production source.
- [ ] Third-party names are used descriptively and not in a way that implies endorsement.

## Repository Quality

- [ ] All relative links resolve after copying `portfolio-showcase` to the root of the public repository.
- [ ] All Mermaid blocks render in GitHub and remain readable on narrow screens.
- [ ] No Mermaid node exposes internal hostnames, IDs, route names, or private class names.
- [ ] Markdown headings have a consistent hierarchy and every file renders correctly in GitHub preview.
- [ ] Placeholder screenshot comments are either replaced with reviewed media or left clearly marked as placeholders.
- [ ] The public repository contains no ignored, hidden, generated, temporary, editor, build, or operating-system files.
- [ ] A fresh clone contains everything needed to read the showcase without broken local references.

## Suggested Pre-Publish Commands

Run equivalent tools available in the publishing environment:

```sh
# Review exactly what will be published.
git status --short
git diff --check
git ls-files

# Check Markdown links and secrets with the team's approved scanners.
# Examples: markdown-link-check, gitleaks, or trufflehog.

# Render each Mermaid block in GitHub preview or a compatible Mermaid CLI.
```

Do not paste scanner output containing a discovered secret into an issue or pull request. Rotate a real exposed credential before continuing, then remove it from the working tree and history as required.

## Recommended GitHub Repository Settings

- [ ] Set repository visibility to **Public** only after this checklist passes.
- [ ] Add a clear description such as: “Public product and architecture showcase for Fina; production source is private.”
- [ ] Disable Issues unless public feedback and triage are desired.
- [ ] Enable Discussions only if there is a plan to moderate and answer questions.
- [ ] Disable the Wiki unless it has a defined documentation purpose.
- [ ] Do not add production deployment secrets, environments, webhooks, or provider credentials.
- [ ] Protect the default branch if more than one contributor will publish changes.
- [ ] Add a reviewed social preview image that contains no private data or unsupported claims.
- [ ] Use relevant topics such as `portfolio`, `architecture`, `fintech`, `react-native`, `nextjs`, `fastify`, `postgresql`, and `ai-assistant`.
- [ ] Add the selected documentation license and a short contribution policy if external contributions are accepted.
