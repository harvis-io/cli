"""harvis — deploy the current folder to harvis.dev with one command."""

import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
import zipfile
from datetime import datetime, timezone

from harvis import __version__

API_URL = os.environ.get("HARVIS_API_URL", "https://harvis.dev/api/upload")
MAX_FILES = 500
MAX_PROJECT_BYTES = 50 * 1024 * 1024

# Site links and deploy tokens live in a per-user store outside the project,
# so a rebuild that wipes the output folder cannot lose them and nothing is
# written into the project itself.
CREDENTIALS_FILE = "credentials.json"

# Anything that marks the top of a project.
PROJECT_MARKERS = (
    ".git", "package.json", "pyproject.toml", "deno.json",
    "deno.jsonc", "go.mod", "Cargo.toml", "Gemfile", "composer.json",
)

IGNORED_DIRS = {"node_modules", "__MACOSX"}
IGNORED_FILES = {"Thumbs.db", "desktop.ini", "harvis.json"}

# Formats that deflate well. Media formats (png, jpg, woff2, mp4…) are
# already compressed, so zipping them gains nothing.
COMPRESSIBLE_EXTENSIONS = {
    ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
    ".json", ".map", ".txt", ".md", ".markdown", ".svg", ".xml", ".rss",
    ".atom", ".yml", ".yaml", ".csv", ".tsv", ".webmanifest", ".ini", ".toml",
}


def print_help():
    print(f"""harvis — deploy the current folder to harvis.dev

Usage:
  harvis                     Deploy the current folder (updates the linked
                             site if this project has one, else creates one)
  harvis deploy [dir]        Deploy a folder (default: current folder)
  harvis link [subdomain]    Link this project to an existing site
                             (--token is enough; the name is optional)
  harvis claim               Open the claim link of the last deploy
  harvis open                Open the live site of the last deploy

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
  {credentials_path()}
so rebuilding or deleting the output folder never loses them.

The token stays valid after you claim the site, and you can view or
regenerate it in the dashboard — use it with `harvis link`, or set
HARVIS_DEPLOY_TOKEN, to deploy from CI. The token is the only secret
CI needs: it identifies the site by itself.

Unclaimed sites expire 24 hours after the last deploy. Claim a site to
keep it online.""")


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
        elif a == "--subdomain":
            i += 1
            args.subdomain = argv[i] if i < len(argv) else None
        elif a.startswith("--subdomain="):
            args.subdomain = a[len("--subdomain="):]
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
            if len(rest) > 1:
                args.subdomain = rest[1]
        else:
            args.dir = os.path.abspath(first)
    return args


def is_compressible(name):
    ext = os.path.splitext(name)[1].lower()
    # Extensionless files (LICENSE, CNAME…) are almost always text.
    return ext == "" or ext in COMPRESSIBLE_EXTENSIONS


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
                files.append({
                    "path": rel_path,
                    "data": buf,
                    "compressible": is_compressible(entry.name),
                })
                if len(files) > MAX_FILES:
                    print(f"Too many files: the limit is {MAX_FILES} per site.", file=sys.stderr)
                    sys.exit(1)
                if total_bytes > MAX_PROJECT_BYTES:
                    print(f"Folder too large: the limit is {MAX_PROJECT_BYTES // 1024 // 1024}MB per site.", file=sys.stderr)
                    sys.exit(1)

    walk(root_dir)
    return files, total_bytes


def should_zip(files, total_bytes):
    """Zip when deflating pays for itself: text shrinks ~60-70%, while already-
    compressed media gains nothing, so a folder that is (almost) all media
    uploads as raw multipart instead. A lone .zip file is always wrapped —
    sent bare, the server would extract the file itself."""
    if len(files) == 1 and re.search(r"\.zip$", files[0]["path"], re.IGNORECASE):
        return True
    compressible_bytes = sum(len(f["data"]) for f in files if f["compressible"])
    return compressible_bytes >= total_bytes * 0.1


