"""media r2.1: the JPEG completeness walker (hive/core/jpeg_complete.py), the two stand-in P1s on media r2.

P1-1: a complete progressive JPEG may end at a higher successive-approximation bit (Al > 0); refinement scans are
optional. The walker must accept it and still refuse a scan cut short and closed with EOI.
P1-2: a tiny malformed header must not make the walker allocate per-component coefficient state without limit. The
memory tests only build small headers and assert the walker refuses them before it allocates; no large fixture is made.
"""

import io
import shutil
import struct
import subprocess
import tracemalloc

import pytest

from hive.core import jpeg_complete
from hive.core.jpeg_complete import Incomplete, check
from hive.core.media import Undecodable, decode_image

MiB = 1 << 20


def _image(size=(96, 80), mode="RGB"):
    from PIL import Image
    w, h = size
    image = Image.new("RGB", size)
    image.putdata([((x * 29 + y * 7) % 256, (x * 3 + y * 19) % 256, (x * y) % 256) for y in range(h) for x in range(w)])
    return image.convert(mode) if mode != "RGB" else image


def _encode(size=(96, 80), mode="RGB", **kw):
    buf = io.BytesIO()
    _image(size, mode).save(buf, "JPEG", **kw)
    return buf.getvalue()


def _pillow_loads(data):
    from PIL import Image
    with Image.open(io.BytesIO(data)) as im:
        im.load()
        return im.size


def _scans(data):
    """Offsets of each SOS marker, and the scan headers (components, Ss, Se, Ah, Al)."""
    out, i = [], 0
    while True:
        i = data.find(b"\xff\xda", i + 1)
        if i < 0:
            return out
        n = data[i + 4]
        comps = list(data[i + 5:i + 5 + 2 * n:2])
        ss, se, a = data[i + 5 + 2 * n], data[i + 6 + 2 * n], data[i + 7 + 2 * n]
        out.append((i, comps, ss, se, a >> 4, a & 15))


def _cuts(data):
    """The same file with 25/50/75 % of its entropy-coded bytes kept, then closed with EOI (Design's method)."""
    start = data.index(b"\xff\xda")
    start += 2 + int.from_bytes(data[start + 2:start + 4], "big")
    end = len(data) - 2
    return {f: data[:start + int((end - start) * f)] + b"\xff\xd9" for f in (0.25, 0.5, 0.75)}


# ---- P1-1: a complete encoding may end at Al > 0 -------------------------------------------------------------------

_CJPEG = shutil.which("cjpeg")
_SCRIPTS = {
    # the stand-in's case: DC and every AC band coded once, ending at Al=1, no refinement scans
    "dc_and_ac_end_at_al1": "0,1,2: 0-0, 0, 1;\n0: 1-63, 0, 1;\n1: 1-63, 0, 1;\n2: 1-63, 0, 1;\n",
    # split AC bands at different final precisions, one refinement taken part-way (Al 2 -> 1), never to 0
    "split_bands_mixed_al": ("0,1,2: 0-0, 0, 1;\n0: 1-5, 0, 2;\n0: 6-63, 0, 2;\n1: 1-63, 0, 1;\n2: 1-63, 0, 0;\n"
                             "0: 1-63, 2, 1;\n"),
    # DC refined to 0, AC left at Al=1
    "dc_refined_ac_at_al1": "0,1,2: 0-0, 0, 1;\n0: 1-63, 0, 1;\n1: 1-63, 0, 1;\n2: 1-63, 0, 1;\n0,1,2: 0-0, 1, 0;\n",
}


def _cjpeg(tmp_path, script, size=(96, 80), restart=None):
    ppm, scans = tmp_path / "in.ppm", tmp_path / "scans.txt"
    _image(size).save(ppm)
    scans.write_text(script)
    args = [_CJPEG, "-quality", "90", "-scans", str(scans)] + (["-restart", str(restart)] if restart else []) + [str(ppm)]
    return subprocess.run(args, capture_output=True, check=True, timeout=30).stdout


@pytest.mark.skipif(_CJPEG is None, reason="libjpeg cjpeg not installed (brew install jpeg-turbo); the Pillow-built "
                                           "Al=1 test below covers the same case")
