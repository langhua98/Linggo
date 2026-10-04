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
                'media_platform/douyin/login.py', 'media_platform/douyin/client.py', 'media_platform/douyin/media.py',
                'store/kuaishou/__init__.py', 'media_platform/kuaishou/core.py'):
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
    ks = (tmp_path / 'store/kuaishou/__init__.py').read_text(encoding='utf-8')
    compile(ks, 'ks', 'exec')
    assert '"best_play_url": _xiaoju_best_url(photo_info)' in ks and '"author_id"' in ks
    check_ks_best(ks)
    ks_core = (tmp_path / 'media_platform/kuaishou/core.py').read_text(encoding='utf-8')
    compile(ks_core, 'ks_core', 'exec')
    assert ks_core.count('wait_until="domcontentloaded"') == 2
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


def check_ks_best(store_src):
    """打过补丁的快手存储：_xiaoju_best_url 挑出最高清的一档"""
    start = store_src.index('def _xiaoju_best_url')
    end = store_src.index('\n\n\n', start) if '\n\n\n' in store_src[start:] else len(store_src)
    ns = {}
    exec(store_src[start:end], ns)
    best = ns['_xiaoju_best_url']
    rep = lambda url, w, h, rate: {'url': url, 'width': w, 'height': h, 'avgBitrate': rate}
    photo = {
        'photoUrl': 'https://v/default.mp4',
        'videoResource': {
            'h264': {'adaptationSet': [{'representation': [rep('https://v/h264_720', 720, 1280, 900), rep('https://v/h264_1080', 1080, 1920, 2000)]}]},
            'hevc': {'adaptationSet': [{'representation': [rep('https://v/hevc_1080', 1080, 1920, 1500)]}]},
        },
    }
    assert best(photo) == 'https://v/h264_1080'  # 一样 1080，先要 H.264
    photo['videoResource']['hevc']['adaptationSet'][0]['representation'].append(rep('https://v/hevc_4k', 2160, 3840, 8000))
    assert best(photo) == 'https://v/hevc_4k'  # 分辨率优先
    assert best({'photoUrl': 'https://v/default.mp4'}) == 'https://v/default.mp4'
    assert best({'manifest': {'adaptationSet': [{'codecs': 'hvc1', 'representation': [rep('https://v/m', 1, 1, 1)]}]}}) == 'https://v/m'
    assert best(None) == ''


def test_patch_ks_store():
    from mc_patch import patch_ks_store, patch_ks_goto
    src = ('from ._store_impl import *\n\n\nasync def update_kuaishou_video(video_item):\n'
           '    photo_info = video_item.get("photo", {})\n    user_info = video_item.get("author", {})\n'
           '    save = {\n        "source_keyword": source_keyword_var.get(),\n    }\n')
    out = patch_ks_store(src)
    assert patch_ks_store(out) == out
    compile(out, 'ks', 'exec')
    check_ks_best(out)
    with pytest.raises(SystemExit):
        patch_ks_store('nothing')
    g = patch_ks_goto('            await self.context_page.goto(f"{self.index_url}?isHome=1")\n')
    assert 'domcontentloaded' in g and patch_ks_goto(g) == g
