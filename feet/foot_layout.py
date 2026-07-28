"""
foot_layout.py
Configurable per-foot zone layouts for the PASS insole viewers.

Positions are normalized foot coordinates (y: 0 = heel, 1 = toe). Editing them
changes only the drawing, so this is the configurable anatomy layer.

LEFT is from the press test, cross-checked channel-by-channel against the
pin->channel map (100% consistent). RIGHT is PROVISIONAL until its press test is
done; run the dual viewer, press each spot, see which channel lights up, then
edit RIGHT_POSITIONS to match.
"""

# LEFT foot - confirmed layout (mux channel -> position)
LEFT_POSITIONS = {
    8:  (0.40, 0.93), 9:  (0.58, 0.93),                       # toes (big toe)
    0:  (0.32, 0.75), 7:  (0.50, 0.75), 10: (0.68, 0.75),     # upper forefoot
    1:  (0.32, 0.58), 4:  (0.50, 0.58), 11: (0.68, 0.58),     # forefoot
    2:  (0.32, 0.42), 5:  (0.50, 0.42), 15: (0.68, 0.42),     # lower forefoot
    3:  (0.32, 0.26), 6:  (0.50, 0.26), 14: (0.68, 0.26),     # midfoot
    13: (0.42, 0.10), 12: (0.58, 0.10),                       # heel
}
LEFT_ANATOMY = {8: "big toe", 9: "big toe", 12: "heel", 13: "heel"}

# RIGHT foot - PROVISIONAL. Channels laid out in reading order; replace after the
# right press test (its pin->channel map differs, so its layout will differ).
RIGHT_POSITIONS = {
    0:  (0.40, 0.93), 1:  (0.58, 0.93),
    2:  (0.32, 0.75), 3:  (0.50, 0.75), 4:  (0.68, 0.75),
    5:  (0.32, 0.58), 6:  (0.50, 0.58), 7:  (0.68, 0.58),
    8:  (0.32, 0.42), 9:  (0.50, 0.42), 10: (0.68, 0.42),
    11: (0.32, 0.26), 12: (0.50, 0.26), 13: (0.68, 0.26),
    14: (0.42, 0.10), 15: (0.58, 0.10),
}
RIGHT_ANATOMY: dict[int, str] = {}     # TODO after right press test

FEET = {
    "left":  {"positions": LEFT_POSITIONS,  "anatomy": LEFT_ANATOMY,
              "port": "COM11", "confirmed": True},
    "right": {"positions": RIGHT_POSITIONS, "anatomy": RIGHT_ANATOMY,
              "port": None, "confirmed": False},
}
