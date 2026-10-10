#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
const { zipSync } = require("fflate");

const VERSION = require("../package.json").version;
const API_URL = process.env.HARVIS_API_URL || "https://harvis.dev/api/upload";

// The same CLI ships under two npm names, `harvis` and `hosting`, so help and
// error text echoes whichever command the user typed. On Windows the shim runs
// the real file path, which falls back to the default.
const CMD = path.basename(process.argv[1] || "", ".js") === "hosting" ? "hosting" : "harvis";
const MAX_FILES = 500;
const MAX_PROJECT_BYTES = 50 * 1024 * 1024;

// Site links and deploy tokens live in a per-user store outside the project,
// so a rebuild that wipes the output folder cannot lose them and nothing is
// written into the project itself.
const CREDENTIALS_FILE = "credentials.json";

// Anything that marks the top of a project.
const PROJECT_MARKERS = [
  ".git", "package.json", "pyproject.toml", "deno.json",
  "deno.jsonc", "go.mod", "Cargo.toml", "Gemfile", "composer.json",
];

const IGNORED_DIRS = new Set(["node_modules", "__MACOSX"]);
const IGNORED_FILES = new Set(["Thumbs.db", "desktop.ini", "harvis.json"]);

// Formats that deflate well. Media formats (png, jpg, woff2, mp4…) are
// already compressed, so zipping them gains nothing.
const COMPRESSIBLE_EXTENSIONS = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
  ".json", ".map", ".txt", ".md", ".markdown", ".svg", ".xml", ".rss",
  ".atom", ".yml", ".yaml", ".csv", ".tsv", ".webmanifest", ".ini", ".toml",
]);

function printHelp() {
  const WIDTH = 27;
  const row = (usage, ...lines) =>
    [`  ${usage.padEnd(WIDTH)}${lines[0]}`, ...lines.slice(1).map((l) => " ".repeat(WIDTH + 2) + l)].join("\n");
  console.log(`${CMD} — deploy the current folder to harvis.dev

Usage:
${row(CMD, "Deploy the current folder (updates the linked", "site if this project has one, else creates one)")}
${row(`${CMD} deploy [dir]`, "Deploy a folder (default: current folder)")}
${row(`${CMD} link [subdomain]`, "Link this project to an existing site", "(--token is enough; the name is optional)")}
${row(`${CMD} claim`, "Open the claim link of the last deploy")}
${row(`${CMD} open`, "Open the live site of the last deploy")}

Options:
  --name <name>       Set the site name (default: from the page <title>)
  --new               Create a fresh site even if this project is linked
  --token <token>     Deploy token (or set HARVIS_DEPLOY_TOKEN)
  --subdomain <sub>   Deploy to this site (or set HARVIS_SUBDOMAIN); optional,
                      the token already names the site — given, it must match
  --claim             After deploying, open the claim link in your browser
  -h, --help          Show this help
  -v, --version       Show version

The first deploy prints two links:
  Live site   — public URL of your site
  Claim link  — private, single-use; open it and sign in to manage the site

Later deploys from the same project update the same site. The link and the
deploy token are stored per user in
  ${credentialsPath()}
so rebuilding or deleting the output folder never loses them.

The token stays valid after you claim the site, and you can view or
regenerate it in the dashboard — use it with \`${CMD} link\`, or set
HARVIS_DEPLOY_TOKEN, to deploy from CI. The token is the only secret
CI needs: it identifies the site by itself.

Unclaimed sites expire 24 hours after the last deploy. Claim a site to
keep it online.`);
}

