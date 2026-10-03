from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base, utcnow

# status：
#   pending   浏览器还在传分片（断点续传：已收到哪些分片记在 upload_chunks）
#   queued    分片收齐，等 Worker 领取
#   uploading Worker 正在校验 / 往 Telegram 传
#   completed 已存进 Telegram
#   failed    重试用完仍失败（临时文件保留一段时间，可点「重新上传」）
#   cancelled 用户取消


class UploadTask(Base):
    __tablename__ = 'upload_tasks'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    file_id: Mapped[int | None] = mapped_column(ForeignKey('files.id', ondelete='SET NULL'), nullable=True, index=True)
    filename: Mapped[str] = mapped_column(String(255))
    file_size: Mapped[int] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(16), default='pending', index=True)
    progress: Mapped[int] = mapped_column(Integer, default=0)       # 往 Telegram 传的百分比
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    chunk_size: Mapped[int] = mapped_column(Integer)
    total_chunks: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Worker 传的过程中定期刷新；Worker 崩了，这个时间停住，下次启动把任务放回队列
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 失败后下次重试的最早时间（退避）
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_activity_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class UploadChunk(Base):
    """已收到的分片。用单独一张表（而不是任务上的一个字段）：浏览器并发传分片时各插各的行，不会互相覆盖。"""
    __tablename__ = 'upload_chunks'
    __table_args__ = (UniqueConstraint('task_id', 'idx'),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey('upload_tasks.id', ondelete='CASCADE'), index=True)
    idx: Mapped[int] = mapped_column(Integer)
    size: Mapped[int] = mapped_column(Integer)
