# Tandem agent runner

MCP agents only act when something prompts them, so an assignment alone does nothing.
This small script is that prompt. It polls Tandem, and for each task assigned to its agent:

1. Claims the task and moves it to `in_progress`.
2. Checks out a private local `tandem/...` branch from the agent push branch configured in Project setup (or `main` when blank).
3. Runs a headless agent, giving it the task's contract and thread. The agent leaves
   completed edits for the runner to verify and commit, so sandbox restrictions on
   Git metadata do not stop publication.
4. Merges the latest configured push branch into the local task branch and asks the
   agent to resolve conflicts and validate the combined changes.
5. Commits verified changes, pushes only to the configured project branch without
   force-pushing, and moves the task to `in_review`.

If anything fails, the task moves to `blocked` with the reason. A person reviews the
published commit and clicks **Accept work**, which lets the tasks that depend on it start. Polling
also keeps the agent showing Online, including during long runs.

The runner records Implementing, Verifying, Committing and Pushing progress in the
task. The project room displays that recorded progress separately from Online status.
Status replies do not invent completion estimates.

### Verification and recovery

Before committing, the runner checks Git whitespace and conflict markers, then runs
root `package.json` scripts named `typecheck`, `lint`, `test` and `build` when present,
with `CI=true`. These commands run only through Anthropic Sandbox Runtime (`srt`
0.0.81, the pinned tested version), with a runner-generated policy outside the writable worktree.
The same verification boundary applies to Codex, Claude and custom agents. Install
the pinned runtime with `npm install -g @anthropic-ai/sandbox-runtime@0.0.81`;
Linux also needs bubblewrap and socat. The runner never installs these automatically.

Verification has an ephemeral HOME/cache, an allowlisted environment without host
credentials, no network or local sockets, read access to the project and required
system/toolchain files, and writes limited to the worktree and a private scratch
directory. Git metadata and environment files are protected. User sandbox settings
and repository files cannot broaden the policy. Missing or unsupported runtimes,
denied access, and failed checks stop publication; there is no host-side fallback.
Checks needing browser networking or other denied access stay blocked for review.
The runner keeps checking in while sandboxed checks run.
For browser checks, Python projects or other commands, use **Verification (optional)**
in worker setup, or repeat `--verify-command 'command arguments'` on the command line.
Explicit commands replace automatic npm checks and use the same sandbox. Commands
are parsed as arguments, not shell scripts; use a project script for shell operators. A failed check prevents
commit and push and preserves edits. When no commands are detected, the result
explicitly reports Git checks only; it does not claim project tests passed.
Only fixed Git operations execute on the host. Hooks, fsmonitor, signing, executable
filters, and custom merge drivers are disabled for runner-owned Git operations.
Changes needing content filters (such as Git LFS) block for manual review rather
than silently publishing data in a different format.

To recover saved edits from an older runner that blocked on committing, stop that
runner, download the updated script, and append `--resume-task <task-id>` to its
startup command. The task must still be assigned to the authenticated agent and
blocked or active. Only dirty files on that task's own branch may be resumed. The
agent inspects the saved work, then the runner verifies, commits and pushes it. A
recovery attempt runs once; failed work is not retried indefinitely.

## Setup

Users do **not** need access to Tandem's private source repository. In **Connect
agent / Set up worker**, choose an engine, get the agent token, and copy
**Download and start**. Run it from any terminal folder. This single command downloads
the runner from the site's `/downloads/tandem_runner.py` to `~/Downloads/tandem_runner.py`
and prompts for the agent token. Only access to the user's own project repository
is needed. GitHub CLI must be signed in with that access.
Run the command from the existing project folder to reuse its repository. Otherwise,
Tandem downloads one shared repository under `~/.local/share/tandem/repositories`.
Each agent gets a linked Git worktree under `~/.local/share/tandem/workspaces`, with
its own working files and task branches. The user's current branch and uncommitted
edits stay in their original folder. Agents on different machines share changes
through GitHub. Rerunning the command updates the runner and reuses the workspace
for that project and agent. No project folder needs to be entered.

The frontend build packages the canonical script from this directory, avoiding a
second copy that can drift. Tests verify that the download matches this source.

### Room presence only

To reply “I'm online.” automatically in the project chat without executing tasks,
run the downloaded script and enter that agent's manual token at the hidden prompt:

```sh
python3 tandem_runner.py --prompt-token --presence-only --project <project-id>
```

This mode needs only Python 3.11+. It uses no repository clone, coding CLI, or GitHub
CLI, and never claims tasks, edits files, or pushes code. Keep it running on the agent's
machine; Ctrl+C stops it. It receives pending checks and explicitly acknowledges each
one using the same authenticated agent identity. The room refreshes every five seconds
and the listener polls every 20 seconds by default. An OAuth connection by itself does
not launch this listener. Existing task runners already handle presence checks.

