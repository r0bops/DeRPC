"""Boundary tests for the SSH publisher; no VPS or live IPNS key is used.

Run: python3 -m unittest discover -s scripts/vps -p 'test_release_site.py'
Optional real offline CAR checks: set DERPC_TEST_IPFS to a trusted Kubo binary.
"""

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest


SPEC = importlib.util.spec_from_file_location("derpc_release_site", Path(__file__).with_name("release-site.py"))
release = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = release
SPEC.loader.exec_module(release)

CID = "bafybeidksnvtvc7n4ciiflw7o2gc563lqaxtulmqix2cxvddvhc4sv24me"
OTHER_CID = "bafybei" + "a" * 52
SOURCE = "a" * 40
OTHER_SOURCE = "b" * 40
UPLOAD = b"CAR fixture containing the desired DAG plus unrelated blocks"
HASH = hashlib.sha256(UPLOAD).hexdigest()
CANONICAL = b"canonical export containing only the desired DAG"


def root_event(cid=CID, error=""):
    return {"Root": {"Cid": {"/": cid}, "PinErrorMsg": error}}


def completed(argv, value):
    payload = value if isinstance(value, bytes) else json.dumps(value).encode()
    return subprocess.CompletedProcess(argv, 0, payload, b"")


class FakeIPFS:
    def __init__(self):
        self.calls = []
        self.import_events = [root_event()]
        self.import_failure = False
        self.live_imports = []
        self.pins = {OTHER_CID}
        self.identity = release.IPNS_NAME
        self.publish_failure = False
        self.publish_response = None
        self.on_publish = None
        self.published = []

    def __call__(self, argv, *, env, timeout, stdout=None):
        self.calls.append((list(argv), dict(env), timeout))
        if "init" in argv:
            return completed(argv, b"initialized offline fixture")
        if "import" in argv:
            if "--offline" in argv:
                if self.import_failure:
                    raise subprocess.CalledProcessError(1, argv, stderr=b"corrupt CAR")
                return completed(argv, b"\n".join(json.dumps(item).encode() for item in self.import_events))
            self.live_imports.append(Path(argv[-1]).read_bytes())
            self.pins.add(CID)
            return completed(argv, root_event())
        if "export" in argv:
            stdout.write(CANONICAL)
            return completed(argv, b"")
        if "key" in argv:
            return completed(argv, {"Keys": [{"Name": release.PUBLISH_KEY, "Id": self.identity}]})
        if "pin" in argv:
            return completed(argv, {"Keys": {cid: {"Type": "recursive"} for cid in self.pins}})
        if "publish" in argv:
            if self.on_publish:
                self.on_publish()
            self.published.append(argv[-1])
            if self.publish_failure:
                # Model Kubo having saved the target before its network call times out.
                raise subprocess.TimeoutExpired(argv, timeout)
            return completed(argv, self.publish_response or {"Name": release.IPNS_NAME, "Value": argv[-1]})
        raise AssertionError(f"unexpected command: {argv}")


