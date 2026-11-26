# One container: the backend, which also serves the built G2 app.
#   docker build -t chengzhang-g2 .
#   docker run -p 8787:8787 -v chengzhang-data:/app/data --env-file .env chengzhang-g2
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=8787 DATA_DIR=/app/data
# Keep /app/data on a volume: `docker run -v …` as above, or a volume mounted there by your host
# (Railway, Fly and the like do not accept a VOLUME line, so there is none here).
EXPOSE 8787
CMD ["npm", "start"]