@pytest.mark.parametrize("name", sorted(_SCRIPTS))
def test_cjpeg_scan_scripts_ending_above_bit_zero_are_accepted_and_their_cuts_refused(tmp_path, name):
    for restart in (None, 2):
        data = _cjpeg(tmp_path, _SCRIPTS[name], restart=restart)
        assert any(al > 0 for *_x, al in _scans(data))           # the fixture really ends above bit 0
        assert _pillow_loads(data) == (96, 80)
        assert check(data) is None
        assert decode_image(data, 96, 80, 96 * 80) == ("image/jpeg", 96, 80)
        for fraction, cut in _cuts(data).items():
            with pytest.raises(Undecodable) as caught:
                decode_image(cut, 96, 80, 96 * 80)
            assert caught.value.reason == "incomplete", (name, restart, fraction)


def test_a_progressive_jpeg_without_its_refinement_scans_is_whole():
    """Built with Pillow alone: libjpeg's default progressive script, keeping every first scan (DC at Al=1, the AC bands
    at Al=1 or 2 refined to 1) and dropping the optional refinement scans to bit 0. That is a complete encoding at a
    lower precision; Pillow decodes it, and so must the host."""
    data = _encode(progressive=True, quality=90)
    scans = _scans(data)
    first_refine_to_zero = next(off for off, _c, ss, _se, ah, al in scans if ah == 1 and al == 0)
    lower = data[:first_refine_to_zero] + b"\xff\xd9"
    assert all(al >= 1 for _o, _c, _ss, _se, _ah, al in _scans(lower))
    assert _pillow_loads(lower) == (96, 80)
    assert check(lower) is None
    assert decode_image(lower, 96, 80, 96 * 80) == ("image/jpeg", 96, 80)


def test_a_progressive_jpeg_missing_a_first_scan_is_refused():
    """Coverage is still required: a band never coded at all (its first scan cut away) is truncation."""
    data = _encode(progressive=True, quality=90)
    for off, _c, ss, _se, ah, _al in _scans(data)[1:]:
        if ah == 0:                                               # every cut that drops a first scan
            with pytest.raises(Incomplete, match="truncated"):
                check(data[:off] + b"\xff\xd9")


@pytest.mark.parametrize("progressive", [False, True])
def test_design_cuts_at_25_50_75_percent_are_refused(progressive):
    data = _encode(size=(128, 128), progressive=progressive, quality=90)
    assert decode_image(data, 128, 128, 128 * 128) == ("image/jpeg", 128, 128)
    for fraction, cut in _cuts(data).items():
        assert _pillow_loads(cut) == (128, 128)                   # Pillow still fills these
        with pytest.raises(Undecodable) as caught:
            decode_image(cut, 128, 128, 128 * 128)
        assert caught.value.reason == "incomplete", fraction


_KIMI_VARIANTS = {
    "baseline": {}, "progressive": {"progressive": True}, "optimize": {"optimize": True},
    "restart_markers": {"restart_marker_blocks": 3}, "progressive_restart": {"progressive": True, "restart_marker_rows": 1},
    "subsampling_0": {"subsampling": 0}, "subsampling_2": {"subsampling": 2},
    "odd_size": {"size": (37, 23)}, "odd_size_progressive": {"size": (37, 23), "progressive": True},
    "grey": {"mode": "L"}, "cmyk": {"mode": "CMYK"}, "q5": {"quality": 5}, "q100": {"quality": 100},
}


@pytest.mark.parametrize("name", sorted(_KIMI_VARIANTS))
def test_kimis_thirteen_encoder_variants_stay_accepted(name):
    kw = dict(_KIMI_VARIANTS[name])
    size = kw.pop("size", (96, 80))
    data = _encode(size=size, **kw)
    assert check(data) is None
    assert decode_image(data, *size, size[0] * size[1]) == ("image/jpeg", *size)


# ---- P1-2: bounded allocation and work -----------------------------------------------------------------------------

def _seg(marker, body):
    return b"\xff" + bytes([marker]) + struct.pack(">H", len(body) + 2) + body


def _stuff(bits):
    bits += "1" * (-len(bits) % 8)
    raw = bytes(int(bits[i:i + 8], 2) for i in range(0, len(bits), 8))
    return raw.replace(b"\xff", b"\xff\x00")


def _sof2(width, height, ids):
    return _seg(0xC2, bytes([8]) + struct.pack(">HHB", height, width, len(ids)) + b"".join(bytes([c, 0x11, 0]) for c in ids))


_DHT_EOB14 = _seg(0xC4, bytes([0x10, 1] + [0] * 15 + [0xE0]))     # AC table 0: one 1-bit code, EOB run r=14
_EOB_RUNS = _stuff(("0" + format(5462, "014b")) * 3)              # 3 x 21846 blocks: a whole 2048^2 component