def build_zip(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for f in files:
            if f["compressible"]:
                zf.writestr(zipfile.ZipInfo(f["path"]), f["data"], zipfile.ZIP_DEFLATED, 6)
            else:
                zf.writestr(zipfile.ZipInfo(f["path"]), f["data"], zipfile.ZIP_STORED)
    return buf.getvalue()


def build_multipart(files, fields):
    boundary = "----harvis" + uuid.uuid4().hex
    parts = []
    for key, value in fields.items():
        if not value:
            continue
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode("utf-8")
        )
    for f in files:
        # The paired "paths" field is the source of truth for the relative
        # path; the filename only needs to be a safe label.
        label = f["path"].split("/")[-1].replace('"', "_").replace("\r", "_").replace("\n", "_")
        parts.append(
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{label}"\r\n'
                "Content-Type: application/octet-stream\r\n\r\n"
            ).encode("utf-8")
        )
        parts.append(f["data"])
        parts.append(
            f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="paths"\r\n\r\n{f["path"]}\r\n'.encode("utf-8")
        )
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def fmt_bytes(n):
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.1f} MB"


class _Progress:
    """Renders on stderr only when it is an interactive terminal, so pipes
    and CI logs stay clean."""

    def __init__(self, total):
        self.total = total
        self.sent = 0
        self.enabled = sys.stderr.isatty()
        self._last = ""

    def update(self, n):
        self.sent += n
        if not self.enabled:
            return
        pct = min(100, round(self.sent * 100 / self.total)) if self.total else 100
        width = 24
        filled = round(width * pct / 100)
        bar = "█" * filled + "░" * (width - filled)
        line = f"  {fmt_bytes(self.sent)} / {fmt_bytes(self.total)} [{bar}] {pct}%"
        if line != self._last:
            sys.stderr.write("\r\x1b[2K" + line)
            sys.stderr.flush()
            self._last = line

    def done(self):
        if self.enabled and self._last:
            sys.stderr.write("\r\x1b[2K")
            sys.stderr.flush()


class _ProgressReader:
    """File-like body wrapper: http.client reads it in blocks, which is what
    lets us count the bytes as they go out."""

    def __init__(self, data, progress):
        self._buf = io.BytesIO(data)
        self._progress = progress

    def read(self, n=-1):
        chunk = self._buf.read(n)
        if chunk:
            self._progress.update(len(chunk))
        return chunk


def upload(url, payload, content_type):
    """POST `payload` to `url` with upload progress. Returns (status, body)
    where body is parsed JSON or None."""
    progress = _Progress(len(payload))
    req = urllib.request.Request(
        url,
        data=_ProgressReader(payload, progress),
        headers={
            "Content-Type": content_type,
            "Content-Length": str(len(payload)),
            # The default Python-urllib user agent is rejected at the edge (403).
            "User-Agent": f"harvis/{__version__}",
        },
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
        progress.done()
        reason = getattr(err, "reason", err)
        print(f"Upload failed: {reason}", file=sys.stderr)
        sys.exit(1)
    finally:
        progress.done()
    try:
        body = json.loads(raw)
    except ValueError:
        body = None
    return status, body


def open_in_browser(url):
    try:
        opened = webbrowser.open(url)
    except webbrowser.Error:
        opened = False
    if not opened:
        print(f"Could not open a browser. Open this URL yourself:\n  {url}", file=sys.stderr)


def config_dir():
    override = os.environ.get("HARVIS_CONFIG_DIR")
    if override:
        return os.path.abspath(override)
    if sys.platform == "win32" and os.environ.get("APPDATA"):
        return os.path.join(os.environ["APPDATA"], "harvis")
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "harvis")


def credentials_path():
    return os.path.join(config_dir(), CREDENTIALS_FILE)


def read_credentials():
    """{"sites": {<subdomain>: {url, name, deployToken, claimUrl, deployedAt}},
    "projects": {<projectRoot>: <subdomain>},
    "tokens": {<projectRoot>: <deployToken>}}

    `tokens` holds a token linked before its site name is known — the server
    resolves the site from the token, and the first deploy moves the entry
    into `sites` under the subdomain it returns."""
    try:
        with open(credentials_path(), encoding="utf-8") as f:
            raw = json.load(f)
        return {
            "sites": raw.get("sites") or {},
            "projects": raw.get("projects") or {},
            "tokens": raw.get("tokens") or {},
        }
    except (OSError, ValueError):
        # Missing or corrupt: start fresh rather than blocking the deploy.
        return {"sites": {}, "projects": {}, "tokens": {}}


