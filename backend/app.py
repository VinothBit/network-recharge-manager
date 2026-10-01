from flask import Flask, jsonify, request, send_file
import sqlite3
import tempfile
import threading
from pathlib import Path
from datetime import date, datetime
from flask_cors import CORS
from dotenv import load_dotenv
import os
import requests
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.schedulers.base import STATE_RUNNING

from database import DATABASE, init_db, get_db_connection

load_dotenv()

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")


def send_telegram_message(message):
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("Telegram configuration is missing.")
        return False

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"

    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message
    }

    try:
        response = requests.post(url, json=payload, timeout=10)

        if response.ok:
            print("Telegram message sent successfully.")
            return True

        print("Telegram error:", response.text)
        return False

    except Exception as error:
        print("Telegram connection error:", error)
        return False
app = Flask(__name__)
CORS(app)

DATABASE_OPERATION_LOCK = threading.RLock()
REQUIRED_DATABASE_TABLES = {"plans", "recharge_history", "reminder_log"}
scheduler = None


@app.before_request
def lock_database_operations():
    DATABASE_OPERATION_LOCK.acquire()


@app.teardown_request
def unlock_database_operations(error=None):
    DATABASE_OPERATION_LOCK.release()


def validate_restore_database(database_path):
    connection = sqlite3.connect(str(database_path))
    try:
        connection.execute("PRAGMA query_only = ON")
        integrity_results = connection.execute("PRAGMA integrity_check").fetchall()
        if integrity_results != [("ok",)]:
            raise ValueError("SQLite integrity check failed.")

        existing_tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        missing_tables = REQUIRED_DATABASE_TABLES - existing_tables
        if missing_tables:
            raise ValueError(
                "Database is missing required tables: "
                + ", ".join(sorted(missing_tables))
            )
    except sqlite3.DatabaseError as error:
        raise ValueError("Uploaded file is not a valid SQLite database.") from error
    finally:
        connection.close()


def create_database_safety_backup():
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = DATABASE.parent / f"recharge_manager_pre_restore_{timestamp}.db"
    suffix = 1
    while backup_path.exists():
        backup_path = DATABASE.parent / (
            f"recharge_manager_pre_restore_{timestamp}_{suffix}.db"
        )
        suffix += 1

    source = sqlite3.connect(str(DATABASE))
    destination = sqlite3.connect(str(backup_path))
    try:
        source.backup(destination)
    except Exception:
        destination.close()
        source.close()
        backup_path.unlink(missing_ok=True)
        raise
    else:
        destination.close()
        source.close()

    validate_restore_database(backup_path)
    return backup_path

# Initialize database
init_db()
def calculate_status(expiry_date):
    if not expiry_date:
        return "UPDATE REQUIRED", None

    try:
        expiry = datetime.strptime(
            expiry_date,
            "%Y-%m-%d"
        ).date()

        today = date.today()

        days_remaining = (expiry - today).days

        if days_remaining < 0:
            status = "EXPIRED"

        elif days_remaining == 0:
            status = "DUE TODAY"

        elif days_remaining <= 3:
            status = "DUE SOON"

        elif days_remaining <= 7:
            status = "UPCOMING"

        else:
            status = "ACTIVE"

        return status, days_remaining

    except ValueError:
        return "INVALID DATE", None


