"""media r2 P1-4 / r2.1: is every scan of a JPEG fully present? (pure Python, no pixels kept)

Pillow (libjpeg) fills missing entropy-coded data with grey and reports success when a scan is cut short and the file
still ends in EOI (Design's reproduction, 2026-10-17: 25/50/75 % of the scan kept, all accepted). Header, end-marker and
dimension checks cannot see that. Two passes:

1. Plan (headers only, nothing allocated per block): one frame of 1, 3 or 4 components within the admitted geometry;
   every scan header valid; the declared scans cover every coefficient of every component (sequential: one scan over
   0..63 per component; progressive: every coefficient first coded once, each refinement exactly one bit below the
   last, and refinements optional, so a complete encoding may end at any Al); each scan carries at least the bits its
   blocks need; total work (blocks x coefficients, summed over scans) within ``_PASSES`` passes over the frame.
2. Walk: every MCU (block) of every scan decodes from the bytes that scan actually carries, with valid codes, and every
   restart interval is present in order.

Arithmetic-coded, lossless and hierarchical JPEGs are refused as unsupported. Coefficient values are skipped, never
stored; a progressive AC scan keeps one bit per coefficient (which ones are already non-zero, for refinement), so the
state is at most ``limits(...)[0]`` bytes: 2 MiB for four full 2048x2048 components.

Cost: pure Python, so media.py runs it in a worker thread. A 2048x2048 photo-like JPEG takes about 2-5 s; worst-case
noise at quality 95 (about 5 MB) about 8-20 s on the busy dev Mac. The pinned max_output_bytes bounds it.
"""

from __future__ import annotations

import re
import struct

_SEQUENTIAL, _PROGRESSIVE = (0xC0, 0xC1), (0xC2,)
_SCAN_END = re.compile(rb"\xff[^\x00\xd0-\xd7\xff]")      # the marker that ends an entropy-coded segment
_RST = re.compile(rb"\xff[\xd0-\xd7]")


class Incomplete(Exception):
    """Why the JPEG is not whole: truncated, corrupt or unsupported."""


class _Table:
    """One Huffman table: its canonical codes, and 16-bit lookups built per use (each code fills its prefix span)."""

    def __init__(self, counts, symbols):
        self.codes, code, k = [], 0, 0
        for length in range(1, 17):
            for _ in range(counts[length - 1]):
                if k >= len(symbols) or code >= (1 << length):
                    raise Incomplete("corrupt")
                self.codes.append((code, length, symbols[k]))
                code, k = code + 1, k + 1
            code <<= 1
        self.luts = {}

    def lut(self, use):
        """use "raw": length << 8 | symbol. Otherwise each code's whole advance folded in: entry = bits (code + value)
        | coefficient step << 5. "dc": no step. "ac" (sequential): run + 1 for a coefficient, 16 for ZRL, _EOB for EOB.
        "first" (progressive first AC): as "ac", plus EOBr as _EOB + r (its r run bits read separately) and _COEF on a
        coefficient. A code with no meaning for that use, or no code at all, is 0."""
        if use not in self.luts:
            out = [0] * 65536
            for code, length, sym in self.codes:
                if use == "raw":
                    entry = (length << 8) | sym
                elif use == "dc":
                    entry = length + sym if sym <= 16 else 0
                elif sym & 15:
                    entry = length + (sym & 15) | ((sym >> 4) + 1) << 5 | (_COEF if use == "first" else 0)
                elif sym == 0xF0:
                    entry = length | 16 << 5
                elif sym == 0:
                    entry = length | _EOB << 5
                elif use == "first":
                    entry = length | (_EOB + (sym >> 4)) << 5
                else:
                    entry = 0
                span = 1 << (16 - length)
                out[code * span:(code + 1) * span] = [entry] * span
            self.luts[use] = out
        return self.luts[use]


class _Bits:
    """An unstuffed restart segment read as bits; reading past its end is truncation."""
    __slots__ = ("buf", "pos", "end")

    def __init__(self, raw):
        data = raw.replace(b"\xff\x00", b"\xff")
        self.buf, self.pos, self.end = data + b"\x00" * 8, 0, len(data) * 8

    def finish(self):
        if self.pos > self.end:
            raise Incomplete("truncated")


