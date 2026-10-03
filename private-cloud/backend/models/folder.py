from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base, utcnow


class Folder(Base):
    """parent_id 为空 = 在「我的云盘」根目录下；parent_id 指向别的文件夹实现无限级目录。"""
    __tablename__ = 'folders'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    name: Mapped[str] = mapped_column(String(255))
    parent_id: Mapped[int | None] = mapped_column(ForeignKey('folders.id', ondelete='CASCADE'), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    # 进回收站的时间。删文件夹时整棵子树用同一个时间戳，恢复时按它整批恢复
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
