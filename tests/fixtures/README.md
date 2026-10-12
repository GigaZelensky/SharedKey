# Video fixtures

These tiny one-second, 320×180 solid-red videos were generated for SharedKey’s browser tests. They contain no user recordings or third-party media. The MP4 uses H.264; the WebM uses VP8.

Regenerate with FFmpeg:

```sh
ffmpeg -f lavfi -i color=c=0xe04030:s=320x180:r=10 -t 1 -an -c:v libx264 -pix_fmt yuv420p local-video.mp4
ffmpeg -f lavfi -i color=c=0xe04030:s=320x180:r=10 -t 1 -an -c:v libvpx -pix_fmt yuv420p local-video.webm
```
