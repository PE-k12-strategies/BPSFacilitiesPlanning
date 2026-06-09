"""
Erase everything outside a closed black boundary by flood-filling from image edges.

Light pixels are traversable; pixels darker than --wall-threshold block the flood.
Interior (unreachable from edges) plus a thin rim around it is kept; exterior is transparent.
"""

from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation


def luminance(rgb: np.ndarray) -> np.ndarray:
    return (
        0.299 * rgb[..., 0].astype(np.float64)
        + 0.587 * rgb[..., 1].astype(np.float64)
        + 0.114 * rgb[..., 2].astype(np.float64)
    )


def flood_from_edges(passable: np.ndarray) -> np.ndarray:
    """True = reachable from any image-edge cell through 4-connected passable pixels."""
    h, w = passable.shape
    visited = np.zeros((h, w), dtype=bool)
    q: deque[tuple[int, int]] = deque()

    def try_add(i: int, j: int) -> None:
        if passable[i, j] and not visited[i, j]:
            visited[i, j] = True
            q.append((i, j))

    for j in range(w):
        try_add(0, j)
        try_add(h - 1, j)
    for i in range(h):
        try_add(i, 0)
        try_add(i, w - 1)

    while q:
        i, j = q.popleft()
        if i > 0:
            try_add(i - 1, j)
        if i + 1 < h:
            try_add(i + 1, j)
        if j > 0:
            try_add(i, j - 1)
        if j + 1 < w:
            try_add(i, j + 1)

    return visited


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input_png", type=Path)
    ap.add_argument("-o", "--output", type=Path, default=None)
    ap.add_argument(
        "--wall-threshold",
        type=int,
        default=40,
        help="Grayscale values below this are walls (blocks flood). Lower = only near-black ink.",
    )
    ap.add_argument(
        "--dilate-wall",
        type=int,
        default=14,
        help="Iterations of 3x3 dilation on wall mask to close anti-aliasing gaps in the stroke.",
    )
    ap.add_argument(
        "--cover-border",
        type=int,
        default=6,
        help="Dilate kept interior this many iterations so the black stroke stays opaque.",
    )
    args = ap.parse_args()

    inp = args.input_png
    out = args.output or inp.with_name(inp.stem + "_clipped.png")

    img = np.array(Image.open(inp).convert("RGBA"))
    gray = luminance(img[..., :3])

    wall = gray < args.wall_threshold
    if args.dilate_wall > 0:
        wall = binary_dilation(wall, iterations=args.dilate_wall)

    passable = ~wall
    outside = flood_from_edges(passable)
    inside_core = passable & ~outside

    structure = np.ones((3, 3), dtype=bool)
    kept = binary_dilation(inside_core, structure=structure, iterations=args.cover_border)

    alpha = img[..., 3].astype(np.uint8).copy()
    alpha[~kept] = 0

    out_img = Image.fromarray(np.dstack([img[..., 0], img[..., 1], img[..., 2], alpha]), "RGBA")
    out.parent.mkdir(parents=True, exist_ok=True)
    out_img.save(out)
    print("Wrote", out.resolve())


if __name__ == "__main__":
    main()
