"""harvis — deploy the current folder to harvis.dev with one command."""

import base64
import json
import os
import sys
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime, timezone

from harvis import __version__

API_URL = os.environ.get("HARVIS_API_URL", "https://harvis.dev/api/upload")
MAX_FILES = 500
MAX_PROJECT_BYTES = 50 * 1024 * 1024
STATE_FILE = ".harvis.json"

IGNORED_DIRS = {"node_modules", "__MACOSX"}
IGNORED_FILES = {"Thumbs.db", "desktop.ini", STATE_FILE}

TEXT_EXTENSIONS = {
    ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
    ".json", ".map", ".txt", ".md", ".markdown", ".svg", ".xml", ".rss",
    ".atom", ".yml", ".yaml", ".csv", ".tsv", ".webmanifest", ".ini", ".toml",
}


def print_help():
    print(f"""harvis — deploy the current folder to harvis.dev

Usage:
  harvis                     Deploy the current folder (updates the linked
                             site if {STATE_FILE} exists, else creates one)
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
token saved in {STATE_FILE}. The token stays valid after you claim the
site, and you can view or regenerate it in the dashboard — use it with
`harvis link` to deploy from another machine or CI.

Unclaimed sites expire 24 hours after the last deploy. Claim a site to
keep it online.

{STATE_FILE} contains the deploy token — keep it out of version control
(it is added to .gitignore automatically when one exists).""")


class Args:
    def __init__(self):
        self.command = "deploy"
        self.dir = os.getcwd()
        self.name = None
        self.open_claim = False
        self.force_new = False
        self.token = None
        self.subdomain = None


def parse_args(argv):
    args = Args()
    rest = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-h", "--help"):
            args.command = "help"
        elif a in ("-v", "--version"):
            args.command = "version"
        elif a == "--claim":
            args.open_claim = True
        elif a == "--new":
            args.force_new = True
        elif a == "--name":
            i += 1
            args.name = argv[i] if i < len(argv) else None
        elif a.startswith("--name="):
            args.name = a[len("--name="):]
        elif a == "--token":
            i += 1
            args.token = argv[i] if i < len(argv) else None
        elif a.startswith("--token="):
            args.token = a[len("--token="):]
        elif a.startswith("-"):
            print(f"Unknown option: {a} (see: harvis --help)", file=sys.stderr)
            sys.exit(1)
        else:
            rest.append(a)
        i += 1
    if args.command == "deploy" and rest:
        first = rest[0]
        if first == "deploy":
            if len(rest) > 1:
                args.dir = os.path.abspath(rest[1])
        elif first in ("claim", "open"):
            args.command = first
        elif first == "link":
            args.command = "link"
            args.subdomain = rest[1] if len(rest) > 1 else None
        else:
            args.dir = os.path.abspath(first)
    return args


def collect_files(root_dir):
    files = []
    total_bytes = 0

    def walk(directory):
        nonlocal total_bytes
        try:
            entries = sorted(os.scandir(directory), key=lambda e: e.name)
        except OSError as err:
            print(f"Cannot read directory {directory}: {err}", file=sys.stderr)
            sys.exit(1)
        for entry in entries:
            # The server drops dotfiles anyway; skipping hidden files and folders
            # locally also keeps secrets like .env and .git from leaving the machine.
            if entry.name.startswith("."):
                continue
            if entry.is_dir(follow_symlinks=False):
                if entry.name in IGNORED_DIRS:
                    continue
                walk(entry.path)
            elif entry.is_file(follow_symlinks=False):
                if entry.name in IGNORED_FILES:
                    continue
                with open(entry.path, "rb") as f:
                    buf = f.read()
                total_bytes += len(buf)
                rel_path = os.path.relpath(entry.path, root_dir).replace(os.sep, "/")
                ext = os.path.splitext(entry.name)[1].lower()
                is_text = ext in TEXT_EXTENSIONS
                files.append({
                    "path": rel_path,
                    "content": buf.decode("utf-8") if is_text else base64.b64encode(buf).decode("ascii"),
                    "encoding": "text" if is_text else "base64",
                })
                if len(files) > MAX_FILES:
                    print(f"Too many files: the limit is {MAX_FILES} per site.", file=sys.stderr)
                    sys.exit(1)
                if total_bytes > MAX_PROJECT_BYTES:
                    print(f"Folder too large: the limit is {MAX_PROJECT_BYTES // 1024 // 1024}MB per site.", file=sys.stderr)
                    sys.exit(1)

    walk(root_dir)
    return files, total_bytes


def open_in_browser(url):
    try:
        opened = webbrowser.open(url)
    except webbrowser.Error:
        opened = False
    if not opened:
        print(f"Could not open a browser. Open this URL yourself:\n  {url}", file=sys.stderr)