def check_expiry_reminders():

    print("\nRunning expiry reminder check...")

    conn = get_db_connection()

    plans = conn.execute(
        "SELECT * FROM plans"
    ).fetchall()

    reminders_found = 0

    for plan in plans:

        plan_id = plan["id"]
        service = plan["service"]
        plan_name = plan["plan_name"]
        expiry_date = plan["expiry_date"]

        # -----------------------------
        # EXPIRY DATE MISSING
        # -----------------------------

        if not expiry_date:

            reminder_type = "EXPIRY_MISSING"

            existing = conn.execute("""
                SELECT id
                FROM reminder_log
                WHERE plan_id = ?
                AND reminder_type = ?
                AND expiry_date IS NULL
            """, (
                plan_id,
                reminder_type
            )).fetchone()

            if existing is None:

                conn.execute("""
                    INSERT INTO reminder_log
                    (
                        plan_id,
                        reminder_type,
                        expiry_date,
                        created_at
                    )
                    VALUES (?, ?, ?, ?)
                """, (
                    plan_id,
                    reminder_type,
                    None,
                    datetime.now().isoformat()
                ))

                print("\n[REMINDER]")
                print(f"Service: {service}")
                print(f"Plan: {plan_name}")
                print(f"Recharge Date: {plan['recharge_date']}")
                print("Reminder Type: EXPIRY DATE MISSING")

                message = (
                    "âš ï¸ Network Recharge Manager\n\n"
                    "Expiry date is missing.\n\n"
                    f"Service: {service}\n"
                    f"Plan: {plan_name}\n"
                    f"Recharge Date: {plan['recharge_date']}\n\n"
                    "Please update the new expiry date."
                )

                try:
                    print("Sending Telegram reminder...")
                    print(f"Reminder type: {reminder_type}")
                    print(f"Plan: {plan_name}")
                    telegram_sent = send_telegram_message(message)
                    print(f"Telegram send result: {telegram_sent}")
                except Exception as error:
                    print("Telegram notification failed:", error)

                reminders_found += 1

            continue

        # -----------------------------
        # CHECK EXPIRY DATE
        # -----------------------------

        try:

            expiry = datetime.strptime(
                expiry_date,
                "%Y-%m-%d"
            ).date()

        except ValueError:

            print(
                f"Invalid expiry date for plan: {plan_name}"
            )

            continue

        today = date.today()

        days_remaining = (expiry - today).days

        # -----------------------------
        # DETERMINE REMINDER TYPE
        # -----------------------------

        reminder_type = None

        if days_remaining == 7:

            reminder_type = "7_DAYS"

        elif days_remaining == 3:

            reminder_type = "3_DAYS"

        elif days_remaining == 0:

            reminder_type = "DUE_TODAY"

        elif days_remaining < 0:

            reminder_type = "EXPIRED"

        # -----------------------------
        # NO REMINDER NEEDED
        # -----------------------------

        if reminder_type is None:
            continue

        # -----------------------------
        # CHECK DUPLICATE
        # -----------------------------

        existing = conn.execute("""
            SELECT id
            FROM reminder_log
            WHERE plan_id = ?
            AND reminder_type = ?
            AND expiry_date = ?
        """, (
            plan_id,
            reminder_type,
            expiry_date
        )).fetchone()

        if existing is not None:
            print(
                f"Skipping existing reminder: plan_id={plan_id}, "
                f"reminder_type={reminder_type}, expiry_date={expiry_date}"
            )
            continue

        # -----------------------------
        # SAVE REMINDER
        # -----------------------------

        conn.execute("""
            INSERT INTO reminder_log
            (
                plan_id,
                reminder_type,
                expiry_date,
                created_at
            )
            VALUES (?, ?, ?, ?)
        """, (
            plan_id,
            reminder_type,
            expiry_date,
            datetime.now().isoformat()
        ))

        # -----------------------------
        # PRINT REMINDER
        # -----------------------------

        print("\n[REMINDER]")
        print(f"Service: {service}")
        print(f"Plan: {plan_name}")
        print(f"Expiry Date: {expiry_date}")
        print(f"Days Remaining: {days_remaining}")
        print(f"Reminder Type: {reminder_type}")

        if reminder_type == "7_DAYS":
            message = (
                "ðŸ”” Network Recharge Reminder\n\n"
                f"Service: {service}\n"
                f"Plan: {plan_name}\n"
                f"Expiry Date: {expiry_date}\n"
                "Days Remaining: 7\n\n"
                "Reminder: Recharge/renewal is due in 7 days."
            )
        elif reminder_type == "3_DAYS":
            message = (
                "âš ï¸ Network Recharge Reminder\n\n"
                f"Service: {service}\n"
                f"Plan: {plan_name}\n"
                f"Expiry Date: {expiry_date}\n"
                "Days Remaining: 3\n\n"
                "Reminder: Recharge/renewal is due in 3 days."
            )
        elif reminder_type == "DUE_TODAY":
            message = (
                "ðŸš¨ Network Recharge Reminder\n\n"
                f"Service: {service}\n"
                f"Plan: {plan_name}\n"
                f"Expiry Date: {expiry_date}\n\n"
                "Reminder: Recharge/renewal is due TODAY."
            )
        else:  # EXPIRED
            message = (
                "âŒ Network Recharge Reminder\n\n"
                f"Service: {service}\n"
                f"Plan: {plan_name}\n"
                f"Expiry Date: {expiry_date}\n\n"
                "Reminder: This plan has EXPIRED."
            )

        try:
            print("Sending Telegram reminder...")
            print(f"Reminder type: {reminder_type}")
            print(f"Plan: {plan_name}")
            telegram_sent = send_telegram_message(message)
            print(f"Telegram send result: {telegram_sent}")
        except Exception as error:
            print("Telegram notification failed:", error)

        reminders_found += 1

    conn.commit()
    conn.close()

    if reminders_found == 0:
        print("No new reminders found; matching reminders may already exist.")

    else:
        print(
            f"\nTotal reminders detected: {reminders_found}"
        )
