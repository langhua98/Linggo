"""文件 / 文件夹 / 回收站的业务逻辑。所有函数都带 user：只能操作自己的东西。

永久删除分两步：先算出要删的 Telegram 消息（复制出来的文件和原文件共用同一条消息，
还有别的记录在用就不删），由调用方 await 删掉 Telegram 消息，成功后再删数据库记录。"""
import os

from fastapi import HTTPException
from sqlalchemy import func, or_, select

from ..database import utcnow
from ..models import File, Folder, UploadTask
from .telegram_service import category_for

SORTS = {'name', 'size', 'updated', 'created', 'type'}
MAX_NAME = 255


def clean_name(name):
    name = (name or '').replace('\\', '/').split('/')[-1].strip()
    name = ''.join(ch for ch in name if ch >= ' ' and ch != '\x7f')
    if not name or name in ('.', '..'):
        raise HTTPException(400, '名称不能为空')
    if len(name) > MAX_NAME:
        stem, ext = os.path.splitext(name)
        name = stem[:MAX_NAME - len(ext)] + ext
    return name


# ── 序列化 ───────────────────────────────────────────────────────


def _iso(dt):
    return dt.isoformat() + 'Z' if dt else None


def serialize_file(f, path=None):
    d = {
        'id': f.id, 'type': 'file', 'filename': f.filename, 'original_filename': f.original_filename,
        'file_size': f.file_size, 'mime_type': f.mime_type, 'category': category_for(f.mime_type),
        'sha256': f.sha256, 'folder_id': f.folder_id, 'status': f.status, 'upload_progress': f.upload_progress,
        'telegram_chat_id': f.telegram_chat_id, 'telegram_message_id': f.telegram_message_id,
        'telegram_file_id': f.telegram_file_id,
        'created_at': _iso(f.created_at), 'updated_at': _iso(f.updated_at), 'deleted_at': _iso(f.deleted_at),
    }
    if path is not None:
        d['path'] = path
    return d


def serialize_folder(f, path=None):
    d = {'id': f.id, 'type': 'folder', 'name': f.name, 'parent_id': f.parent_id,
         'created_at': _iso(f.created_at), 'updated_at': _iso(f.updated_at), 'deleted_at': _iso(f.deleted_at)}
    if path is not None:
        d['path'] = path
    return d


# ── 文件夹 ───────────────────────────────────────────────────────


def get_folder(db, user, folder_id, allow_deleted=False):
    if folder_id is None:
        return None
    f = db.get(Folder, folder_id)
    if f is None or f.user_id != user.id or (f.deleted_at and not allow_deleted):
        raise HTTPException(404, '文件夹不存在')
    return f


def get_file(db, user, file_id, allow_deleted=False):
    f = db.get(File, file_id)
    if f is None or f.user_id != user.id or (f.deleted_at and not allow_deleted):
        raise HTTPException(404, '文件不存在')
    return f


def _folder_map(db, user_id):
    return {f.id: f for f in db.scalars(select(Folder).where(Folder.user_id == user_id))}


def folder_path(db, user_id, folder_id, fmap=None):
    """从根到该文件夹的 [{id, name}]。"""
    fmap = fmap if fmap is not None else _folder_map(db, user_id)
    out, seen = [], set()
    while folder_id is not None and folder_id in fmap and folder_id not in seen:
        seen.add(folder_id)
        f = fmap[folder_id]
        out.append({'id': f.id, 'name': f.name})
        folder_id = f.parent_id
    return list(reversed(out))


def path_string(path):
    return '/' + '/'.join(p['name'] for p in path)


def subtree_ids(db, user_id, folder_id, fmap=None):
    """folder_id 和它下面所有层级的文件夹 ID。"""
    fmap = fmap if fmap is not None else _folder_map(db, user_id)
    children = {}
    for f in fmap.values():
        children.setdefault(f.parent_id, []).append(f.id)
    out, stack = [], [folder_id]
    while stack:
        cur = stack.pop()
        out.append(cur)
        stack.extend(children.get(cur, []))
    return out


