# Jam Mode preview

This experimental workspace imports a public itch.io jam, queues its playable
downloads, and keeps the links needed to play and leave jam feedback. Open **Jams**
in the sidebar or on the New Tab page.

## Try it

1. Sign in and choose a default installation location in Preferences.
2. Import the jam's main URL, for example `https://itch.io/jam/gmtk-2025`.
3. Choose **Download all**, or install an individual entry. Compatible native
   uploads are preferred. Downloadable HTML uploads are the fallback; online-only
   entries link to their game pages. If several native builds remain, choose one
   from the entry's build selector.
4. Follow installation progress in Downloads. You can stop adding further games;
   downloads already queued continue there and can be paused or cancelled there.
5. Use **Play** for a ready installation, or **Play web** for browser games.
   **Rate & comment** opens the actual jam submission page inside the app.
   The website handles authentication, eligibility, deadlines, and voting queues.
6. Mark favourites **Keep installed**. **Remove jam installs** uninstalls only
   copies created by the workspace that are neither kept nor still referenced by
   another jam. It releases this jam's references to shared or pre-existing copies.
   Removal can delete saves stored within the installation directory.

## Ownership and restart behaviour

Workspaces, per-entry progress and exact cave/upload ownership are saved in
account-scoped Butler profile data. Merely seeing an installed game never grants
Jam Mode permission to delete it. A late installation result is saved against the
account that requested it, even if that account has signed out. Queued downloads
continue through the normal download driver and progress is reconciled on restore.

Uninstalling removes these copies from the installed library. This preview does
not delete purchases, account ownership, existing collections, or project reviews.
It does not purchase or claim games while scanning a jam.

## Current limits

- Public jams only. Entry discovery uses the website's observed `entries.json`
  contract, isolated in `src/main/jams/import.ts`; this is not a documented public
  jam API. Hidden, removed, or inaccessible submissions may be absent.
- Voting and feedback use the embedded website. No native voting form or locally
  inferred "rated" state is provided.
- Bulk preparation selects accessible, compatible uploads using Butler. It does
  not guarantee that a creator's build is runnable. Failed downloads can be
  retried, and ambiguous builds require an explicit choice.
- Download preparation is sequential. Disk checks and extraction errors are
  handled by the normal installation system; an aggregate space estimate and
  prefetch limit are follow-up work.
- Kept status applies to the shared installation across jam workspaces for the
  active account. Installation provenance is account-scoped.
- Interface strings are English in this preview.

## Development and validation

Use Node 24, then `npm ci`, `npm run ts-check`, `npm test`, and `npm run compile`.
`npm start` runs the development app. Tests cover URL validation, import shape and
all-entry mapping, upload selection, retries, ownership, cleanup, persistence,
account changes, and interrupted operations.

The **Jam mode preview** workflow builds unsigned portable Windows and Linux
artifacts on pushes to `jam-mode`. It uses no itch.io release or signing secrets.
Authenticated installation/launch/rating still needs an end-to-end manual pass
with an itch.io account on each supported platform.
