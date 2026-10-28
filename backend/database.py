import sqlite3
import os
from datetime import datetime, timezone
from pathlib import Path
from werkzeug.security import generate_password_hash

DEFAULT_DATABASE = Path(__file__).resolve().parent / "recharge_manager.db"
DATABASE = Path(os.getenv("DATABASE_PATH", str(DEFAULT_DATABASE))).expanduser().resolve()


def get_db_connection():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db_connection()

    conn.execute("""
        CREATE TABLE IF NOT EXISTS plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            service TEXT NOT NULL,
            plan_name TEXT NOT NULL,
            category TEXT NOT NULL,
            recharge_date TEXT,
            expiry_date TEXT,
            frequency TEXT,
            amount REAL,
            status TEXT DEFAULT 'Active',
            notes TEXT
        )
    """)


    conn.execute("""
        CREATE TABLE IF NOT EXISTS recharge_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_id INTEGER NOT NULL,
            recharge_date TEXT NOT NULL,
            old_expiry_date TEXT,
            new_expiry_date TEXT,
            amount REAL,
            notes TEXT,
            FOREIGN KEY (plan_id) REFERENCES plans(id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS reminder_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_id INTEGER NOT NULL,
            reminder_type TEXT NOT NULL,
            expiry_date TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(plan_id, reminder_type, expiry_date),
            FOREIGN KEY (plan_id) REFERENCES plans(id)
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)

    conn.commit()
    conn.close()


def create_initial_admin():
    """Seed one administrator only when the users table is empty."""
    conn = get_db_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")
        existing_user = conn.execute("SELECT id FROM users LIMIT 1").fetchone()
        if existing_user is not None:
            conn.rollback()
            return False

        username = os.getenv("ADMIN_USERNAME", "").strip()
        password = os.getenv("ADMIN_PASSWORD", "")
        if not username or not password:
            conn.rollback()
            print("Admin account not seeded: configure ADMIN_USERNAME and ADMIN_PASSWORD.")
            return False
        if len(password) < 16:
            conn.rollback()
            print("Admin account not seeded: ADMIN_PASSWORD must be at least 16 characters.")
            return False

        conn.execute(
            "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
            (
                username,
                generate_password_hash(password),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        conn.commit()
        print("Initial administrator account created from environment configuration.")
        return True
    finally:
        conn.close()


def verify_single_admin_account():
    """Fail closed unless exactly one hashed administrator is configured."""
    conn = get_db_connection()
    try:
        users = conn.execute(
            "SELECT username, password_hash FROM users"
        ).fetchall()
    finally:
        conn.close()

    if len(users) != 1:
        raise RuntimeError(
            "RLEMS requires exactly one administrator account. Configure ADMIN_USERNAME "
            "and a strong ADMIN_PASSWORD in backend/.env when the users table is empty."
        )

    password_hash = users[0]["password_hash"] or ""
    if not (users[0]["username"] or "").strip() or not (
        password_hash.startswith("scrypt:") or password_hash.startswith("pbkdf2:")
    ):
        raise RuntimeError("The administrator account is invalid; refusing to start.")
