#!/usr/bin/env python3
"""Idempotent W6 T3-prep provisioning for mycelium-demo.

Allowed actions only:
- service account existence
- project IAM roles for verifier workload SA
- Artifact Registry repo existence
- regional static IP reservation
- API enable/verification
- cloudflared service-token path documentation

Explicitly does NOT create VMs, push images, export keys, or stage/commit git.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import pathlib
import shlex
import subprocess
import sys
from typing import Any

PROJECT = "mycelium-demo"
REGION = "europe-west4"
SA_ID = "verifier-workload"
SA_EMAIL = f"{SA_ID}@{PROJECT}.iam.gserviceaccount.com"
SA_MEMBER = f"serviceAccount:{SA_EMAIL}"
REPO = "mycelium"
STATIC_IP = "mycelium-verifier-t3-ip"
CLOUDFLARED_TOKEN_PATH = pathlib.Path("/Users/evinova-self/.ethonline-testnet/cloudflared-verifier-token.json")
CODE_DIR = pathlib.Path("/Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench/composition/w6-t3-prep")
EVIDENCE_DIR = pathlib.Path("/Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench/artifacts/w6-v2/t3-prep")
SUMMARY_PATH = EVIDENCE_DIR / "SUMMARY.md"
COMMAND_LOG_PATH = EVIDENCE_DIR / "commands.json"
STATE_JSON_PATH = EVIDENCE_DIR / "state.json"
CLOUDFLARED_DOC_PATH = CODE_DIR / "CLOUDFLARED_TOKEN_PATH.md"

REQUIRED_ROLES = [
    "roles/confidentialcomputing.workloadUser",
    "roles/artifactregistry.reader",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/compute.instanceAdmin.v1",
    "roles/iam.serviceAccountTokenCreator",
]
REQUIRED_APIS = [
    "compute.googleapis.com",
    "confidentialcomputing.googleapis.com",
]

commands: list[dict[str, Any]] = []
notes: list[str] = []


def utc_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def safe_cmd(args: list[str]) -> str:
    # Show the mandatory config prefix even though subprocess passes it in env.
    return "CLOUDSDK_ACTIVE_CONFIG_NAME=mycelium " + shlex.join(args)


def run(args: list[str], *, expect_ok: bool = True, label: str | None = None) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["CLOUDSDK_ACTIVE_CONFIG_NAME"] = "mycelium"
    started = utc_now()
    proc = subprocess.run(args, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    ended = utc_now()
    rec = {
        "label": label or args[-1],
        "command": safe_cmd(args),
        "exit_code": proc.returncode,
        "started_at": started,
        "ended_at": ended,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }
    commands.append(rec)
    if expect_ok and proc.returncode != 0:
        raise RuntimeError(f"command failed ({proc.returncode}): {safe_cmd(args)}\nSTDERR:\n{proc.stderr}\nSTDOUT:\n{proc.stdout}")
    return proc


def gcloud(*args: str, expect_ok: bool = True, label: str | None = None) -> subprocess.CompletedProcess[str]:
    return run(["gcloud", f"--project={PROJECT}", *args], expect_ok=expect_ok, label=label)


def gcloud_json(*args: str, expect_ok: bool = True, label: str | None = None) -> Any | None:
    proc = gcloud(*args, expect_ok=expect_ok, label=label)
    if proc.returncode != 0:
        return None
    text = proc.stdout.strip()
    if not text:
        return None
    return json.loads(text)


def write_json(path: pathlib.Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def service_account_state() -> dict[str, Any]:
    desc = gcloud_json("iam", "service-accounts", "describe", SA_EMAIL, "--format=json", expect_ok=False, label="describe service account")
    return {"exists": desc is not None, "describe": desc}


def project_roles_for_sa() -> list[str]:
    policy = gcloud_json("projects", "get-iam-policy", PROJECT, "--format=json", label="get project IAM policy") or {}
    roles: list[str] = []
    for binding in policy.get("bindings", []):
        if SA_MEMBER in binding.get("members", []):
            roles.append(binding.get("role", ""))
    return sorted(r for r in roles if r)


def repo_state() -> dict[str, Any]:
    desc = gcloud_json("artifacts", "repositories", "describe", REPO, f"--location={REGION}", "--format=json", expect_ok=False, label="describe Artifact Registry repo")
    return {"exists": desc is not None, "describe": desc}


def ip_state() -> dict[str, Any]:
    desc = gcloud_json("compute", "addresses", "describe", STATIC_IP, f"--region={REGION}", "--format=json", expect_ok=False, label="describe static regional IP")
    state = {"exists": desc is not None, "describe": desc}
    if desc:
        state["address"] = desc.get("address")
        state["status"] = desc.get("status")
        state["region"] = desc.get("region")
    return state


def enabled_apis() -> list[str]:
    proc = gcloud("services", "list", "--enabled", "--format=value(config.name)", label="list enabled services")
    apis = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    return sorted(apis)


def verify_active_config() -> dict[str, Any]:
    # Use configurations list as requested, filtered to active to avoid relying on default config.
    # This gcloud version stores account/project under properties.core.*; request only those fields
    # so the evidence log does not contain the huge full property map.
    proc = run([
        "gcloud",
        f"--project={PROJECT}",
        "config",
        "configurations",
        "list",
        "--filter=is_active:true",
        "--format=json(name,is_active,properties.core.account,properties.core.project)",
    ], label="verify active gcloud configuration")
    raw = json.loads(proc.stdout or "[]")
    normalized = []
    for item in raw:
        core = item.get("properties", {}).get("core", {})
        normalized.append({
            "name": item.get("name"),
            "is_active": item.get("is_active"),
            "account": item.get("account") or core.get("account"),
            "project": item.get("project") or core.get("project"),
        })
    return {"active_configurations": normalized, "raw_active_configurations": raw}


def collect_state(phase: str) -> dict[str, Any]:
    apis = enabled_apis()
    return {
        "phase": phase,
        "timestamp": utc_now(),
        "service_account": service_account_state(),
        "project_roles_for_service_account": project_roles_for_sa(),
        "artifact_registry_repo": repo_state(),
        "static_ip": ip_state(),
        "required_apis_enabled": {api: api in apis for api in REQUIRED_APIS},
        "relevant_enabled_apis": [api for api in apis if api in set(REQUIRED_APIS + ["artifactregistry.googleapis.com", "logging.googleapis.com", "monitoring.googleapis.com"])],
        "cloudflared_token_path": {
            "path": str(CLOUDFLARED_TOKEN_PATH),
            "parent_exists": CLOUDFLARED_TOKEN_PATH.parent.exists(),
            "file_exists_now": CLOUDFLARED_TOKEN_PATH.exists(),
            "not_created_by_this_task": True,
        },
    }


def ensure_service_account() -> None:
    state = service_account_state()
    if state["exists"]:
        notes.append(f"Service account already existed: {SA_EMAIL}")
    else:
        gcloud("iam", "service-accounts", "create", SA_ID, "--display-name=Mycelium verifier workload", label="create service account")
        gcloud("iam", "service-accounts", "describe", SA_EMAIL, "--format=json", label="verify service account after create")
        notes.append(f"Created service account: {SA_EMAIL}")


def ensure_roles() -> None:
    for role in REQUIRED_ROLES:
        roles_before = project_roles_for_sa()
        if role in roles_before:
            notes.append(f"Role already present on project IAM for {SA_EMAIL}: {role}")
        else:
            gcloud(
                "projects", "add-iam-policy-binding", PROJECT,
                f"--member={SA_MEMBER}",
                f"--role={role}",
                "--condition=None",
                "--quiet",
                label=f"grant {role} to verifier SA",
            )
            notes.append(f"Granted project IAM role to {SA_EMAIL}: {role}")
        roles_after = project_roles_for_sa()
        if role not in roles_after:
            raise RuntimeError(f"Role verification failed after ensure: {role}")


def ensure_repo() -> None:
    state = repo_state()
    if state["exists"]:
        notes.append(f"Artifact Registry repo already existed: projects/{PROJECT}/locations/{REGION}/repositories/{REPO}")
    else:
        gcloud(
            "artifacts", "repositories", "create", REPO,
            f"--location={REGION}",
            "--repository-format=docker",
            "--mode=standard-repository",
            "--description=Mycelium verifier and workload images",
            label="create Artifact Registry repo",
        )
        notes.append(f"Created Artifact Registry repo: projects/{PROJECT}/locations/{REGION}/repositories/{REPO}")
    gcloud("artifacts", "repositories", "describe", REPO, f"--location={REGION}", "--format=json", label="verify Artifact Registry repo")


def ensure_static_ip() -> None:
    state = ip_state()
    if state["exists"]:
        notes.append(f"Static regional IP already existed: {STATIC_IP} = {state.get('address')}")
    else:
        gcloud(
            "compute", "addresses", "create", STATIC_IP,
            f"--region={REGION}",
            "--network-tier=PREMIUM",
            label="reserve static regional IP",
        )
        notes.append(f"Reserved static regional IP: {STATIC_IP}")
    verified = ip_state()
    if not verified["exists"] or not verified.get("address"):
        raise RuntimeError("Static IP verification failed")


def ensure_apis() -> None:
    apis_before = enabled_apis()
    missing = [api for api in REQUIRED_APIS if api not in apis_before]
    if missing:
        gcloud("services", "enable", *missing, label="enable required APIs")
        notes.append("Enabled APIs: " + ", ".join(missing))
    else:
        notes.append("Required APIs already enabled: " + ", ".join(REQUIRED_APIS))
    apis_after = enabled_apis()
    still_missing = [api for api in REQUIRED_APIS if api not in apis_after]
    if still_missing:
        raise RuntimeError("API enable verification failed: " + ", ".join(still_missing))


def write_cloudflared_doc() -> None:
    CLOUDFLARED_DOC_PATH.parent.mkdir(parents=True, exist_ok=True)
    content = f"""# Cloudflared verifier service-token path (Wave 2 T3 prep)\n\nThis task intentionally does **not** create the Cloudflare service token. Wave 2 T3 should create it when the Confidential Space verifier endpoint exists.\n\nDocumented command to run later:\n\n```bash\ncloudflared service token create mycelium-demo/verifier > {CLOUDFLARED_TOKEN_PATH}\nchmod 600 {CLOUDFLARED_TOKEN_PATH}\n```\n\nExpected JSON path for the future token:\n\n`{CLOUDFLARED_TOKEN_PATH}`\n\nCurrent file existence at T3-prep run time: `{CLOUDFLARED_TOKEN_PATH.exists()}`\n\nNo token JSON was created, read, or logged by T3-prep.\n"""
    CLOUDFLARED_DOC_PATH.write_text(content)
    notes.append(f"Documented future cloudflared service-token command/path in {CLOUDFLARED_DOC_PATH}")


