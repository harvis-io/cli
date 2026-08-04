#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
const { zipSync } = require("fflate");

const VERSION = require("../package.json").version;
const API_URL = process.env.HARVIS_API_URL || "https://harvis.dev/api/upload";
const MAX_FILES = 500;
const MAX_PROJECT_BYTES = 50 * 1024 * 1024;
const STATE_FILE = ".harvis.json";

const IGNORED_DIRS = new Set(["node_modules", "__MACOSX"]);
const IGNORED_FILES = new Set(["Thumbs.db", "desktop.ini", STATE_FILE]);

// Formats that deflate well. Media formats (png, jpg, woff2, mp4…) are
// already compressed, so zipping them gains nothing.
const COMPRESSIBLE_EXTENSIONS = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
  ".json", ".map", ".txt", ".md", ".markdown", ".svg", ".xml", ".rss",
  ".atom", ".yml", ".yaml", ".csv", ".tsv", ".webmanifest", ".ini", ".toml",
]);

function printHelp() {
  console.log(`harvis — deploy the current folder to harvis.dev

Usage:
  harvis                     Deploy the current folder (updates the linked
                             site if ${STATE_FILE} exists, else creates one)
  harvis deploy [dir]        Deploy a folder (default: current folder)
  harvis link <subdomain>    Link this folder to an existing site
  harvis claim               Open the claim link of the last deploy
  harvis open                Open the live site of the last deploy

Options:
  --name <name>    Set the site name (default: taken from the page <title>)
  --new            Create a fresh site even if this folder is already linked
  --token <token>  Deploy token (for harvis link; or set HARVIS_DEPLOY_TOKEN)
  --claim          After deploying, open the claim link in your browser
  -h, --help       Show this help
  -v, --version    Show version

The first deploy prints two links:
  Live site   — public URL of your site
  Claim link  — private, single-use; open it and sign in to manage the site

Later deploys from the same folder update the same site using the deploy
token saved in ${STATE_FILE}. The token stays valid after you claim the
site, and you can view or regenerate it in the dashboard — use it with
\`harvis link\` to deploy from another machine or CI.

Unclaimed sites expire 24 hours after the last deploy. Claim a site to
keep it online.

${STATE_FILE} contains the deploy token — keep it out of version control
(it is added to .gitignore automatically when one exists).`);
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
    else if (a.startsWith("-")) {
      console.error(`Unknown option: ${a} (see: harvis --help)`);
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
      args.subdomain = rest[1] || null;
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

function readState(dir) {
  const file = path.join(dir, STATE_FILE);
  if (!fs.existsSync(file)) {
    console.error(`No ${STATE_FILE} found in this folder. Deploy first with: harvis`);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    console.error(`${STATE_FILE} is not valid JSON. Deploy again with: harvis`);
    process.exit(1);
  }
}

function tryReadState(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), "utf8"));
  } catch {
    return null;
  }
}

function writeState(dir, state) {
  try {
    fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
  } catch {
    // Saving state is best-effort; the links are printed either way.
  }
}

