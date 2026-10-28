import os
from datetime import date, timedelta
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import portalocker
TEST_DATA = tempfile.TemporaryDirectory(prefix="rlems-deployment-tests-")
BACKEND_DIR = Path(__file__).resolve().parents[1]
TEST_DATABASE = Path(TEST_DATA.name) / "isolated-test.db"

os.environ.update({
    "APP_ENV": "testing",
    "DATABASE_PATH": str(TEST_DATABASE),
    "FLASK_SECRET_KEY": "test-only-secret-key-value-longer-than-32-bytes",
    "ADMIN_USERNAME": "test-admin",
    "ADMIN_PASSWORD": "test-only-password-not-for-real-use",
    "RATELIMIT_STORAGE_URI": "memory://",
    "SESSION_COOKIE_SECURE": "false",
    "FRONTEND_ORIGINS": "http://localhost:5173",
})

import app as app_module  # noqa: E402
import database  # noqa: E402
import scheduler_service  # noqa: E402
from coordination import (  # noqa: E402
    acquire_database_operation_lock,
    database_operation_lock_path,
    scheduler_instance_lock_path,
)


class FakeScheduler:
    def __init__(self, timezone):
        self.timezone = timezone
        self.job_args = None
        self.job_options = None

    def add_job(self, *args, **kwargs):
        self.job_args = args
        self.job_options = kwargs


class DeploymentSafetyTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        TEST_DATA.cleanup()

    def test_database_path_uses_environment_override(self):
        self.assertEqual(database.DATABASE, TEST_DATABASE.resolve())
        self.assertNotEqual(
            database.DATABASE,
            (BACKEND_DIR / "recharge_manager.db").resolve(),
        )

    def test_database_module_resolves_custom_path_in_fresh_process(self):
        custom_path = Path(TEST_DATA.name) / "custom" / "rlems.db"
        child_env = os.environ.copy()
        child_env["DATABASE_PATH"] = str(custom_path)
        child_env["PYTHONPATH"] = str(BACKEND_DIR)
        result = subprocess.run(
            [sys.executable, "-c", "import database; print(database.DATABASE)"],
            cwd=BACKEND_DIR,
            env=child_env,
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(Path(result.stdout.strip()), custom_path.resolve())

    def test_database_module_defaults_to_existing_backend_location(self):
        child_env = os.environ.copy()
        child_env.pop("DATABASE_PATH", None)
        child_env["PYTHONPATH"] = str(BACKEND_DIR)
        result = subprocess.run(
            [sys.executable, "-c", "import database; print(database.DATABASE)"],
            cwd=BACKEND_DIR,
            env=child_env,
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(
            Path(result.stdout.strip()),
            (BACKEND_DIR / "recharge_manager.db").resolve(),
        )

    def test_login_is_limited_and_csrf_remains_required(self):
        client = app_module.app.test_client()
        csrf = client.get(
            "/auth/csrf", environ_overrides={"REMOTE_ADDR": "198.51.100.42"}
        ).json["csrf_token"]
        statuses = []
        for _ in range(6):
            response = client.post(
                "/login",
                json={"username": "test-admin", "password": "incorrect-test-only"},
                headers={"X-CSRF-Token": csrf},
                environ_overrides={"REMOTE_ADDR": "198.51.100.42"},
            )
            statuses.append(response.status_code)
        self.assertEqual(statuses, [401, 401, 401, 401, 401, 429])

        no_csrf = client.post(
            "/login",
            json={"username": "test-admin", "password": "incorrect-test-only"},
            environ_overrides={"REMOTE_ADDR": "198.51.100.43"},
        )
        self.assertEqual(no_csrf.status_code, 403)

    def test_scheduler_is_configured_for_one_daily_asia_kolkata_job(self):
        scheduler = FakeScheduler("Asia/Kolkata")
        marker_job = lambda: None
        scheduler_service.configure_scheduler(scheduler, marker_job)
        self.assertEqual(scheduler.timezone, "Asia/Kolkata")
        self.assertEqual(scheduler.job_args[0], marker_job)
        self.assertEqual(scheduler.job_args[1], "cron")
        self.assertEqual(
            {key: scheduler.job_options[key] for key in ("hour", "minute", "id")},
            {"hour": 9, "minute": 0, "id": "daily_expiry_check"},
        )
        self.assertTrue(scheduler.job_options["replace_existing"])
        self.assertEqual(scheduler.job_options["max_instances"], 1)
        self.assertTrue(scheduler.job_options["coalesce"])

    def test_database_and_scheduler_locks_exclude_other_processes(self):
        lock_paths = (
            database_operation_lock_path(TEST_DATABASE),
            scheduler_instance_lock_path(TEST_DATABASE),
        )
        for index, lock_path in enumerate(lock_paths):
            with self.subTest(lock_path=lock_path.name):
                script = (
                    "import sys,time,portalocker; "
                    "lock=portalocker.Lock(sys.argv[1],mode='a',timeout=0); "
                    "lock.acquire(); print('ready',flush=True); time.sleep(1); lock.release()"
                )
                child_env = os.environ.copy()
                child = subprocess.Popen(
                    [sys.executable, "-c", script, str(lock_path)],
                    cwd=BACKEND_DIR,
                    env=child_env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                try:
                    self.assertEqual(child.stdout.readline().strip(), "ready")
                    candidate = None
                    try:
                        if index == 0:
                            candidate = acquire_database_operation_lock(
                                TEST_DATABASE,
                                timeout=0.1,
                            )
                        else:
                            candidate = portalocker.Lock(
                                str(lock_path), mode="a", timeout=0.1
                            )
                            candidate.acquire()
                        blocked = False
                    except portalocker.exceptions.LockException:
                        blocked = True
                    if not blocked and candidate is not None:
                        candidate.release()
                    self.assertTrue(blocked)
                finally:
                    child.wait(timeout=5)
                    child.stdout.close()
                    child.stderr.close()

    def test_expiry_reminders_are_logged_once_without_external_delivery(self):
        offsets = {
            "7_DAYS": 7,
            "3_DAYS": 3,
            "1_DAY": 1,
            "DUE_TODAY": 0,
            "EXPIRED": -1,
            "EXPIRY_MISSING": None,
        }
        connection = database.get_db_connection()
        plan_ids = {}
        try:
            for reminder_type, days in offsets.items():
                expiry = (
                    (date.today() + timedelta(days=days)).isoformat()
                    if days is not None
                    else None
                )
                cursor = connection.execute(
                    """
                    INSERT INTO plans (
                        service, plan_name, category, recharge_date, expiry_date,
                        frequency, amount, status, notes
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        "Test Service",
                        f"Reminder test {reminder_type}",
                        "Test",
                        date.today().isoformat(),
                        expiry,
                        "Monthly",
                        0,
                        "ACTIVE",
                        "Isolated automated test",
                    ),
                )
                plan_ids[reminder_type] = cursor.lastrowid
            connection.commit()
        finally:
            connection.close()

        app_module.check_expiry_reminders()
        app_module.check_expiry_reminders()

        connection = database.get_db_connection()
        try:
            rows = connection.execute(
                """
                SELECT plan_id, reminder_type, expiry_date
                FROM reminder_log
                WHERE plan_id IN (?, ?, ?, ?, ?, ?)
                """,
                tuple(plan_ids.values()),
            ).fetchall()
        finally:
            connection.close()

        self.assertEqual(len(rows), len(offsets))
        self.assertEqual(
            {(row["plan_id"], row["reminder_type"]) for row in rows},
            {(plan_ids[reminder_type], reminder_type) for reminder_type in offsets},
        )
        missing_expiry = next(
            row for row in rows if row["reminder_type"] == "EXPIRY_MISSING"
        )
        self.assertIsNone(missing_expiry["expiry_date"])


if __name__ == "__main__":
    unittest.main()