def write_credentials(creds):
    file = credentials_path()
    try:
        os.makedirs(os.path.dirname(file), mode=0o700, exist_ok=True)
        # Write-then-rename so an interrupted write cannot truncate the store,
        # and 0600 because deploy tokens are secrets.
        tmp = f"{file}.{os.getpid()}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(creds, indent=2) + "\n")
        os.replace(tmp, file)
        os.chmod(file, 0o600)
    except OSError as err:
        print(f"Warning: could not save the deploy token to {file}: {err}", file=sys.stderr)


def find_project_root(start_dir):
    """The project root is the key a link is stored under: walking up from
    the deployed folder means `harvis deploy dist` links the project, not the
    build output."""
    home = os.path.expanduser("~")
    directory = start_dir
    while True:
        if any(os.path.exists(os.path.join(directory, m)) for m in PROJECT_MARKERS):
            return directory
        parent = os.path.dirname(directory)
        # Never walk past $HOME — a dotfiles repo there would swallow every project.
        if parent == directory or directory == home:
            return start_dir
        directory = parent


def resolve_link(start_dir, args=None):
    """Where a deploy goes, in order: flags, env (CI), then the per-user
    store keyed by project root.

    The token identifies the site on its own — the server resolves it — so a
    token with no subdomain is a complete target. A subdomain alongside it is
    sent as an assertion: the server rejects the pair if they disagree."""
    root = find_project_root(start_dir)
    creds = read_credentials()
    requested = (args.subdomain if args else None) or os.environ.get("HARVIS_SUBDOMAIN")
    subdomain = requested or creds["projects"].get(root)
    site = creds["sites"].get(subdomain) if subdomain else None
    parked = creds["tokens"].get(root)
    deploy_token = (
        (args.token if args else None)
        or os.environ.get("HARVIS_DEPLOY_TOKEN")
        or (site or {}).get("deployToken")
        or parked
    )
    # A parked token (`harvis link --token`, no name given) is the most recent
    # and most specific instruction there is, so let the server resolve the
    # site rather than asserting a name left over from an earlier link.
    asserted = None if deploy_token and deploy_token == parked and not requested else subdomain
    target = {"subdomain": asserted, "deployToken": deploy_token} if deploy_token else None
    return {"root": root, "subdomain": subdomain, "site": site, "target": target}