### Task execution

Every agent's **Connect / Set up worker** screen generates one download-and-start
command for Codex, Claude Code, or a custom headless CLI. Start one worker per identity,
each with its own worktree. OAuth connection and the Online badge do not prove a worker is running.

Before publishing, the runner fetches and merges the latest configured push branch into
its private local task branch. The agent resolves any conflicts and runs relevant tests.
It then pushes the verified commit directly to that configured branch without force.
If another worker advances the branch first, the runner synchronizes, revalidates, and
retries. Unresolved conflicts block the task while preserving its files for inspection.
Dependent tasks should declare their relationship in Tandem.

For optional diagnostics, append `--check` to the generated command. It verifies project access,
the selected agent identity, a clean clone, Git identity, required executables,
and Codex/Claude/GitHub login without claiming tasks or launching a coding process.
With `--repository`, this check also prepares the repository and agent worktree if needed.
Custom commands must handle their own login. The check does not prove remote push
permissions, model quota, or that every project command can run in the agent sandbox.
Remove `--check` to start working continuously. `--prompt-token` asks for the agent
token without echoing or saving it; paste it directly into your terminal, not chat.
The runner's identity must have tasks assigned and their contracts approved.

Run the terminal on a machine that stays awake. This setup does not install a
background service: closing the terminal stops the worker. To recover, rerun it
with the same identity and clone. Keep other IDE sessions from executing the same
agent's assigned tasks concurrently. Human review and acceptance remain separate
from autonomous execution.

You need Python 3.11+, git, the agent's CLI signed in (Claude Code by default), and the
GitHub CLI signed in (`gh auth login`) to clone and access the project repository.

For manual setup using an existing clone instead of the generated command:

1. **Make a dedicated clone.** The runner switches branches and refuses to start on
   uncommitted changes, so don't use the clone you work in.
2. **Get a token.** In the dashboard, open the agent's **Details and settings** and click
   **Replace token**. This doesn't affect its OAuth connection. Keep the token out of
   the repository and this clone.
3. **Get the project ID** from the project's URL, or by calling `tandem_whoami`.

```powershell
# PowerShell
$env:TANDEM_AGENT_TOKEN = "tdm_..."
python tandem_runner.py --project <project-id> --repo ../tandem-runner-clone
```

```sh
# macOS or Linux
export TANDEM_AGENT_TOKEN=tdm_...
python3 tandem_runner.py --project <project-id> --repo ../tandem-runner-clone
```

The runner removes the token from the environment it gives the agent. Press Ctrl+C to
stop it. Run one per agent, each with its own token and clone.

| Option | Default | Purpose |
| --- | --- | --- |
| `--repository` | | GitHub owner/repository to clone into a managed workspace automatically |
| `--repo` | | Existing dedicated clone, as an alternative to `--repository` |
| `--agent` | `claude` | `claude` or `codex` |
| `--agent-command` | | Custom command; it receives the prompt on stdin |
| `--verify-command` | Detected npm scripts | OS-sandboxed check before commit/push; repeat for multiple checks |
| `--resume-task` | | Recover saved edits on this assigned blocked/active task's branch |
| `--timeout` | `60` | Minutes allowed per task |
| `--poll` | `20` | Seconds between checks, at most 90 |
| `--once` | Off | Handle one ready task, then exit |
| `--check` | Off | Validate setup without claiming tasks or running the coding agent |
| `--prompt-token` | Off | Read a hidden token from the terminal, without saving it |
| `--agent-id` | | Refuse a token belonging to another agent |
| `--url` | Hosted Tandem | MCP endpoint, including its trailing slash |

## What the agent can do

It runs unattended and acts on text written by project members, so run it only on projects
whose members you trust. The `claude` preset can edit files in the clone, make local
commits, and run `npm`, `npx`, `node`, `python`, and `pytest`. Those can execute arbitrary
code as your user, so use a container or a separate account if that's a concern. The agent
isn't given push or GitHub tools or the Tandem token, but it can still read other
credentials your user can reach. The `codex` preset uses `codex exec` with the
`workspace-write` sandbox and `approval_policy="never"`; commands needing escalation
are denied rather than prompting an unattended worker. Its flags are checked against
the installed CLI, but a real model-backed task run still needs validation on the
worker machine. Model usage is billed under that machine's agent login or API account.

## Handling problems

| Task state | What it means | What to do |
| --- | --- | --- |
| `blocked` | The agent failed, timed out, or committed nothing | Read the thread, then **Request changes** or **Release task** |
| `in_review` | Waiting for a person | Review the configured branch and click **Accept work**, or **Request changes** to re-run the agent |
| Stuck in `claimed` or `in_progress` | The runner or machine stopped | Restart the runner to resume, or **Release task** so another agent can take it |
