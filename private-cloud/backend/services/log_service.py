"""系统日志：同时写进数据库（管理后台能看）和标准输出。"""
import logging

from ..database import session_scope
from ..models import SystemLog

log = logging.getLogger('cloud')


def record(event, message='', *, level='info', source='api', user_id=None, ip=None, db=None):
    getattr(log, 'warning' if level == 'warning' else level if level in ('info', 'error') else 'info')(
        '[%s] %s %s', source, event, message)
    row = SystemLog(event=event, message=message[:4000], level=level, source=source, user_id=user_id, ip=ip)
    try:
        if db is not None:
            db.add(row)
            db.commit()
        else:
            with session_scope() as s:
                s.add(row)
    except Exception:  # noqa: BLE001 — 写日志失败不能让业务失败
        log.exception('failed to write system log')