def remember_site(root, subdomain, body):
    creds = read_credentials()
    previous = creds["projects"].get(root)
    # A project points at one site; drop the record it replaced.
    if previous and previous != subdomain:
        creds["sites"].pop(previous, None)
    prior = creds["sites"].get(subdomain) or {}
    record = {
        "url": body["url"],
        "name": body.get("name") or prior.get("name"),
        # The server only returns the token on create; keep the stored one otherwise.
        "deployToken": body.get("deployToken") or prior.get("deployToken"),
        "deployedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    # Absent on a claimed site — dropping it keeps `harvis claim` honest.
    if body.get("claimUrl"):
        record["claimUrl"] = body["claimUrl"]
    creds["sites"][subdomain] = record
    creds["projects"][root] = subdomain
    # The site name is known now, so a token parked by `harvis link --token`
    # has a home under `sites` and the placeholder can go.
    if creds["tokens"].get(root):
        if not record["deployToken"]:
            record["deployToken"] = creds["tokens"][root]
        del creds["tokens"][root]
    write_credentials(creds)


def require_site(start_dir):
    resolved = resolve_link(start_dir)
    if not resolved["subdomain"]:
        print("This project is not linked to a site yet. Deploy first with: harvis", file=sys.stderr)
        sys.exit(1)
    site = resolved["site"]
    if not site or not site.get("url"):
        print(f"No local record of {resolved['subdomain']} in {credentials_path()}.", file=sys.stderr)
        print(f"Deploy again with `harvis`, or run `harvis link {resolved['subdomain']} --token <token>`.", file=sys.stderr)
        sys.exit(1)
    return site


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

    resolved = resolve_link(args.dir, args)
    linked = None if args.force_new else resolved["target"]
    if not args.force_new and resolved["subdomain"] and not linked:
        print(f"No deploy token for {resolved['subdomain']} in {credentials_path()} — creating a new site.", file=sys.stderr)
        print(f"Run `harvis link {resolved['subdomain']} --token <token>` to update it instead.", file=sys.stderr)

    use_zip = should_zip(files, total_bytes)
    zip_payload = build_zip(files) if use_zip else None
    size_note = (
        f"{fmt_bytes(total_bytes)} → {fmt_bytes(len(zip_payload))} zipped"
        if use_zip
        else fmt_bytes(total_bytes)
    )
    action = f"Updating {linked['subdomain'] or 'the linked site'}" if linked else "Uploading"
    plural = "" if len(files) == 1 else "s"
    print(f"{action}: {len(files)} file{plural} ({size_note})...")

    def post_deploy(target):
        url = API_URL
        if use_zip:
            # Raw zip body; metadata travels in query params.
            params = {}
            if args.name:
                params["name"] = args.name
            if target:
                # Optional: the token alone names the site. Sent when known so
                # the server can refuse a token/site mismatch instead of
                # overwriting.
                if target["subdomain"]:
                    params["subdomain"] = target["subdomain"]
                params["deployToken"] = target["deployToken"]
            if params:
                url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
            return upload(url, zip_payload, "application/zip")
        fields = {}
        if args.name:
            fields["name"] = args.name
        if target:
            if target["subdomain"]:
                fields["subdomain"] = target["subdomain"]
            fields["deployToken"] = target["deployToken"]
        payload, content_type = build_multipart(files, fields)
        return upload(url, payload, content_type)

    status, body = post_deploy(linked)

    if linked and status == 404:
        gone = f"Site {linked['subdomain']}" if linked["subdomain"] else "The linked site"
        print(f"{gone} no longer exists (unclaimed sites expire after 24 hours). Creating a new site...")
        linked = None
        status, body = post_deploy(None)
    elif linked and status == 403:
        print(
            f"Deploy failed: the deploy token doesn't match site {linked['subdomain']}."
            if linked["subdomain"]
            else "Deploy failed: the deploy token was not accepted.",
            file=sys.stderr,
        )
        print("Get the current token from the dashboard and run `harvis link --token <token>`,", file=sys.stderr)
        print("or run `harvis --new` to create a fresh site.", file=sys.stderr)
        sys.exit(1)

    if status >= 400 or not body or not body.get("url"):
        message = (body or {}).get("error") or f"HTTP {status}"
        print(f"Deploy failed: {message}", file=sys.stderr)
        sys.exit(1)

    subdomain = body.get("subdomain") or (linked or {}).get("subdomain")
    if subdomain:
        remember_site(resolved["root"], subdomain, body)

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
        print("Unclaimed sites expire after 24 hours. Deploying this project again")
        print("updates this same site.")

    if args.open_claim and body.get("claimUrl"):
        open_in_browser(body["claimUrl"])


def link(args):
    deploy_token = args.token or os.environ.get("HARVIS_DEPLOY_TOKEN")
    if not deploy_token:
        print("Usage: harvis link --token <token>  (or: harvis link <subdomain> --token <token>)", file=sys.stderr)
        print("Find the site's deploy token in the harvis.dev dashboard.", file=sys.stderr)
        sys.exit(1)
    root = find_project_root(os.getcwd())
    creds = read_credentials()
    previous = creds["projects"].get(root)
    if previous and previous != args.subdomain:
        creds["sites"].pop(previous, None)
    if args.subdomain:
        site = creds["sites"].get(args.subdomain) or {}
        site["deployToken"] = deploy_token
        creds["sites"][args.subdomain] = site
        creds["projects"][root] = args.subdomain
        creds["tokens"].pop(root, None)
    else:
        # No site name given: park the token until the first deploy reports
        # which site it belongs to.
        creds["projects"].pop(root, None)
        creds["tokens"][root] = deploy_token
    write_credentials(creds)
    if args.subdomain:
        print(f"Linked {root} to {args.subdomain}. Run `harvis` to deploy.")
    else:
        print(f"Linked {root} to the token's site. Run `harvis` to deploy — the site name is recorded then.")


def main():
    args = parse_args(sys.argv[1:])

    if args.command == "help":
        return print_help()
    if args.command == "version":
        return print(__version__)
    if args.command == "claim":
        site = require_site(os.getcwd())
        if not site.get("claimUrl"):
            print("No claim link for this site — it is already claimed, or was claimed elsewhere.", file=sys.stderr)
            sys.exit(1)
        print(f"Opening claim link: {site['claimUrl']}")
        return open_in_browser(site["claimUrl"])
    if args.command == "open":
        site = require_site(os.getcwd())
        print(f"Opening live site: {site['url']}")
        return open_in_browser(site["url"])
    if args.command == "link":
        return link(args)
    return deploy(args)


if __name__ == "__main__":
    main()
