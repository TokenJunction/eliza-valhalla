#!/usr/bin/env python3
"""Preview drafts only. This file never posts to X."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from valhalla_x import main

if __name__ == "__main__":
    print("social/post.py only previews drafts. Use social/valhalla-x to post.")
    main(["draft"])
