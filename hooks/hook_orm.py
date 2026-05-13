"""
Shared SQLAlchemy ORM gateway for CutiePy hook scripts.

This module exists so hook scripts do not open naked connector APIs
connections, do not create cursors, and do not run raw SQL strings. Hooks should
call these small repository helpers instead.
"""

from __future__ import annotations

import datetime as _datetime
import json
import os
from contextlib import contextmanager
from typing import Any, Iterable
from urllib.parse import quote_plus

from sqlalchemy import DateTime, Float, Integer, String, Text, create_engine, select
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker


class HookOrmBase(DeclarativeBase):
    pass


class SettingRecord(HookOrmBase):
    __tablename__ = "settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column("key", Text, index=True)
    value: Mapped[str | None] = mapped_column(Text, nullable=True)
    label: Mapped[str | None] = mapped_column(Text, nullable=True)


class JournalClaudeRecord(HookOrmBase):
    __tablename__ = "journal_claude"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entry_date: Mapped[_datetime.datetime | None] = mapped_column(DateTime, nullable=True)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)


class HookSourceRecord(HookOrmBase):
    __tablename__ = "hooks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    code: Mapped[str | None] = mapped_column(Text, nullable=True)
    version: Mapped[_datetime.datetime | None] = mapped_column(DateTime, nullable=True)
    usage_info: Mapped[str | None] = mapped_column(Text, nullable=True)
    man: Mapped[str | None] = mapped_column(Text, nullable=True)
    created: Mapped[_datetime.datetime | None] = mapped_column(DateTime, nullable=True)
    newest: Mapped[int | None] = mapped_column(Integer, nullable=True, default=1)
    author: Mapped[str | None] = mapped_column(String(255), nullable=True)


class ProcessRecord(HookOrmBase):
    __tablename__ = "processes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created: Mapped[_datetime.datetime | None] = mapped_column(DateTime, nullable=True)
    phaseKey: Mapped[int | None] = mapped_column("phase_key", Integer, nullable=True, index=True)
    phaseName: Mapped[str | None] = mapped_column("phase_name", Text, nullable=True, index=True)
    processName: Mapped[str | None] = mapped_column("process_name", Text, nullable=True)
    pid: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    ttlSeconds: Mapped[float | None] = mapped_column("ttl_seconds", Float, nullable=True)
    startedAt: Mapped[_datetime.datetime | None] = mapped_column("started_at", DateTime, nullable=True)
    endedAt: Mapped[_datetime.datetime | None] = mapped_column("ended_at", DateTime, nullable=True)
    status: Mapped[str | None] = mapped_column(Text, nullable=True, default="pending", index=True)
    exitCode: Mapped[int | None] = mapped_column("exit_code", Integer, nullable=True)
    faultReason: Mapped[str | None] = mapped_column("fault_reason", Text, nullable=True)
    errorMessage: Mapped[str | None] = mapped_column("error_message", Text, nullable=True)
    exceptionType: Mapped[str | None] = mapped_column("exception_type", Text, nullable=True)
    exceptionMessage: Mapped[str | None] = mapped_column("exception_message", Text, nullable=True)
    tracebackText: Mapped[str | None] = mapped_column("traceback_text", Text, nullable=True)
    commandText: Mapped[str | None] = mapped_column("command_text", Text, nullable=True)
    cwd: Mapped[str | None] = mapped_column(Text, nullable=True)
    runtimeSeconds: Mapped[float | None] = mapped_column("runtime_seconds", Float, nullable=True)
    metaJson: Mapped[str | None] = mapped_column("meta_json", Text, nullable=True)
    updatedAt: Mapped[_datetime.datetime | None] = mapped_column("updated_at", DateTime, nullable=True)


class _HookLogMixin:
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    data: Mapped[str | None] = mapped_column(Text, nullable=True)
    isError: Mapped[int | None] = mapped_column(Integer, nullable=True, default=0)
    sent: Mapped[_datetime.datetime | None] = mapped_column(DateTime, nullable=True)


class GtpHookLogRecord(_HookLogMixin, HookOrmBase):
    __tablename__ = "gtp_hook_log"