class ParserTests(unittest.TestCase):
    def test_exact_commands(self):
        self.assertEqual(release.parse_command("status").action, "status")
        self.assertTrue(release.parse_command(CID).legacy)
        request = release.parse_command(f"pin {CID} {HASH} {SOURCE}")
        self.assertEqual((request.cid, request.car_sha256, request.source_sha), (CID, HASH, SOURCE))
        request = release.parse_command(f"publish {CID} {HASH} 12 345 {SOURCE}")
        self.assertEqual((request.run_number, request.run_id), (12, 345))

    def test_malicious_or_ambiguous_commands_are_rejected(self):
        commands = ["", " status", "status\n", "status; id", "status extra", "$(id)",
                    f"{CID};id", f"pin {CID} {HASH} {SOURCE}\n", f"pin\t{CID} {HASH} {SOURCE}",
                    f"pin {CID} {HASH.upper()} {SOURCE}", f"pin /ipfs/{CID} {HASH} {SOURCE}",
                    f"publish {CID} {HASH} 0 1 {SOURCE}", f"publish {CID} {HASH} 01 1 {SOURCE}",
                    f"publish {CID} {HASH} -1 1 {SOURCE}", f"publish {CID} {HASH} 1 9223372036854775808 {SOURCE}",
                    f"publish {CID} {HASH} 1 2 {SOURCE} --key=self", "x" * 513]
        for command in commands:
            with self.subTest(command=command), self.assertRaises(release.ReleaseError):
                release.parse_command(command)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name) / "state"
        self.fake = FakeIPFS()
        self.helper = release.ReleaseSite(state_dir=self.state, ipfs_binary="/trusted/test/ipfs", runner=self.fake)

    def pin(self, source=SOURCE):
        return self.helper.execute(f"pin {CID} {HASH} {source}", io.BytesIO(UPLOAD))

    def publish(self, number=10, run_id=100, source=SOURCE, car_hash=HASH):
        return self.helper.execute(f"publish {CID} {car_hash} {number} {run_id} {source}")

    def state_record(self):
        return json.loads((self.state / "publication.json").read_text())

    def test_sha_mismatch_never_reaches_ipfs(self):
        with self.assertRaisesRegex(release.ReleaseError, "SHA-256"):
            self.helper.execute(f"pin {CID} {'0' * 64} {SOURCE}", io.BytesIO(UPLOAD))
        self.assertEqual(self.fake.calls, [])
        self.assertEqual(list((self.state / "pins").iterdir()), [])
        self.assertEqual(list(self.state.glob("upload-*")), [])

    def test_empty_and_oversized_uploads_are_rejected(self):
        helper = release.ReleaseSite(state_dir=self.state, runner=self.fake, max_bytes=8)
        for payload in (b"", b"a" * 9):
            with self.subTest(payload=payload), self.assertRaises(release.ReleaseError):
                helper.execute(CID, io.BytesIO(payload))
        self.assertEqual(self.fake.calls, [])

    def test_stalled_pipe_has_upload_deadline(self):
        read_fd, write_fd = os.pipe()
        helper = release.ReleaseSite(state_dir=self.state, runner=self.fake, upload_timeout=0.02)
        try:
            with os.fdopen(read_fd, "rb", buffering=0) as reader:
                with self.assertRaisesRegex(release.ReleaseError, "time limit"):
                    helper.execute(CID, reader)
        finally:
            os.close(write_fd)
        self.assertEqual(self.fake.calls, [])

    def test_invalid_root_or_pin_error_cannot_reach_live_import(self):
        cases = [[], [root_event(OTHER_CID)], [root_event(error="missing block")],
                 [root_event(), root_event(OTHER_CID)], [{"Root": {"Cid": {"/": CID}}}]]
        for events in cases:
            self.fake.import_events = events
            with self.subTest(events=events), self.assertRaises(release.ReleaseError):
                self.pin()
        self.assertEqual(self.fake.live_imports, [])
        self.assertEqual(self.fake.pins, {OTHER_CID})

    def test_corrupt_car_import_failure_never_reaches_live_import(self):
        self.fake.import_failure = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.pin()
        self.assertEqual(self.fake.live_imports, [])
        self.assertEqual(list((self.state / "pins").iterdir()), [])

    def test_only_canonical_root_dag_is_imported_and_old_pins_remain(self):
        receipt = self.pin()
        self.assertEqual(self.fake.live_imports, [CANONICAL])
        self.assertEqual(self.fake.pins, {CID, OTHER_CID})
        self.assertTrue(receipt["publishAuthorized"])
        self.assertEqual(receipt["carSha256"], HASH)
        self.assertEqual(list(self.state.glob("upload-*")), [])
        for argv, env, timeout in self.fake.calls:
            self.assertEqual(argv[0], "/trusted/test/ipfs")
            self.assertEqual(set(env), {"PATH", "LC_ALL", "IPFS_PATH"})
            self.assertGreater(timeout, 0)
            self.assertNotIn("rm", argv)
            if "--api" in argv:
                self.assertEqual(argv[argv.index("--api") + 1], release.IPFS_API)

    def test_legacy_pin_cannot_authorize_publication(self):
        receipt = self.helper.execute(CID, io.BytesIO(UPLOAD))
        self.assertFalse(receipt["publishAuthorized"])
        self.assertEqual(list((self.state / "pins").iterdir()), [])
        with self.assertRaisesRegex(release.ReleaseError, "pin receipt"):
            self.publish()
        self.assertEqual(self.fake.published, [])

    def test_receipt_is_bound_to_source_and_artifact(self):
        self.pin()
        for source, digest in ((OTHER_SOURCE, HASH), (SOURCE, "0" * 64)):
            with self.subTest(source=source, digest=digest), self.assertRaisesRegex(release.ReleaseError, "pin receipt"):
                self.publish(source=source, car_hash=digest)

    def test_fixed_key_identity_and_recursive_pin_required(self):
        self.pin()
        self.fake.identity = "wrong-key"
        with self.assertRaisesRegex(release.ReleaseError, "fixed IPNS identity"):
            self.publish()
        self.fake.identity = release.IPNS_NAME
        self.fake.pins.remove(CID)
        with self.assertRaisesRegex(release.ReleaseError, "recursively pinned"):
            self.publish()
        self.assertFalse((self.state / "publication.json").exists())

    def test_watermark_is_persisted_before_publish_and_exact_retry_republishes(self):
        self.pin()
        def inspect_pending():
            state = self.state_record()
            self.assertEqual(state["status"], "pending")
            self.assertEqual(state["accepted"]["runNumber"], 10)
        self.fake.on_publish = inspect_pending
        result = self.publish()
        self.assertEqual(result["status"], "published")
        self.assertFalse(result["httpsVerified"])
        self.assertTrue(self.publish()["exactRetry"])
        self.assertEqual(len(self.fake.published), 2)
        self.assertEqual((self.state / "publication.json").stat().st_mode & 0o777, 0o600)

    def test_timeout_keeps_watermark_and_allows_only_exact_or_newer_release(self):
        self.pin()
        self.fake.publish_failure = True
        with self.assertRaisesRegex(release.ReleaseError, "may have succeeded"):
            self.publish()
        self.assertEqual(self.state_record()["status"], "publish-uncertain")
        for number, run_id in ((9, 99), (10, 101), (11, 100)):
            with self.subTest(number=number, run_id=run_id), self.assertRaisesRegex(release.ReleaseError, "stale or conflicting"):
                self.publish(number, run_id)
        self.fake.publish_failure = False
        self.assertEqual(self.publish()["status"], "published")
        self.assertEqual(len(self.fake.published), 2)
        self.assertEqual(self.publish(11, 101)["accepted"]["runNumber"], 11)
        with self.assertRaisesRegex(release.ReleaseError, "stale or conflicting"):
            self.publish()

    def test_same_run_cannot_change_artifact_or_source(self):
        self.pin()
        self.pin(OTHER_SOURCE)
        self.publish()
        with self.assertRaisesRegex(release.ReleaseError, "stale or conflicting"):
            self.publish(source=OTHER_SOURCE)
        self.assertEqual(self.state_record()["accepted"]["sourceSha"], SOURCE)

    def test_newer_run_number_does_not_require_ordered_run_ids(self):
        self.pin()
        self.publish(10, 100)
        result = self.publish(11, 99)
        self.assertEqual(result["accepted"]["runId"], 99)
        self.assertEqual(result["accepted"]["runNumber"], 11)

    def test_mismatching_publish_response_is_uncertain_not_rolled_back(self):
        self.pin()
        self.fake.publish_response = {"Name": release.IPNS_NAME, "Value": f"/ipfs/{OTHER_CID}"}
        with self.assertRaises(release.ReleaseError):
            self.publish()
        self.assertEqual(self.state_record()["status"], "publish-uncertain")
        self.assertEqual(self.state_record()["accepted"]["cid"], CID)

    def test_competing_invocation_cannot_publish_while_lock_is_held(self):
        self.pin()
        entered, finish = threading.Event(), threading.Event()
        failures = []
        def pause_publish():
            entered.set()
            if not finish.wait(2):
                raise AssertionError("test did not release publisher")
        def first_publish():
            try:
                self.publish()
            except Exception as error:
                failures.append(error)
        self.fake.on_publish = pause_publish
        worker = threading.Thread(target=first_publish)
        worker.start()
        try:
            self.assertTrue(entered.wait(1))
            contender = release.ReleaseSite(state_dir=self.state, runner=self.fake, lock_timeout=0.02)
            with self.assertRaisesRegex(release.ReleaseError, "deployment lock"):
                contender.execute(f"publish {CID} {HASH} 11 101 {SOURCE}")
            self.assertEqual(self.state_record()["accepted"]["runNumber"], 10)
        finally:
            finish.set()
            worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(failures, [])

    def test_corrupt_watermark_fails_closed(self):
        self.pin()
        self.helper.atomic_json(self.state / "publication.json", {"accepted": {"runNumber": True}})
        with self.assertRaisesRegex(release.ReleaseError, "watermark"):
            self.publish()
        self.assertEqual(self.fake.published, [])

    def test_status_is_public_and_does_not_publish(self):
        result = self.helper.execute("status")
        self.assertEqual(result["ipnsName"], release.IPNS_NAME)
        self.assertTrue(result["keyIdentityMatches"])
        self.assertIsNone(result["publication"])
        self.assertEqual(self.fake.published, [])

    def test_state_directory_symlink_or_public_permissions_are_rejected(self):
        target = Path(self.temporary.name) / "target"
        target.mkdir(mode=0o700)
        self.state.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(release.ReleaseError, "mode-0700"):
            self.helper.execute("status")
        self.state.unlink()
        self.state.mkdir(mode=0o755)
        self.state.chmod(0o755)
        with self.assertRaisesRegex(release.ReleaseError, "mode-0700"):
            self.helper.execute("status")


