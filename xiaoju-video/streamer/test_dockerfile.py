"""镜像里要有 app.py 导入到的每个本地模块（漏拷过一次 outbox.py，Space 直接起不来）"""

import ast
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))


def local_imports(path, seen=None):
    seen = seen if seen is not None else set()
    tree = ast.parse(open(path, encoding='utf-8').read())
    for node in ast.walk(tree):
        names = [a.name for a in node.names] if isinstance(node, ast.Import) else \
            [node.module] if isinstance(node, ast.ImportFrom) and node.module else []
        for n in names:
            mod = n.split('.')[0]
            f = os.path.join(HERE, mod + '.py')
            if os.path.exists(f) and mod not in seen:
                seen.add(mod)
                local_imports(f, seen)
    return seen


def test_dockerfile_copies_every_local_module():
    copied = set()
    for line in open(os.path.join(HERE, 'Dockerfile'), encoding='utf-8'):
        if line.startswith('COPY ') and line.rstrip().endswith('./'):
            copied |= set(re.findall(r'(\w+)\.py', line))
    needed = local_imports(os.path.join(HERE, 'app.py')) | {'app', 'dy_login', 'ks_login'}  # 登录脚本是子进程跑的，不在 import 里
    assert needed <= copied, f'Dockerfile 漏拷：{sorted(needed - copied)}'