def folder_name_taken(db, user, parent_id, name, exclude_id=None):
    q = select(Folder.id).where(Folder.user_id == user.id, Folder.deleted_at.is_(None),
                                func.lower(Folder.name) == name.lower(),
                                Folder.parent_id.is_(None) if parent_id is None else Folder.parent_id == parent_id)
    if exclude_id:
        q = q.where(Folder.id != exclude_id)
    return db.scalar(q.limit(1)) is not None


def file_name_taken(db, user, folder_id, name, exclude_id=None):
    q = select(File.id).where(File.user_id == user.id, File.deleted_at.is_(None), File.filename == name,
                              File.folder_id.is_(None) if folder_id is None else File.folder_id == folder_id)
    if exclude_id:
        q = q.where(File.id != exclude_id)
    return db.scalar(q.limit(1)) is not None


def free_file_name(db, user, folder_id, name, exclude_id=None):
    """同一目录下重名就自动改成「名字 (1).扩展名」。"""
    if not file_name_taken(db, user, folder_id, name, exclude_id):
        return name
    stem, ext = os.path.splitext(name)
    for i in range(1, 10000):
        cand = f'{stem} ({i}){ext}'
        if not file_name_taken(db, user, folder_id, cand, exclude_id):
            return cand
    raise HTTPException(409, '同名文件太多')


def free_folder_name(db, user, parent_id, name, exclude_id=None):
    if not folder_name_taken(db, user, parent_id, name, exclude_id):
        return name
    for i in range(1, 10000):
        cand = f'{name} ({i})'
        if not folder_name_taken(db, user, parent_id, cand, exclude_id):
            return cand
    raise HTTPException(409, '同名文件夹太多')


def create_folder(db, user, name, parent_id):
    name = clean_name(name)
    get_folder(db, user, parent_id)
    if folder_name_taken(db, user, parent_id, name):
        raise HTTPException(409, '这里已经有同名文件夹')
    f = Folder(user_id=user.id, name=name, parent_id=parent_id)
    db.add(f)
    db.commit()
    return f


def rename_folder(db, user, folder_id, name):
    f = get_folder(db, user, folder_id)
    name = clean_name(name)
    if folder_name_taken(db, user, f.parent_id, name, exclude_id=f.id):
        raise HTTPException(409, '这里已经有同名文件夹')
    f.name = name
    db.commit()
    return f


def move_folder(db, user, folder_id, target_id):
    f = get_folder(db, user, folder_id)
    get_folder(db, user, target_id)
    if target_id is not None and target_id in subtree_ids(db, user.id, f.id):
        raise HTTPException(400, '不能把文件夹移动到它自己或它的子文件夹里')
    if folder_name_taken(db, user, target_id, f.name, exclude_id=f.id):
        raise HTTPException(409, '目标位置已经有同名文件夹')
    f.parent_id = target_id
    db.commit()
    return f


def folder_tree(db, user):
    rows = db.scalars(select(Folder).where(Folder.user_id == user.id, Folder.deleted_at.is_(None))
                      .order_by(func.lower(Folder.name)))
    return [serialize_folder(f) for f in rows]


# ── 列表 ─────────────────────────────────────────────────────────


def _order(sort, order):
    sort = sort if sort in SORTS else 'name'
    desc = order == 'desc'
    col = {'name': func.lower(File.filename), 'size': File.file_size, 'updated': File.updated_at,
           'created': File.created_at, 'type': File.mime_type}[sort]
    return [col.desc() if desc else col.asc(), File.id.desc() if desc else File.id.asc()]


