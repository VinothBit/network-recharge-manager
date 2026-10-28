"""Dedicated single-instance APScheduler process for expiry notifications."""

import sys
from pathlib import Path

import portalocker
from apscheduler.schedulers.blocking import BlockingScheduler
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")

from app import run_scheduled_expiry_reminders
from coordination import scheduler_instance_lock
from database import DATABASE


def configure_scheduler(scheduler, job):
    scheduler.add_job(
        job,
        "cron",
        hour=9,
        minute=0,
        id="daily_expiry_check",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
        misfire_grace_time=3600,
    )
    return scheduler


def main():
    try:
        with scheduler_instance_lock(DATABASE):
            scheduler = BlockingScheduler(timezone="Asia/Kolkata")
            configure_scheduler(scheduler, run_scheduled_expiry_reminders)
            print("Scheduler started.")
            print("Daily reminder check scheduled for 09:00 Asia/Kolkata.")
            scheduler.start()
    except portalocker.exceptions.LockException:
        print("A reminder scheduler is already running; refusing to start a duplicate.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