def _huff(bits, lut):
    pos = bits.pos
    if pos >= bits.end:
        raise Incomplete("truncated")      # a code needs at least one bit the segment carries
    b = pos >> 3
    buf = bits.buf
    entry = lut[(((buf[b] << 16) | (buf[b + 1] << 8) | buf[b + 2]) >> (8 - (pos & 7))) & 0xFFFF]
    if not entry:
        raise Incomplete("corrupt")
    bits.pos = pos + (entry >> 8)
    return entry & 0xFF


def _read(bits, n):
    if not n:
        return 0
    pos = bits.pos
    if pos + n > bits.end:
        raise Incomplete("truncated")
    b = pos >> 3
    buf = bits.buf
    value = (((buf[b] << 16) | (buf[b + 1] << 8) | buf[b + 2]) >> (24 - n - (pos & 7))) & ((1 << n) - 1)
    bits.pos = pos + n
    return value


MAX_SIDE = 2048       # the admitted geometry when the caller gives none (media passes its pinned cap)
_COMPONENTS = (1, 3, 4)
_PASSES = 6          # total coefficient work over the frame's blocks; libjpeg's own scripts make at most 3 passes


def limits(max_width=MAX_SIDE, max_height=MAX_SIDE):
    """(most bytes of coefficient state, most coefficient visits) any admitted frame can need, from the geometry cap:
    four components at full size (sampling factors only shrink a component), one bit per coefficient; work counts the
    MCU padding of the largest sampling factor (4: at most 3 blocks a side)."""
    bw, bh = -(-max_width // 8), -(-max_height // 8)
    return 4 * bw * bh * 8, _PASSES * 64 * 4 * (bw + 3) * (bh + 3)


def check(data, max_width=MAX_SIDE, max_height=MAX_SIDE):
    """None when the JPEG is whole; Incomplete(reason) otherwise."""
    frame, mode = _plan(data, max_width, max_height)
    dc, ac, restart, nonzero = {}, {}, 0, {}
    for marker, body, span in _markers(data):
        if marker == 0xC4:
            _dht(body, dc, ac)
        elif marker == 0xDD:
            restart = struct.unpack(">H", body)[0]
        elif marker == 0xDA:
            _scan(frame, mode, _scan_header(frame, mode, body), data[span[0]:span[1]], dc, ac, restart, nonzero)
    return None


def _markers(data):
    """(marker, body, entropy span or None) for each segment up to EOI; structural truncation and corruption raise."""
    if data[:2] != b"\xff\xd8":
        raise Incomplete("not_jpeg")
    pos = 2
    while True:
        if pos + 2 > len(data) or data[pos] != 0xFF:
            raise Incomplete("truncated")
        marker = data[pos + 1]
        if marker == 0xFF:                       # fill byte
            pos += 1
            continue
        if marker == 0xD9:                       # EOI
            if pos + 2 != len(data):
                raise Incomplete("trailing_data")
            return
        if 0xD0 <= marker <= 0xD7 or marker in (0x01, 0xD8):
            raise Incomplete("corrupt")
        if pos + 4 > len(data):
            raise Incomplete("truncated")
        length = struct.unpack(">H", data[pos + 2:pos + 4])[0]
        body = data[pos + 4:pos + 2 + length]
        if length < 2 or len(body) != length - 2:
            raise Incomplete("truncated")
        pos += 2 + length
        if marker == 0xDA:
            end = _SCAN_END.search(data, pos)
            if end is None:
                raise Incomplete("truncated")
            yield marker, body, (pos, end.start())
            pos = end.start()
        else:
            yield marker, body, None


def _plan(data, max_width, max_height):
    """Pass 1, headers only: (frame, mode) once the frame is admitted, the scans cover it and the work is bounded."""
    frame = mode = None
    coverage, scans, work = {}, 0, 0
    for marker, body, span in _markers(data):
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            if frame is not None:
                raise Incomplete("corrupt")
            if marker not in _SEQUENTIAL + _PROGRESSIVE:
                raise Incomplete("unsupported")  # arithmetic, lossless, hierarchical
            mode = "progressive" if marker in _PROGRESSIVE else "sequential"
            frame = _frame(body, max_width, max_height)
            coverage = {cid: [None] * 64 for cid in frame["components"]}   # per coefficient: the bit coded down to
        elif marker == 0xDD:
            if len(body) != 2:
                raise Incomplete("corrupt")
        elif marker == 0xDA:
            if frame is None:
                raise Incomplete("corrupt")
            comps, ss, se, ah, al = _scan_header(frame, mode, body)
            for cid, _d, _a in comps:            # a first scan (ah == 0) codes bits down to al; a refinement one more
                coef = coverage[cid]
                for k in range(ss, se + 1):
                    if ah == 0:
                        if coef[k] is not None:
                            raise Incomplete("corrupt")
                    elif coef[k] != ah or al != ah - 1:
                        raise Incomplete("corrupt")
                    coef[k] = al
            units, per = _scan_units(frame, comps)
            blocks = units * sum(per)
            if mode == "sequential":
                need = 2 * blocks                # a DC code and an EOB, at least one bit each, per block
            elif ss == 0:
                need = blocks                    # a DC code, or one refinement bit, per block
            else:
                need = -(-blocks // 32767)       # one EOB-run code covers at most 32767 blocks
            if (span[1] - span[0]) * 8 < need:
                raise Incomplete("truncated")
            work += blocks * (se - ss + 1)
            scans += 1
        elif marker == 0xDC:                     # DNL: a height given after the scan is not supported
            raise Incomplete("unsupported")
    if frame is None or not scans:
        raise Incomplete("truncated")
    for coef in coverage.values():
        if None in coef:                         # a coefficient no scan coded (refinement to bit 0 is optional)
            raise Incomplete("truncated")
    track_cap, work_cap = limits(max_width, max_height)
    padded = frame["mcux"] * frame["mcuy"] * sum(h * v for h, v in frame["components"].values())
    if work > min(work_cap, _PASSES * 64 * padded):
        raise Incomplete("unsupported")
    if mode == "progressive" and 8 * sum(bw * bh for bw, bh in frame["blocks"].values()) > track_cap:
        raise Incomplete("unsupported")
    return frame, mode


def _frame(body, max_width, max_height):
    if len(body) < 6:
        raise Incomplete("corrupt")
    height, width, count = struct.unpack(">HHB", body[1:6])
    if count not in _COMPONENTS:
        raise Incomplete("unsupported")          # grey, YCbCr/RGB, CMYK/YCCK; checked before any component is read
    if not height or not width or len(body) != 6 + 3 * count:
        raise Incomplete("corrupt")
    if width > max_width or height > max_height:
        raise Incomplete("too_large")
    components = {}
    for i in range(count):
        cid, hv = body[6 + 3 * i], body[7 + 3 * i]
        h, v = hv >> 4, hv & 15
        if not (1 <= h <= 4 and 1 <= v <= 4) or cid in components:
            raise Incomplete("corrupt")
        components[cid] = (h, v)
    hmax, vmax = max(h for h, _ in components.values()), max(v for _, v in components.values())
    mcux, mcuy = -(-width // (8 * hmax)), -(-height // (8 * vmax))
    blocks = {cid: (-(-(-(-width * h // hmax)) // 8), -(-(-(-height * v // vmax)) // 8)) for cid, (h, v) in components.items()}
    return {"width": width, "height": height, "components": components, "mcux": mcux, "mcuy": mcuy, "blocks": blocks}


def _dht(body, dc, ac):
    i = 0
    while i < len(body):
        if i + 17 > len(body):
            raise Incomplete("corrupt")
        kind, slot = body[i] >> 4, body[i] & 15
        counts = body[i + 1:i + 17]
        total = sum(counts)
        symbols = body[i + 17:i + 17 + total]
        if kind > 1 or slot > 3 or len(symbols) != total:
            raise Incomplete("corrupt")
        (dc if kind == 0 else ac)[slot] = _Table(counts, symbols)
        i += 17 + total


def _scan_header(frame, mode, header):
    """(components as (id, dc table, ac table), Ss, Se, Ah, Al), each checked against the frame and the mode."""
    if not header:
        raise Incomplete("corrupt")
    count = header[0]
    if not 1 <= count <= 4 or len(header) != 4 + 2 * count:
        raise Incomplete("corrupt")
    comps = []
    for i in range(count):
        cid, tables = header[1 + 2 * i], header[2 + 2 * i]
        if cid not in frame["components"] or any(c == cid for c, *_ in comps):
            raise Incomplete("corrupt")
        comps.append((cid, tables >> 4, tables & 15))
    ss, se, ahl = header[1 + 2 * count], header[2 + 2 * count], header[3 + 2 * count]
    ah, al = ahl >> 4, ahl & 15
    if mode == "sequential":
        if (ss, se, ah, al) != (0, 63, 0, 0):
            raise Incomplete("corrupt")
    elif ss > se or se > 63 or (ss == 0 and se != 0) or (ss > 0 and count != 1) or al > 13:
        raise Incomplete("corrupt")
    return comps, ss, se, ah, al


def _scan_units(frame, comps):
    """(units, blocks per unit per component) this scan codes, in order: interleaved = MCUs of Hi x Vi blocks; one
    component = its own block grid."""
    if len(comps) > 1:
        return frame["mcux"] * frame["mcuy"], [frame["components"][cid][0] * frame["components"][cid][1] for cid, _d, _a in comps]
    bw, bh = frame["blocks"][comps[0][0]]
    return bw * bh, [1]


def _scan(frame, mode, header, entropy, dc, ac, restart, nonzero):
    comps, ss, se, ah, al = header
    needs_dc = ss == 0 and ah == 0
    needs_ac = se > 0 and (mode == "sequential" or ss > 0)
    try:
        dct = [dc[d] if needs_dc else None for _c, d, _a in comps]
        act = [ac[a] if needs_ac else None for _c, _d, a in comps]
    except KeyError:
        raise Incomplete("corrupt") from None
    units, per = _scan_units(frame, comps)
    segments = _segments(entropy, units, restart)
    if mode == "sequential":
        _sequential(segments, units, restart, per, dct, act)
    elif ss == 0:
        _dc_scan(segments, units, restart, per, dct, ah)
    else:
        cid = comps[0][0]
        if cid not in nonzero:                   # one bit per coefficient: 8 bytes a block, within limits()[0]
            bw, bh = frame["blocks"][cid]
            nonzero[cid] = bytearray(bw * bh * 8)
        (_ac_first if ah == 0 else _ac_refine)(segments, units, restart, act[0], ss, se, nonzero[cid])


def _segments(entropy, units, restart):
    """The restart segments of one scan, each checked present and in RST order."""
    entropy = entropy.rstrip(b"\xff")            # fill bytes before the next marker
    if not restart:
        if _RST.search(entropy):
            raise Incomplete("corrupt")
        return [entropy]
    expected = -(-units // restart)
    parts, last = [], 0
    for i, m in enumerate(_RST.finditer(entropy)):
        if entropy[m.start() + 1] != 0xD0 + (i % 8):
            raise Incomplete("corrupt")
        parts.append(entropy[last:m.start()])
        last = m.end()
    parts.append(entropy[last:])
    if len(parts) != expected:
        raise Incomplete("truncated" if len(parts) < expected else "corrupt")
    return parts


def _units(segments, units, restart):
    """(raw segment, number of units it codes) per restart segment."""
    step = restart or units
    for i, raw in enumerate(segments):
        yield raw, min(step, units - i * step)


def _bit_units(segments, units, restart):
    for raw, n in _units(segments, units, restart):
        yield _Bits(raw), n


_EOB = 100
_COEF = 1 << 12      # progressive first-AC tables only: this code places a coefficient (run 15 + value is step 16, as ZRL)
_PAD = 1024          # bytes after a segment: one block never reads further, and each block is checked against the end


def _sequential(segments, units, restart, per, dct, act):
    plan = [(dct[i].lut("dc"), act[i].lut("ac")) for i, n in enumerate(per) for _ in range(n)]
    for raw, n in _units(segments, units, restart):
        buf = raw.replace(b"\xff\x00", b"\xff")
        end = len(buf) * 8
        buf += bytes(_PAD)
        pos = 0
        for _ in range(n):
            for dlut, alut in plan:
                e = dlut[(((buf[pos >> 3] << 16) | (buf[(pos >> 3) + 1] << 8) | buf[(pos >> 3) + 2]) >> (8 - (pos & 7))) & 0xFFFF]
                if not e:
                    raise Incomplete("truncated" if pos >= end else "corrupt")
                pos += e
                k = 1
                while k < 64:
                    b = pos >> 3
                    e = alut[(((buf[b] << 16) | (buf[b + 1] << 8) | buf[b + 2]) >> (8 - (pos & 7))) & 0xFFFF]
                    if not e:
                        raise Incomplete("truncated" if pos >= end else "corrupt")
                    pos += e & 31
                    k += e >> 5
                if pos > end:
                    raise Incomplete("truncated")
                if 64 < k < _EOB:
                    raise Incomplete("corrupt")


def _dc_scan(segments, units, restart, per, dct, ah):
    plan = [None if ah else dct[i].lut("dc") for i, n in enumerate(per) for _ in range(n)]
    for raw, n in _units(segments, units, restart):
        buf = raw.replace(b"\xff\x00", b"\xff")
        end = len(buf) * 8
        buf += bytes(_PAD)
        pos = 0
        for _ in range(n):
            for dlut in plan:
                if dlut is None:
                    pos += 1                         # a refinement: one bit per block
                    continue
                e = dlut[(((buf[pos >> 3] << 16) | (buf[(pos >> 3) + 1] << 8) | buf[(pos >> 3) + 2]) >> (8 - (pos & 7))) & 0xFFFF]
                if not e:
                    raise Incomplete("truncated" if pos >= end else "corrupt")
                pos += e
            if pos > end:
                raise Incomplete("truncated")


def _ac_first(segments, units, restart, alut, ss, se, nz):
    steps = alut.lut("first")
    block = 0
    for raw, n in _units(segments, units, restart):
        buf = raw.replace(b"\xff\x00", b"\xff")
        end = len(buf) * 8
        buf += bytes(_PAD)
        pos, eobrun = 0, 0
        for _ in range(n):
            if eobrun:
                eobrun -= 1
            else:
                base, k = block * 8, ss
                while k <= se:
                    b = pos >> 3
                    e = steps[(((buf[b] << 16) | (buf[b + 1] << 8) | buf[b + 2]) >> (8 - (pos & 7))) & 0xFFFF]
                    if not e:
                        raise Incomplete("truncated" if pos >= end else "corrupt")
                    pos += e & 31
                    step = (e >> 5) & 127
                    if step >= _EOB:
                        r = step - _EOB
                        if r:
                            b = pos >> 3
                            eobrun = ((((buf[b] << 16) | (buf[b + 1] << 8) | buf[b + 2]) >> (24 - r - (pos & 7))) & ((1 << r) - 1))
                            pos += r
                        eobrun += (1 << r) - 1
                        break
                    k += step
                    if e & _COEF:
                        if k - 1 > se:
                            raise Incomplete("corrupt")
                        nz[base + ((k - 1) >> 3)] |= 1 << ((k - 1) & 7)
                if k > se + 1:
                    raise Incomplete("corrupt")
            block += 1
            if pos > end:
                raise Incomplete("truncated")


def _ac_refine(segments, units, restart, alut, ss, se, nz):
    raw = alut.lut("raw")
    block = 0
    for bits, n in _bit_units(segments, units, restart):
        eobrun = 0
        for _ in range(n):
            base, k = block * 8, ss
            if not eobrun:
                while k <= se:
                    sym = _huff(bits, raw)
                    r, size = sym >> 4, sym & 15
                    if size:
                        if size != 1:
                            raise Incomplete("corrupt")
                        bits.pos += 1                    # the new coefficient's sign
                    elif r != 15:
                        eobrun = (1 << r) + _read(bits, r)
                        break
                    while k <= se:
                        if nz[base + (k >> 3)] >> (k & 7) & 1:
                            bits.pos += 1                # a correction bit for a coefficient already non-zero
                        else:
                            if r == 0:
                                break
                            r -= 1
                        k += 1
                    if size:
                        if k > se:
                            raise Incomplete("corrupt")
                        nz[base + (k >> 3)] |= 1 << (k & 7)
                    k += 1
            if eobrun:
                while k <= se:
                    if nz[base + (k >> 3)] >> (k & 7) & 1:
                        bits.pos += 1
                    k += 1
                eobrun -= 1
            block += 1
            if bits.pos > bits.end:
                raise Incomplete("truncated")
        bits.finish()