def list_dir(db, user, folder_id, sort='name', order='asc'):
    get_folder(db, user, folder_id)
    folders = db.scalars(select(Folder).where(
        Folder.user_id == user.id, Folder.deleted_at.is_(None),
        Folder.parent_id.is_(None) if folder_id is None else Folder.parent_id == folder_id))
    folders = list(folders)
    fkey = {'name': lambda f: f.name.lower(), 'updated': lambda f: f.updated_at, 'created': lambda f: f.created_at}
    folders.sort(key=fkey.get(sort, fkey['name']), reverse=(order == 'desc' and sort in fkey))
    files = db.scalars(select(File).where(
        File.user_id == user.id, File.deleted_at.is_(None),
        File.folder_id.is_(None) if folder_id is None else File.folder_id == folder_id).order_by(*_order(sort, order)))
    return {
        'folder': serialize_folder(get_folder(db, user, folder_id)) if folder_id else None,
        'path': folder_path(db, user.id, folder_id),
        'folders': [serialize_folder(f) for f in folders],
        'files': [serialize_file(f) for f in files],
    }


def search(db, user, q='', category='', sort='updated', order='desc', limit=300):
    q = (q or '').strip()
    fmap = _folder_map(db, user.id)
    live_folders = {fid for fid, f in fmap.items() if f.deleted_at is None}
    stmt = select(File).where(File.user_id == user.id, File.deleted_at.is_(None))
    folder_hits = []
    if q:
        like = '%' + q.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
        conds = [File.filename.ilike(like, escape='\\'), File.original_filename.ilike(like, escape='\\')]
        hexq = q.lower()
        if len(hexq) >= 6 and all(c in '0123456789abcdef' for c in hexq):
            conds.append(File.sha256.startswith(hexq))
        # 文件夹名命中：那个文件夹里的文件也算
        matched = [f for f in fmap.values() if f.deleted_at is None and q.lower() in f.name.lower()]
        folder_hits = matched
        if matched:
            conds.append(File.folder_id.in_([f.id for f in matched]))
        stmt = stmt.where(or_(*conds))
    if category in ('video', 'image', 'audio'):
        stmt = stmt.where(File.mime_type.startswith(category + '/'))
    rows = db.scalars(stmt.order_by(*_order(sort, order)).limit(limit * 3 if category else limit))
    files = []
    for f in rows:
        if f.folder_id is not None and f.folder_id not in live_folders:
            continue
        if category and category_for(f.mime_type) != category:
            continue
        files.append(serialize_file(f, path=path_string(folder_path(db, user.id, f.folder_id, fmap))))
        if len(files) >= limit:
            break
    folders = [serialize_folder(f, path=path_string(folder_path(db, user.id, f.parent_id, fmap)))
               for f in folder_hits if not category and _alive(f, fmap)][:50]
    return {'files': files, 'folders': folders}


def _alive(folder, fmap):
    cur = folder
    seen = set()
    while cur is not None and cur.id not in seen:
        if cur.deleted_at:
            return False
        seen.add(cur.id)
        cur = fmap.get(cur.parent_id)
    return True


# ── 文件操作 ─────────────────────────────────────────────────────


def rename_file(db, user, file_id, name):
    f = get_file(db, user, file_id)
    name = clean_name(name)
    if file_name_taken(db, user, f.folder_id, name, exclude_id=f.id):
        raise HTTPException(409, '这里已经有同名文件')
    f.filename = name
    db.commit()
    return f


def move_file(db, user, file_id, target_id):
    f = get_file(db, user, file_id)
    get_folder(db, user, target_id)
    if f.folder_id == target_id:
        return f
    f.folder_id = target_id
    f.filename = free_file_name(db, user, target_id, f.filename, exclude_id=f.id)
    db.commit()
    return f


