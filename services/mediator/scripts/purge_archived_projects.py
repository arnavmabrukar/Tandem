"""Permanently delete projects archived by the old Disconnect repository feature.

Those projects are invisible and can't be restored, but their data is still stored.
Previews by default and changes nothing. Pass --confirm to delete.

    python services/mediator/scripts/purge_archived_projects.py
    python services/mediator/scripts/purge_archived_projects.py --confirm

Uses the database in DATABASE_URL. Prints counts only, never project content.
"""
import argparse

import psycopg
from psycopg.rows import dict_row

from mediator.config import settings
from mediator.db.project_deletion import delete_project_data, delete_unused_agents


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--confirm", action="store_true", help="Actually delete")
    args = parser.parse_args()

    with psycopg.connect(settings.database_url.get_secret_value(), connect_timeout=15,
                         row_factory=dict_row) as db:
        projects = db.execute(
            """SELECT p.id,
                      (SELECT count(*) FROM public.tasks t WHERE t.project_id = p.id) AS tasks,
                      (SELECT count(*) FROM public.messages m WHERE m.project_id = p.id) AS messages
               FROM public.projects p WHERE p.disconnected_at IS NOT NULL ORDER BY p.id FOR UPDATE OF p"""
        ).fetchall()
        print(f"Archived projects: {len(projects)}")
        print(f"Tasks: {sum(row['tasks'] for row in projects)}, messages: {sum(row['messages'] for row in projects)}")
        for project in projects:
            delete_project_data(db, project["id"])
        # Includes agents left without a project by earlier archiving.
        agents = delete_unused_agents(db)
        print(f"Unused agents: {agents}")
        if not args.confirm:
            db.rollback()
            print("Preview only: nothing was deleted. Pass --confirm to delete.")
            return
    print("Deleted.")


if __name__ == "__main__":
    main()
