# 固定媒体样本

`media/` 中的视频是本项目用 FFmpeg `testsrc2` 与 `sine` 滤镜生成的 24 秒测试信号，不含第三方影视内容。MP4 使用 H.264 baseline / AAC；HLS 从同一视频无损封装为 4 秒分片。自动化测试只使用这些样本，不访问真实来源。

生成命令（本机任意 FFmpeg）：

```sh
ffmpeg -f lavfi -i testsrc2=size=480x270:rate=24 -f lavfi -i sine=frequency=440:sample_rate=44100 -t 24 -c:v libx264 -profile:v baseline -pix_fmt yuv420p -g 48 -crf 32 -c:a aac -b:a 48k -movflags +faststart sample.mp4
ffmpeg -i sample.mp4 -c copy -hls_time 4 -hls_playlist_type vod -hls_segment_filename segment-%02d.ts index.m3u8
ffmpeg -i sample.mp4 -frames:v 1 poster.png
```
