# Runbook — Playwright UI Testing Pipeline (Work Environment)

**Purpose:** Stand up automated Playwright UI testing for Ignition HMI projects, triggered and gated through Jira and executed via GitHub Actions on a self-hosted runner.

**Scope of this document:** every step proven in the homelab proof-of-concept, adapted for the corporate environment. The runner VM itself is provisioned by the internal infrastructure team and is therefore out of scope here — this runbook picks up once a Linux VM exists and is reachable.

**Model in one line:** Jira status change → GitHub Actions runs Playwright on an on-prem runner → tests pass or fail → Jira issue is promoted, or a bug is filed and it's demoted. Verification is automated; the final deploy to production stays a human decision.

---

## Prerequisites (before starting)

Confirm these are in place. The ones marked **⚠ corporate** are the pieces that differ from the homelab and typically involve other teams.

- **Runner VM** — Ubuntu 24.04 LTS, ~2 vCPU / 4 GB RAM / 25 GB disk, sudo user, OpenSSH enabled. *(Provisioned by internal infra team.)*
- **⚠ Network — gateway reach:** the VM must reach the target Ignition gateway on its web port (8088, or 8043 for SSL). Same subnet = no firewall change; different VLAN = one Palo Alto rule (runner IP → gateway IP, TCP 8088/8043, allow).
- **⚠ Network — GitHub reach:** the VM needs **outbound HTTPS (443)** to GitHub. The runner is pull-based — it initiates all connections; nothing connects inward. No inbound rules, no public exposure. Provide the GitHub Actions endpoint allowlist to whoever manages egress (`github.com`, `*.actions.githubusercontent.com`, `codeload.github.com`, `*.pkg.github.com`, etc.).
- **⚠ Proxy:** if corporate egress runs through a proxy, `apt`, `npm`, and the runner service all need proxy settings. Confirm with IT up front.
- **GitHub repo** — the `UI_Testing` repository (or the work equivalent) to hold test code and the workflow.
- **Jira** — admin rights on Project ARGUS to create Automation rules; the workflow transition IDs (see Phase 6).
- **Credentials to be created** — a GitHub token (Phase 3), a Jira API token (Phase 6). Store all as GitHub Actions secrets; never in files.

---

## Phase 1 — Prepare the runner VM

Run on the VM over SSH, as the sudo user (not root).

1. Copy the prep script (`prep-runner.sh`) onto the VM, or recreate it there.
2. Run it:
   ```bash
   chmod +x prep-runner.sh
   ./prep-runner.sh
   ```
   It installs Node 20, the browser system libraries Playwright needs, and creates `~/actions-runner`.
3. **Corporate difference:** if behind a proxy, export proxy variables before running, and add them to `apt` and `npm` config. If `apt`/`curl` can't reach the internet at all, the infra team must open egress first.

**Checkpoint:** script ends with the "DONE" banner and `node -v` shows v20.x.

---

## Phase 2 — Register the GitHub Actions runner

1. In the repo: **Settings → Actions → Runners → New self-hosted runner → Linux / x64**. GitHub shows a command block with a one-time token.
2. On the VM, run that block inside `~/actions-runner`. When prompted for labels, add: `linux,ignition` (or an agreed label scheme).
3. Install it as a service so it survives reboots:
   ```bash
   sudo ./svc.sh install
   sudo ./svc.sh start
   sudo ./svc.sh status      # expect: active (running)
   ```

**Checkpoint:** repo → Settings → Actions → Runners shows the runner as green **Idle**.

*Note:* if it shows **Offline**, the service didn't start — re-run the `svc.sh` steps. If a `filebrowser`-style "masked/not found" error ever appears on a systemd unit, `unmask` then recreate the unit file.

---

## Phase 3 — Create the Playwright project & workflow in the repo

If Playwright isn't already scaffolded in the repo, run once locally: `npm init playwright@latest`. Otherwise add these files.

**`package.json`** — declares Playwright as a dependency.

