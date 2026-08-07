# Store release automation

Fina uses one release-note source for both stores:

`patch-notes/<app-version>.md` → `## App Store — What’s New`

Keep that section at 500 characters or fewer. The release commands use the section exactly as written for both Apple App Store and Google Play.

## Credentials

Credentials stay outside the repository:

- Apple App Store Connect API key: `~/.config/fina/apple/AuthKey_ZH5Y96UGRV.p8`
- Google Play service account: `~/.config/fina/google-play-service-account.json`
- Apple Issuer ID: `FINA_ASC_ISSUER_ID` or the existing `APPLE_ASC_ISSUER_ID` in the root `.env`

Local credential directories should use mode `700`; private key files should use mode `600`.

## Validate release notes

```bash
pnpm release:notes:validate
```

## Google Play

Build locally, submit to production, and update the production release notes:

```bash
pnpm release:android
```

Update only the notes for the latest production release:

```bash
pnpm notes:android
```

## Apple App Store

Submit the latest processed TestFlight build for App Review. Apple will release it automatically after approval:

```bash
pnpm review:ios
```

Build the IPA locally, upload it, submit it for review, and release automatically after approval:

```bash
pnpm release:ios
```

Upload an existing IPA to TestFlight without submitting it for App Review:

```bash
pnpm submit:ios
```

## Normal release checklist

1. Update `apps/mobile/app.json` with the new version.
2. Create `patch-notes/<version>.md` and update `## App Store — What’s New`.
3. Run `pnpm release:notes:validate`.
4. Run the platform release command.
5. Monitor Google Play review and App Store review status.

Store listing metadata, screenshots, privacy answers, review contact information, and demo credentials remain in the store dashboards and are reused. Update them whenever the app behavior or store requirements change.
