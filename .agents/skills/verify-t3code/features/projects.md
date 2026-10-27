# Projects

A project is a folder T3 Code runs threads in. A user adds a local folder from the sidebar, lands on a draft thread in it, and later starts threads in it from the `New thread` picker, which lists every project with its folder.

## Sub-features

- `project-add-local` adds an existing local folder as a project.
- `project-first-draft` opens a draft thread in the new project.
- `project-pick` lists the project, with its folder, when starting a new thread.

## How to get to it (user POV)

- Choose the `Add project` button beside `Search` in the sidebar, then `Local folder`.
- The same palette offers `New project`, `Git URL` and `GitHub repository`.

## Driving it with t3v

Preconditions:

- `node $T3V doctor` prints no `FAIL`.
- A disposable folder exists for the project, under the run's scratch, such as `<main checkout>/.pstack/runs/<run>/scratch/demo-project`, holding a git repository with one commit.

- **Open the palette.** Choose `Add project`. Run `node $T3V browser click --role button --name "Add project"`. A dialog named `Command palette` lists `New project`, `Local folder`, `Git URL` and `GitHub repository`.
- **Local folder.** Choose `Local folder`. Run `node $T3V browser click --role option --name "Local folder Browse a folder on disk"`. The path box reads `~/` and lists your home folder.
- **Enter the path.** Type the folder and add it. Run `node $T3V browser fill --role combobox --name "Enter path (e.g. ~/projects/my-app)" --value "~/<path to the folder>"` and `node $T3V browser press Enter`. The breadcrumb reads `demo-project / New thread` and the heading asks `What should we build in demo-project?`.
- **Pick it for a new thread.** Choose `New thread`. Run `node $T3V browser click --role button --name "New thread"` and `node $T3V browser aria <dir>/picker`. The palette lists `demo-project` with `Local ·` and the folder's absolute path.
- **Proof.** Grade it with `node $T3V outcome sql "select title, workspace_root from projection_projects"`, which lists `demo-project` at the folder you entered.

## Gotchas

- A dev server started in a worktree auto-creates a project named `server` on the worktree's `apps/server`. Never run agent turns there with `Full access`, because the agent edits the code under test.
- The path box starts at `~/`, so give the folder as a `~/` path.
- The new project's sidebar card appears only after its first thread has a turn. Until then only the breadcrumb shows it.
- Removing a project, and every thread in it, is in Settings > Projects, not the sidebar. Cleanup deletes the worktree's `.t3` instead.
