# Repository verification

Use Node 20 and Python 3.11 (declared in the root version files). Prepare a
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
configuration placeholder. Empty passwords, explicit placeholder tokens, and
password reads from environment variables are allowed. Reports contain only
the file, line number, and finding type; matched values are redacted. This is a
targeted check for issue #37, not a comprehensive credential detector.

## Existing upstream blockers

At main revision `3f5792a`, the strict IPv4 policy flags 50 existing loopback
address lines. Examples include `README.md:113`, `bridge/server.js:12`,
`bridge/scripts/smoke.mjs:17`, and `tools/bridge/start-team.ps1:2`. No existing
files were changed or silently exempted to hide these findings. The lead must
decide whether loopback addresses should be allowed.

The combat benchmark's `loadJ1()` in `bridge/bench/combat.mjs` requires
`origin/combat-kill-hostile-skill`, even in CI mode. That remote branch is
absent. Fetching full history does not recreate a deleted branch. Verification
correctly fails rather than skipping the benchmark; fixing its source or
restoring the remote ref requires an upstream decision.

The current bridge lockfile resolves `mineflayer@4.39.0` and
`minecraft-protocol@1.68.0`, both declaring Node >=22. npm warns when installing
them under the issue's requested Node 20. Resolving this mismatch requires
approval to change the requested runtime or the bridge dependency versions.

## Local validation (Windows)

Validated with isolated Node 20.20.2 and Python 3.11.15 installations, without
changing the user's default runtimes:

- All tracked JavaScript syntax checks passed.
- Scanner tests: 3 passed.
- Python tests: 94 passed (6 upstream deprecation warnings).
- Bridge tests: 403 passed, 1 failed. The failure is
  `bridge/skills/registry.test.js:96`, where Windows denies a directory symlink
  with `EPERM`. It occurs both in the baseline and through the new runner.
  Symlink privileges or an approved portable test change are needed locally;
  the GitHub workflow uses Ubuntu, but has not been executed for this change.
- Bridge smoke test passed.
- Latency CI benchmark: 100% of 200 steps under its threshold, passed.
- Combat CI benchmark failed on the absent remote ref described above.
- The tracked-file scan found the 50 existing loopback lines. Adding a
  temporary fake address to `README.md` produced finding `README.md:207` and
  increased the total to 51; the scanner exited 1. The document was then
  restored byte-for-byte. The fixture CLI test separately proves a clean scan
  exits 0 and fails after a tracked bad line is introduced.
- `npm run verify` exited 1 at the bridge tests, correctly stopping the run.
  Its later stages were validated individually as listed above. The full
  fake-address proof through `npm run verify`, a successful clean-clone run,
  and the five-minute CI target remain unverified until the blockers are
  resolved. These results describe the local validation before PR submission.
