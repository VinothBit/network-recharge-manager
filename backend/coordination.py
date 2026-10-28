"""Cross-process locks shared by Flask workers and the reminder service."""

from contextlib import contextmanager
from pathlib import Path

import portalocker


def database_operation_lock_path(database_path):
    database_path = Path(database_path).expanduser().resolve()
    return database_path.with_name(f"{database_path.name}.operations.lock")


def scheduler_instance_lock_path(database_path):
    database_path = Path(database_path).expanduser().resolve()
    return database_path.with_name(f"{database_path.name}.scheduler.lock")


def acquire_database_operation_lock(database_path, timeout=60):
    """Acquire the shared exclusive lock; caller must call release()."""
    lock = portalocker.Lock(
        str(database_operation_lock_path(database_path)),
        mode="a",
        timeout=timeout,
    )
    lock.acquire()
    return lock


@contextmanager
def database_operation_lock(database_path, timeout=60):
    lock = portalocker.Lock(
        str(database_operation_lock_path(database_path)),
        mode="a",
        timeout=timeout,
    )
    with lock:
        yield


@contextmanager
def scheduler_instance_lock(database_path):
    """Hold a host-local singleton lock for the scheduler's full lifetime."""
    lock = portalocker.Lock(
        str(scheduler_instance_lock_path(database_path)),
        mode="a",
        timeout=0,
    )
    with lock:
        yield
