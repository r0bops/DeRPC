#!/usr/bin/env python3
"""Restricted SSH release operations, installed root-owned and run as derpc-deploy.

Only parse_command's grammar and CAR bytes are accepted from SSH. Constructor
overrides are for local tests, never SSH arguments or environment variables.
"""

import contextlib
import dataclasses
import datetime
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import select
import stat
import subprocess
import sys
import tempfile
import time


IPFS_BINARY = "/opt/derpc/bin/ipfs"
IPFS_API = "/ip4/127.0.0.1/tcp/5001"
STATE_DIRECTORY = "/var/lib/derpc-release"
PUBLISH_KEY = "derpc-website"
IPNS_NAME = "k51qzi5uqu5dip6ttqcmj10rokc1dq8ppmppbo05grxwha1yvabumx7k1k9jhc"
MAX_BYTES = 64 * 1024 * 1024
MAX_INTEGER = (1 << 63) - 1
CID_PATTERN = r"bafybei[a-z2-7]{52}"
HASH_PATTERN = r"[0-9a-f]{64}"
SOURCE_PATTERN = r"[0-9a-f]{40}"
INTEGER_PATTERN = r"[1-9][0-9]{0,18}"


class ReleaseError(Exception):
    """A public, non-secret failure suitable for the SSH response."""


@dataclasses.dataclass(frozen=True)
class Request:
    action: str
    cid: str = ""
    car_sha256: str = ""
    source_sha: str = ""
    run_number: int = 0
    run_id: int = 0
    legacy: bool = False

    def release_tuple(self):
        return {"runNumber": self.run_number, "runId": self.run_id,
                "cid": self.cid, "carSha256": self.car_sha256,
                "sourceSha": self.source_sha}


def parse_command(command):
    if not isinstance(command, str) or len(command) > 512:
        raise ReleaseError("invalid release command")
    if command == "status":
        return Request("status")
    if re.fullmatch(CID_PATTERN, command):
        return Request("pin", cid=command, legacy=True)
    pin = re.fullmatch(rf"pin ({CID_PATTERN}) ({HASH_PATTERN}) ({SOURCE_PATTERN})", command)
    if pin:
        return Request("pin", *pin.groups())
    publish = re.fullmatch(
        rf"publish ({CID_PATTERN}) ({HASH_PATTERN}) ({INTEGER_PATTERN}) "
        rf"({INTEGER_PATTERN}) ({SOURCE_PATTERN})", command)
    if publish:
        cid, car_hash, run, run_id, source = publish.groups()
        if int(run) <= MAX_INTEGER and int(run_id) <= MAX_INTEGER:
            return Request("publish", cid, car_hash, source, int(run), int(run_id))
    raise ReleaseError("expected status, pin CID CAR_SHA256 SOURCE_SHA, or "
                       "publish CID CAR_SHA256 RUN_NUMBER RUN_ID SOURCE_SHA")


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def subprocess_runner(argv, *, env, timeout, stdout=None):
    return subprocess.run(argv, env=env, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE if stdout is None else stdout,
                          stderr=subprocess.PIPE, timeout=timeout, check=True)


