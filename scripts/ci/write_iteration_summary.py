"""Build a review receipt, not a claim of UX or live integration acceptance."""

import json
import os
from pathlib import Path
import subprocess


def make_record(event, env, checkout_sha):
    results = {"api": env["API_RESULT"], "ios": env["IOS_RESULT"]}
    allowed = {"success", "failure", "cancelled", "skipped"}
    if any(result not in allowed for result in results.values()):
        raise ValueError("Unknown job result; cannot claim a verified revision")
    pr = event.get("pull_request")
    run_url = f"{env['GITHUB_SERVER_URL']}/{env['GITHUB_REPOSITORY']}/actions/runs/{env['GITHUB_RUN_ID']}"
    return {
        "schema_version": 1,
        "repository": env["GITHUB_REPOSITORY"],
        "event": env["GITHUB_EVENT_NAME"],
        "ref": env["GITHUB_REF"],
        "source_commit": pr["head"]["sha"] if pr else checkout_sha,
        "tested_commit": checkout_sha,
        "pull_request": {"number": event["number"], "url": pr["html_url"]} if pr else None,
        "run_url": run_url,
        "run_attempt": int(env["GITHUB_RUN_ATTEMPT"]),
        "checks": results,
        "automated_checks_passed": all(result == "success" for result in results.values()),
        "ux_acceptance": "not_assessed_by_ci",
        "live_api_verification": "not_assessed_by_ci",
        "external_publication": "not_performed",
        "note": "PR runs normally test GitHub's merge commit; source_commit identifies the contributor revision.",
    }


def main():
    env = os.environ
    with open(env["GITHUB_EVENT_PATH"], encoding="utf-8") as source:
        event = json.load(source)
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    record = make_record(event, env, sha)
    directory = Path(env["INVENTORY_RECORD_DIR"])
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "iteration.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    summary = f"""## Iteration review receipt

| Evidence | Result |
| --- | --- |
| Source commit | `{record['source_commit']}` |
| Tested commit | `{record['tested_commit']}` |
| API checks | {record['checks']['api']} |
| iOS checks | {record['checks']['ios']} |
| UX / animation acceptance | Reviewer required; not assessed by CI |
| Real model / marketplace API | Not assessed by CI |
| External publishing / deployment | Not performed |

[This run]({record['run_url']}) records this revision only. A later push needs a new review.
Download the `iteration` artifact for the JSON receipt and committed iteration notes.
See `CONTRIBUTING.md` and `docs/TEAM_WORKFLOW.md` for screenshot, walkthrough and sign-off requirements.
"""
    (directory / "README.md").write_text(summary, encoding="utf-8")
    with open(env["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as target:
        target.write(summary)


if __name__ == "__main__":
    main()
