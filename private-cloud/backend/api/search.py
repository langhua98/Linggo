from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import User
from ..security import current_user
from ..services import file_service as fs

router = APIRouter(prefix='/api/search', tags=['search'])


@router.get('')
def search(q: str = Query('', max_length=200), type: str = Query('', max_length=20),
           sort: str = 'updated', order: str = 'desc',
           user: User = Depends(current_user), db: Session = Depends(get_db)):
    """按文件名 / 所在文件夹名 / SHA-256 前缀搜索，type 按大类过滤（video/image/audio/document/archive/other）。"""
    return fs.search(db, user, q, type, sort, order)
