from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base, utcnow

# status：pending（等浏览器传完分片）→ uploading（Worker 正往 Telegram 传）→ completed / failed
# 删除不改 status，只写 deleted_at（进回收站），恢复时原状态还在


class File(Base):
    __tablename__ = 'files'
    __table_args__ = (
        Index('ix_files_user_sha', 'user_id', 'sha256', 'file_size'),
        Index('ix_files_tg', 'telegram_chat_id', 'telegram_message_id'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    filename: Mapped[str] = mapped_column(String(255))
    original_filename: Mapped[str] = mapped_column(String(255))
    file_size: Mapped[int] = mapped_column(BigInteger)
    mime_type: Mapped[str] = mapped_column(String(127), default='application/octet-stream')
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    telegram_chat_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    telegram_message_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    telegram_file_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    folder_id: Mapped[int | None] = mapped_column(ForeignKey('folders.id', ondelete='SET NULL'), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(16), default='pending', index=True)
    upload_progress: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