def copy_file(db, user, file_id, target_id):
    """复制不重新上传：新记录指向同一条 Telegram 消息。"""
    f = get_file(db, user, file_id)
    if f.status != 'completed':
        raise HTTPException(400, '文件还没上传完成，不能复制')
    get_folder(db, user, target_id)
    if target_id == f.folder_id:
        stem, ext = os.path.splitext(f.filename)
        name = free_file_name(db, user, target_id, f'{stem} - 副本{ext}')
    else:
        name = free_file_name(db, user, target_id, f.filename)
    c = File(user_id=user.id, filename=name, original_filename=f.original_filename, file_size=f.file_size,
             mime_type=f.mime_type, sha256=f.sha256, telegram_chat_id=f.telegram_chat_id,
             telegram_message_id=f.telegram_message_id, telegram_file_id=f.telegram_file_id,
             folder_id=target_id, status='completed', upload_progress=100)
    db.add(c)
    db.commit()
    return c


def link_existing(db, user, src, folder_id, filename):
    """秒传：查重命中后，在指定目录再放一份指向同一条 Telegram 消息的记录。"""
    c = File(user_id=user.id, filename=free_file_name(db, user, folder_id, clean_name(filename)),
             original_filename=clean_name(filename), file_size=src.file_size, mime_type=src.mime_type,
             sha256=src.sha256, telegram_chat_id=src.telegram_chat_id, telegram_message_id=src.telegram_message_id,
             telegram_file_id=src.telegram_file_id, folder_id=folder_id, status='completed', upload_progress=100)
    db.add(c)
    db.commit()
    return c


def _drop_unfinished(db, f):
    """没传完的文件删除时直接取消上传任务并删掉记录（还没进 Telegram，回收站里留着没意义）。"""
    from .upload_service import discard_task_staging
    for t in db.scalars(select(UploadTask).where(UploadTask.file_id == f.id)):
        if t.status not in ('completed', 'cancelled'):
            t.status = 'cancelled'
            t.error_message = '文件已删除'
            t.completed_at = utcnow()
            discard_task_staging(t.id)
    db.delete(f)


def trash_file(db, user, file_id):
    f = get_file(db, user, file_id)
    if f.status != 'completed':
        _drop_unfinished(db, f)
    else:
        f.deleted_at = utcnow()
    db.commit()


def trash_folder(db, user, folder_id):
    f = get_folder(db, user, folder_id)
    now = utcnow()
    ids = subtree_ids(db, user.id, f.id)
    for sub in db.scalars(select(Folder).where(Folder.id.in_(ids), Folder.deleted_at.is_(None))):
        sub.deleted_at = now
    for x in db.scalars(select(File).where(File.folder_id.in_(ids), File.deleted_at.is_(None))):
        if x.status != 'completed':
            _drop_unfinished(db, x)
        else:
            x.deleted_at = now
    db.commit()


def list_trash(db, user):
    fmap = _folder_map(db, user.id)
    folders = [f for f in fmap.values() if f.deleted_at and not (f.parent_id in fmap and fmap[f.parent_id].deleted_at)]
    files = db.scalars(select(File).where(File.user_id == user.id, File.deleted_at.is_not(None))
                       .order_by(File.deleted_at.desc()))
    out_files = []
    for x in files:
        parent = fmap.get(x.folder_id)
        # 跟着文件夹一起删的（同一批），只显示文件夹
        if parent is not None and parent.deleted_at is not None:
            continue
        out_files.append(serialize_file(x, path=path_string(folder_path(db, user.id, x.folder_id, fmap))))
    folders.sort(key=lambda f: f.deleted_at, reverse=True)
    return {'folders': [serialize_folder(f, path=path_string(folder_path(db, user.id, f.parent_id, fmap)))
                        for f in folders],
            'files': out_files}


def restore_file(db, user, file_id):
    f = get_file(db, user, file_id, allow_deleted=True)
    if not f.deleted_at:
        return f
    if f.folder_id is not None:
        parent = db.get(Folder, f.folder_id)
        if parent is None or parent.deleted_at or not _alive(parent, _folder_map(db, user.id)):
            f.folder_id = None   # 原文件夹不在了，恢复到根目录
    f.deleted_at = None
    f.filename = free_file_name(db, user, f.folder_id, f.filename, exclude_id=f.id)
    db.commit()
    return f


