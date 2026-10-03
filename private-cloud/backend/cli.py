"""命令行工具：

    python -m backend.cli create-user <用户名> [--admin]     # 会提示输入密码
    python -m backend.cli reset-password <用户名>
    python -m backend.cli backup                            # 导出一份 JSON 备份到 data/backups/
    python -m backend.cli restore <备份文件.json.gz>          # 导入到空数据库
"""
import argparse
import getpass
import gzip
import json
import sys

from sqlalchemy import select

from .database import init_db, session_scope
from .models import User
from .security import hash_password
from .services import backup_service


def _password():
    p1 = getpass.getpass('密码（至少 8 位）：')
    if len(p1) < 8:
        sys.exit('密码太短')
    if getpass.getpass('再输一次：') != p1:
        sys.exit('两次不一致')
    return p1


def main(argv=None):
    ap = argparse.ArgumentParser(prog='backend.cli')
    sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('create-user')
    c.add_argument('username')
    c.add_argument('--admin', action='store_true')
    r = sub.add_parser('reset-password')
    r.add_argument('username')
    sub.add_parser('backup')
    rs = sub.add_parser('restore')
    rs.add_argument('path')
    args = ap.parse_args(argv)
    init_db()
    if args.cmd == 'create-user':
        with session_scope() as db:
            if db.scalar(select(User.id).where(User.username == args.username)):
                sys.exit('用户名已存在')
            db.add(User(username=args.username, password_hash=hash_password(_password()), is_admin=args.admin))
        print('已创建', args.username)
    elif args.cmd == 'reset-password':
        with session_scope() as db:
            u = db.scalar(select(User).where(User.username == args.username))
            if u is None:
                sys.exit('没有这个用户')
            u.password_hash = hash_password(_password())
            u.token_version += 1
        print('已重置')
    elif args.cmd == 'backup':
        with session_scope() as db:
            path, data = backup_service.write_backup(db)
        print(path, f'{len(data["files"])} 个文件')
    elif args.cmd == 'restore':
        opener = gzip.open if args.path.endswith('.gz') else open
        with opener(args.path, 'rt', encoding='utf-8') as fh:
            data = json.load(fh)
        with session_scope() as db:
            print(backup_service.restore_data(db, data))


if __name__ == '__main__':
    main()