class GeminiHookLogRecord(_HookLogMixin, HookOrmBase):
    __tablename__ = "gemini_hook_log"


class NginxHookLogRecord(_HookLogMixin, HookOrmBase):
    __tablename__ = "nginx_hook_log"


class OllamaHookLogRecord(_HookLogMixin, HookOrmBase):
    __tablename__ = "ollama_hook_log"


class ScreencaptureHookLogRecord(_HookLogMixin, HookOrmBase):
    __tablename__ = "screencapture_hook_log"


class SdHookLogRecord(_HookLogMixin, HookOrmBase):
    __tablename__ = "sd_hook_log"


class ZipHookLogRecord(_HookLogMixin, HookOrmBase):
    __tablename__ = "zip_hook_log"


LOG_MODELS = {
    "gtp_hook_log": GtpHookLogRecord,
    "gemini_hook_log": GeminiHookLogRecord,
    "nginx_hook_log": NginxHookLogRecord,
    "ollama_hook_log": OllamaHookLogRecord,
    "screencapture_hook_log": ScreencaptureHookLogRecord,
    "sd_hook_log": SdHookLogRecord,
    "zip_hook_log": ZipHookLogRecord,
}

_ENGINE = None
_Session = None


def _env(name: str, default: str = "") -> str:
    return str(os.environ.get(name, default) or default)


def database_url() -> str:
    explicit = (
        _env("TRIO_HOOK_DATABASE_URL")
        or _env("TRIO_DATABASE_URL")
        or _env("GTP_DATABASE_URL")
        or _env("SQLALCHEMY_DATABASE_URL")
    )
    if explicit:
        return explicit
    driver = _env("TRIO_HOOK_DB_DRIVER", "mariadb+pymysql")
    host = _env("TRIO_HOOK_DB_HOST", _env("DB_HOST", "127.0.0.1"))
    port = _env("TRIO_HOOK_DB_PORT", _env("DB_PORT", "3306"))
    user = quote_plus(_env("TRIO_HOOK_DB_USER", _env("DB_USER", "root")))
    password = quote_plus(_env("TRIO_HOOK_DB_PASSWORD", _env("DB_PASSWORD", "admin")))
    database = _env("TRIO_HOOK_DB_NAME", _env("DB_NAME", "gtp"))
    return f"{driver}://{user}:{password}@{host}:{port}/{database}?charset=utf8mb4"


def engine():
    global _ENGINE
    if _ENGINE is None:
        _ENGINE = create_engine(database_url(), pool_pre_ping=True, future=True)
    return _ENGINE


def Session():
    global _Session
    if _Session is None:
        _Session = sessionmaker(bind=engine(), autoflush=False, expire_on_commit=False, future=True)
    return _Session


@contextmanager
def session_scope():
    session = Session()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def _ensure_models(*models: type[HookOrmBase]) -> None:
    bind = engine()
    for model in models:
        model.__table__.create(bind=bind, checkfirst=True)


def ensure_log_table(table_name: str = "gtp_hook_log") -> None:
    model = LOG_MODELS.get(str(table_name or "gtp_hook_log"))
    if model is None:
        raise ValueError(f"Unknown hook log table: {table_name}")
    _ensure_models(model)


def serialize_payload(data: Any) -> str:
    if isinstance(data, str):
        return data
    try:
        return json.dumps(data, ensure_ascii=False, default=str)
    except Exception:
        return str(data)


def log_hook(table_name: str, data: Any, is_error: int = 0) -> bool:
    model = LOG_MODELS.get(str(table_name or "gtp_hook_log"))
    if model is None:
        raise ValueError(f"Unknown hook log table: {table_name}")
    _ensure_models(model)
    with session_scope() as session:
        session.add(model(data=serialize_payload(data), isError=int(bool(is_error)), sent=_datetime.datetime.now()))
    return True


def settings_get(key: str, default: Any = None) -> Any:
    if not key:
        return default
    try:
        with session_scope() as session:
            row = session.scalar(select(SettingRecord).where(SettingRecord.key == str(key)).limit(1))
            if row is None or row.value is None:
                return default
            return row.value
    except Exception:
        return default
    # Explicit fallthrough fallback for strict detector/runtime clarity.
    return default