def read_state(directory):
    file = os.path.join(directory, STATE_FILE)
    if not os.path.exists(file):
        print(f"No {STATE_FILE} found in this folder. Deploy first with: harvis", file=sys.stderr)
        sys.exit(1)
    try:
        with open(file, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        print(f"{STATE_FILE} is not valid JSON. Deploy again with: harvis", file=sys.stderr)
        sys.exit(1)


def try_read_state(directory):
    try:
        with open(os.path.join(directory, STATE_FILE), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_state(directory, state):
    try:
        with open(os.path.join(directory, STATE_FILE), "w", encoding="utf-8") as f:
            f.write(json.dumps(state, indent=2) + "\n")
    except OSError:
        # Saving state is best-effort; the links are printed either way.
        pass


def ensure_gitignored(directory):
    file = os.path.join(directory, ".gitignore")
    if not os.path.exists(file):
        return
    try:
        with open(file, encoding="utf-8") as f:
            content = f.read()
        if any(line.strip() == STATE_FILE for line in content.splitlines()):
            return
        sep = "" if content == "" or content.endswith("\n") else "\n"
        with open(file, "a", encoding="utf-8") as f:
            f.write(f"{sep}{STATE_FILE}\n")
        print(f"Added {STATE_FILE} to .gitignore (it contains your deploy token).")
    except OSError:
        # Best-effort; the help text still warns about committing the state file.
        pass


def post_json(url, payload):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as res:
            status = res.status
            raw = res.read()
    except urllib.error.HTTPError as err:
        status = err.code
        raw = err.read()
    except (urllib.error.URLError, OSError) as err:
        reason = getattr(err, "reason", err)
        print(f"Upload failed: {reason}", file=sys.stderr)
        sys.exit(1)
    try:
        body = json.loads(raw)
    except ValueError:
        body = None
    return status, body


def deploy(args):
    if not os.path.isdir(args.dir):
        print(f"Not a directory: {args.dir}", file=sys.stderr)
        sys.exit(1)

    files, total_bytes = collect_files(args.dir)
    if not files:
        print("Nothing to deploy: the folder has no files (hidden files are skipped).", file=sys.stderr)
        sys.exit(1)
    if not any(f["path"].lower().endswith((".html", ".htm")) for f in files):
        print("Warning: no .html file found — the site may not have a homepage.", file=sys.stderr)

    linked = None
    if not args.force_new:
        state = try_read_state(args.dir)
        deploy_token = os.environ.get("HARVIS_DEPLOY_TOKEN") or (state or {}).get("deployToken")
        if state and state.get("subdomain") and deploy_token:
            linked = {"subdomain": state["subdomain"], "deployToken": deploy_token}

    action = f"Updating {linked['subdomain']}" if linked else "Uploading"
    plural = "" if len(files) == 1 else "s"
    print(f"{action}: {len(files)} file{plural} ({total_bytes / 1024:.1f} KB)...")

    def post_deploy(target):
        payload = {"files": files}
        if args.name:
            payload["name"] = args.name
        if target:
            payload["subdomain"] = target["subdomain"]
            payload["deployToken"] = target["deployToken"]
        return post_json(API_URL, payload)

    status, body = post_deploy(linked)

    if linked and status == 404:
        print(f"Site {linked['subdomain']} no longer exists (unclaimed sites expire after 24 hours). Creating a new site...")
        linked = None
        status, body = post_deploy(None)
    elif linked and status == 403:
        print(f"Deploy failed: the deploy token doesn't match site {linked['subdomain']}.", file=sys.stderr)
        print("Get the current token from the dashboard and run `harvis link " + linked["subdomain"] + " --token <token>`,", file=sys.stderr)
        print("or run `harvis --new` to create a fresh site.", file=sys.stderr)
        sys.exit(1)

    if status >= 400 or not body or not body.get("url"):
        message = (body or {}).get("error") or f"HTTP {status}"
        print(f"Deploy failed: {message}", file=sys.stderr)
        sys.exit(1)

    state = {
        "url": body["url"],
        "subdomain": body.get("subdomain"),
        "name": body.get("name"),
        "deployToken": body.get("deployToken"),
        "deployedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if body.get("claimUrl"):
        state["claimUrl"] = body["claimUrl"]
    write_state(args.dir, state)
    ensure_gitignored(args.dir)

    print("")
    if linked:
        print(f"  Updated:   {body['url']}")
        if body.get("claimUrl"):
            print("")
            print("This site is still unclaimed and expires 24 hours after the last")
            print("deploy. Run `harvis claim` to keep it online permanently.")
    else:
        print(f"  Live site:   {body['url']}")
        if body.get("claimUrl"):
            print(f"  Claim link:  {body['claimUrl']}")
        print("")
        print("The claim link is private and single-use: open it and sign in to")
        print("manage the site. Run `harvis claim` to open it in your browser.")
        print("Unclaimed sites expire after 24 hours. Deploying this folder again")
        print("updates this same site.")

    if args.open_claim and body.get("claimUrl"):
        open_in_browser(body["claimUrl"])


def link(args):
    deploy_token = args.token or os.environ.get("HARVIS_DEPLOY_TOKEN")
    if not args.subdomain or not deploy_token:
        print("Usage: harvis link <subdomain> --token <token>", file=sys.stderr)
        print("Find the site's deploy token in the harvis.dev dashboard.", file=sys.stderr)
        sys.exit(1)
    state = try_read_state(os.getcwd()) or {}
    state["subdomain"] = args.subdomain
    state["deployToken"] = deploy_token
    write_state(os.getcwd(), state)
    ensure_gitignored(os.getcwd())
    print(f"Linked this folder to {args.subdomain}. Run `harvis` to deploy.")


def main():
    args = parse_args(sys.argv[1:])

    if args.command == "help":
        return print_help()
    if args.command == "version":
        return print(__version__)
    if args.command == "claim":
        state = read_state(os.getcwd())
        if not state.get("claimUrl"):
            print(f"No claim link in {STATE_FILE}.", file=sys.stderr)
            sys.exit(1)
        print(f"Opening claim link: {state['claimUrl']}")
        return open_in_browser(state["claimUrl"])
    if args.command == "open":
        state = read_state(os.getcwd())
        print(f"Opening live site: {state['url']}")
        return open_in_browser(state["url"])
    if args.command == "link":
        return link(args)
    return deploy(args)


if __name__ == "__main__":
    main()