@unittest.skipUnless(os.environ.get("DERPC_TEST_IPFS"), "set DERPC_TEST_IPFS for real offline CAR checks")
class RealOfflineCarTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.binary = os.environ["DERPC_TEST_IPFS"]
        env = {"PATH": "/usr/bin:/bin", "IPFS_PATH": str(self.root / "packaging-repo")}
        def run(*args):
            return subprocess.run([self.binary, *args], env=env, check=True, capture_output=True, timeout=30).stdout
        run("init", "--profile=server")
        site = self.root / "site"
        site.mkdir()
        (site / "index.html").write_text("real offline validation fixture")
        self.cid = run("--offline", "add", "--cid-version=1", "--raw-leaves=true", "--recursive", "--quieter", str(site)).decode().strip()
        self.car = run("--offline", "dag", "export", self.cid)
        self.live_imports = []
        def runner(argv, *, env, timeout, stdout=None):
            if "--api" not in argv:
                return release.subprocess_runner(argv, env=env, timeout=timeout, stdout=stdout)
            if "import" in argv:
                self.live_imports.append(Path(argv[-1]).read_bytes())
                return completed(argv, root_event(self.cid))
            if "pin" in argv:
                return completed(argv, {"Keys": {self.cid: {"Type": "recursive"}}})
            raise AssertionError("real offline test must not invoke a live API")
        self.helper = release.ReleaseSite(state_dir=self.root / "state", ipfs_binary=self.binary, runner=runner)

    def test_real_complete_car_validates_and_exports(self):
        digest = hashlib.sha256(self.car).hexdigest()
        result = self.helper.execute(f"pin {self.cid} {digest} {SOURCE}", io.BytesIO(self.car))
        self.assertTrue(result["validatedOffline"])
        self.assertEqual(self.live_imports, [self.car])

    def test_real_corrupt_block_is_rejected_even_with_matching_upload_sha(self):
        corrupt = self.car[:-1] + bytes([self.car[-1] ^ 1])
        digest = hashlib.sha256(corrupt).hexdigest()
        with self.assertRaises(subprocess.CalledProcessError):
            self.helper.execute(f"pin {self.cid} {digest} {SOURCE}", io.BytesIO(corrupt))
        self.assertEqual(self.live_imports, [])


if __name__ == "__main__":
    unittest.main()
