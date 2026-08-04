# harvis

[![npm version](https://img.shields.io/npm/v/harvis)](https://www.npmjs.com/package/harvis)
[![CI](https://github.com/harvis-io/cli/actions/workflows/ci.yml/badge.svg)](https://github.com/harvis-io/cli/actions/workflows/ci.yml)

Deploy the current folder to [harvis.dev](https://harvis.dev) with one command. No account, no config.

```bash
npm i -g harvis
harvis
```

or without installing:

```bash
npx harvis
```

Output:

```
Uploading 3 files (12.4 KB)...

  Live site:   https://happy-panda-482.harvis.dev/
  Claim link:  https://harvis.dev/claim/xxxxxxxx-...

The claim link is private and single-use: open it and sign in to
manage the site. Run `harvis claim` to open it in your browser.
```

## Commands

| Command | What it does |
| --- | --- |
| `harvis` | Deploy the current folder (updates the linked site, or creates one) |
| `harvis deploy [dir]` | Deploy a specific folder |
| `harvis link <subdomain>` | Link the current folder to an existing site |
| `harvis claim` | Open the last deploy's claim link in your browser |
| `harvis open` | Open the last deploy's live site in your browser |

## Options

- `--name <name>` — set the site name (defaults to the page `<title>`)
- `--new` — create a fresh site even if the folder is already linked to one
- `--token <token>` — deploy token for `harvis link` (or set `HARVIS_DEPLOY_TOKEN`)
- `--claim` — open the claim link in your browser right after deploying

## Updating a site

The first deploy creates a site and saves its **deploy token** to `.harvis.json`. Every later deploy from the same folder sends that token and updates the same site — before *and* after you claim it. Claiming attaches the site to your account; the token keeps working, and you can view or regenerate it in the dashboard.

To deploy an existing site from another machine or CI, link the folder first:

```bash
harvis link happy-panda-482 --token <token-from-dashboard>
harvis
```

To start over with a fresh URL, run `harvis --new`.

## Notes

- Limits: 500 files, 50 MB per site. Hidden files and folders (anything starting with `.`, like `.env` or `.git`), `node_modules`, and OS junk files are skipped automatically.
- **Unclaimed sites expire 24 hours after the last deploy.** Claim a site to keep it online permanently. If a linked site has expired, the next deploy tells you and creates a new one.
- `.harvis.json` contains the deploy token and claim link — keep it private. The CLI adds it to `.gitignore` automatically when one exists.
- The claim link is single-use and can't be recovered. If you want to keep the site, claim it before it expires.

## About

This CLI is the open-source companion to [harvis.dev](https://harvis.dev). Deploys are anonymous by default; opening the claim link and signing in attaches the site to your account so you can manage it from the dashboard.

## License

MIT
