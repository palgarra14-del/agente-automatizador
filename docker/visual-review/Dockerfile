FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e
WORKDIR /opt/visual-review
RUN npm init -y >/dev/null 2>&1 && npm install --omit=dev --ignore-scripts playwright@1.62.1 && npm cache clean --force
COPY capture.mjs /opt/visual-review/capture.mjs
ENTRYPOINT ["node", "/opt/visual-review/capture.mjs"]