function parseArgs(argv) {
  const args = {
    command: "deploy", dir: process.cwd(), name: null, openClaim: false,
    forceNew: false, token: null, subdomain: null,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") args.command = "help";
    else if (a === "-v" || a === "--version") args.command = "version";
    else if (a === "--claim") args.openClaim = true;
    else if (a === "--new") args.forceNew = true;
    else if (a === "--name") args.name = argv[++i] || null;
    else if (a.startsWith("--name=")) args.name = a.slice("--name=".length);
    else if (a === "--token") args.token = argv[++i] || null;
    else if (a.startsWith("--token=")) args.token = a.slice("--token=".length);
    else if (a === "--subdomain") args.subdomain = argv[++i] || null;
    else if (a.startsWith("--subdomain=")) args.subdomain = a.slice("--subdomain=".length);
    else if (a.startsWith("-")) {
      console.error(`Unknown option: ${a} (see: ${CMD} --help)`);
      process.exit(1);
    } else rest.push(a);
  }
  if (args.command === "deploy" && rest.length > 0) {
    const first = rest[0];
    if (first === "deploy") {
      if (rest[1]) args.dir = path.resolve(rest[1]);
    } else if (first === "claim" || first === "open") {
      args.command = first;
    } else if (first === "link") {
      args.command = "link";
      if (rest[1]) args.subdomain = rest[1];
    } else {
      args.dir = path.resolve(first);
    }
  }
  return args;
}

function isCompressible(name) {
  const ext = path.extname(name).toLowerCase();
  // Extensionless files (LICENSE, CNAME…) are almost always text.
  return ext === "" || COMPRESSIBLE_EXTENSIONS.has(ext);
}

function collectFiles(rootDir) {
  const files = [];
  let totalBytes = 0;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`Cannot read directory ${dir}: ${err.message}`);
      process.exit(1);
    }
    for (const entry of entries) {
      // The server drops dotfiles anyway; skipping hidden files and folders
      // locally also keeps secrets like .env and .git from leaving the machine.
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        if (IGNORED_FILES.has(entry.name)) continue;
        const buf = fs.readFileSync(abs);
        totalBytes += buf.length;
        const relPath = path.relative(rootDir, abs).split(path.sep).join("/");
        files.push({ path: relPath, data: buf, compressible: isCompressible(entry.name) });
        if (files.length > MAX_FILES) {
          console.error(`Too many files: the limit is ${MAX_FILES} per site.`);
          process.exit(1);
        }
        if (totalBytes > MAX_PROJECT_BYTES) {
          console.error(`Folder too large: the limit is ${Math.round(MAX_PROJECT_BYTES / 1024 / 1024)}MB per site.`);
          process.exit(1);
        }
      }
    }
  }

  walk(rootDir);
  return { files, totalBytes };
}

// Zip when deflating pays for itself: text shrinks ~60-70%, while already-
// compressed media gains nothing, so a folder that is (almost) all media
// uploads as raw multipart instead. A lone .zip file is always wrapped —
// sent bare, the server would extract the file itself.
function shouldZip(files, totalBytes) {
  if (files.length === 1 && /\.zip$/i.test(files[0].path)) return true;
  const compressibleBytes = files.reduce(
    (sum, f) => sum + (f.compressible ? f.data.length : 0), 0,
  );
  return compressibleBytes >= totalBytes * 0.1;
}

function buildZip(files) {
  const entries = {};
  for (const f of files) {
    entries[f.path] = [f.data, { level: f.compressible ? 6 : 0 }];
  }
  return Buffer.from(zipSync(entries));
}

