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
