import pytest

from mc_patch import patch


def test_patch_sets_four_settings():
    src = 'A = 1\nENABLE_CDP_MODE = True  # x\nHEADLESS = True\nENABLE_GET_COMMENTS = True\nSAVE_LOGIN_STATE = False\n'
    out = patch(src)
    assert 'ENABLE_CDP_MODE = False\n' in out and 'HEADLESS = False\n' in out
    assert 'ENABLE_GET_COMMENTS = False\n' in out and 'SAVE_LOGIN_STATE = True\n' in out and out.startswith('A = 1')


def test_patch_refuses_unknown_format():
    with pytest.raises(SystemExit):
        patch('HEADLESS = True\n')


def test_patch_store_keeps_author_once():
    from mc_patch import patch_store
    src = '    save = {\n        "source_keyword": source_keyword_var.get(),\n    }\n'
    out = patch_store(src)
    assert '"author_sec_uid": user_info.get("sec_uid", "")' in out and '"author_nickname"' in out
    assert patch_store(out) == out  # 打过的不再打


def test_patch_real_mediacrawler(tmp_path):
    """用真的 MediaCrawler 文件（本地装过就测）"""
    import os
    import shutil
    import pytest
    from mc_patch import apply
    src = os.path.expanduser(os.environ.get('MC_DIR_FOR_TEST', '~/.xiaoju-video/MediaCrawler'))
    if not os.path.isdir(src):
        pytest.skip('没装 MediaCrawler')
    for rel in ('config/base_config.py', 'store/douyin/__init__.py'):
        os.makedirs(tmp_path / os.path.dirname(rel), exist_ok=True)
        shutil.copy(os.path.join(src, rel), tmp_path / rel)
    apply(str(tmp_path))
    store = (tmp_path / 'store/douyin/__init__.py').read_text(encoding='utf-8')
    compile(store, 'store', 'exec')
    assert 'author_sec_uid' in store