**`playwright.config.js`** — target injected via env var; HTML report + failure screenshots on:
```javascript
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.TARGET_URL || 'https://example.com',
    ignoreHTTPSErrors: true,     // Ignition self-signed certs
    screenshot: 'only-on-failure',
  },
});
```

**`tests/…spec.js`** — the actual test specs (see Phase 7 for the Ignition-specific selector work).

**`.github/workflows/test.yml`** — manual dropdown for now; `repository_dispatch` added in Phase 6:
```yaml
name: UI Tests
on:
  workflow_dispatch:
    inputs:
      site:
        description: 'Which site/gateway to test'
        type: choice
        required: true
        options:
          - site-a
          - site-b
      custom_url:
        description: 'Or paste a URL (overrides dropdown)'
        type: string
        default: ''
jobs:
  test:
    runs-on: [self-hosted, linux, ignition]
    steps:
      - uses: actions/checkout@v4
      - run: npm install
      - run: npx playwright install chromium
      - run: npx playwright test
        env:
          TARGET_URL: ${{ inputs.custom_url != '' && inputs.custom_url || inputs.site }}
      - name: Archive report to results history
        if: ${{ !cancelled() }}
        run: |
          RUN="$(date +%Y-%m-%d_%H-%M-%S)_${{ github.run_number }}"
          DEST="$HOME/test-results/$RUN"
          mkdir -p "$DEST"
          cp -r playwright-report/* "$DEST"/ 2>/dev/null || true
      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 14
```

**GitHub token note:** pushing workflow files requires a token with **workflow** scope (classic) or **Contents + Workflows: read/write** (fine-grained). A token missing this is rejected with a "workflow scope" error. If git reuses a cached credential, clear it (Windows Credential Manager entry `git:https://github.com`, or `git credential-reject https://github.com`) so it re-prompts for the new token.

**Checkpoint:** push succeeds; **Actions → UI Tests → Run workflow** runs green on the self-hosted runner.

---

## Phase 4 — Reporting & results archive

Already wired in the Phase 3 files, but confirm:

- **HTML report** — downloadable from each run's summary page (Artifacts → `playwright-report`). Unzip, open `index.html`. Failure screenshots are embedded.
- **Results history on the VM** — each run drops a dated folder into `~/test-results/`.
- **Filebrowser (optional but recommended for the LAN archive):** single-binary install on the VM, pointed at `~/test-results/`, run as a systemd service on a non-conflicting port (e.g. 8090), bound to the LAN.
  - **⚠ corporate:** change the default admin password immediately; keep it LAN-only / behind proper access controls; do **not** expose to the internet. Results may contain screenshots of internal systems — treat the archive as sensitive.
  - **⚠ corporate:** at work you may be *required* to keep results on-prem rather than relying on GitHub artifacts — the VM archive covers that.

---

## Phase 5 — Point at a real Ignition gateway