def _ac_only_file(ids, width=2048, height=2048):
    """The stand-in's fixture shape: a frame, one AC table, then one first-AC scan per component that codes every block
    with three EOB runs. No DC scan, so it is incomplete; r2 allocated a coefficient map per component before seeing that."""
    scans = b"".join(_seg(0xDA, bytes([1, c, 0x00, 1, 63, 0x00])) + _EOB_RUNS for c in ids)
    return b"\xff\xd8" + _sof2(width, height, ids) + _DHT_EOB14 + scans + b"\xff\xd9"


def _peak(data, **kw):
    """(reason, peak bytes traced) for one walk of data."""
    tracemalloc.start()
    try:
        try:
            check(data, **kw)
            reason = None
        except Incomplete as exc:
            reason = str(exc)
        return reason, tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()


def test_the_four_component_2048_square_fixture_is_refused_before_allocation():
    data = _ac_only_file([1, 2, 3, 4])
    assert len(data) <= 120
    reason, peak = _peak(data)
    assert reason == "truncated"                                   # no DC scan: never coded
    assert peak < 4 * MiB, peak                                    # r2: 16.5 MiB (four 4 MiB coefficient maps)


def test_a_255_component_header_is_refused_before_allocation():
    """The stand-in's 255-component shape (about 5 KB; r2 would have allocated about 1 GiB). Built, never run on r2."""
    data = _ac_only_file(list(range(1, 256)))
    assert len(data) < 6000
    reason, peak = _peak(data)
    assert reason == "unsupported"
    assert peak < 4 * MiB, peak


@pytest.mark.parametrize("count", [2, 5, 255])
def test_only_one_three_or_four_components_are_admitted(count):
    with pytest.raises(Incomplete, match="unsupported"):
        check(b"\xff\xd8" + _sof2(64, 64, list(range(1, count + 1))) + b"\xff\xd9")


def test_a_frame_beyond_the_admitted_geometry_is_refused_before_allocation():
    data = _ac_only_file([1], width=65535, height=65535)          # 1 component, but 64 Mi blocks of state
    reason, peak = _peak(data)
    assert reason == "too_large" and peak < 4 * MiB, (reason, peak)
    assert _peak(_ac_only_file([1, 2, 3]), max_width=1024, max_height=1024)[0] == "too_large"


def test_a_scan_with_too_few_bytes_for_its_blocks_is_refused_before_allocation():
    """A DC scan codes at least one bit per block: 4 x 65536 blocks cannot fit in a handful of bytes."""
    dht_dc = _seg(0xC4, bytes([0x00, 1] + [0] * 15 + [0x00]))
    dc = _seg(0xDA, bytes([4, 1, 0x00, 2, 0x00, 3, 0x00, 4, 0x00, 0, 0, 0x00])) + b"\x00" * 16
    ac = b"".join(_seg(0xDA, bytes([1, c, 0x00, 1, 63, 0x00])) + _EOB_RUNS for c in (1, 2, 3, 4))
    data = b"\xff\xd8" + _sof2(2048, 2048, [1, 2, 3, 4]) + dht_dc + _DHT_EOB14 + dc + ac + b"\xff\xd9"
    reason, peak = _peak(data)
    assert reason == "truncated" and peak < 4 * MiB, (reason, peak)


def test_total_coefficient_work_is_capped_by_the_frame():
    """Every coefficient refined bit by bit from Al=13 is a legal scan chain, but 14 passes over every coefficient is
    over the work cap (_PASSES per coefficient on average) and is refused before any entropy is decoded."""
    dht = _seg(0xC4, bytes([0x00, 1] + [0] * 15 + [0x00])) + _DHT_EOB14
    scans = [(0, 0, 0, 13), (1, 63, 0, 13)]
    scans += [(0, 0, a, a - 1) for a in range(13, 0, -1)] + [(1, 63, a, a - 1) for a in range(13, 0, -1)]
    body = b"".join(_seg(0xDA, bytes([1, 1, 0x00, ss, se, ah << 4 | al])) + b"\x00" for ss, se, ah, al in scans)
    data = b"\xff\xd8" + _sof2(8, 8, [1]) + dht + body + b"\xff\xd9"
    reason, peak = _peak(data)
    assert reason == "unsupported" and peak < 4 * MiB, (reason, peak)


def test_the_tracking_and_work_limits_follow_the_admitted_geometry():
    track, work = jpeg_complete.limits(2048, 2048)
    assert track == 4 * 256 * 256 * 8 == 2 * MiB                   # one bit per coefficient, four full-size components
    assert work == jpeg_complete._PASSES * 64 * 4 * 259 * 259      # MCU padding at the largest sampling factor
