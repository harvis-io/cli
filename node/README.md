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

The same CLI is also published as [`hosting`](https://www.npmjs.com/package/hosting) — identical code and version, invoked as `hosting`:

```bash
npx hosting
```

Pick one; installing both globally just puts two names for the same tool on your PATH. Everything below applies to either, with the command name swapped.

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
| `harvis link [subdomain]` | Link this project to an existing site (`--token` is enough) |
| `harvis claim` | Open the last deploy's claim link in your browser |
| `harvis open` | Open the last deploy's live site in your browser |

## Options

- `--name <name>` — set the site name (defaults to the page `<title>`)
- `--new` — create a fresh site even if this project is already linked to one
- `--token <token>` — deploy token (or set `HARVIS_DEPLOY_TOKEN`)
- `--subdomain <sub>` — deploy to this site (or set `HARVIS_SUBDOMAIN`). Optional: the deploy token already names the site. When given, it must match the token's site, so it acts as a guard against deploying to the wrong one.
- `--claim` — open the claim link in your browser right after deploying

## Updating a site

The first deploy creates a site and records the link to it, along with its **deploy token**, in `~/.config/harvis/credentials.json` — stored per user with `0600` permissions. Nothing is written into your project, and because the record lives outside it, rebuilding or deleting your output folder never loses it. (`%APPDATA%\harvis\credentials.json` on Windows; honours `XDG_CONFIG_HOME`, or `HARVIS_CONFIG_DIR` to override.)

Every later deploy from the same project sends that token and updates the same site — before *and* after you claim it. Claiming attaches the site to your account; the token keeps working, and you can view or regenerate it in the dashboard.

The project root is found by walking up from the folder being deployed, looking for `.git`, `package.json`, `pyproject.toml` and friends — so `harvis deploy dist` links the project, not the build output.

To deploy an existing site from another machine, link the project once. The
token identifies the site by itself, so the subdomain is optional — the first
deploy learns the name from the server and records it:

```bash
harvis link --token <token-from-dashboard>
harvis
```

Name it as well if you want the check that you grabbed the right token — a
mismatch fails the deploy instead of overwriting the other site:

```bash
harvis link happy-panda-482 --token <token-from-dashboard>
```

In CI, set the environment instead of running `link`. The token is the only
secret needed:

```bash
export HARVIS_DEPLOY_TOKEN=<token-from-dashboard>
harvis deploy dist
```

To start over with a fresh URL, run `harvis --new`.

## Uninstalling

Remove the global install:

```bash
npm uninstall -g harvis
```

If you ran it with `npx`, nothing was installed globally — clear the cached copy with `npx clear-npx-cache` (or delete `~/.npm/_npx`).

Neither removes your deploy tokens. To delete those too:

```bash
rm -rf ~/.config/harvis
```

(`%APPDATA%\harvis` on Windows, or wherever `XDG_CONFIG_HOME` / `HARVIS_CONFIG_DIR` points.) Tokens can also be regenerated from the dashboard.

## Notes

- Uploads are zipped when the folder compresses well (HTML/CSS/JS shrink ~60-70%); folders that are mostly already-compressed media (images, video, fonts) upload as raw multipart instead. A progress bar is shown on interactive terminals.
- Limits: 500 files, 50 MB per site. Hidden files and folders (anything starting with `.`, like `.env` or `.git`), `node_modules`, and OS junk files are skipped automatically.
- **Unclaimed sites expire 24 hours after the last deploy.** Claim a site to keep it online permanently. If a linked site has expired, the next deploy tells you and creates a new one.
- The deploy token is a secret and stays out of your project: it is written only to `~/.config/harvis/credentials.json`, mode `0600`.
- The claim link is single-use and can't be recovered. If you want to keep the site, claim it before it expires.

## About

This CLI is the open-source companion to [harvis.dev](https://harvis.dev). Deploys are anonymous by default; opening the claim link and signing in attaches the site to your account so you can manage it from the dashboard.

## License

MIT
