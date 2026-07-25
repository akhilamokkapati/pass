"""
test_insole_source.py
Hardware-free tests for the insole source (task 3) and normalizer (task 4),
using injected serial lines.

Run:  python -m pytest feet/test_insole_source.py -q   (from repo root)
      python -m pytest test_insole_source.py -q         (from feet/)
"""

import numpy as np

from sources.insole_source import InsoleSource, parse_frame_line, ADC_MAX
from sources.normalize import ZoneNormalizer


def _line(vals):
    return " ".join(str(int(v)) for v in vals)


def test_parser_rejects_headers_accepts_data():
    assert parse_frame_line("16-channel scan start") is None
    assert parse_frame_line("C0   C1   C2   C3   C4   C5   C6   C7   "
                            "C8   C9   C10  C11  C12  C13  C14  C15") is None
    d = parse_frame_line(_line(range(4000, 4016)))
    assert d is not None and d.shape == (16,)
    # a frame,timestamp prefix is ignored (last 16 taken)
    d2 = parse_frame_line("42,105300," + ",".join(str(v) for v in range(16)))
    assert d2 is not None and d2.shape == (16,) and d2[0] == 0 and d2[-1] == 15


def test_inversion_pressure_reads_up():
    raw = [4000] * 16
    raw[5] = 3000                       # zone 5 pressed -> raw pulled down
    src = InsoleSource(line_source=[_line(raw)])
    fr = next(src.stream())
    assert np.isclose(fr.pressure[5], ADC_MAX - 3000)      # 1095, the pressed zone
    assert np.isclose(fr.pressure[0], ADC_MAX - 4000)      # 95, an unpressed zone
    assert fr.pressure[5] > fr.pressure[0]                 # pressing reads higher


def test_get_data_shape_and_header_skipping():
    lines = ["16-channel scan start",
             "C0 C1 C2 C3 C4 C5 C6 C7 C8 C9 C10 C11 C12 C13 C14 C15",
             _line([4000] * 16),
             _line([3900] * 16),
             _line([3800] * 16)]
    cap = InsoleSource(line_source=lines).get_data()
    assert cap.pressure.shape == (3, 16)                   # 3 data lines, headers skipped
    assert cap.frame.tolist() == [0, 1, 2]


def test_zone_normalizer_fraction_of_static_load():
    # standing reference: zone 5 bears more load than the rest
    standing = np.tile([100.0] * 16, (5, 1))
    standing[:, 5] = 500.0
    norm = ZoneNormalizer().fit(standing)
    # at the standing load, every zone reads ~1.0 (that is the point)
    assert np.isclose(norm.transform(standing[0])[5], 1.0)
    assert np.isclose(norm.transform(standing[0])[0], 1.0)
    # doubling the load on a zone reads ~2.0
    doubled = standing[0].copy()
    doubled[5] = 1000.0
    assert np.isclose(norm.transform(doubled)[5], 2.0)
    # re-runnable: fitting again replaces the reference
    norm.fit(standing[0] * 2)
    assert np.isclose(norm.transform(standing[0] * 2)[5], 1.0)
