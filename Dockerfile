FROM node:alpine

RUN apk --no-cache add libreoffice
WORKDIR /app
COPY package.json .
RUN npm install 
COPY . .
EXPOSE 5000
CMD ["npm", "start"]