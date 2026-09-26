#!/usr/bin/env python3
"""
migrate.py — one-time schema migration for the attendance portal.

Brings an existing robotics_attendance.db up to date with the current
AttendanceLog model:
  - adds attendance_log.note        (TEXT, nullable)
  - adds attendance_log.is_manual   (BOOLEAN, NOT NULL DEFAULT 0)
  - makes attendance_log.session_id nullable (needed for manual hour
    adjustments that aren't tied to a real build session)

Safe to run more than once — it inspects the current schema first and
does nothing if the database is already up to date. Always makes a
timestamped backup of the database file before changing anything, and
restores that backup automatically if anything goes wrong.

Usage:
    python migrate.py                          # auto-detect the DB from app.py
    python migrate.py --db path/to/whatever.db # migrate a specific file
    python migrate.py --yes                    # skip the confirmation prompt
"""

import argparse
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path


def resolve_default_db_path() -> Path:
    """Ask the actual Flask app where its database lives, so this script
    always targets the same file the running app uses. This mirrors
    Flask-SQLAlchemy's own resolution of the relative sqlite URI (which
    lands in the app's instance/ folder), instead of guessing."""
    try:
        import app as appmod
        with appmod.app.app_context():
            return Path(appmod.db.engine.url.database).resolve()
    except Exception as e:
        fallback = (Path(__file__).parent / "instance" / "robotics_attendance.db").resolve()
        print(f"Could not import app.py to auto-detect the database path ({e}).")
        print(f"Falling back to: {fallback}")
        return fallback


def get_columns(conn, table):
    """Returns {column_name: pragma_row} for a table, or {} if it doesn't exist."""
    return {row[1]: row for row in conn.execute(f"PRAGMA table_info({table})")}


def backup_db(db_path: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = db_path.with_name(f"{db_path.stem}.backup_{stamp}{db_path.suffix}")
    shutil.copy2(db_path, backup_path)
    return backup_path


def migrate(db_path: Path, skip_confirm: bool = False):
    if not db_path.exists():
        print(f"No database found at {db_path} — nothing to migrate.")
        print("(A fresh install creates the up-to-date schema automatically on first run.)")
        return

    conn = sqlite3.connect(str(db_path))
    cols = get_columns(conn, "attendance_log")

    if not cols:
        print(f"No attendance_log table found in {db_path} — nothing to migrate.")
        conn.close()
        return

    session_id_notnull = cols["session_id"][3] == 1  # PRAGMA table_info 'notnull' flag
    has_note = "note" in cols
    has_is_manual = "is_manual" in cols

    if not session_id_notnull and has_note and has_is_manual:
        print(f"{db_path} is already up to date. No changes made.")
        conn.close()
        return

    print(f"Target database: {db_path}")
    print("Planned changes:")
    if not has_note:
        print("  + add attendance_log.note")
    if not has_is_manual:
        print("  + add attendance_log.is_manual")
    if session_id_notnull:
        print("  + make attendance_log.session_id nullable")

    if not skip_confirm:
        answer = input("\nProceed? [y/N] ").strip().lower()
        if answer != "y":
            print("Aborted — no changes made.")
            conn.close()
            return

    backup_path = backup_db(db_path)
    print(f"Backed up to: {backup_path}")

    try:
        with conn:
            if not has_note:
                conn.execute("ALTER TABLE attendance_log ADD COLUMN note VARCHAR(255)")
            if not has_is_manual:
                conn.execute(
                    "ALTER TABLE attendance_log ADD COLUMN is_manual BOOLEAN NOT NULL DEFAULT 0"
                )

            if session_id_notnull:
                # SQLite can't drop a NOT NULL constraint with a plain ALTER TABLE,
                # so rebuild the table with the corrected schema and copy the data over.
                conn.execute("PRAGMA foreign_keys = OFF")
                conn.execute("""
                    CREATE TABLE attendance_log_new (
                        id INTEGER NOT NULL PRIMARY KEY,
                        user_id INTEGER NOT NULL,
                        session_id INTEGER,
                        check_in DATETIME,
                        check_out DATETIME,
                        note VARCHAR(255),
                        is_manual BOOLEAN NOT NULL DEFAULT 0,
                        FOREIGN KEY(user_id) REFERENCES user (id),
                        FOREIGN KEY(session_id) REFERENCES build_session (id)
                    )
                """)
                conn.execute("""
                    INSERT INTO attendance_log_new
                        (id, user_id, session_id, check_in, check_out, note, is_manual)
                    SELECT id, user_id, session_id, check_in, check_out, note, is_manual
                    FROM attendance_log
                """)
                conn.execute("DROP TABLE attendance_log")
                conn.execute("ALTER TABLE attendance_log_new RENAME TO attendance_log")
                conn.execute("PRAGMA foreign_keys = ON")

        new_cols = get_columns(conn, "attendance_log")
        row_count = conn.execute("SELECT COUNT(*) FROM attendance_log").fetchone()[0]
        print("\nMigration complete.")
        print("attendance_log columns now:", ", ".join(new_cols.keys()))
        print(f"attendance_log has {row_count} row(s) — verify this matches what you expected.")

    except Exception:
        print("\nSomething went wrong — restoring the original database from backup.")
        conn.close()
        shutil.copy2(backup_path, db_path)
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Migrate the attendance portal database to the current schema.")
    parser.add_argument(
        "--db",
        type=str,
        default=None,
        help="Path to the sqlite database file (default: auto-detected from app.py / instance folder)",
    )
    parser.add_argument(
        "--yes", "-y",
        action="store_true",
        help="Skip the confirmation prompt",
    )
    args = parser.parse_args()

    target = Path(args.db).resolve() if args.db else resolve_default_db_path()

    try:
        migrate(target, skip_confirm=args.yes)
    except Exception as e:
        print(f"\nMigration failed: {e}", file=sys.stderr)
        sys.exit(1)
