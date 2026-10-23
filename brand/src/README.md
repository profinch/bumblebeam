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