function ensureGitignored(dir) {
  const file = path.join(dir, ".gitignore");
  if (!fs.existsSync(file)) return;
  try {
    const content = fs.readFileSync(file, "utf8");
    if (content.split(/\r?\n/).some((line) => line.trim() === STATE_FILE)) return;
    const sep = content === "" || content.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(file, `${sep}${STATE_FILE}\n`);
    console.log(`Added ${STATE_FILE} to .gitignore (it contains your deploy token).`);
  } catch {
    // Best-effort; the help text still warns about committing the state file.
  }
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

  let linked = null;
  if (!args.forceNew) {
    const state = tryReadState(args.dir);
    const deployToken = process.env.HARVIS_DEPLOY_TOKEN || (state && state.deployToken);
    if (state && state.subdomain && deployToken) {
      linked = { subdomain: state.subdomain, deployToken };
    }
  }

  const useZip = shouldZip(files, totalBytes);
  const zipPayload = useZip ? buildZip(files) : null;
  const sizeNote = useZip
    ? `${fmtBytes(totalBytes)} → ${fmtBytes(zipPayload.length)} zipped`
    : fmtBytes(totalBytes);
  const action = linked ? `Updating ${linked.subdomain}` : "Uploading";
  console.log(`${action}: ${files.length} file${files.length === 1 ? "" : "s"} (${sizeNote})...`);

  async function postDeploy(target) {
    let url = API_URL;
    let payload, contentType;
    if (useZip) {
      // Raw zip body; metadata travels in query params.
      const q = new URLSearchParams();
      if (args.name) q.set("name", args.name);
      if (target) {
        q.set("subdomain", target.subdomain);
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
        fields.subdomain = target.subdomain;
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
    console.log(`Site ${linked.subdomain} no longer exists (unclaimed sites expire after 24 hours). Creating a new site...`);
    linked = null;
    ({ status, body } = await postDeploy(null));
  } else if (linked && status === 403) {
    console.error(`Deploy failed: the deploy token doesn't match site ${linked.subdomain}.`);
    console.error("Get the current token from the dashboard and run `harvis link " + linked.subdomain + " --token <token>`,");
    console.error("or run `harvis --new` to create a fresh site.");
    process.exit(1);
  }

  if (status >= 400 || !body || !body.url) {
    const message = (body && body.error) || `HTTP ${status}`;
    console.error(`Deploy failed: ${message}`);
    process.exit(1);
  }

  const state = {
    url: body.url,
    subdomain: body.subdomain,
    name: body.name,
    deployToken: body.deployToken,
    deployedAt: new Date().toISOString(),
  };
  if (body.claimUrl) state.claimUrl = body.claimUrl;
  writeState(args.dir, state);
  ensureGitignored(args.dir);

  console.log("");
  if (linked) {
    console.log(`  Updated:   ${body.url}`);
    if (body.claimUrl) {
      console.log("");
      console.log("This site is still unclaimed and expires 24 hours after the last");
      console.log("deploy. Run `harvis claim` to keep it online permanently.");
    }
  } else {
    console.log(`  Live site:   ${body.url}`);
    if (body.claimUrl) console.log(`  Claim link:  ${body.claimUrl}`);
    console.log("");
    console.log("The claim link is private and single-use: open it and sign in to");
    console.log("manage the site. Run `harvis claim` to open it in your browser.");
    console.log("Unclaimed sites expire after 24 hours. Deploying this folder again");
    console.log("updates this same site.");
  }

  if (args.openClaim && body.claimUrl) openInBrowser(body.claimUrl);
}

function link(args) {
  const deployToken = args.token || process.env.HARVIS_DEPLOY_TOKEN;
  if (!args.subdomain || !deployToken) {
    console.error("Usage: harvis link <subdomain> --token <token>");
    console.error("Find the site's deploy token in the harvis.dev dashboard.");
    process.exit(1);
  }
  const state = tryReadState(process.cwd()) || {};
  state.subdomain = args.subdomain;
  state.deployToken = deployToken;
  writeState(process.cwd(), state);
  ensureGitignored(process.cwd());
  console.log(`Linked this folder to ${args.subdomain}. Run \`harvis\` to deploy.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help") return printHelp();
  if (args.command === "version") {
    return console.log(VERSION);
  }
  if (args.command === "claim") {
    const state = readState(process.cwd());
    if (!state.claimUrl) {
      console.error(`No claim link in ${STATE_FILE}.`);
      process.exit(1);
    }
    console.log(`Opening claim link: ${state.claimUrl}`);
    return openInBrowser(state.claimUrl);
  }
  if (args.command === "open") {
    const state = readState(process.cwd());
    console.log(`Opening live site: ${state.url}`);
    return openInBrowser(state.url);
  }
  if (args.command === "link") return link(args);
  return deploy(args);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
