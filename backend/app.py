from flask import Flask, g, jsonify, request, send_file, session
import sqlite3
import tempfile
from pathlib import Path
from datetime import date, datetime, timedelta
from flask_cors import CORS
from dotenv import load_dotenv
import os
import hmac
import secrets
from urllib.parse import urlparse
import portalocker
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash

load_dotenv(Path(__file__).resolve().parent / ".env")

from database import (
    DATABASE,
    create_initial_admin,
    get_db_connection,
    init_db,
    verify_single_admin_account,
)
from coordination import acquire_database_operation_lock, database_operation_lock

app = Flask(__name__)
APP_ENV = os.getenv("APP_ENV", "development").strip().lower()
if APP_ENV not in {"development", "testing", "production"}:
    raise RuntimeError("APP_ENV must be development, testing, or production.")
IS_PRODUCTION = APP_ENV == "production"
FLASK_SECRET_KEY = os.getenv("FLASK_SECRET_KEY", "")
if len(FLASK_SECRET_KEY.encode("utf-8")) < 32:
    raise RuntimeError(
        "FLASK_SECRET_KEY must be configured with at least 32 bytes of random data."
    )

configured_origins = os.getenv("FRONTEND_ORIGINS", "").strip()
if IS_PRODUCTION and not configured_origins:
    raise RuntimeError("Set FRONTEND_ORIGINS to the exact HTTPS frontend origin in production.")
if configured_origins:
    FRONTEND_ORIGINS = [
        origin.strip().rstrip("/")
        for origin in configured_origins.split(",")
        if origin.strip()
    ]
else:
    FRONTEND_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]

for origin in FRONTEND_ORIGINS:
    parsed_origin = urlparse(origin)
    if (
        "*" in origin
        or parsed_origin.scheme not in {"http", "https"}
        or not parsed_origin.netloc
        or parsed_origin.path
        or parsed_origin.query
        or parsed_origin.fragment
        or parsed_origin.username
        or parsed_origin.password
    ):
        raise RuntimeError("FRONTEND_ORIGINS must contain exact origins without paths or wildcards.")
    if IS_PRODUCTION and parsed_origin.scheme != "https":
        raise RuntimeError("Production FRONTEND_ORIGINS must use HTTPS.")

if IS_PRODUCTION and len(FRONTEND_ORIGINS) != 1:
    raise RuntimeError("Configure exactly one production frontend origin in FRONTEND_ORIGINS.")

secure_cookie_setting = os.getenv("SESSION_COOKIE_SECURE")
SESSION_COOKIE_SECURE = (
    secure_cookie_setting.strip().lower() in {"1", "true", "yes"}
    if secure_cookie_setting is not None
    else IS_PRODUCTION
)
if IS_PRODUCTION and not SESSION_COOKIE_SECURE:
    raise RuntimeError("SESSION_COOKIE_SECURE must be enabled in production.")

SESSION_COOKIE_SAMESITE = os.getenv("SESSION_COOKIE_SAMESITE", "Lax").strip().capitalize()
if SESSION_COOKIE_SAMESITE not in {"Lax", "Strict", "None"}:
    raise RuntimeError("SESSION_COOKIE_SAMESITE must be Lax, Strict, or None.")
if SESSION_COOKIE_SAMESITE == "None" and not SESSION_COOKIE_SECURE:
    raise RuntimeError("SameSite=None cookies require SESSION_COOKIE_SECURE=true.")

try:
    DATABASE_LOCK_TIMEOUT_SECONDS = float(
        os.getenv("DATABASE_LOCK_TIMEOUT_SECONDS", "60")
    )
    TRUSTED_PROXY_HOPS = int(os.getenv("TRUSTED_PROXY_HOPS", "0"))
except ValueError as error:
    raise RuntimeError(
        "DATABASE_LOCK_TIMEOUT_SECONDS and TRUSTED_PROXY_HOPS must be numeric."
    ) from error
if DATABASE_LOCK_TIMEOUT_SECONDS <= 0 or TRUSTED_PROXY_HOPS < 0:
    raise RuntimeError("Database lock timeout must be positive and proxy hops cannot be negative.")

RATE_LIMIT_STORAGE_URI = os.getenv("RATELIMIT_STORAGE_URI", "memory://").strip() or "memory://"
if IS_PRODUCTION and not RATE_LIMIT_STORAGE_URI.lower().startswith(("redis://", "rediss://")):
    raise RuntimeError(
        "Production requires a shared Redis RATELIMIT_STORAGE_URI; memory storage is development-only."
    )

