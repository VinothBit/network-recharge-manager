import sqlite3

DATABASE = "recharge_manager.db"


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

    conn.commit()
    conn.close()