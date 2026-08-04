# harvis CLI

[![CI](https://github.com/harvis-io/cli/actions/workflows/ci.yml/badge.svg)](https://github.com/harvis-io/cli/actions/workflows/ci.yml)

Deploy the current folder to [harvis.dev](https://harvis.dev) with one command. No account, no config.

This repository hosts the harvis CLI for multiple languages, one per folder:

| Folder | Language | Package | Install |
| --- | --- | --- | --- |
| [`node/`](node/) | Node.js | [harvis on npm](https://www.npmjs.com/package/harvis) | `npm i -g harvis` or `npx harvis` |
| [`python/`](python/) | Python | [harvis on PyPI](https://pypi.org/project/harvis/) | `pip install harvis` or `uvx harvis` |

Both implementations share the same commands, options, and behavior — see each folder's README for details.

```
Uploading 3 files (12.4 KB)...

  Live site:   https://happy-panda-482.harvis.dev/
  Claim link:  https://harvis.dev/claim/xxxxxxxx-...
```

## About

This CLI is the open-source companion to [harvis.dev](https://harvis.dev). Deploys are anonymous by default; opening the claim link and signing in attaches the site to your account so you can manage it from the dashboard.

## License

MIT