app.config.update(
    SECRET_KEY=FLASK_SECRET_KEY,
    SESSION_COOKIE_NAME="rlems_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=SESSION_COOKIE_SECURE,
    SESSION_COOKIE_SAMESITE=SESSION_COOKIE_SAMESITE,
    SESSION_COOKIE_PATH="/",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
    SESSION_REFRESH_EACH_REQUEST=False,
    MAX_CONTENT_LENGTH=1024 * 1024 * 1024,
    RATELIMIT_STORAGE_URI=RATE_LIMIT_STORAGE_URI,
    RATELIMIT_HEADERS_ENABLED=True,
)

if TRUSTED_PROXY_HOPS:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=TRUSTED_PROXY_HOPS)

CORS(
    app,
    resources={r"/*": {"origins": FRONTEND_ORIGINS}},
    supports_credentials=True,
    allow_headers=["Content-Type", "X-CSRF-Token"],
    methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
)

limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=[],
    storage_uri=RATE_LIMIT_STORAGE_URI,
    strategy="fixed-window",
    swallow_errors=False,
)

if IS_PRODUCTION:
    app.logger.warning(
        "Reminder scheduling runs separately; start exactly one scheduler_service.py process."
    )

REQUIRED_DATABASE_TABLES = {"plans", "recharge_history", "reminder_log", "users"}


@app.before_request
def lock_database_operations():
    try:
        g.rlems_database_operation_lock = acquire_database_operation_lock(
            DATABASE,
            timeout=DATABASE_LOCK_TIMEOUT_SECONDS,
        )
    except portalocker.exceptions.LockException:
        return jsonify({"error": "Database is busy. Please retry shortly."}), 503


@app.teardown_request
def unlock_database_operations(error=None):
    lock = g.pop("rlems_database_operation_lock", None)
    if lock is not None:
        lock.release()


@app.after_request
def add_security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("Cache-Control", "no-store")
    return response


@app.errorhandler(429)
def handle_rate_limit_exceeded(error):
    return jsonify({"error": "Too many login attempts. Try again later."}), 429


def valid_csrf_token():
    expected_token = session.get("csrf_token")
    received_token = request.headers.get("X-CSRF-Token", "")
    return bool(
        expected_token
        and received_token
        and hmac.compare_digest(expected_token, received_token)
    )


