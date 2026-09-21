# SNMP vendor lab matrix

The live poller must be tested against representative devices before production
credentials are enabled. The repository includes a gated runner at
`artifacts/api-server/src/lib/snmp-matrix.ts`. It does not send packets unless
the command includes `--live`.

## Safe run procedure

1. Build a lab-only target list. Never point this check at a production range or
   use a production community/password.
2. Copy the JSON shape below to a local, untracked file such as
   `snmp-lab.json`.
3. Put credentials in environment variables. The JSON contains variable names,
   never the credential values.
4. Run the preflight first:

   ```sh
   pnpm --filter @workspace/scripts snmp:matrix -- --config ./snmp-lab.json
   ```

5. Review the target and protocol summary, then run the live matrix:

   ```sh
   pnpm --filter @workspace/scripts snmp:matrix -- --config ./snmp-lab.json --live
   ```

For a controlled lab job, use the dedicated live command and inject the
credential variables through the job's secret store:

```sh
SNMP_MATRIX_CONFIG=./snmp-lab.json \
  pnpm --filter @workspace/scripts snmp:lab
```

`SNMP_MATRIX_CONFIG` is optional and defaults to the checked-in shape example.
Set the `SNMP_LAB_*` variables referenced by that JSON in the job environment
using your CI secret manager or lab runner's secret store. Do not put their
values in JSON, shell scripts, workflow files, or committed `.env` files.
The command never prints credential values. It prints one result for each
profile and protocol, and writes the same table to `GITHUB_STEP_SUMMARY` when
that CI variable is provided. A failed profile makes the job exit non-zero.

## Automated release gate

`.github/workflows/snmp-lab.yml` runs the release-gated matrix on a schedule and
is also reusable from a release workflow. Configure a protected `snmp-lab`
environment in the CI system with:

- `SNMP_MATRIX_CONFIG`: the complete lab matrix JSON, including only approved
  lab targets and environment-variable names for credentials;
- `SNMP_LAB_APPROVED_TARGETS`: a comma- or whitespace-separated exact list of
  every target in that matrix; and
- each `SNMP_LAB_*` credential referenced by the matrix, plus any required
  `HYDRANMS_*` MIB overrides.

The workflow writes the matrix JSON only to the runner's temporary directory.
The `snmp:release` command rejects a matrix entry that is not an exact match
for `SNMP_LAB_APPROVED_TARGETS`, so changing a target requires an intentional
CI environment update. Credential values are passed as masked CI environment
variables and are never put in the repository, command arguments, or reports.
The matrix table is retained as a workflow artifact, and a failed poll makes
the job fail. A release workflow must call this reusable workflow and make its
release/promotion job depend on the SNMP job's success.

The runner requires exactly one entry for each supported profile: Cisco, ZTE,
VSOL, MikroTik, Cambium, Juniper, vBNG, Servers, and Generic OLT. It requires
the matrix to include at least one v1, v2c, and v3 target. Every entry checks
`sysName`, positive `sysUpTime`, and at least one interface row. ZTE, VSOL, and
Generic OLT additionally require PON/ONU and optical readings by default. Set
an `expect` flag to `false` only when the specific lab model genuinely does not
expose that reading.

The Generic OLT profile uses the same environment overrides as the poller:
`HYDRANMS_PON_COUNT_OID`, `HYDRANMS_ONU_COUNT_OID`,
`HYDRANMS_RX_POWER_ROOT`, and `HYDRANMS_TX_POWER_ROOT`. Set these to the
vendor MIBs for the lab OLT before using `--live`; do not put them in the JSON
file if they contain device-specific information.

## Configuration shape

```json
{
  "checks": [
    {
      "profile": "cisco",
      "target": "192.0.2.11",
      "credential": {
        "version": "v2c",
        "communityEnv": "SNMP_LAB_CISCO_COMMUNITY"
      }
    },
    {
      "profile": "zte",
      "target": "192.0.2.12",
      "credential": {
        "version": "v3",
        "usernameEnv": "SNMP_LAB_ZTE_USER",
        "securityLevel": "authPriv",
        "authProtocol": "sha",
        "authPasswordEnv": "SNMP_LAB_ZTE_AUTH",
        "privProtocol": "aes",
        "privPasswordEnv": "SNMP_LAB_ZTE_PRIV"
      }
    },
    {
      "profile": "vsol",
      "target": "192.0.2.13",
      "credential": {
        "version": "v1",
        "communityEnv": "SNMP_LAB_VSOL_COMMUNITY"
      }
    }
  ]
}
```

The example is intentionally partial; the live runner rejects it until all
nine profiles are present. Use an RFC 5737 documentation address only as a
placeholder, not as a live target.

## Protocol coverage

Use separate representative devices where possible:

| Protocol          | Required checks                                                                       |
| ----------------- | ------------------------------------------------------------------------------------- |
| v1                | System identity/uptime, interface rows, and the profile-specific PON/optical readings |
| v2c               | Same checks with the v2c community and the device's read-only ACL                     |
| v3 `noAuthNoPriv` | Identity/uptime and interface rows on a device that permits this level                |
| v3 `authNoPriv`   | Identity/uptime, interface rows, and vendor readings with SHA/MD5 as configured       |
| v3 `authPriv`     | Identity/uptime, interface rows, and vendor readings with AES/DES as configured       |

The runner's required protocol coverage is v1, v2c, and v3. The v3 security
levels should be exercised during the lab run when the vendor supports them;
the runner validates the configured v3 credential shape and never logs
credential values.

## Release validation

The repository's normal `pnpm run typecheck` validation includes
`pnpm run snmp:preflight`. That check reads the committed shape example,
validates every supported profile and protocol without resolving credentials,
and runs the deterministic retention-state check. It sends no SNMP packets.
The live lab command is intentionally separate and must be invoked by a
controlled lab job after its targets and secret mappings have been reviewed.

## Failure and retention check

The runner always executes a deterministic failure check before live polling:
it seeds known telemetry, applies three failed polls, asserts that telemetry
and `lastSeen` remain unchanged, expects warning on misses one and two, and
expects offline on miss three. This exercises the same state transition helper
used by `recordPoll` in `nms-store.ts`.

For the lab checklist, after a successful live poll temporarily block the
device's SNMP source or stop the lab agent. Run three normal poll intervals and
confirm in the operator view or database that:

- `consecutiveFailures` increments to 3;
- status changes from warning to offline;
- `lastSeen`, interface rows, PON/ONU rows, and optical values remain at their
  last successful values; and
- restoring access produces an online status and resets failures to zero.

Do not use a production device for the outage step.