def markdown_command_table() -> str:
    lines = ["| # | Label | Exit | Command |", "|---:|---|---:|---|"]
    for i, rec in enumerate(commands, start=1):
        label = str(rec["label"]).replace("|", "\\|")
        cmd = str(rec["command"]).replace("|", "\\|")
        lines.append(f"| {i} | {label} | {rec['exit_code']} | `{cmd}` |")
    return "\n".join(lines)


def write_summary(state: dict[str, Any], error: str | None = None) -> None:
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    write_json(COMMAND_LOG_PATH, commands)
    write_json(STATE_JSON_PATH, state)

    before = state.get("before", {})
    after = state.get("after", {})
    role_before = before.get("project_roles_for_service_account", [])
    role_after = after.get("project_roles_for_service_account", [])
    missing_roles_after = [r for r in REQUIRED_ROLES if r not in role_after]
    api_after = after.get("required_apis_enabled", {})
    repo_after = after.get("artifact_registry_repo", {})
    ip_after = after.get("static_ip", {})
    sa_after = after.get("service_account", {})

    files_for_hash = [
        CLOUDFLARED_DOC_PATH,
        COMMAND_LOG_PATH,
        STATE_JSON_PATH,
    ]
    file_hash_lines = []
    for p in files_for_hash:
        if p.exists():
            file_hash_lines.append(f"- `{p}` — sha256 `{sha256_file(p)}`")
    # SUMMARY hash cannot include itself until after write; append in final report from caller or rewrite below.

    lines = [
        "# W6 T3-prep evidence summary",
        "",
        f"Generated: `{utc_now()}`",
        f"Project: `{PROJECT}`",
        f"Region: `{REGION}`",
        f"Service account: `{SA_EMAIL}`",
        "",
        "## Scope boundary",
        "",
        "Real live GCP calls were used for IAM, Artifact Registry, Compute regional address, and Service Usage checks/changes. No VM was created, no Docker image was pushed, and no service account key was created/exported/logged.",
        "",
        "## Result",
        "",
        f"- Status: `{'FAILED' if error else 'SUCCESS'}`",
        f"- Error: `{error}`" if error else "- Error: none",
        f"- Service account exists after run: `{sa_after.get('exists')}`",
        f"- Required roles present after run: `{missing_roles_after == []}`",
        f"- Missing roles after run: `{missing_roles_after}`",
        f"- Artifact Registry repo exists after run: `{repo_after.get('exists')}`",
        f"- Static IP exists after run: `{ip_after.get('exists')}`",
        f"- Static IP address: `{ip_after.get('address')}`",
        f"- Required APIs enabled after run: `{api_after}`",
        f"- Cloudflared future token path: `{CLOUDFLARED_TOKEN_PATH}`",
        f"- Cloudflared token file existed at run time: `{CLOUDFLARED_TOKEN_PATH.exists()}`",
        "",
        "## Before state",
        "",
        f"- Service account existed: `{before.get('service_account', {}).get('exists')}`",
        f"- Project IAM roles for SA: `{role_before}`",
        f"- Artifact Registry repo existed: `{before.get('artifact_registry_repo', {}).get('exists')}`",
        f"- Static IP existed: `{before.get('static_ip', {}).get('exists')}`",
        f"- Static IP address: `{before.get('static_ip', {}).get('address')}`",
        f"- Required APIs enabled: `{before.get('required_apis_enabled')}`",
        "",
        "## After state",
        "",
        f"- Service account existed: `{after.get('service_account', {}).get('exists')}`",
        f"- Project IAM roles for SA: `{role_after}`",
        f"- Artifact Registry repo existed: `{repo_after.get('exists')}`",
        f"- Artifact Registry resource: `projects/{PROJECT}/locations/{REGION}/repositories/{REPO}`",
        f"- Static IP existed: `{ip_after.get('exists')}`",
        f"- Static IP address: `{ip_after.get('address')}`",
        f"- Static IP status: `{ip_after.get('status')}`",
        f"- Required APIs enabled: `{api_after}`",
        "",
        "## Actions / notes",
        "",
        *(f"- {n}" for n in notes),
        "",
        "## Commands run and exit codes",
        "",
        markdown_command_table(),
        "",
        "## Files created / modified with sha256",
        "",
        *file_hash_lines,
        "- `SUMMARY.md` hash listed in final assistant handoff after final write.",
        "",
        "## Evidence files",
        "",
        f"- Command log: `{COMMAND_LOG_PATH}`",
        f"- State JSON: `{STATE_JSON_PATH}`",
        f"- Cloudflared path doc: `{CLOUDFLARED_DOC_PATH}`",
        "",
        "## Real vs synthetic boundary",
        "",
        "- Real: gcloud project/IAM/API/Artifact Registry/Compute regional address calls and their verification outputs.",
        "- Synthetic/documentary only: Cloudflare service-token command/path documentation. The token was not created in this prep task.",
        "",
        "## Open issues",
        "",
        "- None for T3-prep if status is SUCCESS. Wave 2 must still create the Confidential Space VM, create/use the Cloudflare service token, configure DNS/proxying, perform attestation verification, and bind verifier keys. Those are explicitly out of scope here.",
        "",
    ]
    SUMMARY_PATH.write_text("\n".join(lines))
    # Rewrite command/state after summary write is complete; include final summary hash in a small companion manifest.
    manifest = {
        "summary": str(SUMMARY_PATH),
        "summary_sha256": sha256_file(SUMMARY_PATH),
        "files": {str(p): sha256_file(p) for p in [SUMMARY_PATH, CLOUDFLARED_DOC_PATH, COMMAND_LOG_PATH, STATE_JSON_PATH] if p.exists()},
        "generated_at": utc_now(),
    }
    write_json(EVIDENCE_DIR / "manifest.json", manifest)


