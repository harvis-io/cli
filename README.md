# harvis CLI

[![CI](https://github.com/harvis-io/cli/actions/workflows/ci.yml/badge.svg)](https://github.com/harvis-io/cli/actions/workflows/ci.yml)

Deploy the current folder to [harvis.dev](https://harvis.dev) with one command. No account, no config.

This repository hosts the harvis CLI for multiple languages, one per folder:

| Folder | Language | Package | Install |
| --- | --- | --- | --- |
| [`node/`](node/) | Node.js | [harvis on npm](https://www.npmjs.com/package/harvis) | `npm i -g harvis` or `npx harvis` |
| [`python/`](python/) | Python | [harvis on PyPI](https://pypi.org/project/harvis/) | `pip install harvis` or `uvx harvis` |

Both implementations share the same commands, options, and behavior — see each folder's README for details.

The Node package is also published under the name [`hosting`](https://www.npmjs.com/package/hosting) — same code, same version, invoked as `hosting` instead of `harvis`. Install either one, not both.

```
Uploading 3 files (12.4 KB)...

  Live site:   https://happy-panda-482.harvis.dev/
  Claim link:  https://harvis.dev/claim/xxxxxxxx-...
```

## Uninstalling

```bash
npm uninstall -g harvis       # npm i -g harvis
pip uninstall harvis          # pip install harvis
uv tool uninstall harvis      # uv tool install harvis
```

`npx harvis` / `uvx harvis` install nothing globally; clear their caches with `npx clear-npx-cache` or `uv cache clean harvis`.

Deploy tokens live outside the package in `~/.config/harvis/` (`%APPDATA%\harvis` on Windows) and are left behind — `rm -rf ~/.config/harvis` to remove them as well.

## About

This CLI is the open-source companion to [harvis.dev](https://harvis.dev). Deploys are anonymous by default; opening the claim link and signing in attaches the site to your account so you can manage it from the dashboard.

## License

MIT