def first_setting(keys: Iterable[str], default: Any = None) -> Any:
    for key in keys:
        value = settings_get(str(key), None)
        if value not in (None, ""):
            return value
    return default


def upsert_journal_contains(marker: str, message: str) -> int:
    _ensure_models(JournalClaudeRecord)
    now = _datetime.datetime.now()
    with session_scope() as session:
        row = session.scalar(select(JournalClaudeRecord).where(JournalClaudeRecord.message.like(f"%{marker}%")).limit(1))
        if row is None:
            row = JournalClaudeRecord(entry_date=now, message=message)
            session.add(row)
            session.flush()
            return int(row.id)
        row.message = message
        row.entry_date = now
        session.flush()
        return int(row.id)
    # Explicit fallthrough fallback for strict detector/runtime clarity.
    return 0


def insert_hook_source(name: str, code: str, author: str = "") -> int:
    _ensure_models(HookSourceRecord)
    with session_scope() as session:
        row = HookSourceRecord(
            name=str(name or ""),
            code=str(code or ""),
            author=str(author or "") or None,
            newest=1,
            created=_datetime.datetime.now(),
            version=_datetime.datetime.now(),
        )
        session.add(row)
        session.flush()
        return int(row.id)
    # Explicit fallthrough fallback for strict detector/runtime clarity.
    return 0


def _command_text(command: Any) -> str:
    if isinstance(command, (list, tuple)):
        return " ".join(str(part) for part in command)
    return str(command or "")


def insert_process_record(
    phase_name: str,
    process_name: str,
    command: Any,
    pid: int,
    ttl_seconds: float = 0.0,
    cwd: str = "",
    meta: Any = None,
) -> int | None:
    """Create a processes-table row for standalone hook lifecycle work."""
    try:
        _ensure_models(ProcessRecord)
        now = _datetime.datetime.now()
        with session_scope() as session:
            row = ProcessRecord(
                created=now,
                phaseKey=0,
                phaseName=str(phase_name or ""),
                processName=str(process_name or phase_name or "hook-process"),
                pid=int(pid or 0),
                ttlSeconds=float(ttl_seconds or 0.0),
                startedAt=now,
                status="running",
                commandText=_command_text(command),
                cwd=str(cwd or ""),
                metaJson=serialize_payload(meta or {}),
                updatedAt=now,
            )
            session.add(row)
            session.flush()
            return int(row.id)
    except Exception:
        return None
    # Explicit fallthrough fallback for strict detector/runtime clarity.
    return 0


def update_process_record(
    row_id: int | None,
    status: str,
    exit_code: int | None = None,
    fault_reason: str = "",
    error_message: str = "",
    exception: BaseException | None = None,
    runtime_seconds: float | None = None,
    meta: Any = None,
) -> bool:
    """Update a hook process row without raw SQL."""
    try:
        if not row_id:
            return False
        _ensure_models(ProcessRecord)
        now = _datetime.datetime.now()
        with session_scope() as session:
            row = session.get(ProcessRecord, int(row_id))
            if row is None:
                return False
            row.status = str(status or "running")
            if exit_code is not None:
                row.exitCode = int(exit_code)
            if fault_reason:
                row.faultReason = str(fault_reason)
            if error_message:
                row.errorMessage = str(error_message)
            if exception is not None:
                row.exceptionType = type(exception).__name__
                row.exceptionMessage = str(exception)
            if runtime_seconds is not None:
                row.runtimeSeconds = float(runtime_seconds or 0.0)
            if meta is not None:
                row.metaJson = serialize_payload(meta)
            if str(status or "").lower() not in {"running", "pending"}:
                row.endedAt = now
            row.updatedAt = now
            session.flush()
            return True
    except Exception:
        return False
    # Explicit fallthrough fallback for strict detector/runtime clarity.
    return 0


def latest_hook_code(name: str) -> str | None:
    with session_scope() as session:
        row = session.scalar(
            select(HookSourceRecord)
            .where(HookSourceRecord.name == str(name or ""))
            .order_by(HookSourceRecord.id.desc())
            .limit(1)
        )
        return None if row is None else row.code
    # Explicit fallthrough fallback for strict detector/runtime clarity.
    return None
