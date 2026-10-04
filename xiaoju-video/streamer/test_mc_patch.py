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
    for rel in ('config/base_config.py', 'store/douyin/__init__.py', 'media_platform/douyin/core.py', 'main.py',
                'media_platform/douyin/login.py', 'media_platform/douyin/client.py', 'media_platform/douyin/media.py'):
        os.makedirs(tmp_path / os.path.dirname(rel), exist_ok=True)
        shutil.copy(os.path.join(src, rel), tmp_path / rel)
    apply(str(tmp_path))
    store = (tmp_path / 'store/douyin/__init__.py').read_text(encoding='utf-8')
    compile(store, 'store', 'exec')
    assert 'author_sec_uid' in store
    core = (tmp_path / 'media_platform/douyin/core.py').read_text(encoding='utf-8')
    compile(core, 'core', 'exec')
    assert 'wait_until="domcontentloaded"' in core
    assert core.index('add_cookies') < core.index('self.context_page = await self.browser_context.new_page()')
    login = (tmp_path / 'media_platform/douyin/login.py').read_text(encoding='utf-8')
    compile(login, 'login', 'exec')
    assert 'click(timeout=5000)' in login
    client = (tmp_path / 'media_platform/douyin/client.py').read_text(encoding='utf-8')
    compile(client, 'client', 'exec')
    for t in (login, client):
        assert 'bool(cookie_dict.get("sessionid"))' in t
    apply(str(tmp_path))  # 再打一次不变
    assert (tmp_path / 'media_platform/douyin/core.py').read_text(encoding='utf-8') == core
    main = (tmp_path / 'main.py').read_text(encoding='utf-8')
    assert main.startswith('import xiaoju_retry') and main.count('xiaoju_retry') == 1
    compile((tmp_path / 'xiaoju_retry.py').read_text(encoding='utf-8'), 'retry', 'exec')
    media = (tmp_path / 'media_platform/douyin/media.py').read_text(encoding='utf-8')
    assert media.count('_xiaoju_best') == 2
    import sys
    sys.path.insert(0, src)  # media.py 要 import MediaCrawler 自己的模块
    try:
        check_best_quality(media)
    finally:
        sys.path.remove(src)


def check_best_quality(media_src):
    """打过补丁的 media.py：真的挑出最高清的一档"""
    ns = {}
    exec(compile(media_src.split('def build_media_items')[0], 'media', 'exec'), ns)
    pick = ns['extract_video_urls']
    addr = lambda name, w, h: {'url_list': [f'http://cdn1/{name}', f'http://cdn2/{name}'], 'width': w, 'height': h}
    video = {
        'play_addr_h264': addr('default720', 720, 1280),
        'bit_rate': [
            {'gear_name': 'normal_720', 'bit_rate': 900000, 'is_h265': 0, 'format': 'mp4', 'play_addr': addr('h264_720', 720, 1280)},
            {'gear_name': '1080_h265', 'bit_rate': 2500000, 'is_h265': 1, 'format': 'mp4', 'play_addr': addr('h265_1080', 1080, 1920)},
            {'gear_name': 'normal_1080', 'bit_rate': 2000000, 'is_h265': 0, 'format': 'mp4', 'play_addr': addr('h264_1080', 1080, 1920)},
            {'gear_name': 'dash', 'bit_rate': 9000000, 'is_h265': 0, 'format': 'dash', 'play_addr': addr('dash_4k', 2160, 3840)},
            'junk',
        ],
    }
    assert pick({'aweme_id': '1', 'video': video})[0] == 'http://cdn2/h264_1080'  # 最高 1080，同是 1080 先要 H.264；dash 不要
    video['bit_rate'].append({'bit_rate': 8000000, 'is_h265': 1, 'format': 'mp4', 'play_addr': addr('h265_4k', 2160, 3840)})
    assert pick({'aweme_id': '1', 'video': video})[0] == 'http://cdn2/h265_4k'  # 4K 只有 H.265 也要它：分辨率优先
    assert pick({'aweme_id': '1', 'video': {'play_addr_h264': addr('default720', 720, 1280)}})[0] == 'http://cdn2/default720'  # 没有 bit_rate：照旧


def test_patch_media_picks_best_quality():
    from mc_patch import patch_media
    src = """from typing import Dict, List

_VIDEO_ADDR_KEYS = ("play_addr_h264", "play_addr_256", "play_addr")


def _url_list_of(container) -> List[str]:
    if not isinstance(container, dict):
        return []
    return [url for url in (container.get("url_list") or []) if url and isinstance(url, str)]


def extract_video_urls(aweme_detail: Dict) -> List[str]:
    video_item = aweme_detail.get("video")
    if not isinstance(video_item, dict):
        return []

    for key in _VIDEO_ADDR_KEYS:
        candidates = _url_list_of(video_item.get(key))
        if candidates:
            return list(reversed(candidates))
    return []


def build_media_items(aweme_item):
    return []
"""
    out = patch_media(src)
    assert patch_media(out) == out  # 打过的不再打
    check_best_quality(out)
    with pytest.raises(SystemExit):
        patch_media('def something(): pass\n')