def run_scheduled_expiry_reminders():
    with DATABASE_OPERATION_LOCK:
        check_expiry_reminders()


# --------------------------------
# HOME
# --------------------------------

@app.route("/")
def home():
    return jsonify({
        "message": "Network Recharge Manager API is running"
    })

# --------------------------------
# TEST REMINDERS
# --------------------------------

@app.route("/reminders/test", methods=["GET"])
def test_reminders():

    check_expiry_reminders()

    return jsonify({
        "message": "Reminder check completed"
    })


@app.route("/reminders", methods=["GET"])
def get_reminders():

    conn = get_db_connection()

    reminders = conn.execute("""
        SELECT
            reminder_log.*,
            plans.service,
            plans.plan_name
        FROM reminder_log
        LEFT JOIN plans ON plans.id = reminder_log.plan_id
        ORDER BY reminder_log.created_at DESC
    """).fetchall()

    conn.close()

    return jsonify([
        dict(reminder)
        for reminder in reminders
    ])


@app.route("/restore/database", methods=["POST"])
def restore_database():
    uploaded_file = request.files.get("database")
    if uploaded_file is None or not uploaded_file.filename:
        return jsonify({"success": False, "error": "Select a database backup file."}), 400

    if not uploaded_file.filename.lower().endswith(".db"):
        return jsonify({"success": False, "error": "Only .db backup files are accepted."}), 400

    temporary_path = None
    recovery_path = None
    safety_backup_path = None
    scheduler_was_running = scheduler is not None and scheduler.state == STATE_RUNNING
    scheduler_paused = False

    try:
        with tempfile.NamedTemporaryFile(
            prefix=".restore_upload_",
            suffix=".db",
            dir=str(DATABASE.parent),
            delete=False
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)

        uploaded_file.save(str(temporary_path))
        if temporary_path.stat().st_size == 0:
            return jsonify({"success": False, "error": "The uploaded backup file is empty."}), 400

        try:
            validate_restore_database(temporary_path)
        except ValueError as error:
            return jsonify({"success": False, "error": str(error)}), 400

        if scheduler_was_running:
            scheduler.pause()
            scheduler_paused = True

        # The request lock and scheduled-job lock ensure no database work is active here.
        safety_backup_path = create_database_safety_backup()
        os.replace(str(temporary_path), str(DATABASE))
        temporary_path = None

        try:
            validate_restore_database(DATABASE)
        except ValueError as error:
            with tempfile.NamedTemporaryFile(
                prefix=".restore_recovery_",
                suffix=".db",
                dir=str(DATABASE.parent),
                delete=False
            ) as recovery_file:
                recovery_path = Path(recovery_file.name)

            safety_connection = sqlite3.connect(str(safety_backup_path))
            recovery_connection = sqlite3.connect(str(recovery_path))
            try:
                safety_connection.backup(recovery_connection)
            finally:
                recovery_connection.close()
                safety_connection.close()

            os.replace(str(recovery_path), str(DATABASE))
            recovery_path = None
            return jsonify({
                "success": False,
                "error": f"Restored database verification failed; the previous database was recovered. {error}"
            }), 500

        return jsonify({
            "success": True,
            "message": "Database restored successfully.",
            "safety_backup_filename": safety_backup_path.name
        })
    except Exception as error:
        app.logger.exception("Database restore failed")
        return jsonify({
            "success": False,
            "error": f"Database restore failed: {error}"
        }), 500
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                app.logger.exception("Could not remove temporary restore upload")
        if recovery_path is not None:
            try:
                recovery_path.unlink(missing_ok=True)
            except OSError:
                app.logger.exception("Could not remove temporary restore recovery file")
        if scheduler_paused:
            try:
                scheduler.resume()
            except Exception:
                app.logger.exception("Could not resume reminder scheduler after restore")


