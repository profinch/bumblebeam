"""The link preview of puzzle.bumblebeam.org (Open Graph / Twitter card, 1200x630): the static banner (banner_size.py)
with the puzzle site's line and address under the logo.
python3 brand/src/og_puzzle.py /tmp/bb/og.html
then: chrome-headless-shell --headless --hide-scrollbars --window-size=1200,630 --screenshot=/tmp/bb/og.png file:///tmp/bb/og.html
      ffmpeg -i /tmp/bb/og.png -q:v 3 bitcoin/puzzle/web/og.jpg   (90 KB instead of the PNG's 580)"""
import sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import frames as F
import banner_size as B

if __name__ == "__main__":
    out = sys.argv[1]
    open(out, "w").write(B.banner(25 / F.BF * F.BT, F.BT, 1200, 630, 1.0, tag="The Bitcoin puzzle: all 160, live", url="https://puzzle.bumblebeam.org"))
    print(out)
