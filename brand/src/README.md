# How the animated files are made

    python3 brand/src/frames.py /tmp/bb                      # one SVG page per frame: /tmp/bb/avatar, /tmp/bb/banner
    mkdir -p /tmp/bb/png/avatar /tmp/bb/png/banner
    ls /tmp/bb/avatar/*.html | xargs -P 8 -I{} brand/src/render.sh avatar {} 800,800 /tmp/bb    # headless Chrome
    ls /tmp/bb/banner/*.html | xargs -P 8 -I{} brand/src/render.sh banner {} 1500,500 /tmp/bb
    cd /tmp/bb/png
    ffmpeg -stream_loop 3 -framerate 25 -i avatar/f%03d.png -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart -an avatar-800.mp4
    ffmpeg -framerate 25 -i avatar/f%03d.png -vf "scale=512:512:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a" -loop 0 avatar-512.gif
    ffmpeg -stream_loop 1 -framerate 25 -i banner/f%03d.png -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart -an banner-1500x500.mp4
    ffmpeg -framerate 25 -i banner/f%03d.png -vf "fps=20,split[a][b];[a]palettegen=max_colors=192:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" -loop 0 banner-1500x500.gif

The static banner is frame 25 (banner/f025.png). Both loop in 4.4 s: 10 wing beats of 0.44 s and 3 trail blinks of 1.47 s, as pool/web/favicon.svg moves (0.44 s, 1.5 s).

Other banner sizes (the static frame 25, the logo+text block centred, elements scaled by k):

    python3 brand/src/banner_size.py 1024 576 1.0 /tmp/bb/b.html && brand/src/render.sh b /tmp/bb/b.html 1024,576 /tmp/bb
    python3 brand/src/banner_size.py 1920 640 1.28 ...   # 3:1
    python3 brand/src/banner_size.py 2560 1440 1.5 ...   # YouTube: the block stays inside the 1546x423 safe area
    python3 brand/src/banner_size.py 4000 192 0.7 ... 0.33   # Reddit banner; the 5th arg moves the wave next to the block
    python3 brand/src/banner_size.py 2160 256 0.9 ...   # Reddit mobile banner

On Linux/WSL `chrome --headless=new --screenshot` hangs; Playwright's `chrome-headless-shell` with the same flags works.