@app.before_request
def require_authentication_and_csrf():
    if request.method == "OPTIONS":
        return None

    if request.endpoint == "auth_csrf":
        return None

    if request.endpoint == "login":
        if request.method in {"POST", "PUT", "PATCH", "DELETE"} and not valid_csrf_token():
            return jsonify({"error": "CSRF token missing or invalid."}), 403
        return None

    if request.endpoint == "auth_me" and request.method == "GET":
        return None

    user_id = session.get("user_id")
    if user_id is None:
        return jsonify({"error": "Authentication required."}), 401

    connection = get_db_connection()
    try:
        user = connection.execute(
            "SELECT id FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    finally:
        connection.close()

    if user is None:
        session.clear()
        return jsonify({"error": "Authentication required."}), 401

    csrf_protected_gets = {"test_reminders"}
    requires_csrf = (
        request.method in {"POST", "PUT", "PATCH", "DELETE"}
        or request.endpoint in csrf_protected_gets
    )
    if requires_csrf and not valid_csrf_token():
        return jsonify({"error": "CSRF token missing or invalid."}), 403
    return None


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

        user_columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info(users)").fetchall()
        }
        required_user_columns = {"id", "username", "password_hash", "created_at"}
        missing_user_columns = required_user_columns - user_columns
        if missing_user_columns:
            raise ValueError("Database users table is missing required columns.")

        stored_users = connection.execute(
            "SELECT username, password_hash FROM users"
        ).fetchall()
        valid_users = []
        for row in stored_users:
            username, password_hash = row[0], row[1]
            if not username or not username.strip() or not password_hash:
                continue
            if not (
                password_hash.startswith("scrypt:")
                or password_hash.startswith("pbkdf2:")
            ):
                continue
            try:
                check_password_hash(password_hash, "restore-validation-probe")
            except (TypeError, ValueError):
                continue
            valid_users.append(row)
        usernames = [row[0] for row in valid_users]
        if len(stored_users) != 1 or len(valid_users) != 1 or len(set(usernames)) != 1:
            raise ValueError(
                "Database must contain exactly one administrator with a valid password hash."
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

# Initialize the database under the shared lock so concurrent workers cannot race.
with database_operation_lock(DATABASE, timeout=DATABASE_LOCK_TIMEOUT_SECONDS):
    init_db()
    create_initial_admin()
    verify_single_admin_account()


@app.route("/auth/csrf", methods=["GET"])
def auth_csrf():
    if not session.get("csrf_token"):
        session["csrf_token"] = secrets.token_urlsafe(32)
        session.permanent = True
    return jsonify({"csrf_token": session["csrf_token"]})


@app.route("/login", methods=["POST"])
@limiter.limit("5 per minute; 20 per hour")
def login():
    data = request.get_json(silent=True) or {}
    username = data.get("username", "")
    password = data.get("password", "")
    if not isinstance(username, str) or not isinstance(password, str):
        return jsonify({"error": "Invalid username or password."}), 401

    connection = get_db_connection()
    try:
        user = connection.execute(
            "SELECT id, username, password_hash FROM users WHERE username = ?",
            (username.strip(),),
        ).fetchone()
    finally:
        connection.close()

    try:
        valid_password = (
            user is not None
            and check_password_hash(user["password_hash"], password)
        )
    except (TypeError, ValueError):
        valid_password = False

    if not valid_password:
        return jsonify({"error": "Invalid username or password."}), 401

    session.clear()
    session.permanent = True
    session["user_id"] = int(user["id"])
    session["username"] = user["username"]
    session["csrf_token"] = secrets.token_urlsafe(32)
    return jsonify({
        "authenticated": True,
        "username": user["username"],
        "csrf_token": session["csrf_token"],
    })


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    session.permanent = True
    session["csrf_token"] = secrets.token_urlsafe(32)
    return jsonify({"success": True, "csrf_token": session["csrf_token"]})


@app.route("/auth/me", methods=["GET"])
def auth_me():
    user_id = session.get("user_id")
    if user_id is None:
        return jsonify({"authenticated": False})

    connection = get_db_connection()
    try:
        user = connection.execute(
            "SELECT id, username FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    finally:
        connection.close()

    if user is None:
        session.clear()
        return jsonify({"authenticated": False})

    return jsonify({"authenticated": True, "username": user["username"]})


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
                conn.commit()

                print("\n[REMINDER]")
                print(f"Service: {service}")
                print(f"Plan: {plan_name}")
                print(f"Recharge Date: {plan['recharge_date']}")
                print("Reminder Type: EXPIRY DATE MISSING")

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

        elif days_remaining == 1:

            reminder_type = "1_DAY"

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
        conn.commit()

        # -----------------------------
        # PRINT REMINDER
        # -----------------------------

        print("\n[REMINDER]")
        print(f"Service: {service}")
        print(f"Plan: {plan_name}")
        print(f"Expiry Date: {expiry_date}")
        print(f"Days Remaining: {days_remaining}")
        print(f"Reminder Type: {reminder_type}")

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
    try:
        with database_operation_lock(
            DATABASE,
            timeout=DATABASE_LOCK_TIMEOUT_SECONDS,
        ):
            check_expiry_reminders()
    except portalocker.exceptions.LockException:
        app.logger.warning("Scheduled reminder check skipped because the database remained busy.")


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

        # The shared cross-process request lock excludes web workers and scheduler jobs.
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


@app.route("/backup/database", methods=["GET"])
def backup_database():
    if not os.path.isfile(DATABASE):
        return jsonify({"error": "Database file not found"}), 404

    snapshot_path = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=".backup_download_",
            suffix=".db",
            dir=str(DATABASE.parent),
            delete=False,
        ) as snapshot_file:
            snapshot_path = Path(snapshot_file.name)

        source = sqlite3.connect(str(DATABASE))
        destination = sqlite3.connect(str(snapshot_path))
        try:
            source.backup(destination)
        finally:
            destination.close()
            source.close()

        response = send_file(
            snapshot_path,
            as_attachment=True,
            download_name="recharge_manager_backup.db",
            mimetype="application/octet-stream",
        )
        response.call_on_close(lambda: snapshot_path.unlink(missing_ok=True))
        return response
    except Exception:
        if snapshot_path is not None:
            snapshot_path.unlink(missing_ok=True)
        raise

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

# --------------------------------
# START SERVER
# --------------------------------

if __name__ == "__main__":
    if IS_PRODUCTION and os.name == "nt":
        from waitress import serve

        print("Starting Waitress on 127.0.0.1:5000.")
        serve(app, host="127.0.0.1", port=5000)
    elif IS_PRODUCTION:
        raise RuntimeError(
            "Use the documented Gunicorn WSGI command on non-Windows production hosts."
        )
    else:
        app.run(
            debug=True,
            port=5000,
            use_reloader=False,
        )
