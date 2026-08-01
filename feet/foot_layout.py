"""
foot_layout.py
Configurable per-foot zone layouts for the PASS insole viewers.

Positions are normalized foot coordinates (y: 0 = heel, 1 = toe). Editing them
changes only the drawing, so this is the configurable anatomy layer.

Both feet are from the press test (each channel confirmed by pressing the spot and
seeing which channel lights up). The two feet differ, so they have separate maps.
"""

# LEFT foot - confirmed press-test layout (mux channel -> position), toe to heel
LEFT_POSITIONS = {
    8:  (0.40, 0.93), 15: (0.58, 0.93),                       # toes
    4:  (0.32, 0.76), 7:  (0.50, 0.76), 9:  (0.68, 0.76),     # upper forefoot
    3:  (0.32, 0.60), 6:  (0.50, 0.60), 14: (0.68, 0.60),     # forefoot
    5:  (0.32, 0.44), 1:  (0.50, 0.44), 11: (0.68, 0.44),     # midfoot
    2:  (0.32, 0.28), 0:  (0.50, 0.28), 12: (0.68, 0.28),     # lower
    10: (0.42, 0.12), 13: (0.58, 0.12),                       # heel
}
LEFT_ANATOMY = {8: "toe", 15: "toe", 10: "heel", 13: "heel"}

# RIGHT foot - confirmed press-test layout, toe to heel
RIGHT_POSITIONS = {
    8:  (0.40, 0.93), 1:  (0.58, 0.93),                       # toes
    2:  (0.32, 0.76), 0:  (0.50, 0.76), 13: (0.68, 0.76),     # upper forefoot
    7:  (0.32, 0.60), 15: (0.50, 0.60), 12: (0.68, 0.60),     # forefoot
    4:  (0.32, 0.44), 10: (0.50, 0.44), 14: (0.68, 0.44),     # midfoot
    5:  (0.32, 0.28), 9:  (0.50, 0.28), 11: (0.68, 0.28),     # lower
    6:  (0.42, 0.12), 3:  (0.58, 0.12),                       # heel
}
RIGHT_ANATOMY = {8: "toe", 1: "toe", 6: "heel", 3: "heel"}

FEET = {
    "left":  {"positions": LEFT_POSITIONS,  "anatomy": LEFT_ANATOMY,
              "port": "COM15", "confirmed": True},
    "right": {"positions": RIGHT_POSITIONS, "anatomy": RIGHT_ANATOMY,
              "port": "COM13", "confirmed": True},
}