class ReleaseSite:
    def __init__(self, *, state_dir=STATE_DIRECTORY, ipfs_binary=IPFS_BINARY,
                 runner=subprocess_runner, max_bytes=MAX_BYTES,
                 upload_timeout=90, lock_timeout=15):
        self.state_dir = Path(state_dir)
        self.ipfs_binary = str(ipfs_binary)
        self.runner = runner
        self.max_bytes = max_bytes
        self.upload_timeout = upload_timeout
        self.lock_timeout = lock_timeout

    def prepare_state(self):
        self.state_dir.mkdir(mode=0o700, exist_ok=True)
        info = self.state_dir.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) & 0o077):
            raise ReleaseError("release state must be an owned mode-0700 directory")
        receipts = self.state_dir / "pins"
        receipts.mkdir(mode=0o700, exist_ok=True)
        info = receipts.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) & 0o077):
            raise ReleaseError("pin receipts must be an owned mode-0700 directory")

    @contextlib.contextmanager
    def locked(self):
        self.prepare_state()
        fd = os.open(self.state_dir / "release.lock",
                     os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        try:
            deadline = time.monotonic() + self.lock_timeout
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise ReleaseError("another release holds the deployment lock")
                    time.sleep(min(0.05, max(0, deadline - time.monotonic())))
            yield
        finally:
            os.close(fd)

    def atomic_json(self, path, data):
        path = Path(path)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8",
                                             dir=path.parent, delete=False) as file:
                temporary = file.name
                json.dump(data, file, sort_keys=True, indent=2)
                file.write("\n")
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, path)
            temporary = None
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if temporary is not None:
                os.unlink(temporary)

    @staticmethod
    def read_json(path):
        try:
            with open(path, encoding="utf-8") as file:
                value = json.load(file)
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as error:
            raise ReleaseError("release state is unreadable; operator repair required") from error
        if not isinstance(value, dict):
            raise ReleaseError("invalid release state; operator repair required")
        return value

    def ipfs(self, *args, repo=None, timeout=45, stdout=None):
        env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C",
               "IPFS_PATH": str(repo if repo is not None else self.state_dir / "client")}
        prefix = [self.ipfs_binary]
        if repo is None:
            prefix += ["--api", IPFS_API]
        return self.runner(prefix + list(args), env=env, timeout=timeout, stdout=stdout)

    @staticmethod
    def json_output(result):
        try:
            return json.loads(result.stdout)
        except (ValueError, TypeError) as error:
            raise ReleaseError("IPFS returned invalid JSON") from error

    @staticmethod
    def check_import(result, expected):
        try:
            events = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
            roots = [event["Root"] for event in events if "Root" in event]
            if (len(roots) != 1 or roots[0]["Cid"]["/"] != expected
                    or roots[0].get("PinErrorMsg") != ""):
                raise ValueError("unexpected root or incomplete DAG")
            if any(set(event) != {"Root"} for event in events):
                raise ValueError("unexpected import output")
        except (ValueError, TypeError, KeyError, AttributeError) as error:
            raise ReleaseError("CAR must contain one matching root with a complete valid DAG") from error

    def check_identity(self):
        keys = self.json_output(self.ipfs("key", "ls", "--ipns-base=base36", "--enc=json", timeout=15))
        matches = [item for item in keys.get("Keys", []) if item.get("Name") == PUBLISH_KEY]
        if len(matches) != 1 or matches[0].get("Id") != IPNS_NAME:
            raise ReleaseError("website publishing key does not match the fixed IPNS identity")

    def check_pin(self, cid):
        pins = self.json_output(self.ipfs("pin", "ls", "--type=recursive", "--enc=json", cid, timeout=15))
        if pins.get("Keys", {}).get(cid, {}).get("Type") != "recursive":
            raise ReleaseError("release CID is not recursively pinned")

    def receive_car(self, stream, path):
        digest = hashlib.sha256()
        size = 0
        deadline = time.monotonic() + self.upload_timeout
        try:
            fd = stream.fileno()
        except (AttributeError, io.UnsupportedOperation):
            fd = None  # In-memory streams are used only by local tests.
        with open(path, "xb") as file:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ReleaseError("CAR upload exceeded its time limit")
                if fd is not None:
                    readable, _, _ = select.select([fd], [], [], remaining)
                    if not readable:
                        raise ReleaseError("CAR upload exceeded its time limit")
                    chunk = os.read(fd, min(65536, self.max_bytes + 1 - size))
                else:
                    chunk = stream.read(min(65536, self.max_bytes + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                if size > self.max_bytes:
                    raise ReleaseError("CAR upload exceeds the 64-MiB release limit")
                digest.update(chunk)
                file.write(chunk)
            file.flush()
            os.fsync(file.fileno())
        if size == 0:
            raise ReleaseError("empty CAR upload")
        return size, digest.hexdigest()

    def receipt_path(self, request):
        identity = f"{request.cid} {request.car_sha256} {request.source_sha}".encode()
        return self.state_dir / "pins" / (hashlib.sha256(identity).hexdigest() + ".json")

    def pin(self, request, stream):
        with tempfile.TemporaryDirectory(prefix="upload-", dir=self.state_dir) as temporary:
            work = Path(temporary)
            upload = work / "upload.car"
            size, digest = self.receive_car(stream, upload)
            if not request.legacy and digest != request.car_sha256:
                raise ReleaseError("CAR SHA-256 does not match the tested artifact")
            repo = work / "validation-repo"
            self.ipfs("init", "--profile=server", repo=repo, timeout=20)
            options = ("dag", "import", "--pin-roots=true", "--fast-provide-root=false",
                       "--fast-provide-dag=false", "--enc=json")
            self.check_import(self.ipfs("--offline", *options, str(upload), repo=repo, timeout=60), request.cid)
            # Only this root's DAG enters the live repository. Uploaded orphan
            # blocks disappear with the temporary offline validation repository.
            canonical = work / "canonical.car"
            with open(canonical, "xb") as output:
                self.ipfs("--offline", "dag", "export", request.cid,
                          repo=repo, timeout=45, stdout=output)
            if not 0 < canonical.stat().st_size <= self.max_bytes:
                raise ReleaseError("canonical CAR exceeds the release size limit or is empty")
            self.check_import(self.ipfs(*options, str(canonical), timeout=60), request.cid)
            self.check_pin(request.cid)
            receipt = {"schemaVersion": 1, "status": "pinned", "cid": request.cid,
                       "carSha256": digest, "carBytes": size, "sourceSha": request.source_sha,
                       "validatedOffline": True, "canonicalDagImported": True,
                       "pinnedAt": now(), "publishAuthorized": not request.legacy}
            if not request.legacy:
                self.atomic_json(self.receipt_path(request), receipt)
            return receipt

    @staticmethod
    def check_order(request, state):
        if state is None:
            return False
        accepted = state.get("accepted")
        if not isinstance(accepted, dict):
            raise ReleaseError("missing accepted release watermark; operator repair required")
        for field in ("runNumber", "runId"):
            if type(accepted.get(field)) is not int or not 0 < accepted[field] <= MAX_INTEGER:
                raise ReleaseError("invalid release watermark; operator repair required")
        for field, pattern in (("cid", CID_PATTERN), ("carSha256", HASH_PATTERN), ("sourceSha", SOURCE_PATTERN)):
            if not isinstance(accepted.get(field), str) or not re.fullmatch(pattern, accepted[field]):
                raise ReleaseError("invalid release watermark; operator repair required")
        proposed = request.release_tuple()
        if proposed == accepted:
            return True
        if (request.run_number <= accepted["runNumber"]
                or request.run_id <= accepted["runId"]):
            raise ReleaseError("stale or conflicting release; accepted watermark is retained")
        return False

    def publish(self, request):
        path = self.state_dir / "publication.json"
        previous = self.read_json(path)
        exact_retry = self.check_order(request, previous)
        receipt = self.read_json(self.receipt_path(request))
        if (receipt is None or receipt.get("publishAuthorized") is not True
                or receipt.get("status") != "pinned" or receipt.get("cid") != request.cid
                or receipt.get("carSha256") != request.car_sha256
                or receipt.get("sourceSha") != request.source_sha
                or receipt.get("validatedOffline") is not True
                or receipt.get("canonicalDagImported") is not True):
            raise ReleaseError("matching validated pin receipt is required before publication")
        self.check_identity()
        self.check_pin(request.cid)
        if exact_retry and previous.get("status") == "published":
            return {**previous, "exactRetry": True}
        state = {"schemaVersion": 1, "ipnsName": IPNS_NAME,
                 "accepted": request.release_tuple(), "status": "pending",
                 "acceptedAt": previous["acceptedAt"] if exact_retry else now(),
                 "attemptedAt": now(), "httpsVerified": False,
                 "lastSuccessful": previous.get("lastSuccessful") if previous else None}
        # Persist before network publication. Kubo can save and subsequently
        # republish this target even if the SSH connection or publish call fails.
        self.atomic_json(path, state)
        try:
            result = self.ipfs("--timeout=90s", "name", "publish",
                               f"--key={PUBLISH_KEY}", "--lifetime=48h", "--ttl=5m",
                               "--ipns-base=base36", "--enc=json", f"/ipfs/{request.cid}",
                               timeout=100)
            published = self.json_output(result)
            if published.get("Name") != IPNS_NAME or published.get("Value") != f"/ipfs/{request.cid}":
                raise ReleaseError("IPNS publish response does not match the fixed name and release")
        except (subprocess.SubprocessError, OSError, ReleaseError) as error:
            state["status"] = "publish-uncertain"
            state["finishedAt"] = now()
            state["detail"] = "Publication may have succeeded; verify the public signed record. Exact release retry is allowed."
            self.atomic_json(path, state)
            raise ReleaseError(state["detail"]) from error
        state["status"] = "published"
        state["finishedAt"] = now()
        state["lastSuccessful"] = {**request.release_tuple(), "publishedAt": state["finishedAt"]}
        state["detail"] = "IPNS publish acknowledged; public signed-record and HTTPS verification remain required."
        self.atomic_json(path, state)
        return state

    def execute(self, command, stream=None):
        request = parse_command(command)
        with self.locked():
            if request.action == "status":
                self.check_identity()
                return {"ipnsName": IPNS_NAME, "keyIdentityMatches": True,
                        "publication": self.read_json(self.state_dir / "publication.json")}
            if request.action == "pin":
                return self.pin(request, sys.stdin.buffer if stream is None else stream)
            return self.publish(request)


def main():
    os.umask(0o077)
    try:
        if len(sys.argv) != 1:
            raise ReleaseError("helper arguments are not supported")
        result = ReleaseSite().execute(os.environ.get("SSH_ORIGINAL_COMMAND", ""))
        print(json.dumps({"ok": True, **result}, sort_keys=True))
        return 0
    except (ReleaseError, subprocess.SubprocessError, OSError) as error:
        # Never expose arbitrary archive bytes or subprocess stderr in responses.
        detail = str(error) if isinstance(error, ReleaseError) else "release operation failed or timed out"
        print(json.dumps({"ok": False, "error": detail}), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
