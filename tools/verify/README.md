# Repository verification

Use Node 22 and Python 3.11 (declared in the root version files). Prepare a
Python environment before the first run:

```sh
python -m venv /path/to/verification-venv
# Activate that environment using the command appropriate to your shell.
python -m pip install -r ml/requirements.txt
npm run verify
```

Run `npm run verify` from the repository root. It installs the locked bridge
dependencies, syntax-checks tracked JavaScript, runs bridge tests and smoke,
runs all top-level benchmark `.mjs` entry points with `--ci` (200 latency
steps), runs Python tests, tests the scanner, and finally scans tracked files.
It stops on the first failed stage and returns a nonzero exit code. Missing
benchmark and ML directories are explicitly skipped. No game server is used.

The Python executable defaults to `python`. To select an existing environment
without activating it, set `A37_VERIFY_PYTHON` to its Python executable path.
GitHub Actions installs the Python dependencies and invokes the same npm
command, with a five-minute job timeout and npm/pip download caches.

## Scanner policy

Run `npm run test:scanner` for the scanner tests, or
`node tools/verify/scan-secrets.mjs` for the scan alone. Only Git-tracked files
are scanned; newly created files enter the scan after `git add`. Modified
tracked files are read from the working tree. Files ending in `.example` and
binary content containing NUL bytes are excluded.

The scanner rejects IPv4 literals, populated password assignments, and common
tunnel-provider HTTP(S) URLs. The unspecified IPv4 address is allowed as a
configuration placeholder, and the entire IPv4 loopback range is allowed.
Other IPv4 addresses still fail the scan. Empty passwords, explicit placeholder tokens, and
password reads from environment variables are allowed. Reports contain only
the file, line number, and finding type; matched values are redacted. This is a
targeted check for issue #37, not a comprehensive credential detector.

## PR review fixes

Ben approved allowing the full loopback range, which removes the 50 existing
local-address findings. Tests cover loopback addresses and rejection of nearby
non-loopback ranges and private network addresses.
One of the original lines also contained a private address used by a negative
test. With user approval, that test now constructs the same address from
octets, preserving its behavior without exempting private addresses.

The combat benchmark's `J1_REF` now points to the reviewed historical commit
`f58ce2226f4c14cedb69ecf78ab1c65e685592a4` instead of the deleted remote
branch. CI retains `fetch-depth: 0` so that commit is available.

The version file and CI now select Node 22, matching the current bridge
lockfile's Mineflayer and minecraft-protocol requirements.

## Initial validation before review (Windows)

Validated with isolated Node 20.20.2 and Python 3.11.15 installations, without
changing the user's default runtimes:

- All tracked JavaScript syntax checks passed.
- Scanner tests: 3 passed.
- Python tests: 94 passed (6 upstream deprecation warnings).
- Bridge tests: 403 passed, 1 failed. The failure is
  `bridge/skills/registry.test.js:96`, where Windows denies a directory symlink
  with `EPERM`. It occurs both in the baseline and through the new runner.
  Symlink privileges or an approved portable test change are needed locally;
  the GitHub workflow uses Ubuntu, where all 404 bridge tests passed in the
  initial PR check.
- Bridge smoke test passed.
- Latency CI benchmark: 100% of 200 steps under its threshold, passed.
- Combat CI benchmark failed on the then-absent remote ref, since fixed above.
- The tracked-file scan found the 50 existing loopback lines. Adding a
  temporary fake address to `README.md` produced finding `README.md:207` and
  increased the total to 51; the scanner exited 1. The document was then
  restored byte-for-byte. The fixture CLI test separately proves a clean scan
  exits 0 and fails after a tracked bad line is introduced.
- `npm run verify` exited 1 at the bridge tests, correctly stopping the run.
  Its later stages were validated individually as listed above. The full
  fake-address proof through `npm run verify`, a successful clean-clone run,
  and the five-minute CI target were not established in that initial local
  run. These results describe validation before the review fixes above.

## Validation after review fixes (Windows)

Using isolated Node 22.23.4:

- Scanner tests: 4 passed, including the loopback regression test.
- Tracked-file scanner passed. A temporary fake address in `README.md:207`
  produced exactly one finding and exit 1; restoring the original document
  returned the scanner to exit 0.
- Combat CI benchmark passed: 17 of 20, target 16, using the pinned revision.
- Latency CI benchmark passed: 100% of 200 steps under the threshold.
- Bridge smoke test passed.
- Full bridge suite: 403 passed; the same Windows directory-symlink permission
  failure remains. The changed planned-runner test file was then rerun from
  `bridge/`: all 36 tests passed.
- GitHub CI provides Linux validation of the complete command. The complete
  local verification command still cannot pass the Windows symlink test.