def restore_folder(db, user, folder_id):
    f = get_folder(db, user, folder_id, allow_deleted=True)
    if not f.deleted_at:
        return f
    stamp = f.deleted_at
    fmap = _folder_map(db, user.id)
    if f.parent_id is not None and (f.parent_id not in fmap or not _alive(fmap[f.parent_id], fmap)):
        f.parent_id = None
    ids = subtree_ids(db, user.id, f.id, fmap)
    for sub in db.scalars(select(Folder).where(Folder.id.in_(ids), Folder.deleted_at == stamp)):
        sub.deleted_at = None
    for x in db.scalars(select(File).where(File.folder_id.in_(ids), File.deleted_at == stamp)):
        x.deleted_at = None
    f.deleted_at = None
    db.flush()
    f.name = free_folder_name(db, user, f.parent_id, f.name, exclude_id=f.id)
    db.commit()
    return f


# ── 永久删除 ─────────────────────────────────────────────────────


def telegram_refs_to_delete(db, files):
    """这些记录删掉后，哪些 Telegram 消息不再有人引用 → {chat_id: [message_id]}。"""
    ids = {f.id for f in files}
    out = {}
    for f in files:
        if f.telegram_chat_id is None or f.telegram_message_id is None:
            continue
        others = db.scalar(select(func.count(File.id)).where(
            File.telegram_chat_id == f.telegram_chat_id, File.telegram_message_id == f.telegram_message_id,
            File.id.not_in(ids)))
        if not others:
            out.setdefault(f.telegram_chat_id, set()).add(f.telegram_message_id)
    return {k: sorted(v) for k, v in out.items()}


def collect_purge(db, user, file_ids=(), folder_ids=()):
    """要永久删除的文件记录和文件夹记录（只收回收站里的）。"""
    files, folders = [], []
    for fid in file_ids:
        f = get_file(db, user, fid, allow_deleted=True)
        if not f.deleted_at:
            raise HTTPException(400, '只能永久删除回收站里的文件')
        files.append(f)
    fmap = _folder_map(db, user.id)
    for fid in folder_ids:
        f = get_folder(db, user, fid, allow_deleted=True)
        if not f.deleted_at:
            raise HTTPException(400, '只能永久删除回收站里的文件夹')
        ids = subtree_ids(db, user.id, f.id, fmap)
        folders.extend(fmap[i] for i in ids)
        files.extend(db.scalars(select(File).where(File.folder_id.in_(ids))))
    uniq = {f.id: f for f in files}
    return list(uniq.values()), list({f.id: f for f in folders}.values())


def collect_empty_trash(db, user):
    trash = list_trash(db, user)
    return collect_purge(db, user, [f['id'] for f in trash['files']], [f['id'] for f in trash['folders']])


def apply_purge(db, files, folders):
    for f in files:
        db.delete(f)
    db.flush()
    # 先删深层的文件夹
    depth = {}
    fmap = {f.id: f for f in folders}

    def d(f):
        n, cur, seen = 0, f, set()
        while cur.parent_id in fmap and cur.id not in seen:
            seen.add(cur.id)
            n += 1
            cur = fmap[cur.parent_id]
        return n
    for f in folders:
        depth[f.id] = d(f)
    for f in sorted(folders, key=lambda f: -depth[f.id]):
        db.delete(f)
    db.commit()


# ── 统计 ─────────────────────────────────────────────────────────


def usage(db, user):
    total = db.scalar(select(func.coalesce(func.sum(File.file_size), 0)).where(
        File.user_id == user.id, File.deleted_at.is_(None), File.status == 'completed'))
    count = db.scalar(select(func.count(File.id)).where(
        File.user_id == user.id, File.deleted_at.is_(None), File.status == 'completed'))
    trash = db.scalar(select(func.count(File.id)).where(File.user_id == user.id, File.deleted_at.is_not(None)))
    return {'total_size': int(total or 0), 'file_count': int(count or 0), 'trash_count': int(trash or 0)}