function buildMultipart(files, fields) {
  const boundary = "----harvis" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const parts = [];
  const push = (s) => parts.push(Buffer.from(s, "utf8"));
  for (const [key, value] of Object.entries(fields)) {
    if (!value) continue;
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
  }
  for (const f of files) {
    // The paired "paths" field is the source of truth for the relative path;
    // the filename only needs to be a safe label.
    const label = f.path.split("/").pop().replace(/["\r\n]/g, "_");
    push(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${label}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    parts.push(f.data);
    push(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="paths"\r\n\r\n${f.path}\r\n`);
  }
  push(`--${boundary}--\r\n`);
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function fmtBytes(n) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Renders on stderr only when it is an interactive terminal, so pipes and
// CI logs stay clean.
function makeProgress(total) {
  if (!process.stderr.isTTY) return { update() {}, done() {} };
  let last = "";
  return {
    update(sent) {
      const pct = total ? Math.min(100, Math.round((sent / total) * 100)) : 100;
      const width = 24;
      const filled = Math.round((width * pct) / 100);
      const line = `  ${fmtBytes(sent)} / ${fmtBytes(total)} [${"█".repeat(filled)}${"░".repeat(width - filled)}] ${pct}%`;
      if (line !== last) {
        process.stderr.write("\r\x1b[2K" + line);
        last = line;
      }
    },
    done() {
      if (last) process.stderr.write("\r\x1b[2K");
    },
  };
}

// POST `payload` to `url`, writing in chunks so upload progress can be
// reported. Resolves with { status, body } where body is parsed JSON or null.
function upload(url, payload, contentType) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === "http:" ? http : https;
    const progress = makeProgress(payload.length);
    const req = lib.request(target, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "Content-Length": payload.length,
        "User-Agent": `harvis/${VERSION}`,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        progress.done();
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          // fall through to the status check at the call site
        }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on("error", (err) => {
      progress.done();
      reject(err);
    });

    const CHUNK = 64 * 1024;
    let offset = 0;
    function writeMore() {
      while (offset < payload.length) {
        const chunk = payload.subarray(offset, offset + CHUNK);
        offset += chunk.length;
        const ok = req.write(chunk);
        progress.update(offset);
        if (!ok) {
          req.once("drain", writeMore);
          return;
        }
      }
      req.end();
    }
    writeMore();
  });
}

function openInBrowser(url) {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const cmdArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
  child.on("error", () => console.error(`Could not open a browser. Open this URL yourself:\n  ${url}`));
  child.unref();
}

function configDir() {
  if (process.env.HARVIS_CONFIG_DIR) return path.resolve(process.env.HARVIS_CONFIG_DIR);
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "harvis");
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "harvis");
}

function credentialsPath() {
  return path.join(configDir(), CREDENTIALS_FILE);
}

// { sites: { <subdomain>: { url, name, deployToken, claimUrl, deployedAt } },
//   projects: { <projectRoot>: <subdomain> },
//   tokens: { <projectRoot>: <deployToken> } }
//
// `tokens` holds a token linked before its site name is known — the server
// resolves the site from the token, and the first deploy moves the entry
// into `sites` under the subdomain it returns.
function readCredentials() {
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath(), "utf8"));
    return { sites: raw.sites || {}, projects: raw.projects || {}, tokens: raw.tokens || {} };
  } catch {
    // Missing or corrupt: start fresh rather than blocking the deploy.
    return { sites: {}, projects: {}, tokens: {} };
  }
}

function writeCredentials(creds) {
  const file = credentialsPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Write-then-rename so an interrupted write cannot truncate the store,
    // and 0600 because deploy tokens are secrets.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch (err) {
    console.error(`Warning: could not save the deploy token to ${file}: ${err.message}`);
  }
}

// The project root is the key a link is stored under: walking up from the
// deployed folder means `harvis deploy dist` links the project, not the build
// output.
function findProjectRoot(startDir) {
  const home = os.homedir();
  let dir = startDir;
  for (;;) {
    if (PROJECT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
    const parent = path.dirname(dir);
    // Never walk past $HOME — a dotfiles repo there would swallow every project.
    if (parent === dir || dir === home) return startDir;
    dir = parent;
  }
}

// Where a deploy goes, in order: flags, env (CI), then the per-user store
// keyed by project root.
//
// The token identifies the site on its own — the server resolves it — so a
// token with no subdomain is a complete target. A subdomain alongside it is
// sent as an assertion: the server rejects the pair if they disagree.
function resolveLink(startDir, args) {
  const root = findProjectRoot(startDir);
  const creds = readCredentials();
  const requested = (args && args.subdomain) || process.env.HARVIS_SUBDOMAIN || null;
  const subdomain = requested || creds.projects[root] || null;
  const site = subdomain ? creds.sites[subdomain] || null : null;
  const parked = creds.tokens[root] || null;
  const deployToken = (args && args.token) || process.env.HARVIS_DEPLOY_TOKEN
    || (site && site.deployToken) || parked;
  // A parked token (`harvis link --token`, no name given) is the most recent
  // and most specific instruction there is, so let the server resolve the
  // site rather than asserting a name left over from an earlier link.
  const asserted = deployToken && deployToken === parked && !requested ? null : subdomain;
  return {
    root,
    subdomain,
    site,
    target: deployToken ? { subdomain: asserted, deployToken } : null,
  };
}

function rememberSite(root, subdomain, body) {
  const creds = readCredentials();
  const previous = creds.projects[root];
  // A project points at one site; drop the record it replaced.
  if (previous && previous !== subdomain) delete creds.sites[previous];
  const prior = creds.sites[subdomain] || {};
  const record = {
    url: body.url,
    name: body.name || prior.name,
    // The server only returns the token on create; keep the stored one otherwise.
    deployToken: body.deployToken || prior.deployToken,
    deployedAt: new Date().toISOString(),
  };
  // Absent on a claimed site — dropping it keeps `harvis claim` honest.
  if (body.claimUrl) record.claimUrl = body.claimUrl;
  creds.sites[subdomain] = record;
  creds.projects[root] = subdomain;
  // The site name is known now, so a token parked by `harvis link --token`
  // has a home under `sites` and the placeholder can go.
  if (creds.tokens[root]) {
    if (!record.deployToken) creds.sites[subdomain].deployToken = creds.tokens[root];
    delete creds.tokens[root];
  }
  writeCredentials(creds);
}

function requireSite(startDir) {
  const { subdomain, site } = resolveLink(startDir, null);
  if (!subdomain) {
    console.error(`This project is not linked to a site yet. Deploy first with: ${CMD}`);
    process.exit(1);
  }
  if (!site || !site.url) {
    console.error(`No local record of ${subdomain} in ${credentialsPath()}.`);
    console.error(`Deploy again with \`${CMD}\`, or run \`${CMD} link ${subdomain} --token <token>\`.`);
    process.exit(1);
  }
  return site;
}

async function deploy(args) {
  if (!fs.existsSync(args.dir) || !fs.statSync(args.dir).isDirectory()) {
    console.error(`Not a directory: ${args.dir}`);
    process.exit(1);
  }

  const { files, totalBytes } = collectFiles(args.dir);
  if (files.length === 0) {
    console.error("Nothing to deploy: the folder has no files (hidden files are skipped).");
    process.exit(1);
  }
  if (!files.some((f) => /\.html?$/i.test(f.path))) {
    console.error("Warning: no .html file found — the site may not have a homepage.");
  }

  const resolved = resolveLink(args.dir, args);
  let linked = args.forceNew ? null : resolved.target;
  if (!args.forceNew && resolved.subdomain && !linked) {
    console.error(`No deploy token for ${resolved.subdomain} in ${credentialsPath()} — creating a new site.`);
    console.error(`Run \`${CMD} link ${resolved.subdomain} --token <token>\` to update it instead.`);
  }

  const useZip = shouldZip(files, totalBytes);
  const zipPayload = useZip ? buildZip(files) : null;
  const sizeNote = useZip
    ? `${fmtBytes(totalBytes)} → ${fmtBytes(zipPayload.length)} zipped`
    : fmtBytes(totalBytes);
  const action = linked ? `Updating ${linked.subdomain || "the linked site"}` : "Uploading";
  console.log(`${action}: ${files.length} file${files.length === 1 ? "" : "s"} (${sizeNote})...`);

  async function postDeploy(target) {
    let url = API_URL;
    let payload, contentType;
    if (useZip) {
      // Raw zip body; metadata travels in query params.
      const q = new URLSearchParams();
      if (args.name) q.set("name", args.name);
      if (target) {
        // Optional: the token alone names the site. Sent when known so the
        // server can refuse a token/site mismatch instead of overwriting.
        if (target.subdomain) q.set("subdomain", target.subdomain);
        q.set("deployToken", target.deployToken);
      }
      const qs = q.toString();
      if (qs) url += (url.includes("?") ? "&" : "?") + qs;
      payload = zipPayload;
      contentType = "application/zip";
    } else {
      const fields = {};
      if (args.name) fields.name = args.name;
      if (target) {
        if (target.subdomain) fields.subdomain = target.subdomain;
        fields.deployToken = target.deployToken;
      }
      ({ payload, contentType } = buildMultipart(files, fields));
    }
    try {
      return await upload(url, payload, contentType);
    } catch (err) {
      console.error(`Upload failed: ${err.message}`);
      process.exit(1);
    }
  }

  let { status, body } = await postDeploy(linked);

  if (linked && status === 404) {
    const gone = linked.subdomain ? `Site ${linked.subdomain}` : "The linked site";
    console.log(`${gone} no longer exists (unclaimed sites expire after 24 hours). Creating a new site...`);
    linked = null;
    ({ status, body } = await postDeploy(null));
  } else if (linked && status === 403) {
    console.error(linked.subdomain
      ? `Deploy failed: the deploy token doesn't match site ${linked.subdomain}.`
      : "Deploy failed: the deploy token was not accepted.");
    console.error(`Get the current token from the dashboard and run \`${CMD} link --token <token>\`,`);
    console.error(`or run \`${CMD} --new\` to create a fresh site.`);
    process.exit(1);
  }

  if (status >= 400 || !body || !body.url) {
    const message = (body && body.error) || `HTTP ${status}`;
    console.error(`Deploy failed: ${message}`);
    process.exit(1);
  }

  const subdomain = body.subdomain || (linked && linked.subdomain);
  if (subdomain) {
    rememberSite(resolved.root, subdomain, body);
  }

  console.log("");
  if (linked) {
    console.log(`  Updated:   ${body.url}`);
    if (body.claimUrl) {
      console.log("");
      console.log("This site is still unclaimed and expires 24 hours after the last");
      console.log(`deploy. Run \`${CMD} claim\` to keep it online permanently.`);
    }
  } else {
    console.log(`  Live site:   ${body.url}`);
    if (body.claimUrl) console.log(`  Claim link:  ${body.claimUrl}`);
    console.log("");
    console.log("The claim link is private and single-use: open it and sign in to");
    console.log(`manage the site. Run \`${CMD} claim\` to open it in your browser.`);
    console.log("Unclaimed sites expire after 24 hours. Deploying this project again");
    console.log("updates this same site.");
  }

  if (args.openClaim && body.claimUrl) openInBrowser(body.claimUrl);
}

function link(args) {
  const deployToken = args.token || process.env.HARVIS_DEPLOY_TOKEN;
  if (!deployToken) {
    console.error(`Usage: ${CMD} link --token <token>  (or: ${CMD} link <subdomain> --token <token>)`);
    console.error("Find the site's deploy token in the harvis.dev dashboard.");
    process.exit(1);
  }
  const root = findProjectRoot(process.cwd());
  const creds = readCredentials();
  const previous = creds.projects[root];
  if (previous && previous !== args.subdomain) delete creds.sites[previous];
  if (args.subdomain) {
    creds.sites[args.subdomain] = { ...(creds.sites[args.subdomain] || {}), deployToken };
    creds.projects[root] = args.subdomain;
    delete creds.tokens[root];
  } else {
    // No site name given: park the token until the first deploy reports
    // which site it belongs to.
    delete creds.projects[root];
    creds.tokens[root] = deployToken;
  }
  writeCredentials(creds);
  console.log(args.subdomain
    ? `Linked ${root} to ${args.subdomain}. Run \`${CMD}\` to deploy.`
    : `Linked ${root} to the token's site. Run \`${CMD}\` to deploy — the site name is recorded then.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help") return printHelp();
  if (args.command === "version") {
    return console.log(VERSION);
  }
  if (args.command === "claim") {
    const site = requireSite(process.cwd());
    if (!site.claimUrl) {
      console.error("No claim link for this site — it is already claimed, or was claimed elsewhere.");
      process.exit(1);
    }
    console.log(`Opening claim link: ${site.claimUrl}`);
    return openInBrowser(site.claimUrl);
  }
  if (args.command === "open") {
    const site = requireSite(process.cwd());
    console.log(`Opening live site: ${site.url}`);
    return openInBrowser(site.url);
  }
  if (args.command === "link") return link(args);
  return deploy(args);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
