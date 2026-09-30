# The remote-path bench browser: Playwright's image plus Google Chrome. Playwright's own Linux
# Chromium has NO H.264 (measured: VP8/VP9/AV1 only), so against the doorbell (H.264) it answers
# with the video m-line rejected and gets audio only - which looks exactly like "TURN drops video".
# Google Chrome carries H.264, like the Windows build the other benches use.
#   docker build -t igd-remote-bench tests/card/remote_path/image
FROM mcr.microsoft.com/playwright:v1.55.0-noble
RUN npx -y playwright@1.55.0 install chrome && /opt/google/chrome/chrome --version
