FROM node:22-alpine

WORKDIR /usr/src/app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

# node directly (not npm): SIGTERM reaches the bot, so graceful shutdown runs.
CMD ["node", "src/app.js"]