def main() -> int:
    CODE_DIR.mkdir(parents=True, exist_ok=True)
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    state: dict[str, Any] = {"started_at": utc_now()}
    error: str | None = None
    try:
        state["gcloud_config"] = verify_active_config()
        active = state["gcloud_config"].get("active_configurations", [])
        if not active or active[0].get("name") != "mycelium" or active[0].get("project") != PROJECT:
            raise RuntimeError(f"Refusing to continue: active gcloud config is not mycelium/{PROJECT}: {active}")
        account = active[0].get("account", "")
        if account.endswith("@self.xyz") or active[0].get("project") == "self-protocol":
            raise RuntimeError(f"Refusing to continue: forbidden account/project in active config: {active}")

        state["before"] = collect_state("before")
        ensure_service_account()
        ensure_roles()
        ensure_repo()
        ensure_static_ip()
        ensure_apis()
        write_cloudflared_doc()
        state["after"] = collect_state("after")

        # Final acceptance checks.
        after = state["after"]
        if not after["service_account"]["exists"]:
            raise RuntimeError("acceptance failed: service account missing")
        missing_roles = [role for role in REQUIRED_ROLES if role not in after["project_roles_for_service_account"]]
        if missing_roles:
            raise RuntimeError(f"acceptance failed: missing IAM roles: {missing_roles}")
        if not after["artifact_registry_repo"]["exists"]:
            raise RuntimeError("acceptance failed: Artifact Registry repo missing")
        if not after["static_ip"]["exists"] or not after["static_ip"].get("address"):
            raise RuntimeError("acceptance failed: static IP missing")
        missing_apis = [api for api, enabled in after["required_apis_enabled"].items() if not enabled]
        if missing_apis:
            raise RuntimeError(f"acceptance failed: required APIs disabled: {missing_apis}")
        return_code = 0
    except Exception as exc:  # noqa: BLE001 - preserve partial evidence on blocker
        error = str(exc)
        return_code = 1
        if "after" not in state:
            try:
                state["after"] = collect_state("after_failure")
            except Exception as nested:  # noqa: BLE001
                state["after_collection_error"] = str(nested)
    finally:
        state["ended_at"] = utc_now()
        state["notes"] = notes
        write_summary(state, error=error)
        print(f"SUMMARY={SUMMARY_PATH}")
        print(f"MANIFEST={EVIDENCE_DIR / 'manifest.json'}")
        print(f"COMMAND_LOG={COMMAND_LOG_PATH}")
        print(f"STATE={STATE_JSON_PATH}")
        if error:
            print(f"ERROR={error}", file=sys.stderr)
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