1. Add the real staging gateway URL as a dropdown option (or the site's Perspective project path):
   `https://<gateway-host>:8088/data/perspective/client/<ProjectName>`
2. `ignoreHTTPSErrors: true` (already set) handles the self-signed cert.
3. Confirm reachability from the VM first: `curl -k https://<gateway-host>:8088`.

**Checkpoint:** a manual run against the real gateway loads the HMI and the report shows the actual screen.

---

## Phase 6 — Wire Jira ↔ GitHub automation

Bidirectional. Requires the ARGUS transition IDs (confirmed from the workflow's Text view; verify against a live issue via `GET /rest/api/3/issue/<issue-in-IN-STAGE>/transitions`):

| Transition | ID | From → To |
|---|---|---|
| Deploy for Staging (trigger point) | 4 | READY FOR STAGE → IN STAGE |
| Approve for Production (pass gate) | 5 | IN STAGE → READY FOR PROD |
| Reject from Staging (fail kickback) | 7 | IN STAGE → IN DEVELOPMENT |

**A) Jira → GitHub (trigger tests when an issue enters Staging)**
- Jira: Project settings → Automation → Rule. Trigger: *Issue transitioned → To: IN STAGE*. Action: *Send web request* → `POST https://api.github.com/repos/<owner>/UI_Testing/dispatches`, header `Authorization: Bearer <fine-grained-PAT>`, body `{"event_type":"staging-marked","client_payload":{"issue":"{{issue.key}}","site":"..."}}`.
- GitHub workflow: add `repository_dispatch: types: [staging-marked]` to the `on:` block. Read `${{ github.event.client_payload.site }}` / `.issue`.
- **⚠ PAT storage:** Jira Automation stores the token in plain rule config — use a fine-grained PAT scoped to only this repo with only dispatch permission.

**B) GitHub → Jira (promote / demote / file bug on result)**
- **Pass:** `if: success()` → transition issue via ID **5** (Approve for Production).
- **Fail:** `if: failure()` → **file bug first, then** transition via ID **7** (Reject from Staging).
- Bug creation: Atlassian's official `atlassian/gajira-create` action, or a direct `POST /rest/api/3/issue` call. Include site, "failed in Staging", test name, and the Actions run link.
- **⚠ Required fields:** ARGUS Bug type may require component/priority on create — a missing required field returns HTTP 400. Confirm required fields before first run.
- **⚠ Deduplication:** search for an existing open bug for this site/test before creating; comment on it instead of spawning duplicates. Without this, flaky tests flood the board.
- Auth: Jira Cloud REST uses email + API token (base64), stored as a GitHub secret — separate credential from the dispatch PAT.

**Ownership boundary (by design):** the pipeline owns automated transitions (pass → advance, fail → demote). Staging is read-only — no editing there; all fixes happen in Dev. The final **READY FOR PROD → DONE** (Deploy to Production) stays **manual** — never automate the production hop.

---

## Phase 7 — Ignition selector strategy (the real test-writing work)

This is the one genuinely new problem and the thing that determines suite reliability. Perspective renders standard HTML5, so Playwright drives it — but Perspective exposes **no native element IDs**, and the `props.custom` workaround does not inject attributes into the DOM (Inductive Automation won't add DOM exposure for performance/security reasons).

Approach:
- Select on **user-visible anchors** — `getByRole`, `getByText`, label-based locators.
- **Bake testability into views** — standardize a visible `meta.name` or label convention on key components, pushed through the shared monorepo so every site is addressable the same way. Solve once, centrally.
- **Split concerns:** Playwright for "does the UI render and respond"; a test-fixture view + Client Mount API for backend data validation. Don't force one tool to do both.
- **High-value first checks:** page loads, no quality overlays (broken bindings), key elements visible, controls respond.
- Set `retries: process.env.CI ? 2 : 0` — critical once failures auto-demote, so a flaky pass-on-retry doesn't kick good work back to Dev.

---

## Homelab vs. corporate — what actually changes

Everything software-side is identical. Only these differ:

1. **Network placement** — the runner must be positioned to reach the corporate gateway (VLAN membership or one firewall rule) and GitHub (outbound 443). This is the main corporate task and involves the network/security team.
2. **Proxy** — corporate egress may require proxy config for apt/npm/runner.
3. **Target URL** — real staging gateway instead of a test one.
4. **Secrets & tokens** — real Jira/GitHub credentials, minimally scoped, stored as GitHub secrets.
5. **Results handling** — on-prem archive may be a requirement, not a convenience; treat reports/screenshots as sensitive internal data.
6. **Governance** — bug-creation dedup and required-field mapping must be sorted against the real ARGUS board before trusting the gate.

---

## Suggested sequence

1. VM ready (infra team) → **Phase 1–2** (prep + register runner) → confirm green Idle.
2. **Phase 3–4** (repo, workflow, reporting) → confirm a manual run goes green.
3. **Phase 5** (real gateway) → confirm it loads a real HMI.
4. **Phase 7** (selectors) → write real tests; prove both pass and fail.
5. **Phase 6** (Jira automation) → wire the trigger, then the promote/demote/bug loop.
6. Turn on the gate; keep production deploy manual.