@app.route("/backup/database", methods=["GET"])
def backup_database():
    database_path = DATABASE

    if not os.path.isfile(database_path):
        return jsonify({"error": "Database file not found"}), 404

    return send_file(
        database_path,
        as_attachment=True,
        download_name="recharge_manager_backup.db",
        mimetype="application/octet-stream"
    )

# --------------------------------
# GET ALL PLANS
# --------------------------------

@app.route("/plans", methods=["GET"])
def get_plans():

    conn = get_db_connection()

    plans = conn.execute(
        "SELECT * FROM plans ORDER BY expiry_date"
    ).fetchall()

    conn.close()

    result = []

    for plan in plans:

        plan_data = dict(plan)

        status, days_remaining = calculate_status(
            plan_data["expiry_date"]
        )

        plan_data["status"] = status
        plan_data["days_remaining"] = days_remaining

        result.append(plan_data)

    return jsonify(result)


# --------------------------------
# ADD NEW PLAN
# --------------------------------

@app.route("/plans", methods=["POST"])
def add_plan():

    data = request.get_json()

    service = data.get("service")
    plan_name = data.get("plan_name")
    category = data.get("category")
    recharge_date = data.get("recharge_date")
    expiry_date = data.get("expiry_date")
    frequency = data.get("frequency")
    amount = data.get("amount")
    notes = data.get("notes")

    if not service or not plan_name or not category:
        return jsonify({
            "error": "Service, plan name and category are required"
        }), 400

    conn = get_db_connection()

    cursor = conn.execute("""
        INSERT INTO plans
        (
            service,
            plan_name,
            category,
            recharge_date,
            expiry_date,
            frequency,
            amount,
            notes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        service,
        plan_name,
        category,
        recharge_date,
        expiry_date,
        frequency,
        amount,
        notes
    ))

    conn.commit()

    plan_id = cursor.lastrowid

    conn.close()

    return jsonify({
        "message": "Plan added successfully",
        "id": plan_id
    }), 201


# --------------------------------
# GET SINGLE PLAN
# --------------------------------

@app.route("/plans/<int:plan_id>", methods=["GET"])
def get_plan(plan_id):

    conn = get_db_connection()

    plan = conn.execute(
        "SELECT * FROM plans WHERE id = ?",
        (plan_id,)
    ).fetchone()

    conn.close()

    if plan is None:
        return jsonify({
            "error": "Plan not found"
        }), 404

    return jsonify(dict(plan))


# --------------------------------
# UPDATE PLAN
# --------------------------------

@app.route("/plans/<int:plan_id>", methods=["PUT"])
def update_plan(plan_id):

    data = request.get_json()

    conn = get_db_connection()

    existing_plan = conn.execute(
        "SELECT * FROM plans WHERE id = ?",
        (plan_id,)
    ).fetchone()

    if existing_plan is None:
        conn.close()

        return jsonify({
            "error": "Plan not found"
        }), 404

    conn.execute("""
        UPDATE plans
        SET
            service = ?,
            plan_name = ?,
            category = ?,
            recharge_date = ?,
            expiry_date = ?,
            frequency = ?,
            amount = ?,
            status = ?,
            notes = ?
        WHERE id = ?
    """, (
        data.get("service"),
        data.get("plan_name"),
        data.get("category"),
        data.get("recharge_date"),
        data.get("expiry_date"),
        data.get("frequency"),
        data.get("amount"),
        data.get("status", "Active"),
        data.get("notes"),
        plan_id
    ))

    conn.commit()
    conn.close()

    return jsonify({
        "message": "Plan updated successfully"
    })

# --------------------------------
# RECHARGE PLAN
# --------------------------------

@app.route("/plans/<int:plan_id>/recharge", methods=["POST"])
def recharge_plan(plan_id):

    data = request.get_json()

    recharge_date = data.get("recharge_date")
    new_expiry_date = data.get("expiry_date")
    amount = data.get("amount")
    notes = data.get("notes")

    if not recharge_date:
        return jsonify({
            "error": "Recharge date is required"
        }), 400

    conn = get_db_connection()

    plan = conn.execute(
        "SELECT * FROM plans WHERE id = ?",
        (plan_id,)
    ).fetchone()

    if plan is None:
        conn.close()

        return jsonify({
            "error": "Plan not found"
        }), 404

    old_expiry_date = plan["expiry_date"]

    # Update current plan
    conn.execute("""
        UPDATE plans
        SET
            recharge_date = ?,
            expiry_date = ?,
            amount = ?,
            status = 'Active'
        WHERE id = ?
    """, (
        recharge_date,
        new_expiry_date,
        amount if amount is not None else plan["amount"],
        plan_id
    ))

    # Save recharge history
    conn.execute("""
        INSERT INTO recharge_history
        (
            plan_id,
            recharge_date,
            old_expiry_date,
            new_expiry_date,
            amount,
            notes
        )
        VALUES (?, ?, ?, ?, ?, ?)
    """, (
        plan_id,
        recharge_date,
        old_expiry_date,
        new_expiry_date,
        amount if amount is not None else plan["amount"],
        notes
    ))

    conn.commit()
    conn.close()

    return jsonify({
        "message": "Recharge updated successfully"
    })

# --------------------------------
# RECHARGE HISTORY
# --------------------------------

@app.route("/plans/<int:plan_id>/history", methods=["GET"])
def get_recharge_history(plan_id):

    conn = get_db_connection()

    plan = conn.execute(
        "SELECT * FROM plans WHERE id = ?",
        (plan_id,)
    ).fetchone()

    if plan is None:
        conn.close()
        return jsonify({
            "error": "Plan not found"
        }), 404

    history = conn.execute("""
        SELECT *
        FROM recharge_history
        WHERE plan_id = ?
        ORDER BY recharge_date DESC
    """, (plan_id,)).fetchall()

    conn.close()

    return jsonify([dict(row) for row in history])

# --------------------------------
# DELETE PLAN
# --------------------------------

@app.route("/plans/<int:plan_id>", methods=["DELETE"])
def delete_plan(plan_id):

    conn = get_db_connection()

    existing_plan = conn.execute(
        "SELECT * FROM plans WHERE id = ?",
        (plan_id,)
    ).fetchone()

    if existing_plan is None:
        conn.close()

        return jsonify({
            "error": "Plan not found"
        }), 404

    conn.execute(
        "DELETE FROM plans WHERE id = ?",
        (plan_id,)
    )

    conn.commit()
    conn.close()

    return jsonify({
        "message": "Plan deleted successfully"
    })

@app.route("/telegram/test", methods=["GET"])
def telegram_test():
    success = send_telegram_message(
        "ðŸ”” Network Recharge Manager\n\nTelegram notification test successful! âœ…"
    )

    if success:
        return jsonify({
            "message": "Telegram message sent successfully"
        })

    return jsonify({
        "error": "Failed to send Telegram message"
    }), 500

# --------------------------------
# START SERVER
# --------------------------------

if __name__ == "__main__":
    scheduler = BackgroundScheduler(
        timezone="Asia/Kolkata"
    )

    scheduler.add_job(
        run_scheduled_expiry_reminders,
        "cron",
        hour=9,
        minute=0,
        id="daily_expiry_check",
        replace_existing=True
    )

    scheduler.start()

    print("Scheduler started.")
    print("Daily reminder check scheduled for 09:00 Asia/Kolkata.")

    app.run(
        debug=True,
        port=5000,
        use_reloader=False
    )
