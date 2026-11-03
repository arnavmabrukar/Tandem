# Tandem agent runner

MCP agents only act when something prompts them, so an assignment alone does nothing.
This small script is that prompt. It polls Tandem, and for each task assigned to its agent:

1. Claims the task and moves it to `in_progress`.
2. Checks out a `tandem/...` branch from the repository's default branch.
3. Runs a headless agent, giving it the task's contract and thread.
4. Pushes the branch and opens a pull request.
5. Moves the task to `in_review` and posts the pull request link in its thread.

If anything fails, the task moves to `blocked` with the reason. A person merges the pull
request and clicks **Accept work**, which lets the tasks that depend on it start. Polling
also keeps the agent showing Online, including during long runs.

## Setup

### Room presence only

To reply “I'm online.” automatically in the project chat without executing tasks,
set `TANDEM_AGENT_TOKEN` to that agent's manual token and run from this repository:

```sh
python3 agent-integrations/runner/tandem_runner.py --presence-only --project <project-id>
```

This mode needs only Python 3.11+. It uses no repository clone, coding CLI, or GitHub
CLI, and never claims tasks, edits files, or pushes code. Keep it running on the agent's
machine; Ctrl+C stops it. It receives pending checks and explicitly acknowledges each
one using the same authenticated agent identity. The room refreshes every five seconds
and the listener polls every 20 seconds by default. An OAuth connection by itself does
not launch this listener. Existing task runners already handle presence checks.

### Task execution

You need Python 3.11+, git, the agent's CLI signed in (Claude Code by default), and the
GitHub CLI signed in (`gh auth login`) to open pull requests.

1. **Make a dedicated clone.** The runner switches branches and refuses to start on
   uncommitted changes, so don't use the clone you work in.
2. **Get a token.** In the dashboard, open the agent's **Details and settings** and click
   **Replace token**. This doesn't affect its OAuth connection. Keep the token out of
   the repository and this clone.
3. **Get the project ID** from the project's URL, or by calling `tandem_whoami`.

```powershell
# PowerShell
$env:TANDEM_AGENT_TOKEN = "tdm_..."
python agent-integrations/runner/tandem_runner.py --project <project-id> --repo ../tandem-runner-clone
```

```sh
# macOS or Linux
export TANDEM_AGENT_TOKEN=tdm_...
python3 agent-integrations/runner/tandem_runner.py --project <project-id> --repo ../tandem-runner-clone
```

The runner removes the token from the environment it gives the agent. Press Ctrl+C to
stop it. Run one per agent, each with its own token and clone.

| Option | Default | Purpose |
| --- | --- | --- |
| `--agent` | `claude` | `claude` or `codex` |
| `--agent-command` | | Custom command; it receives the prompt on stdin |
| `--base` | Repository default | Branch to start from |
| `--timeout` | `60` | Minutes allowed per task |
| `--poll` | `20` | Seconds between checks, at most 90 |
| `--no-pr` | Off | Push branches without opening pull requests |
| `--once` | Off | Handle one ready task, then exit |
| `--url` | Hosted Tandem | MCP endpoint, including its trailing slash |

## What the agent can do

It runs unattended and acts on text written by project members, so run it only on projects
whose members you trust. The `claude` preset can edit files in the clone, make local
commits, and run `npm`, `npx`, `node`, `python`, and `pytest`. Those can execute arbitrary
code as your user, so use a container or a separate account if that's a concern. The agent
isn't given push or GitHub tools or the Tandem token, but it can still read other
credentials your user can reach. The `codex` preset uses `codex exec --full-auto` and
hasn't been tested yet.

## Handling problems

| Task state | What it means | What to do |
| --- | --- | --- |
| `blocked` | The agent failed, timed out, or committed nothing | Read the thread, then **Request changes** or **Release task** |
| `in_review` | Waiting for a person | Merge the pull request and click **Accept work**, or **Request changes** to re-run the agent on the same branch |
| Stuck in `claimed` or `in_progress` | The runner or machine stopped | Restart the runner to resume, or **Release task** so another agent can take it |
